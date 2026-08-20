import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/database.js';
import { codedError, codedErrorStatus, isCodedError } from '../src/errors.js';
import type { Requirement } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function seedDb(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'reqpool-'));
  dirs.push(dir);
  const db = new AppDatabase(join(dir, 'test.db'));
  const state = db.load();
  state.data.projects.push({ id: 'p1', name: '项目一', code: 'P1' });
  state.data.versions.push({ id: 'v1', projectId: 'p1', name: 'V1.0', status: '规划中' });
  state.data.requirements.push(
    { id: 'r1', projectId: 'p1', versionId: 'v1', name: '需求一', status: '进行中', updatedAt: 100 },
    { id: 'r2', projectId: 'p1', versionId: 'v1', name: '需求二', status: '进行中', updatedAt: 100 },
  );
  db.replace(state.data);
  return db;
}

describe('mergeIncomingProject', () => {
  it('overwrite 模式：远端新增 + 修改全部落地', () => {
    const db = seedDb();
    const merged = db.mergeIncomingProject('p1', {
      project: { id: 'p1', name: '项目一', code: 'P1' },
      versions: [],
      requirements: [
        { id: 'r1', projectId: 'p1', name: '需求一（改）', status: '进行中', updatedAt: 50 },
        { id: 'r3', projectId: 'p1', name: '需求三', status: '待处理', updatedAt: 50 },
      ],
      exportedAt: 50,
    }, 'overwrite');
    expect(merged.added).toBe(1);
    expect(merged.modified).toBe(1);
    const reqs = db.load().data.requirements;
    expect(reqs.find((r) => r.id === 'r1')?.name).toBe('需求一（改）');
    expect(reqs.find((r) => r.id === 'r3')?.name).toBe('需求三');
    db.close();
  });

  it('preferNewer 模式：更新的进入，更旧的记为冲突且不落地', () => {
    const db = seedDb();
    const merged = db.mergeIncomingProject('p1', {
      requirements: [
        { id: 'r1', projectId: 'p1', name: '需求一（新）', status: '进行中', updatedAt: 200 },
        { id: 'r2', projectId: 'p1', name: '需求二（旧）', status: '进行中', updatedAt: 10 },
      ],
      exportedAt: 10,
    }, 'preferNewer');
    expect(merged.modified).toBe(1);
    expect(merged.conflicts).toEqual([{ id: 'r2', kind: 'requirement' }]);
    const reqs = db.load().data.requirements;
    expect(reqs.find((r) => r.id === 'r1')?.name).toBe('需求一（新）');
    expect(reqs.find((r) => r.id === 'r2')?.name).toBe('需求二');
    db.close();
  });

  it('不影响其他项目的数据', () => {
    const db = seedDb();
    const state = db.load();
    state.data.projects.push({ id: 'p2', name: '项目二', code: 'P2' });
    state.data.requirements.push({ id: 'r9', projectId: 'p2', name: '他项目需求', status: '进行中' });
    db.replace(state.data);

    db.mergeIncomingProject('p1', {
      requirements: [{ id: 'r5', projectId: 'p1', name: '需求五', status: '待处理' }],
    }, 'overwrite');

    const reqs = db.load().data.requirements;
    expect(reqs.find((r) => r.id === 'r9')).toBeDefined();
    expect(reqs.find((r) => r.id === 'r5')).toBeDefined();
    db.close();
  });

  it('同步版本发布计划字段', () => {
    const db = seedDb();
    const merged = db.mergeIncomingProject('p1', {
      versions: [{ id: 'v1', projectId: 'p1', name: 'V1.0', status: '规划中', updatedAt: 200, goal: '远端发布目标', owner: 'Mima', riskLevel: 'medium', risks: ['远端风险'] }],
      requirements: [],
      exportedAt: 200,
    }, 'preferNewer');
    expect(merged.conflicts).toEqual([]);
    const v1 = db.load().data.versions.find((v) => v.id === 'v1');
    expect(v1?.goal).toBe('远端发布目标');
    expect(v1?.owner).toBe('Mima');
    expect(v1?.risks).toEqual(['远端风险']);
    db.close();
  });

  it('previewIncomingProject 不落库', () => {
    const db = seedDb();
    const preview = db.previewIncomingProject('p1', {
      requirements: [{ id: 'r4', projectId: 'p1', name: '需求四', status: '待处理' }],
    }, 'overwrite');
    expect(preview.result.added).toBe(1);
    expect(db.load().data.requirements.find((r) => r.id === 'r4')).toBeUndefined();
    db.close();
  });
});

describe('setRequirementsJiraKeys', () => {
  it('回写 jiraKey 与 syncedAt，重复调用无变化时不再递增 revision', () => {
    const db = seedDb();
    const rev1 = db.setRequirementsJiraKeys([{ id: 'r1', jiraKey: 'TASK-1', syncedAt: 1000 }]);
    const r1 = db.load().data.requirements.find((x) => x.id === 'r1') as Requirement;
    expect(r1.jiraKey).toBe('TASK-1');
    expect(r1.jiraSyncedAt).toBe(1000);
    expect(rev1).toBeGreaterThan(0);

    const rev2 = db.setRequirementsJiraKeys([{ id: 'r1', jiraKey: 'TASK-1', syncedAt: 1000 }]);
    expect(rev2).toBe(rev1);
    db.close();
  });

  it('jiraKey=null 清除标记', () => {
    const db = seedDb();
    db.setRequirementsJiraKeys([{ id: 'r1', jiraKey: 'TASK-1', syncedAt: 1000 }]);
    db.setRequirementsJiraKeys([{ id: 'r1', jiraKey: null }]);
    const r1 = db.load().data.requirements.find((x) => x.id === 'r1') as Requirement;
    expect(r1.jiraKey).toBeUndefined();
    expect(r1.jiraSyncedAt).toBeUndefined();
    db.close();
  });
});

describe('coded error -> HTTP 映射', () => {
  it('已知错误码映射到正确状态码，未知回落 500', () => {
    expect(codedErrorStatus('NOT_FOUND')).toBe(404);
    expect(codedErrorStatus('REVISION_CONFLICT')).toBe(409);
    expect(codedErrorStatus('LOOPBACK_ONLY')).toBe(403);
    expect(codedErrorStatus('LOOPBACK_REQUIRED')).toBe(403);
    expect(codedErrorStatus('VALIDATION_ERROR')).toBe(400);
    expect(codedErrorStatus('SYNC_FAILED')).toBe(502);
    expect(codedErrorStatus('PUSH_FAILED')).toBe(502);
    expect(codedErrorStatus('MERGE_FAILED')).toBe(502);
    expect(codedErrorStatus('WHATEVER_ELSE')).toBe(500);
  });

  it('isCodedError 识别工厂产物', () => {
    expect(isCodedError(codedError('NOT_FOUND', '快照不存在'))).toBe(true);
    expect(isCodedError(new Error('普通错误'))).toBe(false);
    expect(isCodedError('不是错误对象')).toBe(false);
  });
});
