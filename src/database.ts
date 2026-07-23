import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { AppData, Project, Version, Requirement } from './types.js';
import { appDataSchema } from './schemas.js';

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
  dataVersion: string;
  exportedAt: number;
}

export interface SyncMergeResult {
  added: number;
  modified: number;
  conflicts: Array<{ id: string; kind: 'requirement' | 'version' }>;
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

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        reason TEXT NOT NULL,
        requirement_count INTEGER NOT NULL,
        payload_gzip BLOB NOT NULL,
        payload_sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requirement_comments (
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
      );
      CREATE INDEX IF NOT EXISTS idx_comments_requirement ON requirement_comments(requirement_id, created_at);
      CREATE TABLE IF NOT EXISTS requirement_revisions (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        revision_no INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        changed_fields_json TEXT NOT NULL,
        author TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(requirement_id, revision_no)
      );
      CREATE INDEX IF NOT EXISTS idx_revisions_requirement ON requirement_revisions(requirement_id, revision_no DESC);
      CREATE TABLE IF NOT EXISTS ai_reviews (
        id TEXT PRIMARY KEY,
        requirement_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_reviews_requirement ON ai_reviews(requirement_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS sync_history (
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
      );
      CREATE INDEX IF NOT EXISTS idx_sync_history_project ON sync_history(project_id, created_at DESC);
    `);
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
      const current = this.load();
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

  exportEnvelope(): Record<string, unknown> {
    return {
      documentType: 'requirement-pool-backup',
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      state: this.load().data,
      comments: this.db.prepare('SELECT * FROM requirement_comments ORDER BY created_at').all(),
      revisions: this.db.prepare('SELECT * FROM requirement_revisions ORDER BY created_at').all(),
      aiReviews: this.db.prepare('SELECT * FROM ai_reviews ORDER BY created_at').all(),
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
        this.db.exec('DELETE FROM requirement_comments; DELETE FROM requirement_revisions; DELETE FROM ai_reviews;');
        const commentStmt = this.db.prepare(`INSERT INTO requirement_comments(id,requirement_id,parent_id,section_key,author,role,content,resolved,created_at,updated_at) VALUES(@id,@requirement_id,@parent_id,@section_key,@author,@role,@content,@resolved,@created_at,@updated_at)`);
        for (const row of Array.isArray(input.comments) ? input.comments : []) commentStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const revisionStmt = this.db.prepare(`INSERT INTO requirement_revisions(id,requirement_id,revision_no,payload_json,changed_fields_json,author,reason,created_at) VALUES(@id,@requirement_id,@revision_no,@payload_json,@changed_fields_json,@author,@reason,@created_at)`);
        for (const row of Array.isArray(input.revisions) ? input.revisions : []) revisionStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
        const reviewStmt = this.db.prepare(`INSERT INTO ai_reviews(id,requirement_id,content,status,created_at,updated_at) VALUES(@id,@requirement_id,@content,@status,@created_at,@updated_at)`);
        for (const row of Array.isArray(input.aiReviews) ? input.aiReviews : []) reviewStmt.run(row as Record<string, string | number | bigint | null | Uint8Array>);
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
      const error = new Error('快照不存在');
      (error as Error & { code?: string }).code = 'NOT_FOUND';
      throw error;
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
    if (result.changes === 0) throw Object.assign(new Error('批注不存在'), { code: 'NOT_FOUND' });
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
    if (result.changes === 0) throw Object.assign(new Error('评审记录不存在'), { code: 'NOT_FOUND' });
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

  /* ========== Cloud Sync (v0.2.0) ========== */

  /** Export a single project's slice of data (project meta + versions + requirements) with a content hash. */
  exportProjectPayload(projectId: string): ProjectSyncPayload {
    const { data } = this.load();
    const project = data.projects.find((p) => p.id === projectId) ?? null;
    const versions = data.versions.filter((v) => v.projectId === projectId);
    const requirements = data.requirements.filter((r) => r.projectId === projectId);
    const dataVersion = hashPayload({ versions, requirements });
    return { projectId, project, versions, requirements, dataVersion, exportedAt: Date.now() };
  }

  /** Lightweight version hash for a project, without shipping the full payload. */
  computeProjectVersion(projectId: string): { dataVersion: string; requirementCount: number; versionCount: number } {
    const payload = this.exportProjectPayload(projectId);
    return { dataVersion: payload.dataVersion, requirementCount: payload.requirements.length, versionCount: payload.versions.length };
  }

  /**
   * Merge an incoming project payload (from a remote HubPooL instance) into the local database.
   * mode 'overwrite'    -> incoming always wins (used when a remote instance pushes data to us).
   * mode 'preferNewer'  -> the copy with the greater updatedAt/createdAt/exportedAt wins; ties keep local and are reported as conflicts.
   */
  mergeIncomingProject(
    projectId: string,
    incoming: { project?: Project | null; versions?: Version[]; requirements?: Requirement[]; exportedAt?: number },
    mode: 'overwrite' | 'preferNewer',
  ): SyncMergeResult {
    const { data } = this.load();
    const result: SyncMergeResult = { added: 0, modified: 0, conflicts: [] };

    // --- Requirements ---
    const otherReqs = data.requirements.filter((r) => r.projectId !== projectId);
    const localReqById = new Map(data.requirements.filter((r) => r.projectId === projectId).map((r) => [r.id, r]));
    for (const incomingReq of incoming.requirements ?? []) {
      const existing = localReqById.get(incomingReq.id);
      if (!existing) {
        localReqById.set(incomingReq.id, incomingReq);
        result.added += 1;
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incomingReq)) continue;
      if (mode === 'overwrite') {
        localReqById.set(incomingReq.id, incomingReq);
        result.modified += 1;
        continue;
      }
      const existingTs = Number(existing.updatedAt ?? existing.createdAt ?? 0);
      const incomingTs = Number(incomingReq.updatedAt ?? incomingReq.createdAt ?? incoming.exportedAt ?? 0);
      if (incomingTs > existingTs) {
        localReqById.set(incomingReq.id, incomingReq);
        result.modified += 1;
      } else {
        result.conflicts.push({ id: incomingReq.id, kind: 'requirement' });
      }
    }

    // --- Versions (simpler: same rules, no detailed conflict tracking beyond the list) ---
    const otherVersions = data.versions.filter((v) => v.projectId !== projectId);
    const localVerById = new Map(data.versions.filter((v) => v.projectId === projectId).map((v) => [v.id, v]));
    for (const incomingVer of incoming.versions ?? []) {
      const existing = localVerById.get(incomingVer.id);
      if (!existing) {
        localVerById.set(incomingVer.id, incomingVer);
        continue;
      }
      if (JSON.stringify(existing) === JSON.stringify(incomingVer)) continue;
      if (mode === 'overwrite') {
        localVerById.set(incomingVer.id, incomingVer);
        continue;
      }
      const existingTs = Number((existing as Record<string, unknown>).updatedAt ?? 0);
      const incomingTs = Number((incomingVer as Record<string, unknown>).updatedAt ?? incoming.exportedAt ?? 0);
      if (incomingTs > existingTs) localVerById.set(incomingVer.id, incomingVer);
      else result.conflicts.push({ id: incomingVer.id, kind: 'version' });
    }

    // --- Project metadata: only adopt incoming project meta if we don't have one locally yet ---
    const projects = data.projects.slice();
    if (incoming.project && !projects.some((p) => p.id === projectId)) {
      projects.push(incoming.project);
    }

    const next: AppData = {
      ...data,
      projects,
      versions: [...otherVersions, ...Array.from(localVerById.values())],
      requirements: [...otherReqs, ...Array.from(localReqById.values())],
    };
    this.replace(next);
    return result;
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
