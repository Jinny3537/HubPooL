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
});
