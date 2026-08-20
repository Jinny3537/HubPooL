import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AppData, Project, Version, Requirement } from './types.js';
import { appDataSchema } from './schemas.js';
import { codedError } from './errors.js';

export const DOCUMENT_MAX_CHARS = 200_000;
export const PROTOTYPE_MAX_CHARS = 2_000_000;

export function versionDocumentMaxChars(kind: VersionDocument['kind']): number {
  return kind === 'prototype' ? PROTOTYPE_MAX_CHARS : DOCUMENT_MAX_CHARS;
}

const EMPTY_DATA: AppData = {
  projects: [],
  versions: [],
  requirements: [],
  settings: {},
  seqCounters: {},
};

export interface SnapshotInfo {
  id: string;
  createdAt: number;
  reason: string;
  requirementCount: number;
}

export interface ProjectSyncPayload {
  projectId: string;
  project: Project | null;
  versions: Version[];
  requirements: Requirement[];
  documents: VersionDocument[];
  dataVersion: string;
  exportedAt: number;
}

export interface SyncMergeResult {
  added: number;
  modified: number;
  conflicts: Array<{ id: string; kind: 'requirement' | 'version' | 'document' }>;
}

/** One line item in a sync preview/diff — used by the pre-sync "what will change" UI. */
export interface SyncDiffItem {
  id: string;
  kind: 'requirement' | 'version' | 'document';
  name: string;
  action: 'add' | 'modify' | 'conflict';
}

export interface SyncDiffPlan {
  result: SyncMergeResult;
  items: SyncDiffItem[];
}

/** 本地 AI 工作台（v0.2.1）通过 MCP 提出的待确认改动——从不直接写入 app_state，
 *  必须由用户在既有的新建/编辑需求表单里过一遍、手动点保存才会真正生效。 */
export interface AiProposal {
  id: string;
  projectId: string;
  kind: 'create_requirement' | 'edit_requirement' | 'batch_update' | 'split_requirement';
  requirementId: string | null;
  /** 'batch_update' 提案的 payload 形如 { requirementIds: string[], field: 'status'|'priority'|'versionId', value: string }。
   *  'split_requirement' 提案的 payload 形如 { sourceRequirementId: string, sourceName: string, children: Array<需求草稿字段> }。 */
  payload: Record<string, unknown>;
  summary: string;
  status: 'pending' | 'applied' | 'rejected';
  createdAt: number;
}

/** 版本关联的技术规格书/PRD 文档（v0.2.1）——存原文（Markdown 或 HTML），参与项目间 P2P 同步（v0.2.2 起）。
 *  渲染时前端会用 marked + DOMPurify 转成安全 HTML 再展示，原型 HTML 用 sandbox iframe 预览，这里只负责存取原文。 */
