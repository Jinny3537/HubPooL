/* ========== MCP 客户端（v0.2.3，实验性）==========
 *
 * HubPooL 既是 MCP 服务端（给本地 AI CLI 用），这里让它也能作为 MCP 客户端去连
 * 用户在「项目设置 -> Jira 同步」里配置的外部 Jira MCP 服务，从而把版本需求同步到本地 Jira。
 *
 * 支持两种传输：
 *   - stdio：HubPooL 用子进程拉起 MCP 服务（如 npx -y mcp-atlassian）。这会在本机执行进程，
 *     风险等级与 localAgents 一致，因此调用方必须先用 assertLoopbackForStdio() 校验请求来自回环
 *     地址（127.0.0.1/::1）——不放宽给局域网，哪怕开了局域网访问令牌也不放行。
 *   - http：用户自己运行 MCP 服务，HubPooL 通过 URL + 可选请求头连接，不涉及本机子进程，
 *     局域网可用（仍受局域网访问令牌/密码网关控制）。
 *
 * 连接生命周期：withMcpClient 打开一条连接、跑完回调、确保 close。一次版本同步复用同一条连接
 * 逐条调用 create/update 工具，避免反复握手。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { codedError } from './errors.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JiraSyncConfig } from './types.js';
import { z } from 'zod';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: unknown;
}

/** 判断 Fastify request.remoteAddress 是否回环。stdio 类操作只允许回环调用。 */
export function isLoopback(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

/**
 * stdio 传输会在 HubPooL 主机上 spawn 子进程，风险高于普通数据接口，因此与 localAgents 一致：
 * 只允许回环调用。局域网请求（即使带了正确的访问令牌/密码）也直接拒绝。
 * 抛出带 code=LOOPBACK_REQUIRED 的错误，由路由层转成 403。
 */
export function assertLoopbackForStdio(config: JiraSyncConfig, remoteAddress: string | undefined | null): void {
  if (config.transport === 'stdio' && !isLoopback(remoteAddress)) {
    throw codedError('LOOPBACK_REQUIRED', 'stdio 方式的 Jira MCP 服务只能在本机（127.0.0.1）调用，局域网设备请改用 http 方式');
  }
}

function buildTransport(config: JiraSyncConfig) {
  if (config.transport === 'stdio') {
    if (!config.command || !config.command.trim()) {
      throw codedError('JIRA_CONFIG_INVALID', 'stdio 方式需要填写启动命令（command）');
    }
    // 显式带上 process.env，保证 PATH 等可用（npx/node 才找得到），再叠加用户配置的 env。
    // process.env 的值可能是 undefined，需过滤成纯 string。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    Object.assign(env, config.env ?? {});
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
      stderr: 'inherit',
    });
  }
  if (!config.url || !config.url.trim()) {
    throw codedError('JIRA_CONFIG_INVALID', 'http 方式需要填写 MCP 服务 URL');
  }
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw codedError('JIRA_CONFIG_INVALID', `MCP 服务 URL 格式不正确：${config.url}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw codedError('JIRA_CONFIG_INVALID', 'MCP 服务 URL 必须以 http:// 或 https:// 开头');
  }
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

/** 打开一条 MCP 连接，执行回调，无论成功失败都关闭连接。 */
export async function withMcpClient<T>(config: JiraSyncConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'hubpool-jira-client', version: '0.2.3' }, { capabilities: {} });
  const transport = buildTransport(config);
  try {
    await client.connect(transport);
  } catch (err) {
    try { await client.close(); } catch { /* 忽略关闭错误 */ }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`无法连接 Jira MCP 服务：${msg}`);
  }
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* 忽略关闭错误 */ }
  }
}

/**
 * 宽松工具结果 schema：structuredContent 接受任意类型。
 * assess-task-mcp 的 create/update 把任务 id 作为数字直接塞进 structuredContent 返回，违反 MCP
 * 「structuredContent 必须是 record」约定；SDK 默认 CallToolResultSchema 会抛
 * ZodError「expected record, received number」。这里用 z.unknown() 放开 structuredContent。
 */
const LooseToolResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
}).passthrough();

/** callToolRaw 返回的原始工具结果。structuredContent 可能是对象、数组、数字、字符串等。 */
export interface RawToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * 调工具并返回原始结果，绕过 SDK 对 structuredContent 必须为 record 的校验，也绕过 callTool 内置的
 * outputSchema 二次校验。用 client.request 直发 tools/call + 宽松 schema，拿到服务端原始 JSON。
 * 适用于 assess-task-mcp 这类 structuredContent 非标准的服务端。
 */
export async function callToolRaw(client: Client, name: string, args: Record<string, unknown>): Promise<RawToolResult> {
  return client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    LooseToolResultSchema,
  ) as Promise<RawToolResult>;
}

/** 连接 -> tools/list -> 关闭。返回工具清单（供前端「加载工具」下拉用）。 */
export async function listMcpTools(config: JiraSyncConfig): Promise<McpToolInfo[]> {
  return withMcpClient(config, async (client) => {
    const res = await client.listTools();
    return (res.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  });
}
