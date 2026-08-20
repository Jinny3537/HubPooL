import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/database.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function createDb(): AppDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'reqpool-'));
  dirs.push(dir);
  return new AppDatabase(join(dir, 'test.db'));
}

describe('AppDatabase', () => {
  it('persists state with revision checks', () => {
    const db = createDb();
    const initial = db.load();
    expect(initial.revision).toBe(0);
    initial.data.projects.push({ id: 'p1', name: '项目一', code: 'P1' });
    expect(db.replace(initial.data, 0)).toBe(1);
    expect(db.load().data.projects).toHaveLength(1);
    expect(() => db.replace(initial.data, 0)).toThrow(/其他页面更新/);
    db.close();
  });

  it('creates and restores snapshots without lowering sequence counters', () => {
    const db = createDb();
    const state = db.load();
    state.data.seqCounters['P1-202607'] = 10;
    db.replace(state.data);
    const snapshot = db.createSnapshot('测试');
    const changed = db.load();
    changed.data.seqCounters['P1-202607'] = 20;
    db.replace(changed.data);
    db.restoreSnapshot(snapshot.id);
    expect(db.load().data.seqCounters['P1-202607']).toBe(20);
    db.close();
  });

  it('preserves v0.3.0 identity and release plan fields through validation', () => {
    const db = createDb();
    const state = db.load();
    state.data.settings.collaboration = { currentUserName: 'Mima', currentUserRole: '产品', teamRoles: ['产品', '研发'] };
    state.data.projects.push({ id: 'p1', name: '项目一', code: 'P1' });
    state.data.versions.push({
      id: 'v1',
      projectId: 'p1',
      name: 'V1.0',
      status: '规划中',
      goal: '完成一期发布闭环',
      owner: 'Mima',
      riskLevel: 'medium',
      risks: ['联调时间待确认'],
      signoffs: { 产品: '已确认', 测试: '待确认' },
      releaseNotes: '发布说明',
    });
    db.replace(state.data);
    const loaded = db.load().data;
    expect(loaded.settings.collaboration?.currentUserName).toBe('Mima');
    expect(loaded.versions[0]?.goal).toBe('完成一期发布闭环');
    expect(loaded.versions[0]?.signoffs).toEqual({ 产品: '已确认', 测试: '待确认' });
    db.close();
  });

  it('exports and imports operation logs', () => {
    const db = createDb();
    db.recordOperation({ type: 'snapshot_restore', actor: 'Mima', targetType: 'snapshot', targetId: 's1', summary: '恢复快照' });
    const envelope = db.exportEnvelope();
    const imported = createDb();
    imported.importEnvelope(envelope);
    const logs = imported.listOperationLogs();
    expect(logs[0]?.summary).toBe('恢复快照');
    expect(logs[0]?.actor).toBe('Mima');
    db.close();
    imported.close();
  });

  it('restores snapshots without losing release plan fields', () => {
    const db = createDb();
    const state = db.load();
    state.data.projects.push({ id: 'p1', name: '项目一', code: 'P1' });
    state.data.versions.push({ id: 'v1', projectId: 'p1', name: 'V1.0', status: '规划中', goal: '原目标', riskLevel: 'high' });
    db.replace(state.data);
    const snapshot = db.createSnapshot('含发布计划');
    const changed = db.load();
    changed.data.versions[0]!.goal = '新目标';
    db.replace(changed.data);
    db.restoreSnapshot(snapshot.id);
    const restored = db.load().data;
    expect(restored.versions[0]?.goal).toBe('原目标');
    expect(restored.versions[0]?.riskLevel).toBe('high');
    db.close();
  });

  it('preserves large self-contained prototype documents without truncation', () => {
    const db = createDb();
    const content = `<!doctype html><html><body>${'x'.repeat(600_000)}</body></html>`;
    const created = db.createVersionDocument({ versionId: 'v1', title: '大型原型', kind: 'prototype', content });

    expect(created.content).toBe(content);
    expect(db.getVersionDocument(created.id)?.content).toBe(content);
    db.close();
  });
});