export interface VersionDocument {
  id: string;
  versionId: string;
  title: string;
  kind: 'spec' | 'prd' | 'other' | 'prototype';
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** AI 工作台对话历史（v0.2.1）——本地专属、不参与 P2P 同步，只是为了让用户关掉工作台再打开时
 *  还能看到上次聊到哪、并且能靠 sessionId 接着 --resume，而不是每次都从零开始。 */
export interface ChatMessage {
  id: string;
  projectId: string;
  sessionId: string | null;
  role: 'user' | 'assistant' | 'error' | 'system';
  content: string;
  createdAt: number;
}

export interface SyncHistoryEntry {
  id: string;
  projectId: string;
  type: 'push' | 'pull' | 'merge' | 'receive';
  status: 'success' | 'failed';
  dataVersion: string;
  remoteUrl: string | null;
  added: number;
  modified: number;
  deleted: number;
  conflictCount: number;
  message: string | null;
  createdAt: number;
}

export interface OperationLogEntry {
  id: string;
  type: string;
  actor: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  createdAt: number;
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

/** 建库 DDL，按表拆分便于按表阅读；全部 IF NOT EXISTS，幂等。 */
const SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        requirement_count INTEGER NOT NULL,
        payload_gzip BLOB NOT NULL,
        payload_sha256 TEXT NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS requirement_comments (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        parent_id TEXT,
        section_key TEXT NOT NULL,
        author TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_comments_requirement ON requirement_comments(requirement_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS requirement_revisions (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        revision_no INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,
        author TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(requirement_id, revision_no)
      );`,
  `CREATE INDEX IF NOT EXISTS idx_revisions_requirement ON requirement_revisions(requirement_id, revision_no DESC);`,
  `CREATE TABLE IF NOT EXISTS ai_reviews (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_ai_reviews_requirement ON ai_reviews(requirement_id, created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS sync_history (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        data_version TEXT NOT NULL,
        remote_url TEXT,
        added INTEGER NOT NULL DEFAULT 0,
        modified INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        conflict_count INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        created_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_sync_history_project ON sync_history(project_id, created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS ai_proposals (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        requirement_id TEXT,
        payload_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_ai_proposals_project ON ai_proposals(project_id, created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS version_documents (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_version_documents_version ON version_documents(version_id, updated_at DESC);`,
  `CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_project ON ai_chat_messages(project_id, created_at);`,
  `CREATE TABLE IF NOT EXISTS operation_logs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
  `CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at DESC);`,
];

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_DDL.join('\n'));
    const migration = this.db.prepare('SELECT version FROM schema_migrations WHERE version = 1').get();
    if (!migration) {
      this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(Date.now());
    }
    const state = this.db.prepare('SELECT id FROM app_state WHERE id = 1').get();
    if (!state) {
      this.db.prepare('INSERT INTO app_state(id, revision, data_json, updated_at) VALUES(1, 0, ?, ?)')
        .run(JSON.stringify(EMPTY_DATA), Date.now());
    }
  }

  load(): { data: AppData; revision: number } {
    const row = this.db.prepare('SELECT revision, data_json FROM app_state WHERE id = 1').get() as { revision: number; data_json: string };
    const parsed = appDataSchema.parse(JSON.parse(row.data_json)) as AppData;
    return { data: parsed, revision: row.revision };
  }

  replace(data: AppData, expectedRevision?: number): number {
    const validated = appDataSchema.parse(data) as AppData;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT revision FROM app_state WHERE id = 1').get() as { revision: number };
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        const error = new Error(`数据已被其他页面更新；当前版本为 ${current.revision}`);
        (error as Error & { code?: string }).code = 'REVISION_CONFLICT';
        throw error;
      }
      const next = current.revision + 1;
      this.db.prepare('UPDATE app_state SET revision = ?, data_json = ?, updated_at = ? WHERE id = 1')
        .run(next, JSON.stringify(validated), Date.now());
      this.db.exec('COMMIT');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * 服务端批量回写需求的 jiraKey（Jira 同步用）。不走前端 PUT /state 的乐观锁，而是直接
   * load -> patch -> replace；遇到 REVISION_CONFLICT 自动重试（最多 5 次），因为同步过程中
   * 用户可能在网页里同时编辑数据。jiraKey 传 null 表示清除标记。返回写入后的 revision。
   */
  setRequirementsJiraKeys(updates: Array<{ id: string; jiraKey: string | null; syncedAt?: number }>): number {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data, revision } = this.load();
      const map = new Map(updates.map((u) => [u.id, u]));
      let changed = false;
      for (const r of data.requirements) {
        const u = map.get(r.id);
        if (!u) continue;
        const syncedAt = u.syncedAt ?? Date.now();
        if (u.jiraKey === null) {
          if (r.jiraKey !== undefined || r.jiraSyncedAt !== undefined) {
            delete r.jiraKey; delete r.jiraSyncedAt; changed = true;
          }
        } else if (r.jiraKey !== u.jiraKey || r.jiraSyncedAt !== syncedAt) {
          r.jiraKey = u.jiraKey; r.jiraSyncedAt = syncedAt; changed = true;
        }
      }
      if (!changed) return revision;
      try {
        return this.replace(data, revision);
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code === 'REVISION_CONFLICT' && attempt < 4) continue;
        throw err;
      }
    }
    throw new Error('同步回写 jiraKey 失败：多次重试仍遇到版本冲突，请稍后重试');
  }

  exportEnvelope(): Record<string, unknown> {
    return {
      documentType: 'requirement-pool-backup',
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      state: this.load().data,
      comments: this.db.prepare('SELECT * FROM requirement_comments ORDER BY created_at').all(),
      revisions: this.db.prepare('SELECT * FROM requirement_revisions ORDER BY created_at').all(),
      aiReviews: this.db.prepare('SELECT * FROM ai_reviews ORDER BY created_at').all(),
      versionDocuments: this.db.prepare('SELECT * FROM version_documents ORDER BY created_at').all(),
      operationLogs: this.db.prepare('SELECT * FROM operation_logs ORDER BY created_at').all(),
      metadata: this.db.prepare('SELECT * FROM metadata').all(),
    };
  }

  importEnvelope(input: Record<string, unknown>): number {
    const isEnvelope = input.documentType === 'requirement-pool-backup' && input.state;
    const state = appDataSchema.parse(isEnvelope ? input.state : input) as AppData;
    this.createSnapshot('JSON 导入前');
    const revision = this.replace(state);
    if (isEnvelope) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM requirement_comments; DELETE FROM requirement_revisions; DELETE FROM ai_reviews; DELETE FROM version_documents; DELETE FROM operation_logs;');
        const commentStmt = this.db.prepare(`INSERT INTO requirement_comments(id,requirement_id,parent_id,section_key,author,role,content,resolved,created_at,updated_at) VALUES(@id,@requirement_id,@parent_id,@section_key,@author,@role,@content,@resolved,@created_at,@updated_at)`);
        for (const row of Array.isArray(input.comments) ? input.comments : []) commentStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const revisionStmt = this.db.prepare(`INSERT INTO requirement_revisions(id,requirement_id,revision_no,payload_json,changed_fields_json,author,reason,created_at) VALUES(@id,@requirement_id,@revision_no,@payload_json,@changed_fields_json,@author,@reason,@created_at)`);
        for (const row of Array.isArray(input.revisions) ? input.revisions : []) revisionStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const reviewStmt = this.db.prepare(`INSERT INTO ai_reviews(id,requirement_id,content,status,created_at,updated_at) VALUES(@id,@requirement_id,@content,@status,@created_at,@updated_at)`);
        for (const row of Array.isArray(input.aiReviews) ? input.aiReviews : []) reviewStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const docStmt = this.db.prepare(`INSERT INTO version_documents(id,version_id,title,kind,content,created_at,updated_at) VALUES(@id,@version_id,@title,@kind,@content,@created_at,@updated_at)`);
        for (const row of Array.isArray(input.versionDocuments) ? input.versionDocuments : []) docStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const logStmt = this.db.prepare(`INSERT INTO operation_logs(id,type,actor,target_type,target_id,summary,created_at) VALUES(@id,@type,@actor,@target_type,@target_id,@summary,@created_at)`);
        for (const row of Array.isArray(input.operationLogs) ? input.operationLogs : []) logStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    return revision;
  }

  createSnapshot(reason: string): SnapshotInfo {
    const { data } = this.load();
    const json = Buffer.from(JSON.stringify(data), 'utf8');
    const payload = gzipSync(json);
    const info: SnapshotInfo = {
      id: randomUUID(),
      createdAt: Date.now(),
      reason,
      requirementCount: data.requirements.length,
    };
    const hash = createHash('sha256').update(payload).digest('hex');
    this.db.prepare(`INSERT INTO snapshots(id, created_at, reason, requirement_count, payload_gzip, payload_sha256)
      VALUES(?, ?, ?, ?, ?, ?)`).run(info.id, info.createdAt, info.reason, info.requirementCount, payload, hash);
    this.trimSnapshots(this.snapshotLimit(data));
    return info;
  }

  listSnapshots(): SnapshotInfo[] {
    return this.db.prepare(`SELECT id, created_at AS createdAt, reason, requirement_count AS requirementCount
      FROM snapshots ORDER BY created_at DESC`).all() as unknown as SnapshotInfo[];
  }

  restoreSnapshot(id: string): number {
    const row = this.db.prepare('SELECT payload_gzip, payload_sha256 FROM snapshots WHERE id = ?').get(id) as
      | { payload_gzip: Buffer; payload_sha256: string }
      | undefined;
    if (!row) {
      throw codedError('NOT_FOUND', '快照不存在');
    }
    const actual = createHash('sha256').update(row.payload_gzip).digest('hex');
    if (actual !== row.payload_sha256) throw new Error('快照校验失败');
    const target = appDataSchema.parse(JSON.parse(gunzipSync(row.payload_gzip).toString('utf8'))) as AppData;
    const current = this.load();
    const mergedCounters = { ...target.seqCounters };
    for (const [key, value] of Object.entries(current.data.seqCounters ?? {})) {
      mergedCounters[key] = Math.max(mergedCounters[key] ?? 0, value);
    }
    target.seqCounters = mergedCounters;
    this.createSnapshot('恢复前自动留档');
    return this.replace(target);
  }

  listComments(requirementId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT id, requirement_id AS requirementId, parent_id AS parentId,
      section_key AS sectionKey, author, role, content, resolved, created_at AS createdAt, updated_at AS updatedAt
      FROM requirement_comments WHERE requirement_id = ? ORDER BY created_at ASC`).all(requirementId) as Array<Record<string, unknown>>;
  }

  addComment(input: { requirementId: string; parentId?: string | null; sectionKey: string; author: string; role: string; content: string }): Record<string, unknown> {
    const now = Date.now();
    const comment = { id: randomUUID(), ...input, parentId: input.parentId ?? null, resolved: 0, createdAt: now, updatedAt: now };
    this.db.prepare(`INSERT INTO requirement_comments(id, requirement_id, parent_id, section_key, author, role, content, resolved, created_at, updated_at)
      VALUES(@id,@requirementId,@parentId,@sectionKey,@author,@role,@content,@resolved,@createdAt,@updatedAt)`).run(comment as Record<string, string | number | bigint | null | Uint8Array>);
    return comment;
  }

  setCommentResolved(id: string, resolved: boolean): void {
    const result = this.db.prepare('UPDATE requirement_comments SET resolved = ?, updated_at = ? WHERE id = ?').run(resolved ? 1 : 0, Date.now(), id);
    if (result.changes === 0) throw codedError('NOT_FOUND', '批注不存在');
  }

  captureRequirementRevision(requirementId: string, payload: Record<string, unknown>, author: string, reason: string): Record<string, unknown> {
    const previous = this.db.prepare('SELECT payload_json FROM requirement_revisions WHERE requirement_id = ? ORDER BY revision_no DESC LIMIT 1').get(requirementId) as { payload_json: string } | undefined;
    const before = previous ? JSON.parse(previous.payload_json) as Record<string, unknown> : {};
    const keys = new Set([...Object.keys(before), ...Object.keys(payload)]);
    const changedFields = Array.from(keys).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(payload[key]));
    const nextNo = (this.db.prepare('SELECT COALESCE(MAX(revision_no),0)+1 AS n FROM requirement_revisions WHERE requirement_id = ?').get(requirementId) as { n: number }).n;
    const revision = { id: randomUUID(), requirementId, revisionNo: nextNo, payload, changedFields, author, reason, createdAt: Date.now() };
    this.db.prepare(`INSERT INTO requirement_revisions(id, requirement_id, revision_no, payload_json, changed_fields_json, author, reason, created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(revision.id, requirementId, nextNo, JSON.stringify(payload), JSON.stringify(changedFields), author, reason, revision.createdAt);
    return revision;
  }

  listRequirementRevisions(requirementId: string): Array<Record<string, unknown>> {
    const rows = this.db.prepare(`SELECT id, requirement_id AS requirementId, revision_no AS revisionNo, payload_json AS payloadJson,
      changed_fields_json AS changedFieldsJson, author, reason, created_at AS createdAt
      FROM requirement_revisions WHERE requirement_id = ? ORDER BY revision_no DESC`).all(requirementId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(String(row.payloadJson)), changedFields: JSON.parse(String(row.changedFieldsJson)), payloadJson: undefined, changedFieldsJson: undefined }));
  }

  listAiReviews(requirementId: string): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT id, requirement_id AS requirementId, content, status, created_at AS createdAt, updated_at AS updatedAt
      FROM ai_reviews WHERE requirement_id = ? ORDER BY created_at DESC`).all(requirementId) as Array<Record<string, unknown>>;
  }

  addAiReview(requirementId: string, content: string): Record<string, unknown> {
    const review = { id: randomUUID(), requirementId, content, status: '待处理', createdAt: Date.now(), updatedAt: Date.now() };
    this.db.prepare(`INSERT INTO ai_reviews(id, requirement_id, content, status, created_at, updated_at) VALUES(@id,@requirementId,@content,@status,@createdAt,@updatedAt)`).run(review);
    return review;
  }

  updateAiReviewStatus(id: string, status: string): void {
    const result = this.db.prepare('UPDATE ai_reviews SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
    if (result.changes === 0) throw codedError('NOT_FOUND', '评审记录不存在');
  }

  /* ========== AI 提案（v0.2.1）========== */

  createProposal(input: { projectId: string; kind: AiProposal['kind']; requirementId?: string | null; payload: Record<string, unknown>; summary: string }): AiProposal {
    const proposal: AiProposal = {
      id: randomUUID(), projectId: input.projectId, kind: input.kind,
      requirementId: input.requirementId ?? null, payload: input.payload,
      summary: input.summary.slice(0, 300), status: 'pending', createdAt: Date.now(),
    };
    this.db.prepare(`INSERT INTO ai_proposals(id, project_id, kind, requirement_id, payload_json, summary, status, created_at)
      VALUES(@id,@projectId,@kind,@requirementId,@payloadJson,@summary,@status,@createdAt)`)
      .run({
        id: proposal.id, projectId: proposal.projectId, kind: proposal.kind, requirementId: proposal.requirementId,
        payloadJson: JSON.stringify(proposal.payload), summary: proposal.summary, status: proposal.status, createdAt: proposal.createdAt,
      });
    return proposal;
  }

  listProposals(projectId: string, status?: AiProposal['status']): AiProposal[] {
    const rows = (status
      ? this.db.prepare(`SELECT id, project_id AS projectId, kind, requirement_id AS requirementId, payload_json AS payloadJson, summary, status, created_at AS createdAt
          FROM ai_proposals WHERE project_id = ? AND status = ? ORDER BY created_at DESC`).all(projectId, status)
      : this.db.prepare(`SELECT id, project_id AS projectId, kind, requirement_id AS requirementId, payload_json AS payloadJson, summary, status, created_at AS createdAt
          FROM ai_proposals WHERE project_id = ? ORDER BY created_at DESC`).all(projectId)) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(String(row.payloadJson)), payloadJson: undefined }) as unknown as AiProposal);
  }

  setProposalStatus(id: string, status: AiProposal['status']): void {
    const result = this.db.prepare('UPDATE ai_proposals SET status = ? WHERE id = ?').run(status, id);
    if (result.changes === 0) throw codedError('NOT_FOUND', '提案不存在');
  }

  /* ========== 版本文档：技术规格书/PRD（v0.2.1+，参与项目同步）========== */

  createVersionDocument(input: { versionId: string; title: string; kind?: VersionDocument['kind']; content: string }): VersionDocument {
    const now = Date.now();
    const kind = input.kind ?? 'other';
    const doc: VersionDocument = {
      id: randomUUID(), versionId: input.versionId, title: input.title.slice(0, 200),
      kind, content: input.content.slice(0, versionDocumentMaxChars(kind)),
      createdAt: now, updatedAt: now,
    };
    this.db.prepare(`INSERT INTO version_documents(id, version_id, title, kind, content, created_at, updated_at)
      VALUES(@id,@versionId,@title,@kind,@content,@createdAt,@updatedAt)`).run({ ...doc });
    return doc;
  }

  listVersionDocuments(versionId: string): VersionDocument[] {
    const rows = this.db.prepare(`SELECT id, version_id AS versionId, title, kind, content, created_at AS createdAt, updated_at AS updatedAt
      FROM version_documents WHERE version_id = ? ORDER BY updated_at DESC`).all(versionId) as unknown as VersionDocument[];
    return rows;
  }

  getVersionDocument(id: string): VersionDocument | null {
    const row = this.db.prepare(`SELECT id, version_id AS versionId, title, kind, content, created_at AS createdAt, updated_at AS updatedAt
      FROM version_documents WHERE id = ?`).get(id) as unknown as VersionDocument | undefined;
    return row ?? null;
  }

  updateVersionDocument(id: string, input: { title?: string; kind?: VersionDocument['kind']; content?: string }): VersionDocument {
    const existing = this.getVersionDocument(id);
    if (!existing) throw codedError('NOT_FOUND', '文档不存在');
    const kind = input.kind ?? existing.kind;
    const updated: VersionDocument = {
      ...existing,
      title: input.title !== undefined ? input.title.slice(0, 200) : existing.title,
      kind,
      content: input.content !== undefined ? input.content.slice(0, versionDocumentMaxChars(kind)) : existing.content,
      updatedAt: Date.now(),
    };
    this.db.prepare('UPDATE version_documents SET title = @title, kind = @kind, content = @content, updated_at = @updatedAt WHERE id = @id')
      .run({ title: updated.title, kind: updated.kind, content: updated.content, updatedAt: updated.updatedAt, id: updated.id });
    return updated;
  }

  deleteVersionDocument(id: string): void {
    const result = this.db.prepare('DELETE FROM version_documents WHERE id = ?').run(id);
    if (result.changes === 0) throw codedError('NOT_FOUND', '文档不存在');
  }

  /* ========== 版本文档：项目级查询与同步合并（v0.2.2）========== */

  /** 列出某项目下所有版本关联的文档（同步导出 + 卡片计数用）。 */
  listVersionDocumentsByProject(projectId: string): VersionDocument[] {
    const { data } = this.load();
    const versionIds = data.versions.filter((v) => v.projectId === projectId).map((v) => v.id);
    if (versionIds.length === 0) return [];
    const placeholders = versionIds.map(() => '?').join(',');
    return this.db.prepare(`SELECT id, version_id AS versionId, title, kind, content, created_at AS createdAt, updated_at AS updatedAt
      FROM version_documents WHERE version_id IN (${placeholders}) ORDER BY updated_at DESC`).all(...versionIds) as unknown as VersionDocument[];
  }

  /** 各版本文档计数（版本卡片入口用），只返回该项目下有文档的 versionId -> count。 */
  versionDocumentCounts(projectId: string): Record<string, number> {
    const { data } = this.load();
    const versionIds = data.versions.filter((v) => v.projectId === projectId).map((v) => v.id);
    if (versionIds.length === 0) return {};
    const placeholders = versionIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT version_id AS versionId, COUNT(*) AS c FROM version_documents WHERE version_id IN (${placeholders}) GROUP BY version_id`).all(...versionIds) as Array<{ versionId: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.versionId] = r.c;
    return out;
  }

