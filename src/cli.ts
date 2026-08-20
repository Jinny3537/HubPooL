import { Command } from 'commander';
import envPaths from 'env-paths';
import open from 'open';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppDatabase } from './database.js';
import { createServer } from './server.js';

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1—65535 的整数');
  return port;
}

function validateHost(host: string): string {
  if (!host) {
    throw new Error('监听地址不能为空');
  }
  // 拒绝「数字+点」但不是合法 IPv4 的地址（常见于把端口拼进地址，如 100.100.60.122.8080）
  if (/^[\d.]+$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new Error('监听地址格式不正确：看起来像 IP 但不是合法 IPv4；局域网访问请使用 0.0.0.0');
  }
  if (/[\s/:\\]/.test(host) && host !== '::1') {
    throw new Error('监听地址格式不正确；请使用 127.0.0.1、0.0.0.0、::1 或合法主机名');
  }
  return host;
}

/**
 * 读取数据库里「系统设置 -> 网络配置」保存的监听地址。
 * 仅在用户开启了「允许局域网设备访问」时返回保存的地址，否则返回 null（回退到 127.0.0.1）。
 * 这样 UI 里的监听地址配置在重启后才会真正生效——否则启动器/CLI 始终默认 127.0.0.1，局域网永远连不上。
 */
function readSavedHost(database: AppDatabase): string | null {
  try {
    const net = database.load().data.settings?.network as { lanEnabled?: unknown; listenHost?: unknown } | undefined;
    if (net?.lanEnabled && typeof net.listenHost === 'string' && net.listenHost.trim()) {
      const host = net.listenHost.trim();
      try {
        validateHost(host);
        return host;
      } catch {
        // 保存的监听地址无效（常见于误填成「IP.端口」或「IP:端口」）。用户已开启局域网访问，
        // 这里回退到 0.0.0.0 让服务能正常起来，并提示去设置里修正，而不是直接崩溃。
        console.warn(`⚠️ 系统设置中保存的监听地址「${host}」无效，已临时改用 0.0.0.0 开启局域网访问。请到「设置 -> 网络配置」把监听地址改为 0.0.0.0。`);
        return '0.0.0.0';
      }
    }
  } catch {
    // 数据库读取失败时不阻断启动，回退到默认 127.0.0.1。
  }
  return null;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const program = new Command();
program.name('reqpool').description('多项目需求池本地管理软件').version('0.9.6');

program
  .command('start', { isDefault: true })
  .description('启动本地需求池管理服务')
  .option('--host <host>', '监听地址（未指定时优先读 REQPOOL_HOST 环境变量，再读系统设置，最后默认 127.0.0.1）')
  .option('--port <port>', '监听端口', parsePort, parsePort(process.env.REQPOOL_PORT ?? '8080'))
  .option('--open', '启动后打开默认浏览器', false)
  .option('--data-dir <path>', '数据库目录')
  .action(async (options: { host?: string; port: number; open: boolean; dataDir?: string }) => {
    const paths = envPaths('requirement-pool-local');
    const dataDir = resolve(options.dataDir ?? paths.data);
    mkdirSync(dataDir, { recursive: true });
    const publicDir = resolve(packageRoot, 'public');
    const database = new AppDatabase(resolve(dataDir, 'requirements.db'));
    // 监听地址优先级：显式 --host > REQPOOL_HOST 环境变量 > 数据库系统设置（开启局域网时）> 127.0.0.1
    const explicitHost = (options.host ?? process.env.REQPOOL_HOST)?.trim();
    const host = validateHost(explicitHost || readSavedHost(database) || '127.0.0.1');
    const { app } = await createServer({ host, port: options.port, openBrowser: options.open, dataDir, publicDir, projectDir: packageRoot }, database);

    const close = async () => {
      await app.close();
      database.close();
      process.exit(0);
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);

    try {
      await app.listen({ host, port: options.port });
      const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
      const url = `http://${browserHost}:${options.port}`;
      console.log(`\n需求池已启动：${url}`);
      console.log(`SQLite 数据库：${resolve(dataDir, 'requirements.db')}`);
      if (options.open) await open(url);
    } catch (error) {
      database.close();
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOTFOUND' || code === 'EADDRNOTAVAIL') {
        throw new Error(`无法监听 ${host}:${options.port}（${code}）。保存的监听地址无效或本机不存在该网卡。请在「设置 -> 网络配置」中改用 0.0.0.0，或用 REQPOOL_HOST=0.0.0.0 启动。`);
      }
      throw error;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
