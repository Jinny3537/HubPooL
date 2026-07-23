import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import AdmZip from 'adm-zip';
import type { RuntimeConfig } from './types.js';

const OFFICIAL_PATHS = ['dist', 'public', 'src', 'scripts', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'ROADMAP.md'];

export interface UpdateAsset { name: string; url: string; size: number; }
export interface UpdateInfo { currentVersion: string; latestVersion: string; releaseName: string; notes: string; publishedAt: string; prerelease: boolean; asset?: UpdateAsset; updateAvailable: boolean; }
export interface BackupRecord { id: string; createdAt: number; fromVersion: string; toVersion: string; backupDir: string; archiveFile: string; status: string; coveredFiles: number; }

function versionParts(value: string): number[] { return value.replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0); }
function newer(latest: string, current: string): boolean {
  const a = versionParts(latest), b = versionParts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}
function validRepo(repo: string): boolean { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
async function countFiles(path: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  if (!(await exists(path))) return 0;
  const entry = await stat(path); if (!entry.isDirectory()) return 1;
  let total = 0; for (const child of await readdir(path)) total += await countFiles(join(path, child)); return total;
}

export class SoftwareUpdater {
  private readonly root: string;
  private readonly backupRoot: string;
  private readonly downloadRoot: string;
  constructor(private readonly config: RuntimeConfig) {
    this.root = config.projectDir;
    this.backupRoot = join(config.dataDir, 'software-backups');
    this.downloadRoot = join(config.dataDir, 'updates');
  }

  async check(repo: string, currentVersion: string, includePrerelease: boolean): Promise<UpdateInfo> {
    if (!validRepo(repo)) throw new Error('GitHub 仓库格式应为 owner/repository');
    const endpoint = includePrerelease ? `https://api.github.com/repos/${repo}/releases` : `https://api.github.com/repos/${repo}/releases/latest`;
    const response = await fetch(endpoint, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'requirement-pool-local/1.0.0' }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const raw = await response.json() as Record<string, unknown> | Array<Record<string, unknown>>;
    const release = Array.isArray(raw) ? raw.find((item) => includePrerelease || !item.prerelease) : raw;
    if (!release) throw new Error('没有可用的 GitHub Release');
    const assets = Array.isArray(release.assets) ? release.assets as Array<Record<string, unknown>> : [];
    const chosen = assets.find((item) => /requirement-pool.*\.(zip|tgz)$/i.test(String(item.name))) ?? assets.find((item) => /\.(zip|tgz)$/i.test(String(item.name)));
    const latestVersion = String(release.tag_name ?? '').replace(/^v/i, '');
    return {
      currentVersion, latestVersion, releaseName: String(release.name ?? release.tag_name ?? latestVersion), notes: String(release.body ?? ''),
      publishedAt: String(release.published_at ?? ''), prerelease: Boolean(release.prerelease), updateAvailable: newer(latestVersion, currentVersion),
      asset: chosen ? { name: String(chosen.name), url: String(chosen.browser_download_url), size: Number(chosen.size ?? 0) } : undefined,
    };
  }

  async listBackups(): Promise<BackupRecord[]> {
    await mkdir(this.backupRoot, { recursive: true });
    const { readdir } = await import('node:fs/promises');
    const records: BackupRecord[] = [];
    for (const id of await readdir(this.backupRoot)) {
      try { records.push(JSON.parse(await readFile(join(this.backupRoot, id, 'record.json'), 'utf8')) as BackupRecord); } catch { /* ignore incomplete backup */ }
    }
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  async apply(input: { assetUrl: string; assetName: string; fromVersion: string; toVersion: string; sha256?: string }): Promise<BackupRecord> {
    const url = new URL(input.assetUrl);
    if (url.protocol !== 'https:' || !['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('更新包只允许来自 GitHub HTTPS 地址');
    if (!/\.(zip|tgz)$/i.test(input.assetName)) throw new Error('更新包必须是 zip 或 tgz');
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const dir = join(this.backupRoot, id), filesDir = join(dir, 'files');
    await mkdir(filesDir, { recursive: true }); await mkdir(this.downloadRoot, { recursive: true });
    let coveredFiles = 0;
    for (const name of OFFICIAL_PATHS) { const source = join(this.root, name); if (await exists(source)) { await cp(source, join(filesDir, name), { recursive: true }); coveredFiles += await countFiles(source); } }
    const archiveFile = join(this.downloadRoot, `${id}-${basename(input.assetName)}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`更新包下载失败：${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archiveFile));
    if (input.sha256) {
      const actual = createHash('sha256').update(await readFile(archiveFile)).digest('hex');
      if (actual.toLowerCase() !== input.sha256.toLowerCase()) throw new Error('更新包 SHA-256 校验失败');
    }
    if (!/\.zip$/i.test(input.assetName)) throw new Error('自动安装首版仅支持 zip 更新包');
    const staging = join(this.downloadRoot, `${id}-staging`); await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
    const zip = new AdmZip(archiveFile);
    const entries = zip.getEntries();
    if (entries.length > 20_000) throw new Error('更新包文件数量异常');
    let totalSize = 0;
    for (const entry of entries) {
      const normalized = entry.entryName.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new Error('更新包包含不安全路径');
      totalSize += entry.header.size; if (totalSize > 500 * 1024 * 1024) throw new Error('更新包解压后超过 500MB');
    }
    zip.extractAllTo(staging, true);
    const { readdir } = await import('node:fs/promises');
    const top = await readdir(staging); const candidateRoot = top.length === 1 && (await stat(join(staging, top[0]!))).isDirectory() ? join(staging, top[0]!) : staging;
    if (!(await exists(join(candidateRoot, 'package.json'))) || !(await exists(join(candidateRoot, 'public', 'index.html')))) throw new Error('更新包不是有效的需求池软件包');
    for (const name of OFFICIAL_PATHS) {
      const source = join(candidateRoot, name); if (!(await exists(source))) continue;
      const target = join(this.root, name); const temp = target + '.update-' + randomUUID().slice(0, 6);
      await rm(temp, { recursive: true, force: true }); await cp(source, temp, { recursive: true }); await rm(target, { recursive: true, force: true }); await rename(temp, target);
    }
    await rm(staging, { recursive: true, force: true });
    const record: BackupRecord = { id, createdAt: Date.now(), fromVersion: input.fromVersion, toVersion: input.toVersion, backupDir: filesDir, archiveFile, status: '已更新，等待重启', coveredFiles };
    await writeFile(join(dir, 'record.json'), JSON.stringify(record, null, 2));
    return record;
  }

  async restore(id: string): Promise<BackupRecord> {
    if (!/^[A-Za-z0-9_.:-]+$/.test(id)) throw new Error('备份 ID 不正确');
    const record = JSON.parse(await readFile(join(this.backupRoot, id, 'record.json'), 'utf8')) as BackupRecord;
    for (const name of OFFICIAL_PATHS) {
      const source = join(record.backupDir, name); if (!(await exists(source))) continue;
      const target = resolve(this.root, name); if (!target.startsWith(resolve(this.root))) throw new Error('还原路径越界');
      const temp = target + '.restore-' + randomUUID().slice(0, 6); await rm(temp, { recursive: true, force: true }); await cp(source, temp, { recursive: true }); await rm(target, { recursive: true, force: true }); await rename(temp, target);
    }
    record.status = '已还原'; await writeFile(join(this.backupRoot, id, 'record.json'), JSON.stringify(record, null, 2)); return record;
  }
}