  /** 同步合并时按 id upsert 单条文档（新增或覆盖，不改其他文档）。 */
  upsertVersionDocument(doc: VersionDocument): void {
    this.db.prepare(`INSERT INTO version_documents(id, version_id, title, kind, content, created_at, updated_at)
      VALUES(@id,@versionId,@title,@kind,@content,@createdAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET version_id=excluded.version_id, title=excluded.title, kind=excluded.kind, content=excluded.content, updated_at=excluded.updated_at`)
      .run(doc as unknown as Record<string, string | number | bigint | null | Uint8Array>);
  }

  /**
   * 文档合并核心（与 computeMergePlan 同构）：按 id 决定新增/更新/冲突。
   * mode 'overwrite' -> incoming 永远胜出（远端推给我们，或预览推送）；
   * mode 'preferNewer' -> updatedAt 更大者胜，平手记为冲突并保留 baseline。
   * 返回 docMap 仅用于预览统计；实际持久化由 mergeIncomingProject 按 items 的 add/modify 决定。
   */
  private computeDocumentMergePlan(
    baselineDocs: VersionDocument[],
    incomingDocs: VersionDocument[],
    mode: 'overwrite' | 'preferNewer',
    exportedAt: number,
  ): { added: number; modified: number; conflicts: Array<{ id: string; kind: 'document' }>; items: SyncDiffItem[]; docMap: Map<string, VersionDocument> } {
    const conflicts: Array<{ id: string; kind: 'document' }> = [];
    const items: SyncDiffItem[] = [];
    const docMap = new Map(baselineDocs.map((d) => [d.id, d]));
    let added = 0;
    let modified = 0;
    for (const inc of incomingDocs) {
      const existing = docMap.get(inc.id);
      if (!existing) {
        docMap.set(inc.id, inc);
        added += 1;
        items.push({ id: inc.id, kind: 'document', name: inc.title, action: 'add' });
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(inc)) continue;
      if (mode === 'overwrite') {
        docMap.set(inc.id, inc);
        modified += 1;
        items.push({ id: inc.id, kind: 'document', name: inc.title, action: 'modify' });
        continue;
      }
      const existingTs = Number(existing.updatedAt ?? 0);
      const incomingTs = Number(inc.updatedAt ?? exportedAt ?? 0);
      if (incomingTs > existingTs) {
        docMap.set(inc.id, inc);
        modified += 1;
        items.push({ id: inc.id, kind: 'document', name: inc.title, action: 'modify' });
      } else {
        conflicts.push({ id: inc.id, kind: 'document' });
        items.push({ id: inc.id, kind: 'document', name: inc.title, action: 'conflict' });
      }
    }
    return { added, modified, conflicts, items, docMap };
  }


