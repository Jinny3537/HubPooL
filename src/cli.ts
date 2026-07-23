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
  if (!host || /[\s/:\\]/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host !== '::1') {
    throw new Error('监听地址格式不正确；请使用 127.0.0.1、0.0.0.0、::1 或合法主机名');
  }
  return host;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const program = new Command();
program.name('reqpool').description('多项目需求池本地管理软件').version('1.0.0');

program
  .command('start', { isDefault: true })
  .description('启动本地需求池管理服务')
  .option('--host <host>', '监听地址', process.env.REQPOOL_HOST ?? '127.0.0.1')
  .option('--port <port>', '监听端口', parsePort, parsePort(process.env.REQPOOL_PORT ?? '8080'))
  .option('--open', '启动后打开默认浏览器', false)
  .option('--data-dir <path>', '数据库目录')
  .action(async (options: { host: string; port: number; open: boolean; dataDir?: string }) => {
    const host = validateHost(options.host);
    const paths = envPaths('requirement-pool-local');
    const dataDir = resolve(options.dataDir ?? paths.data);
    mkdirSync(dataDir, { recursive: true });
    const publicDir = resolve(packageRoot, 'public');
    const database = new AppDatabase(resolve(dataDir, 'requirements.db'));
    const { app, accessToken } = await createServer({ host, port: options.port, openBrowser: options.open, dataDir, publicDir, projectDir: packageRoot }, database);

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
      if (accessToken) {
        console.log('\n当前为局域网模式。API 访问令牌（仅显示一次）：');
        console.log(accessToken);
        console.log('请只在可信局域网使用，并妥善保管令牌。\n');
      }
      if (options.open) await open(url);
    } catch (error) {
      database.close();
      throw error;
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
