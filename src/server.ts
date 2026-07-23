import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppDatabase } from './database.js';
import { appDataSchema, replaceStateSchema, snapshotCreateSchema } from './schemas.js';
import type { RuntimeConfig } from './types.js';
import { SoftwareUpdater } from './updater.js';

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createServer(config: RuntimeConfig, database: AppDatabase): Promise<{ app: FastifyInstance; accessToken?: string }> {
  const app = Fastify({ logger: true, bodyLimit: 12 * 1024 * 1024, trustProxy: false });
  const lanMode = !isLoopback(config.host);
  const accessToken = lanMode ? randomBytes(32).toString('hex') : undefined;
  const updater = new SoftwareUpdater(config);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (!lanMode) return;
    // decodeURIComponent closes percent-encoded path bypasses such as /%61pi/.
    let path = request.url.split('?', 1)[0] ?? '';
    try { path = decodeURIComponent(path); } catch { return reply.code(400).send({ error: { code: 'BAD_PATH', message: '请求路径不正确' } }); }
    if (!path.startsWith('/api/') || path === '/api/v1/health') return;
    const header = request.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!accessToken || !safeTokenEquals(supplied, accessToken)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: '局域网访问需要有效访问令牌' } });
    }
  });

  app.get('/api/v1/health', async () => ({ status: 'ok', version: '0.2.0' }));

  app.get('/api/v1/runtime', async () => ({
    host: config.host,
    port: config.port,
    lanMode,
    dataDir: config.dataDir,
  }));

  app.get('/api/v1/bootstrap', async () => {
    const state = database.load();
    return {
      schemaVersion: 1,
      revision: state.revision,
      data: state.data,
      meta: {
        lastBackupAt: database.getMetadata<number>('lastBackupAt', 0),
        storage: 'sqlite',
      },
    };
  });

  app.put('/api/v1/state', async (request, reply) => {
    const parsed = replaceStateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '数据格式不正确', details: parsed.error.issues } });
    try {
      const revision = database.replace(parsed.data.data, parsed.data.expectedRevision);
      return { revision };
    } catch (error) {
      const coded = error as Error & { code?: string };
      if (coded.code === 'REVISION_CONFLICT') return reply.code(409).send({ error: { code: coded.code, message: coded.message } });
      throw error;
    }
  });

  app.post('/api/v1/import/json', async (request, reply) => {
    try {
      const input = request.body as Record<string, unknown>;
      const revision = database.importEnvelope(input);
      const state = database.load().data;
      return { revision, imported: { projects: state.projects.length, versions: state.versions.length, requirements: state.requirements.length } };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'IMPORT_VALIDATION_ERROR', message: '备份文件结构不正确' } });
    }
  });

  app.get('/api/v1/export/json', async (_request, reply) => {
    database.setMetadata('lastBackupAt', Date.now());
    reply.header('Content-Disposition', 'attachment; filename="requirement-pool-backup.json"');
    reply.type('application/json; charset=utf-8');
    return JSON.stringify(database.exportEnvelope(), null, 2);
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/comments', async (request) => ({ comments: database.listComments(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/comments', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const content = String(body?.content ?? '').trim();
    if (!content || content.length > 5000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '批注内容须为 1—5000 字' } });
    return database.addComment({ requirementId: request.params.id, parentId: body.parentId ? String(body.parentId) : null, sectionKey: String(body.sectionKey ?? 'general'), author: String(body.author ?? '本地用户').slice(0, 80), role: String(body.role ?? '产品').slice(0, 30), content });
  });
  app.patch<{ Params: { id: string } }>('/api/v1/comments/:id', async (request) => {
    const body = request.body as Record<string, unknown>;
    database.setCommentResolved(request.params.id, Boolean(body.resolved));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/revisions', async (request) => ({ revisions: database.listRequirementRevisions(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/revisions', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    const payload = body?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '版本内容不正确' } });
    return database.captureRequirementRevision(request.params.id, payload as Record<string, unknown>, String(body.author ?? '本地用户').slice(0, 80), String(body.reason ?? '手动保存版本').slice(0, 200));
  });

  app.get<{ Params: { id: string } }>('/api/v1/requirements/:id/ai-reviews', async (request) => ({ reviews: database.listAiReviews(request.params.id) }));
  app.post<{ Params: { id: string } }>('/api/v1/requirements/:id/ai-reviews', async (request, reply) => {
    const content = String((request.body as Record<string, unknown>)?.content ?? '').trim();
    if (!content || content.length > 30_000) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'AI 评审内容须为 1—30000 字' } });
    return database.addAiReview(request.params.id, content);
  });
  app.patch<{ Params: { id: string } }>('/api/v1/ai-reviews/:id', async (request, reply) => {
    const status = String((request.body as Record<string, unknown>)?.status ?? '');
    if (!['待处理', '已采纳', '已驳回', '已解决'].includes(status)) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '评审状态不正确' } });
    database.updateAiReviewStatus(request.params.id, status);
    return { ok: true };
  });

  app.post('/api/v1/software/check-update', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      return await updater.check(String(body.repo ?? ''), String(body.currentVersion ?? '1.0.0'), Boolean(body.includePrerelease));
    } catch (error) { return reply.code(400).send({ error: { code: 'UPDATE_CHECK_FAILED', message: error instanceof Error ? error.message : '检测更新失败' } }); }
  });
  app.get('/api/v1/software/backups', async () => ({ projectDir: config.projectDir, backups: await updater.listBackups() }));
  app.post('/api/v1/software/apply-update', async (request, reply) => {
    try {
      const body = request.body as Record<string, unknown>;
      return await updater.apply({ assetUrl: String(body.assetUrl ?? ''), assetName: String(body.assetName ?? ''), fromVersion: String(body.fromVersion ?? ''), toVersion: String(body.toVersion ?? ''), sha256: body.sha256 ? String(body.sha256) : undefined });
    } catch (error) { return reply.code(400).send({ error: { code: 'UPDATE_FAILED', message: error instanceof Error ? error.message : '更新失败' } }); }
  });
  app.post<{ Params: { id: string } }>('/api/v1/software/backups/:id/restore', async (request, reply) => {
    try { return await updater.restore(request.params.id); }
    catch (error) { return reply.code(400).send({ error: { code: 'RESTORE_FAILED', message: error instanceof Error ? error.message : '还原失败' } }); }
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
    if (!value) throw Object.assign(new Error('请填写远端服务器地址'), { code: 'VALIDATION_ERROR' });
    let url: URL;
    try { url = new URL(value); } catch { throw Object.assign(new Error('远端服务器地址格式不正确'), { code: 'VALIDATION_ERROR' }); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw Object.assign(new Error('远端服务器地址必须以 http:// 或 https:// 开头'), { code: 'VALIDATION_ERROR' });
    }
    return url.origin;
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
        throw Object.assign(new Error(message), { code: 'REMOTE_ERROR' });
      }
      return json;
    } catch (error) {
      const err = error as Error & { code?: string; cause?: { code?: string } };
      if (err.name === 'AbortError') throw Object.assign(new Error('连接远端服务器超时，请确认对方服务已启动且地址正确'), { code: 'REMOTE_TIMEOUT' });
      if (err.code === 'REMOTE_ERROR') throw err;
      const causeCode = err.cause?.code;
      if (err.message === 'fetch failed' || causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'EHOSTUNREACH') {
        throw Object.assign(new Error('无法连接到远端服务器，请检查地址是否正确、对方 HubPooL 服务是否已启动'), { code: 'REMOTE_UNREACHABLE' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
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

  // Receive: lets a remote HubPooL instance push its project data into us.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/receive', async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { project?: unknown; versions?: unknown; requirements?: unknown; exportedAt?: number; dataVersion?: string };
    if (!Array.isArray(body?.requirements) || !Array.isArray(body?.versions)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '同步数据格式不正确' } });
    }
    try {
      const merged = database.mergeIncomingProject(projectId, {
        project: (body.project ?? null) as never,
        versions: body.versions as never,
        requirements: body.requirements as never,
        exportedAt: body.exportedAt,
      }, 'overwrite');
      const version = database.computeProjectVersion(projectId);
      database.recordSyncEvent({ projectId, type: 'receive', status: 'success', dataVersion: version.dataVersion, added: merged.added, modified: merged.modified, conflictCount: merged.conflicts.length, message: '接收到远端推送' });
      return { success: true, ...merged, dataVersion: version.dataVersion };
    } catch (error) {
      return reply.code(400).send({ error: { code: 'MERGE_FAILED', message: error instanceof Error ? error.message : '合并失败' } });
    }
  });

  // Push: send our project data to a remote instance's /receive endpoint.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/push', async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { remoteUrl?: string; remoteToken?: string };
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      const payload = database.exportProjectPayload(projectId);
      const result = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/receive`, body.remoteToken, { method: 'POST', body: payload }) as
        { success: boolean; added: number; modified: number; conflicts: Array<{ id: string }>; dataVersion: string };
      database.recordSyncEvent({ projectId, type: 'push', status: 'success', dataVersion: result.dataVersion ?? payload.dataVersion, remoteUrl, added: result.added, modified: result.modified, conflictCount: result.conflicts?.length ?? 0, message: '推送成功' });
      return { success: true, remoteVersion: result.dataVersion ?? payload.dataVersion, changes: { added: result.added ?? 0, modified: result.modified ?? 0, deleted: 0 }, conflicts: result.conflicts ?? [], syncTime: Date.now() };
    } catch (error) {
      const coded = error as Error & { code?: string };
      database.recordSyncEvent({ projectId, type: 'push', status: 'failed', dataVersion: database.computeProjectVersion(projectId).dataVersion, remoteUrl: body.remoteUrl ?? null, message: coded.message });
      return reply.code(400).send({ error: { code: coded.code ?? 'PUSH_FAILED', message: coded.message ?? '推送失败' } });
    }
  });

  // Pull: fetch a remote instance's project data via /export, merge into local DB (newer wins).
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/pull', async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { remoteUrl?: string; remoteToken?: string };
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      const remoteData = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/export`, body.remoteToken) as
        { project: unknown; versions: unknown[]; requirements: unknown[]; dataVersion: string; exportedAt: number };
      const merged = database.mergeIncomingProject(projectId, {
        project: remoteData.project as never,
        versions: remoteData.versions as never,
        requirements: remoteData.requirements as never,
        exportedAt: remoteData.exportedAt,
      }, 'preferNewer');
      const version = database.computeProjectVersion(projectId);
      database.recordSyncEvent({ projectId, type: 'pull', status: 'success', dataVersion: version.dataVersion, remoteUrl, added: merged.added, modified: merged.modified, conflictCount: merged.conflicts.length, message: '拉取成功' });
      return { success: true, localVersion: version.dataVersion, changes: { added: merged.added, modified: merged.modified, deleted: 0 }, conflicts: merged.conflicts, data: database.exportProjectPayload(projectId), syncTime: Date.now() };
    } catch (error) {
      const coded = error as Error & { code?: string };
      database.recordSyncEvent({ projectId, type: 'pull', status: 'failed', dataVersion: database.computeProjectVersion(projectId).dataVersion, remoteUrl: body.remoteUrl ?? null, message: coded.message });
      return reply.code(400).send({ error: { code: coded.code ?? 'PULL_FAILED', message: coded.message ?? '拉取失败' } });
    }
  });

  // Merge: two-way — pull remote data in with newer-wins, then push the reconciled result back out.
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/sync/merge', async (request, reply) => {
    const { projectId } = request.params;
    const body = request.body as { remoteUrl?: string; remoteToken?: string };
    try {
      const remoteUrl = normalizeRemoteUrl(body.remoteUrl);
      const remoteData = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/export`, body.remoteToken) as
        { project: unknown; versions: unknown[]; requirements: unknown[]; dataVersion: string; exportedAt: number };
      const pullMerge = database.mergeIncomingProject(projectId, {
        project: remoteData.project as never,
        versions: remoteData.versions as never,
        requirements: remoteData.requirements as never,
        exportedAt: remoteData.exportedAt,
      }, 'preferNewer');
      const reconciled = database.exportProjectPayload(projectId);
      const pushResult = await remoteFetch(remoteUrl, `/api/v1/projects/${encodeURIComponent(projectId)}/sync/receive`, body.remoteToken, { method: 'POST', body: reconciled }) as
        { added: number; modified: number; conflicts: Array<{ id: string }> };
      const conflictCount = pullMerge.conflicts.length + (pushResult.conflicts?.length ?? 0);
      database.recordSyncEvent({ projectId, type: 'merge', status: 'success', dataVersion: reconciled.dataVersion, remoteUrl, added: pullMerge.added, modified: pullMerge.modified + (pushResult.modified ?? 0), conflictCount, message: '双向合并完成' });
      return {
        success: true,
        mergedVersion: reconciled.dataVersion,
        changes: { added: pullMerge.added, modified: pullMerge.modified, deleted: 0 },
        conflicts: [...pullMerge.conflicts, ...(pushResult.conflicts ?? [])],
        data: reconciled,
        syncTime: Date.now(),
      };
    } catch (error) {
      const coded = error as Error & { code?: string };
      database.recordSyncEvent({ projectId, type: 'merge', status: 'failed', dataVersion: database.computeProjectVersion(projectId).dataVersion, remoteUrl: body.remoteUrl ?? null, message: coded.message });
      return reply.code(400).send({ error: { code: coded.code ?? 'MERGE_FAILED', message: coded.message ?? '合并失败' } });
    }
  });

  app.get('/api/v1/snapshots', async () => ({ snapshots: database.listSnapshots() }));
  app.post('/api/v1/snapshots', async (request, reply) => {
    const parsed = snapshotCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: '快照参数不正确' } });
    return database.createSnapshot(parsed.data.reason);
  });
  app.post<{ Params: { id: string } }>('/api/v1/snapshots/:id/restore', async (request, reply) => {
    try { return { revision: database.restoreSnapshot(request.params.id) }; }
    catch (error) {
      const coded = error as Error & { code?: string };
      if (coded.code === 'NOT_FOUND') return reply.code(404).send({ error: { code: coded.code, message: coded.message } });
      throw error;
    }
  });

  await app.register(fastifyStatic, { root: resolve(config.publicDir), prefix: '/' });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
    return reply.sendFile('index.html');
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务处理失败，请查看终端日志' } });
  });

  return { app, accessToken };
}
