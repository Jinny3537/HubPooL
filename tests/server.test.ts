import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppDatabase } from '../src/database.js';
import { createServer } from '../src/server.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

async function createTestServer() {
  const dir = mkdtempSync(join(tmpdir(), 'reqpool-server-'));
  dirs.push(dir);
  const database = new AppDatabase(join(dir, 'test.db'));
  const { app } = await createServer({
    host: '0.0.0.0',
    port: 0,
    openBrowser: false,
    dataDir: dir,
    publicDir: resolve('public'),
    projectDir: resolve('.'),
  }, database);
  return { app, database };
}

describe('LAN guest access control', () => {
  it('reports the v0.9.6 runtime version', async () => {
    const { app, database } = await createTestServer();

    const health = await app.inject({ method: 'GET', url: '/api/v1/health', remoteAddress: '127.0.0.1' });

    expect(health.statusCode).toBe(200);
    expect(health.json().version).toBe('0.9.6');
    expect(health.json().releaseStage).toBe('release-candidate');
    expect(health.json().upgradeRange).toBe('0.9.1-0.9.6');

    await app.close();
    database.close();
  });

  it('marks loopback requests as local and LAN requests as guest', async () => {
    const { app, database } = await createTestServer();

    const local = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '127.0.0.1' });
    const lan = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '100.100.60.122' });
    const mappedLan = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '::ffff:100.100.60.123' });

    expect(local.statusCode).toBe(200);
    expect(local.json().meta.isLocalRequest).toBe(true);
    expect(lan.statusCode).toBe(200);
    expect(lan.json().meta.isLocalRequest).toBe(false);
    expect(lan.json().meta.requesterIp).toBe('100.100.60.122');
    expect(mappedLan.statusCode).toBe(200);
    expect(mappedLan.json().meta.isLocalRequest).toBe(false);
    expect(mappedLan.json().meta.requesterIp).toBe('100.100.60.123');

    await app.close();
    database.close();
  });

  it('allows loopback writes and blocks LAN writes', async () => {
    const { app, database } = await createTestServer();
    const bootstrap = await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '127.0.0.1' });
    const state = bootstrap.json();

    const localWrite = await app.inject({
      method: 'PUT',
      url: '/api/v1/state',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { data: state.data, expectedRevision: state.revision },
    });
    const lanWrite = await app.inject({
      method: 'PUT',
      url: '/api/v1/state',
      remoteAddress: '100.100.60.122',
      headers: { 'content-type': 'application/json' },
      payload: { data: state.data, expectedRevision: state.revision + 1 },
    });

    expect(localWrite.statusCode).toBe(200);
    expect(localWrite.json().revision).toBe(state.revision + 1);
    expect(lanWrite.statusCode).toBe(403);
    expect(lanWrite.json().error.code).toBe('LOOPBACK_ONLY');

    await app.close();
    database.close();
  });

  it('blocks LAN callers from sync preview and receive endpoints', async () => {
    const { app, database } = await createTestServer();

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/p1/sync/preview',
      remoteAddress: '100.100.60.122',
      headers: { 'content-type': 'application/json' },
      payload: { mode: 'pull', remoteUrl: 'http://127.0.0.1:9999' },
    });
    const receive = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/p1/sync/receive',
      remoteAddress: '100.100.60.122',
      headers: { 'content-type': 'application/json' },
      payload: { versions: [], requirements: [], documents: [] },
    });
    const taskPreview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/p1/versions/v1/task-sync/preview',
      remoteAddress: '100.100.60.122',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });

    expect(preview.statusCode).toBe(403);
    expect(preview.json().error.code).toBe('LOOPBACK_ONLY');
    expect(receive.statusCode).toBe(403);
    expect(receive.json().error.code).toBe('LOOPBACK_ONLY');
    expect(taskPreview.statusCode).toBe(403);
    expect(taskPreview.json().error.code).toBe('LOOPBACK_ONLY');

    await app.close();
    database.close();
  });

  it('uses the global task sync config for project task previews', async () => {
    const { app, database } = await createTestServer();
    const data = {
      projects: [{ id: 'p-global', name: '全局配置项目', code: 'GLOBAL' }],
      versions: [{ id: 'v-global', projectId: 'p-global', name: 'v1', status: '规划中' }],
      requirements: [{ id: 'REQ-1', projectId: 'p-global', versionId: 'v-global', name: '同步测试需求', status: '开发中', priority: 'P1' }],
      settings: {
        taskSync: {
          config: {
            enabled: true,
            transport: 'stdio',
            command: '/tmp/assess-task-mcp',
            args: [],
            env: {},
            url: '',
            headers: {},
            defaultTaskType: 4,
            priorityMap: { P0: 1, P1: 2, P2: 3, P3: 4 },
          },
        },
      },
      seqCounters: {},
    };
    const state = await app.inject({
      method: 'PUT',
      url: '/api/v1/state',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { data },
    });
    expect(state.statusCode).toBe(200);

    const preview = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/p-global/versions/v-global/task-sync/preview',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { platform: { projectId: '100' } },
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().preview.counts.create).toBe(1);

    await app.close();
    database.close();
  });

  it('shows recent visitors only to loopback callers', async () => {
    const { app, database } = await createTestServer();

    await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '127.0.0.1', headers: { 'user-agent': 'Local Browser' } });
    await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '100.100.60.122', headers: { 'user-agent': 'LAN Browser' } });
    await app.inject({ method: 'GET', url: '/api/v1/bootstrap', remoteAddress: '::ffff:100.100.60.123', headers: { 'user-agent': 'Mapped LAN Browser' } });

    const localVisitors = await app.inject({ method: 'GET', url: '/api/v1/visitors', remoteAddress: '127.0.0.1' });
    const lanVisitors = await app.inject({ method: 'GET', url: '/api/v1/visitors', remoteAddress: '100.100.60.122' });

    expect(localVisitors.statusCode).toBe(200);
    const visitors = localVisitors.json().visitors as Array<{ ip: string; name: string; role: string; active: boolean }>;
    expect(visitors.some((visitor) => visitor.ip === '127.0.0.1' && visitor.active)).toBe(true);
    expect(visitors.some((visitor) => visitor.ip === '100.100.60.122' && visitor.name === '局域网游客' && visitor.role === '游客')).toBe(true);
    expect(visitors.some((visitor) => visitor.ip === '100.100.60.123' && visitor.name === '局域网游客' && visitor.role === '游客')).toBe(true);
    expect(lanVisitors.statusCode).toBe(403);

    await app.close();
    database.close();
  });

  it('accepts large prototype HTML without relaxing normal document limits', async () => {
    const { app, database } = await createTestServer();
    const prototypeContent = `<!doctype html><html><body>${'x'.repeat(600_000)}</body></html>`;
    const prototype = await app.inject({
      method: 'POST',
      url: '/api/v1/versions/v1/documents',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { title: '大型原型', kind: 'prototype', content: prototypeContent },
    });
    const oversizedSpec = await app.inject({
      method: 'POST',
      url: '/api/v1/versions/v1/documents',
      remoteAddress: '127.0.0.1',
      headers: { 'content-type': 'application/json' },
      payload: { title: '过大规格书', kind: 'spec', content: 'x'.repeat(200_001) },
    });

    expect(prototype.statusCode).toBe(200);
    expect(prototype.json().content).toBe(prototypeContent);
    expect(oversizedSpec.statusCode).toBe(400);

    await app.close();
    database.close();
  });
});
