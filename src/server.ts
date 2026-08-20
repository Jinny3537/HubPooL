import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { AppDatabase, versionDocumentMaxChars } from './database.js';
import { codedError, isCodedError, codedErrorStatus } from './errors.js';
import { appDataSchema, operationLogCreateSchema, replaceStateSchema, snapshotCreateSchema } from './schemas.js';
import type { RuntimeConfig, JiraSyncConfig } from './types.js';
import { SoftwareUpdater } from './updater.js';
import { AGENT_REGISTRY, CLAUDE_MODEL_ALIASES, DEFAULT_EXEC_TEMPLATE, detectAgent, findAgent, runAgentPrompt, runClaudeCodeWithMcp, type ClaudeModelAlias } from './localAgents.js';
import { createHubPoolMcpServer } from './mcpServer.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { assertLoopbackForStdio } from './mcpClient.js';
import { executeVersionSync, executeRequirementSync, previewVersionSync, loadPlatformData, readProjectJiraConfig, type PlatformSelection } from './jiraSync.js';

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** Best-effort primary LAN IPv4 address, for display in Settings → 网络配置. */
function primaryLanAddress(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function normalizeRemoteAddress(ip: string): string {
  const raw = String(ip || '').trim();
  if (raw.startsWith('::ffff:')) return raw.slice('::ffff:'.length);
  return raw;
}

/** 127.0.0.1 / ::1 / IPv4-mapped ::ffff:127.0.0.1 — used to gate 本机维护接口。 */
function isLoopbackAddr(ip: string): boolean {
  const normalized = normalizeRemoteAddress(ip);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export async function createServer(config: RuntimeConfig, database: AppDatabase): Promise<{ app: FastifyInstance }> {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024, trustProxy: false });
  const lanMode = !isLoopback(config.host);
  const updater = new SoftwareUpdater(config);

  // 任务同步是全项目通用能力：若旧数据仍只有 project.jiraSync，则启动时取第一份
  // 旧项目配置升为 settings.taskSync.config。旧字段保留作兼容读取，不再主动写入。
  try {
    const { data, revision } = database.load();
    const g = data.settings?.taskSync?.config;
    if (!g || typeof g !== 'object' || g.enabled === undefined) {
      const legacy = data.projects.find((p) => p.jiraSync && p.jiraSync.enabled !== undefined)?.jiraSync;
      if (legacy) {
        data.settings = { ...(data.settings ?? {}), taskSync: { ...(data.settings?.taskSync ?? {}), config: legacy as JiraSyncConfig } };
        database.replace(data, revision);
        app.log.info('已把旧项目任务同步配置迁移为全局任务同步配置');
      }
    }
  } catch (err) {
    app.log.warn({ err }, '任务同步配置迁移失败（忽略，继续启动）');
  }

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // 统一错误响应：coded error 按 codedErrorStatus 映射 HTTP 码；非 coded -> 500 INTERNAL_ERROR。
  // 路由内只需 throw codedError(...)，或对带兜底码的同步流调用 sendCodedError。
  function sendCodedError(reply: FastifyReply, err: unknown, fallbackCode: string, fallbackMessage: string): void {
    const code = isCodedError(err) ? err.code : fallbackCode;
    const message = err instanceof Error && err.message ? err.message : fallbackMessage;
    reply.code(codedErrorStatus(code)).send({ error: { code, message } });
  }
  app.setErrorHandler((err, _request, reply) => {
    const code = isCodedError(err) ? err.code : 'INTERNAL_ERROR';
    const message = err instanceof Error && err.message ? err.message : '内部错误';
    reply.code(codedErrorStatus(code)).send({ error: { code, message } });
  });

  function currentActor(): string {
    const { data } = database.load();
    const name = String(data.settings?.collaboration?.currentUserName ?? '').trim();
    return name || '本地用户';
  }

  function recordOperation(type: string, targetType: string, targetId: string | null, summary: string, actor = currentActor()): void {
    database.recordOperation({ type, actor, targetType, targetId, summary });
  }

  // 令牌登录已取消：局域网访问不再需要访问令牌。写入本机数据、启动本机进程或执行高风险维护的接口统一限制为 127.0.0.1。
  interface VisitorEntry {
    id: string;
    name: string;
    role: string;
    ip: string;
    isLocalRequest: boolean;
    userAgent: string;
    firstSeen: number;
    lastSeen: number;
    requestCount: number;
  }
  const visitors = new Map<string, VisitorEntry>();
  const visitorRetentionMs = 10 * 60 * 1000;
  function currentRole(): string {
    const { data } = database.load();
    const role = String(data.settings?.collaboration?.currentUserRole ?? '').trim();
    return role || '游客';
  }
  function recordVisitor(request: FastifyRequest): void {
    const now = Date.now();
    const ip = normalizeRemoteAddress(request.ip);
    const local = isLoopbackAddr(ip);
    const id = local ? 'local' : `lan:${ip}`;
    const existing = visitors.get(id);
    const entry: VisitorEntry = {
      id,
      name: local ? currentActor() : '局域网游客',
      role: local ? currentRole() : '游客',
      ip,
      isLocalRequest: local,
      userAgent: String(request.headers['user-agent'] ?? '').slice(0, 200),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      requestCount: (existing?.requestCount ?? 0) + 1,
    };
    visitors.set(id, entry);
    for (const [key, value] of visitors) {
      if (now - value.lastSeen > visitorRetentionMs) visitors.delete(key);
    }
  }
  app.addHook('onRequest', async (request) => {
    recordVisitor(request);
  });

  app.get('/api/v1/health', async () => ({ status: 'ok', version: '0.9.6', releaseStage: 'release-candidate', upgradeRange: '0.9.1-0.9.6' }));

  app.get<{ Querystring: { activeMs?: string } }>('/api/v1/visitors', { preHandler: loopbackOnly }, async (request) => {
    const activeMs = Math.min(10 * 60 * 1000, Math.max(30 * 1000, Number(request.query.activeMs ?? 120_000) || 120_000));
    const now = Date.now();
    return {
      activeMs,
      visitors: Array.from(visitors.values())
        .map((visitor) => ({ ...visitor, active: now - visitor.lastSeen <= activeMs }))
        .sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeen - a.lastSeen),
    };
  });

  app.get('/api/v1/runtime', async (request) => ({
    host: config.host,
    port: config.port,
    lanMode,
    dataDir: config.dataDir,
    lanAddress: primaryLanAddress(),
    isLocalRequest: isLoopbackAddr(request.ip),
    requesterIp: normalizeRemoteAddress(request.ip),
  }));

  app.get('/api/v1/bootstrap', async (request) => {
    const state = database.load();
    return {
      schemaVersion: 1,
      revision: state.revision,
      data: state.data,
      meta: {
        lastBackupAt: database.getMetadata<number>('lastBackupAt', 0),
        storage: 'sqlite',
        isLocalRequest: isLoopbackAddr(request.ip),
        requesterIp: normalizeRemoteAddress(request.ip),
      },
    };
  });

  app.put('/api/v1/state', { preHandler: loopbackOnly }, async (request, reply) => {
    const parsed = replaceStateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '数据格式不正确', details: parsed.error.issues } });
    return { revision: database.replace(parsed.data.data, parsed.data.expectedRevision) };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/v1/operation-logs', async (request) => ({
    logs: database.listOperationLogs(Number(request.query.limit ?? 50)),
  }));

  app.post('/api/v1/operation-logs', { preHandler: loopbackOnly }, async (request, reply) => {
    const parsed = operationLogCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '操作日志参数不正确', details: parsed.error.issues } });
    return database.recordOperation(parsed.data);
  });

  app.post('/api/v1/import/json', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const input = request.body as Record<string, unknown>;
      const revision = database.importEnvelope(input);
      const state = database.load().data;
      recordOperation('import_json', 'data', null, `导入 JSON 备份：${state.projects.length} 个项目 / ${state.requirements.length} 条需求`);
      return { revision, imported: { projects: state.projects.length, versions: state.versions.length, requirements: state.requirements.length } };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'IMPORT_VALIDATION_ERROR', message: '备份文件结构不正确' } });
    }
  });

  app.get('/api/v1/export/json', async (_request, reply) => {
    database.setMetadata('lastBackupAt', Date.now());
    recordOperation('export_json', 'data', null, '导出 JSON 备份');
    reply.header('Content-Disposition', 'attachment; filename="requirement-pool-backup.json"');
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(database.exportEnvelope(), null, 2);
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/comments', async (request) => ({ comments: database.listComments(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/comments', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const content = String(body?.content ?? '').trim();
    if (!content || content.length > 5000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '批注内容须为 1—5000 字' } });
    return database.addComment({ requirementId: request.params.id, parentId: body.parentId ? String(body.parentId) : null, sectionKey: String(body.sectionKey ?? 'general'), author: String(body.author ?? '本地用户').slice(0, 80), role: String(body.role ?? '产品').slice(0, 30), content });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/comments/:id', { preHandler: loopbackOnly }, async (request) => {
    const body = request.body as Record<string, unknown>;
    database.setCommentResolved(request.params.id, Boolean(body.resolved));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/revisions', async (request) => ({ revisions: database.listRequirementRevisions(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/revisions', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const payload = body?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '版本内容不正确' } });
    return database.captureRequirementRevision(request.params.id, payload as Record<string, unknown>, String(body.author ?? '本地用户').slice(0, 80), String(body.reason ?? '手动保存版本').slice(0, 200));
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/ai-reviews', async (request) => ({ reviews: database.listAiReviews(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/ai-reviews', { preHandler: loopbackOnly }, async (request, reply) => {
    const content = String((request.body as Record<string, unknown>)?.content ?? '').trim();
    if (!content || content.length > 30_000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'AI 评审内容须为 1—30000 字' } });
    return database.addAiReview(request.params.id, content);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/ai-reviews/:id', { preHandler: loopbackOnly }, async (request, reply) => {
    const status = String((request.body as Record<string, unknown>)?.status ?? '');
    if (!['待处理', '已采纳', '已驳回', '已解决'].includes(status)) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '评审状态不正确' } });
    database.updateAiReviewStatus(request.params.id, status);
    return { ok: true };
  });

  /* ========== 版本文档：技术规格书/PRD（v0.2.1+，参与 P2P 同步）========== */
  app.get<{ Params: { versionId: string } }>('/api/v1/versions/:versionId/documents', async (request) => ({
    documents: database.listVersionDocuments(request.params.versionId),
  }));
  app.post<{ Params: { versionId: string } }>('/api/v1/versions/:versionId/documents', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const title = String(body?.title ?? '').trim();
    const content = String(body?.content ?? '');
    const kind = ['spec', 'prd', 'other', 'prototype'].includes(String(body?.kind)) ? (body.kind as 'spec' | 'prd' | 'other' | 'prototype') : 'other';
    if (!title || title.length > 200) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '文档标题须为 1—200 字' } });
    const maxChars = versionDocumentMaxChars(kind);
    if (!content.trim() || content.length > maxChars) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `文档内容须为 1—${maxChars} 字` } });
    return database.createVersionDocument({ versionId: request.params.versionId, title, kind, content });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/documents/:id', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (body?.title !== undefined && (!String(body.title).trim() || String(body.title).length > 200)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '文档标题须为 1—200 字' } });
    }
    const kind = body?.kind !== undefined && ['spec', 'prd', 'other', 'prototype'].includes(String(body.kind)) ? (body.kind as 'spec' | 'prd' | 'other' | 'prototype') : undefined;
    if (body?.content !== undefined) {
      const existing = database.getVersionDocument(request.params.id);
      if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '文档不存在' } });
      const maxChars = versionDocumentMaxChars(kind ?? existing.kind);
      if (!String(body.content).trim() || String(body.content).length > maxChars) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `文档内容须为 1—${maxChars} 字` } });
      }
    }
    return database.updateVersionDocument(request.params.id, {
      title: body?.title !== undefined ? String(body.title).trim() : undefined,
      kind,
      content: body?.content !== undefined ? String(body.content) : undefined,
    });
  });
  app.delete<{ Params: { id: string } }>('/api/v1/documents/:id', { preHandler: loopbackOnly }, async (request, reply) => {
    database.deleteVersionDocument(request.params.id);
    return { ok: true };
  });
  // v0.2.2: 版本卡片上的文档入口需要展示每个版本关联了多少文档，按项目一次取回，避免逐版本请求。
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/document-counts', async (request) => ({
    counts: database.versionDocumentCounts(request.params.projectId),
  }));
  // v0.2.10.8: 原型发布展示页按项目一次取回所有版本文档，避免逐版本请求。
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/documents', async (request) => ({
    documents: database.listVersionDocumentsByProject(request.params.projectId),
  }));

  /* ========== 任务同步（全局配置，按项目执行）==========
   * MCP 配置在「系统设置 -> 任务同步」里全局保存；所有项目共用同一份配置。
   * 列表行内「同步」单次同步时弹窗选择平台目标（项目/版本/冲刺/任务类型）。
   * 旧 /jira/* 路由（v0.2.3）与 v0.2.10 的全局 /task-sync/config 路由均已下线。
   * - /task-sync/load-platform：连 MCP 加载平台项目/版本(规划中+进行中)/冲刺。stdio 仅回环。
   * - /task-sync/preview：纯本地 dry-run，仅本机维护者可调，body 可带 platform。
   * - /task-sync/sync：逐条 create/update + 回写 jiraKey。stdio 仅回环，body 含 platform。
   * - /task-sync/sync-one：单条需求同步（列表行内一键同步，弹窗选 platform）。stdio 仅回环。
   */

  function parseJiraConfigFromBody(body: unknown): JiraSyncConfig {
    const b = (body ?? {}) as Record<string, unknown>;
    const cfg = (b.config ?? b) as Partial<JiraSyncConfig>;
    const priorityMapRaw = cfg.priorityMap && typeof cfg.priorityMap === 'object' ? (cfg.priorityMap as Record<string, unknown>) : {};
    const priorityMap: Record<string, number> = {};
    for (const [k, v] of Object.entries(priorityMapRaw)) {
      const n = Number(v);
      if (Number.isFinite(n)) priorityMap[String(k)] = n;
    }
    const defaultTaskType = typeof cfg.defaultTaskType === 'number' ? cfg.defaultTaskType : Number(cfg.defaultTaskType);
    return {
      enabled: Boolean(cfg.enabled),
      transport: cfg.transport === 'http' ? 'http' : 'stdio',
      command: String(cfg.command ?? ''),
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [String(k), String(v ?? '')])) : {},
      url: String(cfg.url ?? ''),
      headers: cfg.headers && typeof cfg.headers === 'object' ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [String(k), String(v ?? '')])) : {},
      defaultTaskType: Number.isFinite(defaultTaskType) ? defaultTaskType : 0,
      priorityMap,
    };
  }

  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/task-sync/load-platform', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = (request.body ?? {}) as { config?: unknown; platformProjectId?: string };
    const cfg = body.config ? parseJiraConfigFromBody(body) : readProjectJiraConfig(database, request.params.projectId);
    if (!cfg) return reply.code(400).send({ error: { code: 'JIRA_NOT_CONFIGURED', message: '未配置任务同步，请先在「系统设置 -> 任务同步」里配置' } });
    try {
      assertLoopbackForStdio(cfg, request.ip);
      const platformData = await loadPlatformData(cfg, body.platformProjectId);
      return { data: platformData };
    } catch (error) {
      return sendCodedError(reply, error, 'LOAD_PLATFORM_FAILED', '加载平台数据失败');
    }
  });

  app.post<{ Params: { projectId: string; versionId: string } }>('/api/v1/projects/:projectId/versions/:versionId/task-sync/preview', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { platform?: PlatformSelection };
      return { preview: previewVersionSync(database, request.params.projectId, request.params.versionId, body.platform) };
    } catch (error) {
      return sendCodedError(reply, error, 'PREVIEW_FAILED', '预览失败');
    }
  });

  app.post<{ Params: { projectId: string; versionId: string } }>('/api/v1/projects/:projectId/versions/:versionId/task-sync/sync', { preHandler: loopbackOnly }, async (request, reply) => {
    const cfg = readProjectJiraConfig(database, request.params.projectId);
    if (!cfg) return reply.code(400).send({ error: { code: 'JIRA_NOT_CONFIGURED', message: '未配置任务同步，请先在「系统设置 -> 任务同步」里配置' } });
    try {
      assertLoopbackForStdio(cfg, request.ip);
      const body = (request.body ?? {}) as { platform?: PlatformSelection; recreateRequirementIds?: unknown; reloadRequirementIds?: unknown };
      const recreateIds = Array.isArray(body.recreateRequirementIds) ? body.recreateRequirementIds.filter((x): x is string => typeof x === 'string') : undefined;
      const reloadIds = Array.isArray(body.reloadRequirementIds) ? body.reloadRequirementIds.filter((x): x is string => typeof x === 'string') : undefined;
      const result = await executeVersionSync(database, request.params.projectId, request.params.versionId, body.platform, recreateIds, reloadIds);
      const okCount = result.counts.created + result.counts.updated + result.counts.recreated + result.counts.skipped;
      recordOperation('task_sync_version', 'version', request.params.versionId, `同步版本需求到任务平台：成功 ${okCount} 条，失败 ${result.counts.failed} 条`);
      return { result };
    } catch (error) {
      return sendCodedError(reply, error, 'SYNC_FAILED', '同步失败');
    }
  });

  /* 单条需求同步（列表行内一键同步）：读全局任务同步配置 + body.platform（弹窗选择）。stdio 仅回环。 */
  app.post<{ Params: { projectId: string; requirementId: string } }>('/api/v1/projects/:projectId/requirements/:requirementId/task-sync/sync-one', { preHandler: loopbackOnly }, async (request, reply) => {
    const cfg = readProjectJiraConfig(database, request.params.projectId);
    if (!cfg) return reply.code(400).send({ error: { code: 'JIRA_NOT_CONFIGURED', message: '未配置任务同步，请先在「系统设置 -> 任务同步」里配置' } });
    try {
      assertLoopbackForStdio(cfg, request.ip);
      const body = (request.body ?? {}) as { platform?: PlatformSelection; recreate?: boolean; reload?: boolean };
      const result = await executeRequirementSync(database, request.params.projectId, request.params.requirementId, body.platform, body.recreate, body.reload);
      recordOperation('task_sync_requirement', 'requirement', request.params.requirementId, `同步单条需求到任务平台：失败 ${result.counts.failed} 条`);
      return { result };
    } catch (error) {
      return sendCodedError(reply, error, 'SYNC_FAILED', '同步失败');
    }
  });

  app.post('/api/v1/software/check-update', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      return await updater.check(String(body.repo ?? ''), String(body.currentVersion ?? '1.0.0'), Boolean(body.includePrerelease));
    } catch (error) { return reply.code(400).send({ error: { code: 'UPDATE_CHECK_FAILED', message: error instanceof Error ? error.message : '检测更新失败' } }); }
  });
  app.get('/api/v1/software/backups', { preHandler: loopbackOnly }, async () => ({ projectDir: config.projectDir, backups: await updater.listBackups() }));
  app.post('/api/v1/software/apply-update', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const result = await updater.apply({ assetUrl: String(body.assetUrl ?? ''), assetName: String(body.assetName ?? ''), fromVersion: String(body.fromVersion ?? ''), toVersion: String(body.toVersion ?? ''), sha256: body.sha256 ? String(body.sha256) : undefined });
      recordOperation('software_update', 'software', null, `应用软件更新：${String(body.fromVersion ?? '')} -> ${String(body.toVersion ?? '')}`);
      return result;
    } catch (error) { return reply.code(400).send({ error: { code: 'UPDATE_FAILED', message: error instanceof Error ? error.message : '更新失败' } }); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/software/backups/:id/restore', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const result = await updater.restore(request.params.id);
      recordOperation('software_restore', 'software_backup', request.params.id, '恢复软件备份');
      return result;
    }
    catch (error) { return reply.code(400).send({ error: { code: 'RESTORE_FAILED', message: error instanceof Error ? error.message : '还原失败' } }); }
  });

  /* ========== 本地 AI Agent 直连（v0.2.1，实验性）==========
   * 通过 spawn 本地已安装的 AI CLI 工具（Claude Code / Codex CLI 等）执行非交互 prompt，
   * 取代纯复制粘贴。风险比数据同步更高一级——一旦放开就等于允许触发本机进程执行——
   * 所以这里不认局域网访问令牌/密码，只认请求本身是不是从这台机器发出的。
   */
  // 挂在会 spawn 本机进程的路由上（preHandler）：非回环调用直接抛 LOOPBACK_ONLY，
  // 由中央 setErrorHandler 统一转成 403。
  async function loopbackOnly(request: FastifyRequest): Promise<void> {
    if (!isLoopbackAddr(request.ip)) {
      throw codedError('LOOPBACK_ONLY', '本机维护接口只能从本机访问；局域网访问默认为游客，只支持查看');
    }
  }

  function agentExecTemplate(id: string): string {
    const overrides = database.getMetadata<Record<string, string>>('aiAgentExecTemplates', {});
    return overrides[id] ?? DEFAULT_EXEC_TEMPLATE[id] ?? '';
  }

  app.get('/api/v1/ai-agents', { preHandler: loopbackOnly }, async () => {
    const defaultAgentId = database.getMetadata<string | null>('aiAgentDefault', null);
    const reviewAgentId = database.getMetadata<string | null>('aiReviewAgentId', null);
    const agents = await Promise.all(AGENT_REGISTRY.map(async (def) => {
      const detected = await detectAgent(def.bin);
      return { ...def, ...detected, execTemplate: agentExecTemplate(def.id) };
    }));
    return { agents, defaultAgentId, reviewAgentId };
  });

  app.post<{ Params: { id: string } }>('/api/v1/ai-agents/:id/detect', { preHandler: loopbackOnly }, async (request, reply) => {
    const def = findAgent(request.params.id);
    if (!def) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '未知的 Agent' } });
    return { id: def.id, ...(await detectAgent(def.bin)) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/ai-agents/:id/exec-template', { preHandler: loopbackOnly }, async (request, reply) => {
    const def = findAgent(request.params.id);
    if (!def) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '未知的 Agent' } });
    const template = String((request.body as { template?: unknown })?.template ?? '').slice(0, 500);
    const overrides = database.getMetadata<Record<string, string>>('aiAgentExecTemplates', {});
    overrides[def.id] = template;
    database.setMetadata('aiAgentExecTemplates', overrides);
    return { ok: true };
  });

  app.post('/api/v1/ai-agents/default', { preHandler: loopbackOnly }, async (request, reply) => {
    const id = (request.body as { id?: unknown })?.id;
    if (id !== null && !findAgent(String(id))) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '未知的 Agent' } });
    database.setMetadata('aiAgentDefault', id === null ? null : String(id));
    return { ok: true };
  });

  app.post('/api/v1/ai-agents/review-config', { preHandler: loopbackOnly }, async (request, reply) => {
    const id = (request.body as { agentId?: unknown })?.agentId;
    if (id !== null && !findAgent(String(id))) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '未知的 Agent' } });
    database.setMetadata('aiReviewAgentId', id === null ? null : String(id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/ai-agents/:id/run', { preHandler: loopbackOnly }, async (request, reply) => {
    const def = findAgent(request.params.id);
    if (!def) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '未知的 Agent' } });
    const body = request.body as { prompt?: unknown; timeoutMs?: unknown };
    const prompt = String(body?.prompt ?? '').trim();
    if (!prompt) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '请提供要执行的 prompt' } });
    const timeoutMs = Math.min(180_000, Math.max(5_000, Number(body?.timeoutMs) || 120_000));
    try {
      const result = await runAgentPrompt(def.bin, agentExecTemplate(def.id), prompt, timeoutMs);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'AGENT_RUN_FAILED', message: error instanceof Error ? error.message : '执行失败' } });
    }
  });

  /* ========== HubPooL MCP 工具服务 + AI 工作台（v0.2.1，实验性）==========
   * /mcp 是标准 MCP Streamable HTTP 端点，供本地 AI Agent 连接查询数据、生成待确认提案。
   * /api/v1/ai-chat/send 负责把用户在「AI 工作台」页面输入的一句话转成一次 Claude Code
   * 的一次性调用（带 --mcp-config 指向 /mcp，并用 --allowedTools 锁死只能用 hubpool 的
   * 四个工具，不给它本机文件/命令的访问权限）。同样只认回环地址。
   */
  // 无状态模式：官方推荐做法是每个请求都建一对新的 McpServer + Transport（各自很轻，
  // 只是注册工具元数据），而不是复用一个长期实例——复用会导致第二个请求（例如
  // initialize 后紧跟着的 notifications/initialized）内部状态对不上而报 500。
  app.post('/mcp', { preHandler: loopbackOnly }, async (request, reply) => {
    reply.hijack();
    const mcpServerInstance = createHubPoolMcpServer(database);
    const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcpServerInstance.connect(mcpTransport);
      await mcpTransport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      app.log.error(error);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
      }
    }
    reply.raw.on('close', () => { void mcpTransport.close(); void mcpServerInstance.close(); });
  });
  app.get('/mcp', { preHandler: loopbackOnly }, async (_request, reply) => {
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });
  app.delete('/mcp', { preHandler: loopbackOnly }, async (_request, reply) => {
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  });

  app.get<{ Querystring: { projectId?: string; status?: string } }>('/api/v1/ai-proposals', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId, status } = request.query;
    if (!projectId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '缺少 projectId' } });
    const allowedStatus = status === 'pending' || status === 'applied' || status === 'rejected' ? status : undefined;
    return { proposals: database.listProposals(projectId, allowedStatus) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/ai-proposals/:id/status', { preHandler: loopbackOnly }, async (request, reply) => {
    const status = String((request.body as { status?: unknown })?.status ?? '');
    if (status !== 'applied' && status !== 'rejected' && status !== 'pending') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '状态不正确' } });
    }
    try {
      database.setProposalStatus(request.params.id, status);
      recordOperation('ai_proposal_status', 'ai_proposal', request.params.id, `AI 提案状态更新为 ${status}`);
      return { ok: true };
    }
    catch (error) {
      return sendCodedError(reply, error, 'INTERNAL_ERROR', '设置状态失败');
    }
  });

  // v0.2.1：文本附件——刻意只做"服务端读内容拼进 prompt"，不给 Claude Code 开任何本机文件读取
  // 权限（工作台里它仍然只能碰 hubpool 的 MCP 工具）。每个附件截断到 20000 字，最多 3 个，
  // 附件原文不写进聊天历史，历史里只留文件名，避免历史越聊越大、也避免重复占用 prompt 预算。
  const MAX_ATTACHMENTS = 3;
  const MAX_ATTACHMENT_CHARS = 20_000;
  interface ChatAttachment { name: string; content: string }
  function parseAttachments(raw: unknown): ChatAttachment[] {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_ATTACHMENTS).map((item) => {
      const it = item as Record<string, unknown>;
      const name = String(it?.name ?? '未命名文件').slice(0, 200);
      let content = String(it?.content ?? '');
      if (content.length > MAX_ATTACHMENT_CHARS) content = content.slice(0, MAX_ATTACHMENT_CHARS) + '\n…（内容过长，已截断）';
      return { name, content };
    }).filter((a) => a.content.trim().length > 0);
  }
  function attachmentNote(attachments: ChatAttachment[]): string {
    return attachments.length ? `\n\n📎 ${attachments.map((a) => a.name).join('、')}` : '';
  }
  function buildPromptWithAttachments(prompt: string, attachments: ChatAttachment[]): string {
    if (attachments.length === 0) return prompt;
    const blocks = attachments.map((a) => `[附件：${a.name}]\n${a.content}`).join('\n\n---\n\n');
    return `${blocks}\n\n---\n\n用户消息：\n${prompt}`;
  }

  app.post('/api/v1/ai-chat/send', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as { projectId?: unknown; prompt?: unknown; sessionId?: unknown; model?: unknown; attachments?: unknown };
    const projectId = String(body?.projectId ?? '').trim();
    const prompt = String(body?.prompt ?? '').trim();
    // 会话延续：同一次「AI 工作台」对话里，前端把上一轮返回的 sessionId 带回来，
    // 这样 Claude Code 才能真正记得之前几轮说了什么，而不是每条消息都是无记忆的新会话。
    // v0.2.1：sessionId 现在也可能来自"关闭工作台重新打开"后从历史记录里恢复的上一次会话，
    // 而不只是同一次打开期间的前端内存变量——所以对话历史要落库，重开也能接得上。
    const resumeSessionId = typeof body?.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(body.sessionId) ? body.sessionId : null;
    if (!projectId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '缺少 projectId' } });
    if (!prompt) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '请输入消息内容' } });
    if (prompt.length > 20_000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '消息过长' } });
    let model: ClaudeModelAlias | null = null;
    if (body?.model !== undefined && body.model !== null && body.model !== '') {
      if (typeof body.model !== 'string' || !(CLAUDE_MODEL_ALIASES as readonly string[]).includes(body.model)) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '模型档位不正确' } });
      }
      model = body.model as ClaudeModelAlias;
    }
    const attachments = parseAttachments(body?.attachments);
    const mcpUrl = `http://127.0.0.1:${config.port}/mcp`;
    const displayPrompt = prompt + attachmentNote(attachments);
    const fullPrompt = buildPromptWithAttachments(prompt, attachments);
    database.addChatMessage({ projectId, sessionId: resumeSessionId, role: 'user', content: displayPrompt });
    try {
      const result = await runClaudeCodeWithMcp({ prompt: fullPrompt, projectId, mcpUrl, resumeSessionId, model });
      database.addChatMessage({ projectId, sessionId: result.sessionId, role: result.isError ? 'error' : 'assistant', content: result.output });
      return { ok: true, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : '执行失败';
      database.addChatMessage({ projectId, sessionId: resumeSessionId, role: 'error', content: message });
      return reply.code(400).send({ error: { code: 'AI_CHAT_FAILED', message } });
    }
  });

  app.get<{ Querystring: { projectId?: string } }>('/api/v1/ai-chat/history', { preHandler: loopbackOnly }, async (request, reply) => {
    const projectId = String(request.query.projectId ?? '').trim();
    if (!projectId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '缺少 projectId' } });
    return { messages: database.listChatMessages(projectId), lastSessionId: database.getLastChatSessionId(projectId) };
  });

  app.delete<{ Querystring: { projectId?: string } }>('/api/v1/ai-chat/history', { preHandler: loopbackOnly }, async (request, reply) => {
    const projectId = String(request.query.projectId ?? '').trim();
    if (!projectId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '缺少 projectId' } });
    database.clearChatMessages(projectId);
    return { ok: true };
  });

  /* ========== Cloud Sync (v0.2.0) ==========
   * Peer-to-peer sync between two running HubPooL instances (e.g. two teammates,
   * each running their own local server). One side calls push/pull/merge with the
   * other side's URL + access token; the other side exposes export/receive so the
   * actual data transfer happens over real HTTP, backed by the SQLite database.
   */
  const syncFetchTimeoutMs = 15_000;

  function normalizeRemoteUrl(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) throw codedError('VALIDATION_ERROR', '请填写远端服务器地址');
    let url: URL;
    try { url = new URL(value); } catch { throw codedError('VALIDATION_ERROR', '远端服务器地址格式不正确'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw codedError('VALIDATION_ERROR', '远端服务器地址必须以 http:// 或 https:// 开头');
    }
    return url.origin;
  }

  // Optional user-supplied note for a sync attempt (e.g. "上线前对齐"), shown in place of the
  // auto-generated "推送成功" text in 同步历史. Trimmed and length-capped; empty -> no override.
  function sanitizeSyncMessage(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    return value.slice(0, 200);
  }

  async function remoteFetch(remoteUrl: string, path: string, remoteToken: string | undefined, init?: { method?: string; body?: unknown }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), syncFetchTimeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (remoteToken) headers.Authorization = `Bearer ${remoteToken}`;
      const res = await fetch(`${remoteUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = undefined;
      try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON response */ }
      if (!res.ok) {
        const message = (json as { error?: { message?: string } } | undefined)?.error?.message ?? `远端服务器返回 ${res.status}`;
        throw codedError('REMOTE_ERROR', message);
      }
      return json;
    } catch (error) {
      const err = error as Error & { code?: string; cause?: { code?: string } };
      if (err.name === 'AbortError') throw codedError('REMOTE_TIMEOUT', '连接远端服务器超时，请确认对方服务已启动且地址正确');
      if (err.code === 'REMOTE_ERROR') throw err;
      const causeCode = err.cause?.code;
      if (err.message === 'fetch failed' || causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'EHOSTUNREACH') {
        throw codedError('REMOTE_UNREACHABLE', '无法连接到远端服务器，请检查地址是否正确、对方 HubPooL 服务是否已启动');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  // push/pull/merge 三个 handler 的公共骨架：校验远端地址、执行业务回调，失败时记录同步
  // 事件并统一错误响应。
  async function runSyncOperation<T>(
    reply: FastifyReply,
    projectId: string,
    body: { remoteUrl?: string; remoteToken?: string; message?: string },
    type: 'push' | 'pull' | 'merge',
    fallbackCode: string,
    fallbackMessage: string,
    run: (remoteUrl: string, remoteToken: string | undefined, note: string | null) => Promise<T>,
  ): Promise<T | undefined> {
    const note = sanitizeSyncMessage(body.message);
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      return await run(remoteUrl, body.remoteToken, note);
    } catch (error) {
      database.recordSyncEvent({ projectId, type, status: 'failed', dataVersion: database.computeProjectVersion(projectId).dataVersion, remoteUrl: body.remoteUrl ?? null, message: note ?? (error instanceof Error ? error.message : fallbackMessage) });
      sendCodedError(reply, error, fallbackCode, fallbackMessage);
      return undefined;
    }
  }

  // Status: local data version + last sync record for a project.
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/status', async (request) => {
    const { projectId } = request.params;
    const version = database.computeProjectVersion(projectId);
    const lastSync = database.getLastSyncEvent(projectId);
    return { projectId, ...version, lastSync };
  });

  // History: recent sync events for a project.
  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>('/api/v1/projects/:projectId/sync/history', async (request) => {
    const { projectId } = request.params;
    const limit = Math.min(100, Math.max(1, Number(request.query.limit ?? 20) || 20));
    return { records: database.listSyncHistory(projectId, limit) };
  });

  // Export: lets a remote HubPooL instance pull this project's data from us.
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/export', async (request) => {
    return database.exportProjectPayload(request.params.projectId);
  });

  // Preview: dry-run of push/pull/merge — fetches the remote's current data and diffs it against
  // local, without writing anything anywhere. Powers the "同步前变更预览" / "领先落后" UI.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/preview', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { mode?: 'push' | 'pull' | 'merge'; remoteUrl?: string; remoteToken?: string };
    if (body.mode !== 'push' && body.mode !== 'pull' && body.mode !== 'merge') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '预览模式必须是 push / pull / merge 之一' } });
    }
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      const remoteData = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/export`, body.remoteToken) as
        { project: unknown; versions: unknown[]; requirements: unknown[]; documents: unknown[]; dataVersion: string; exportedAt: number };
      if (body.mode === 'push') {
        const plan = database.previewOutgoingProject(projectId, { requirements: remoteData.requirements as never, versions: remoteData.versions as never, documents: remoteData.documents as never }, 'overwrite');
        return { mode: body.mode, ...plan.result, items: plan.items };
      }
      const plan = database.previewIncomingProject(projectId, {
        project: remoteData.project as never,
        versions: remoteData.versions as never,
        requirements: remoteData.requirements as never,
        documents: remoteData.documents as never,
        exportedAt: remoteData.exportedAt,
      }, 'preferNewer');
      return { mode: body.mode, ...plan.result, items: plan.items };
    } catch (error) {
      return sendCodedError(reply, error, 'PREVIEW_FAILED', '预览失败');
    }
  });

  // Receive: lets a remote HubPooL instance push its project data into us.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/receive', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { project?: unknown; versions?: unknown; requirements?: unknown; documents?: unknown; exportedAt?: number; dataVersion?: string };
    if (!Array.isArray(body?.requirements) || !Array.isArray(body?.versions)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '同步数据格式不正确' } });
    }
    try {
      const merged = database.mergeIncomingProject(projectId, {
        project: (body.project ?? null) as never,
        versions: body.versions as never,
        requirements: body.requirements as never,
        documents: body.documents as never,
        exportedAt: body.exportedAt,
      }, 'overwrite');
      const version = database.computeProjectVersion(projectId);
      database.recordSyncEvent({ projectId, type: 'receive', status: 'success', dataVersion: version.dataVersion, added: merged.added, modified: merged.modified, conflictCount: merged.conflicts.length, message: '接收到远端推送' });
      recordOperation('sync_receive', 'project', projectId, `接收远端推送：新增 ${merged.added} 条，更新 ${merged.modified} 条，冲突 ${merged.conflicts.length} 条`);
      return { success: true, ...merged, dataVersion: version.dataVersion };
    } catch (error) {
      return sendCodedError(reply, error, 'MERGE_FAILED', '合并失败');
    }
  });

  // Push: send our project data to a remote instance's /receive endpoint.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/push', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId } = request.params;
    return runSyncOperation(reply, projectId, request.body as { remoteUrl?: string; remoteToken?: string; message?: string }, 'push', 'PUSH_FAILED', '推送失败',
      async (remoteUrl, remoteToken, note) => {
        const payload = database.exportProjectPayload(projectId);
        const result = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/receive`, remoteToken, { method: 'POST', body: payload }) as
          { success: boolean; added: number; modified: number; conflicts: Array<{ id: string }>; dataVersion: string };
        database.recordSyncEvent({ projectId, type: 'push', status: 'success', dataVersion: result.dataVersion ?? payload.dataVersion, remoteUrl, added: result.added, modified: result.modified, conflictCount: result.conflicts?.length ?? 0, message: note ?? '推送成功' });
        recordOperation('sync_push', 'project', projectId, `推送到远端：新增 ${result.added ?? 0} 条，更新 ${result.modified ?? 0} 条，冲突 ${result.conflicts?.length ?? 0} 条`);
        return { success: true, remoteVersion: result.dataVersion ?? payload.dataVersion, changes: { added: result.added ?? 0, modified: result.modified ?? 0, deleted: 0 }, conflicts: result.conflicts ?? [], syncTime: Date.now() };
      });
  });

  // Pull: fetch a remote instance's project data via /export, merge into local DB (newer wins).
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/pull', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId } = request.params;
    return runSyncOperation(reply, projectId, request.body as { remoteUrl?: string; remoteToken?: string; message?: string }, 'pull', 'PULL_FAILED', '拉取失败',
      async (remoteUrl, remoteToken, note) => {
        const remoteData = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/export`, remoteToken) as
          { project: unknown; versions: unknown[]; requirements: unknown[]; documents: unknown[]; dataVersion: string; exportedAt: number };
        const merged = database.mergeIncomingProject(projectId, {
          project: remoteData.project as never,
          versions: remoteData.versions as never,
          requirements: remoteData.requirements as never,
          documents: remoteData.documents as never,
          exportedAt: remoteData.exportedAt,
        }, 'preferNewer');
        const version = database.computeProjectVersion(projectId);
        database.recordSyncEvent({ projectId, type: 'pull', status: 'success', dataVersion: version.dataVersion, remoteUrl, added: merged.added, modified: merged.modified, conflictCount: merged.conflicts.length, message: note ?? '拉取成功' });
        recordOperation('sync_pull', 'project', projectId, `从远端拉取：新增 ${merged.added} 条，更新 ${merged.modified} 条，冲突 ${merged.conflicts.length} 条`);
        return { success: true, localVersion: version.dataVersion, changes: { added: merged.added, modified: merged.modified, deleted: 0 }, conflicts: merged.conflicts, data: database.exportProjectPayload(projectId), syncTime: Date.now() };
      });
  });

  // Merge: two-way — pull remote data in with newer-wins, then push the reconciled result back out.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/merge', { preHandler: loopbackOnly }, async (request, reply) => {
    const { projectId } = request.params;
    return runSyncOperation(reply, projectId, request.body as { remoteUrl?: string; remoteToken?: string; message?: string }, 'merge', 'MERGE_FAILED', '合并失败',
      async (remoteUrl, remoteToken, note) => {
        const remoteData = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/export`, remoteToken) as
          { project: unknown; versions: unknown[]; requirements: unknown[]; documents: unknown[]; dataVersion: string; exportedAt: number };
        const pullMerge = database.mergeIncomingProject(projectId, {
          project: remoteData.project as never,
          versions: remoteData.versions as never,
          requirements: remoteData.requirements as never,
          documents: remoteData.documents as never,
          exportedAt: remoteData.exportedAt,
        }, 'preferNewer');
        const reconciled = database.exportProjectPayload(projectId);
        const pushResult = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/receive`, remoteToken, { method: 'POST', body: reconciled }) as
          { added: number; modified: number; conflicts: Array<{ id: string }> };
        const conflictCount = pullMerge.conflicts.length + (pushResult.conflicts?.length ?? 0);
        database.recordSyncEvent({ projectId, type: 'merge', status: 'success', dataVersion: reconciled.dataVersion, remoteUrl, added: pullMerge.added, modified: pullMerge.modified + (pushResult.modified ?? 0), conflictCount, message: note ?? '双向合并完成' });
        recordOperation('sync_merge', 'project', projectId, `双向合并：新增 ${pullMerge.added} 条，更新 ${pullMerge.modified + (pushResult.modified ?? 0)} 条，冲突 ${conflictCount} 条`);
        return {
          success: true,
          mergedVersion: reconciled.dataVersion,
          changes: { added: pullMerge.added, modified: pullMerge.modified, deleted: 0 },
          conflicts: [...pullMerge.conflicts, ...(pushResult.conflicts ?? [])],
          data: reconciled,
          syncTime: Date.now(),
        };
      });
  });

  // Test connectivity to a remote HubPooL instance (used by Settings → 云同步 "测试连接").
  // Runs server-side to avoid browser CORS restrictions, exactly like push/pull/merge.
  app.post('/api/v1/sync/test-connection', { preHandler: loopbackOnly }, async (request, reply) => {
    const body = request.body as { remoteUrl?: string; remoteToken?: string };
    const started = Date.now();
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      const health = await remoteFetch(remoteUrl, '/api/v1/health', body.remoteToken) as { status?: string; version?: string };
      return { ok: true, remoteUrl, version: health?.version ?? '未知', latencyMs: Date.now() - started };
    } catch (error) {
      return sendCodedError(reply, error, 'CONNECTION_FAILED', '连接失败');
    }
  });

  // Aggregate sync summary across every project (used by Settings → 云同步 overview card).
  app.get('/api/v1/sync/summary', async () => {
    const { data } = database.load();
    const projects = data.projects.map((p) => {
      const lastSync = database.getLastSyncEvent(p.id);
      return { projectId: p.id, projectName: p.name, lastSync };
    });
    const withSync = projects.filter((p) => p.lastSync);
    const lastSyncAt = withSync.reduce((max, p) => Math.max(max, p.lastSync?.createdAt ?? 0), 0);
    return {
      totalProjects: projects.length,
      syncedProjects: withSync.length,
      lastSyncAt: lastSyncAt || null,
      projects,
    };
  });

  app.get('/api/v1/snapshots', async () => ({ snapshots: database.listSnapshots() }));
  app.post('/api/v1/snapshots', { preHandler: loopbackOnly }, async (request, reply) => {
    const parsed = snapshotCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '快照参数不正确' } });
    const snapshot = database.createSnapshot(parsed.data.reason);
    recordOperation('snapshot_create', 'snapshot', snapshot.id, `创建 SQLite 快照：${parsed.data.reason}`);
    return snapshot;
  });
  app.post<{ Params: { id: string } }>('/api/v1/snapshots/:id/restore', { preHandler: loopbackOnly }, async (request, reply) => {
    try {
      const revision = database.restoreSnapshot(request.params.id);
      recordOperation('snapshot_restore', 'snapshot', request.params.id, '恢复 SQLite 快照');
      return { revision };
    }
    catch (error) {
      return sendCodedError(reply, error, 'INTERNAL_ERROR', '还原失败');
    }
  });

  await app.register(fastifyStatic, { root: resolve(config.publicDir), prefix: '/' });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
    return reply.sendFile('index.html');
  });

  return { app };
}