  /* ========== AI 工作台对话历史（v0.2.1，本地专属）========== */

  addChatMessage(input: { projectId: string; sessionId: string | null; role: ChatMessage['role']; content: string }): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, role: input.role, content: input.content.slice(0, 30_000), createdAt: Date.now() };
    this.db.prepare(`INSERT INTO ai_chat_messages(id, project_id, session_id, role, content, created_at)
      VALUES(@id,@projectId,@sessionId,@role,@content,@createdAt)`).run({ ...msg });
    return msg;
  }

  listChatMessages(projectId: string, limit = 300): ChatMessage[] {
    const rows = this.db.prepare(`SELECT id, project_id AS projectId, session_id AS sessionId, role, content, created_at AS createdAt
      FROM ai_chat_messages WHERE project_id = ? ORDER BY created_at ASC LIMIT ?`).all(projectId, limit) as unknown as ChatMessage[];
    return rows;
  }

  clearChatMessages(projectId: string): void {
    this.db.prepare('DELETE FROM ai_chat_messages WHERE project_id = ?').run(projectId);
  }

  getLastChatSessionId(projectId: string): string | null {
    const row = this.db.prepare(`SELECT session_id AS sessionId FROM ai_chat_messages
      WHERE project_id = ? AND session_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`).get(projectId) as { sessionId: string } | undefined;
    return row?.sessionId ?? null;
  }

  getMetadata<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM metadata WHERE key = ?').get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : fallback;
  }

  setMetadata(key: string, value: unknown): void {
    this.db.prepare(`INSERT INTO metadata(key, value_json, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(value), Date.now());
  }

  recordOperation(input: { type: string; actor: string; targetType: string; targetId?: string | null; summary: string }): OperationLogEntry {
    const entry: OperationLogEntry = {
      id: randomUUID(),
      type: input.type.slice(0, 80),
      actor: input.actor.slice(0, 80),
      targetType: input.targetType.slice(0, 80),
      targetId: input.targetId ? input.targetId.slice(0, 150) : null,
      summary: input.summary.slice(0, 500),
      createdAt: Date.now(),
    };
    this.db.prepare(`INSERT INTO operation_logs(id, type, actor, target_type, target_id, summary, created_at)
      VALUES(@id,@type,@actor,@targetType,@targetId,@summary,@createdAt)`).run(entry as unknown as Record<string, string | number | bigint | null | Uint8Array>);
    return entry;
  }

  listOperationLogs(limit = 50): OperationLogEntry[] {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.db.prepare(`SELECT id, type, actor, target_type AS targetType, target_id AS targetId, summary, created_at AS createdAt
      FROM operation_logs ORDER BY created_at DESC LIMIT ?`).all(safeLimit) as unknown as OperationLogEntry[];
  }

  /* ========== Cloud Sync (v0.2.0) ========== */

  /** Export a single project's slice of data (project meta + versions + requirements + version documents) with a content hash. */
  exportProjectPayload(projectId: string): ProjectSyncPayload {
    const { data } = this.load();
    const project = data.projects.find((p) => p.id === projectId) ?? null;
    const versions = data.versions.filter((v) => v.projectId === projectId);
    const requirements = data.requirements.filter((r) => r.projectId === projectId);
    const documents = this.listVersionDocumentsByProject(projectId);
    const dataVersion = hashPayload({ versions, requirements, documents });
    return { projectId, project, versions, requirements, documents, dataVersion, exportedAt: Date.now() };
  }

  /** Lightweight version hash for a project, without shipping the full payload. */
  computeProjectVersion(projectId: string): { dataVersion: string; requirementCount: number; versionCount: number } {
    const payload = this.exportProjectPayload(projectId);
    return { dataVersion: payload.dataVersion, requirementCount: payload.requirements.length, versionCount: payload.versions.length };
  }

  /**
   * Pure comparison core shared by mergeIncomingProject (which persists) and the preview* methods
   * (which don't). Given a baseline set of requirements/versions and an incoming set, decides per
   * item whether it's a new add, a modify, or (in 'preferNewer' mode) a conflict — and returns both
   * the aggregate counts (SyncMergeResult) and a readable line-item list (SyncDiffItem[]) for UI preview.
   * mode 'overwrite'    -> incoming always wins (remote pushing to us; or previewing a push, where the
   *                        "baseline" passed in is the remote's data and "incoming" is our local data).
   * mode 'preferNewer'  -> the copy with the greater updatedAt/createdAt/exportedAt wins; ties keep
   *                        the baseline and are reported as conflicts.
   */
  private computeMergePlan(
    baselineRequirements: Requirement[],
    baselineVersions: Version[],
    incoming: { project?: Project | null; versions?: Version[]; requirements?: Requirement[]; exportedAt?: number },
    mode: 'overwrite' | 'preferNewer',
  ): SyncDiffPlan & { reqMap: Map<string, Requirement>; verMap: Map<string, Version> } {
    const result: SyncMergeResult = { added: 0, modified: 0, conflicts: [] };
    const items: SyncDiffItem[] = [];

    const reqMap = new Map(baselineRequirements.map((r) => [r.id, r]));
    for (const incomingReq of incoming.requirements ?? []) {
      const existing = reqMap.get(incomingReq.id);
      if (!existing) {
        reqMap.set(incomingReq.id, incomingReq);
        result.added += 1;
        items.push({ id: incomingReq.id, kind: 'requirement', name: incomingReq.name, action: 'add' });
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incomingReq)) continue;
      if (mode === 'overwrite') {
        reqMap.set(incomingReq.id, incomingReq);
        result.modified += 1;
        items.push({ id: incomingReq.id, kind: 'requirement', name: incomingReq.name, action: 'modify' });
        continue;
      }
      const existingTs = Number(existing.updatedAt ?? existing.createdAt ?? 0);
      const incomingTs = Number(incomingReq.updatedAt ?? incomingReq.createdAt ?? incoming.exportedAt ?? 0);
      if (incomingTs > existingTs) {
        reqMap.set(incomingReq.id, incomingReq);
        result.modified += 1;
        items.push({ id: incomingReq.id, kind: 'requirement', name: incomingReq.name, action: 'modify' });
      } else {
        result.conflicts.push({ id: incomingReq.id, kind: 'requirement' });
        items.push({ id: incomingReq.id, kind: 'requirement', name: incomingReq.name, action: 'conflict' });
      }
    }

    const verMap = new Map(baselineVersions.map((v) => [v.id, v]));
    for (const incomingVer of incoming.versions ?? []) {
      const existing = verMap.get(incomingVer.id);
      if (!existing) {
        verMap.set(incomingVer.id, incomingVer);
        items.push({ id: incomingVer.id, kind: 'version', name: incomingVer.name, action: 'add' });
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incomingVer)) continue;
      if (mode === 'overwrite') {
        verMap.set(incomingVer.id, incomingVer);
        items.push({ id: incomingVer.id, kind: 'version', name: incomingVer.name, action: 'modify' });
        continue;
      }
      const existingTs = Number((existing as Record<string, unknown>).updatedAt ?? 0);
      const incomingTs = Number((incomingVer as Record<string, unknown>).updatedAt ?? incoming.exportedAt ?? 0);
      if (incomingTs > existingTs) {
        verMap.set(incomingVer.id, incomingVer);
        items.push({ id: incomingVer.id, kind: 'version', name: incomingVer.name, action: 'modify' });
      } else {
        result.conflicts.push({ id: incomingVer.id, kind: 'version' });
        items.push({ id: incomingVer.id, kind: 'version', name: incomingVer.name, action: 'conflict' });
      }
    }

    return { result, items, reqMap, verMap };
  }

  /** Merge an incoming project payload (from a remote HubPooL instance) into the local database. Persists. */
  mergeIncomingProject(
    projectId: string,
    incoming: { project?: Project | null; versions?: Version[]; requirements?: Requirement[]; documents?: VersionDocument[]; exportedAt?: number },
    mode: 'overwrite' | 'preferNewer',
  ): SyncMergeResult {
    const { data } = this.load();
    const otherReqs = data.requirements.filter((r) => r.projectId !== projectId);
    const otherVersions = data.versions.filter((v) => v.projectId !== projectId);
    const localReqs = data.requirements.filter((r) => r.projectId === projectId);
    const localVers = data.versions.filter((v) => v.projectId === projectId);
    const plan = this.computeMergePlan(localReqs, localVers, incoming, mode);

    const projects = data.projects.slice();
    if (incoming.project && !projects.some((p) => p.id === projectId)) {
      projects.push(incoming.project);
    }

    const next: AppData = {
      ...data,
      projects,
      versions: [...otherVersions, ...Array.from(plan.verMap.values())],
      requirements: [...otherReqs, ...Array.from(plan.reqMap.values())],
    };
    this.replace(next);

    // v0.2.2: 合并版本文档（独立表，按 id upsert 新增/更新项；不删除本地仅有的文档，冲突中本地胜出的保留不动）。
    const localDocs = this.listVersionDocumentsByProject(projectId);
    const incomingDocs = incoming.documents ?? [];
    const docPlan = this.computeDocumentMergePlan(localDocs, incomingDocs, mode, incoming.exportedAt ?? Date.now());
    const incomingById = new Map(incomingDocs.map((d) => [d.id, d]));
    for (const item of docPlan.items) {
      if (item.action === 'add' || item.action === 'modify') {
        const d = incomingById.get(item.id);
        if (d) this.upsertVersionDocument(d);
      }
    }

    return {
      added: plan.result.added + docPlan.added,
      modified: plan.result.modified + docPlan.modified,
      conflicts: [...plan.result.conflicts, ...docPlan.conflicts],
    };
  }

  /** Read-only preview of a pull/merge: what would change locally if we merged this incoming (remote) data in. Never persists. */
  previewIncomingProject(
    projectId: string,
    incoming: { project?: Project | null; versions?: Version[]; requirements?: Requirement[]; documents?: VersionDocument[]; exportedAt?: number },
    mode: 'overwrite' | 'preferNewer',
  ): SyncDiffPlan {
    const { data } = this.load();
    const localReqs = data.requirements.filter((r) => r.projectId === projectId);
    const localVers = data.versions.filter((v) => v.projectId === projectId);
    const plan = this.computeMergePlan(localReqs, localVers, incoming, mode);
    const localDocs = this.listVersionDocumentsByProject(projectId);
    const docPlan = this.computeDocumentMergePlan(localDocs, incoming.documents ?? [], mode, incoming.exportedAt ?? Date.now());
    return {
      result: { added: plan.result.added + docPlan.added, modified: plan.result.modified + docPlan.modified, conflicts: [...plan.result.conflicts, ...docPlan.conflicts] },
      items: [...plan.items, ...docPlan.items],
    };
  }

  /** Read-only preview of a push: what would change on the remote if we pushed our local data to it. Never persists (and can't — the remote isn't us). */
  previewOutgoingProject(
    projectId: string,
    remoteBaseline: { versions?: Version[]; requirements?: Requirement[]; documents?: VersionDocument[] },
    mode: 'overwrite' | 'preferNewer',
  ): SyncDiffPlan {
    const { data } = this.load();
    const localReqs = data.requirements.filter((r) => r.projectId === projectId);
    const localVers = data.versions.filter((v) => v.projectId === projectId);
    const plan = this.computeMergePlan(
      remoteBaseline.requirements ?? [],
      remoteBaseline.versions ?? [],
      { requirements: localReqs, versions: localVers, exportedAt: Date.now() },
      mode,
    );
    const localDocs = this.listVersionDocumentsByProject(projectId);
    const docPlan = this.computeDocumentMergePlan(remoteBaseline.documents ?? [], localDocs, mode, Date.now());
    return {
      result: { added: plan.result.added + docPlan.added, modified: plan.result.modified + docPlan.modified, conflicts: [...plan.result.conflicts, ...docPlan.conflicts] },
      items: [...plan.items, ...docPlan.items],
    };
  }
  recordSyncEvent(event: {
    projectId: string;
    type: SyncHistoryEntry['type'];
    status: SyncHistoryEntry['status'];
    dataVersion: string;
    remoteUrl?: string | null;
    added?: number;
    modified?: number;
    deleted?: number;
    conflictCount?: number;
    message?: string | null;
  }): SyncHistoryEntry {
    const entry: SyncHistoryEntry = {
      id: randomUUID(),
      projectId: event.projectId,
      type: event.type,
      status: event.status,
      dataVersion: event.dataVersion,
      remoteUrl: event.remoteUrl ?? null,
      added: event.added ?? 0,
      modified: event.modified ?? 0,
      deleted: event.deleted ?? 0,
      conflictCount: event.conflictCount ?? 0,
      message: event.message ?? null,
      createdAt: Date.now(),
    };
    this.db.prepare(`INSERT INTO sync_history(id, project_id, type, status, data_version, remote_url, added, modified, deleted, conflict_count, message, created_at)
      VALUES(@id,@projectId,@type,@status,@dataVersion,@remoteUrl,@added,@modified,@deleted,@conflictCount,@message,@createdAt)`).run(entry as unknown as Record<string, string | number | bigint | null | Uint8Array>);
    return entry;
  }

  listSyncHistory(projectId: string, limit = 20): SyncHistoryEntry[] {
    const rows = this.db.prepare(`SELECT id, project_id AS projectId, type, status, data_version AS dataVersion,
      remote_url AS remoteUrl, added, modified, deleted, conflict_count AS conflictCount, message, created_at AS createdAt
      FROM sync_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, limit) as unknown as SyncHistoryEntry[];
    return rows;
  }

  getLastSyncEvent(projectId: string): SyncHistoryEntry | null {
    const rows = this.listSyncHistory(projectId, 1);
    return rows[0] ?? null;
  }

  private snapshotLimit(data: AppData): number {
    const raw = Number((data.settings?.collaboration as { snapshotLimit?: unknown } | undefined)?.snapshotLimit ?? 5);
    return Number.isInteger(raw) ? Math.max(1, Math.min(20, raw)) : 5;
  }

  private trimSnapshots(limit: number): void {
    this.db.prepare(`DELETE FROM snapshots WHERE id IN (
      SELECT id FROM snapshots ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )`).run(limit);
  }

  close(): void {
    this.db.close();
  }
}
