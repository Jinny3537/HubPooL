/* ========== 本地 AI CLI 直连（实验性，v0.2.1）==========
 *
 * 这不是完整的 Agent Client Protocol（ACP）实现——只是把「向本地已安装的 AI CLI 工具
 * 发一条非交互 prompt、拿回文本输出」这件事做成一个受控的子进程调用，取代原来纯手工
 * 复制粘贴的方式。设计上刻意收紧了几件事：
 *
 * 1. 只允许调用下面注册表里的固定二进制名，不接受客户端传来的任意命令。
 * 2. 用 execFile 风格的 argv 数组 spawn（shell: false），杜绝 shell 注入。
 * 3. 每个 Agent 的「非交互执行参数模板」用户可见可改；只有 Claude Code 给了一个我们
 *    有把握的默认值，其余的默认留空，避免用错误的参数悄悄跑起来。
 * 4. 调用这些接口必须来自回环地址（127.0.0.1/::1），不受局域网访问令牌/密码放行——
 *    这是比数据同步更高一级的风险：一旦放开，相当于允许远端触发本机执行进程。
 * 5. 不注入任何"跳过权限确认"之类的参数。执行内容如果来自需求/批注这类可能被他人
 *    编辑过的文本，存在 prompt注入 风险，尤其是像 Claude Code / Codex CLI 这类本身
 *    具备文件读写、命令执行能力的 Agent——这一点必须在 UI 上对用户可见，不能只在代码注释里。
 */

import { spawn } from 'node:child_process';

export interface AgentDef {
  id: string;
  label: string;
  bin: string;
}

export const AGENT_REGISTRY: AgentDef[] = [
  { id: 'claude-code', label: 'Claude Code', bin: 'claude' },
  { id: 'codex-cli', label: 'Codex CLI', bin: 'codex' },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode' },
  { id: 'cursor-cli', label: 'Cursor CLI', bin: 'cursor-agent' },
  { id: 'qoder-cli', label: 'Qoder CLI', bin: 'qoder' },
  { id: 'codebuddy-cli', label: 'CodeBuddy CLI', bin: 'codebuddy' },
  { id: 'reasonix-cli', label: 'Reasonix CLI', bin: 'reasonix' },
  { id: 'grok-build', label: 'Grok Build', bin: 'grok' },
];

// 只有这一个我们有信心：Claude Code 的 `-p/--print` 是文档化的非交互模式。
// 其余工具的确切 CLI 参数在不同版本间变化较大，宁可留空让用户自己确认，也不猜错。
export const DEFAULT_EXEC_TEMPLATE: Record<string, string> = {
  'claude-code': '-p {prompt}',
};

export function findAgent(id: string): AgentDef | undefined {
  return AGENT_REGISTRY.find((a) => a.id === id);
}

interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string; }

function runProcess(bin: string, args: string[], timeoutMs: number, outputCapBytes: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    let stdout = '', stderr = '', settled = false, didTimeout = false;
    let child;
    try {
      child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      didTimeout = true;
      child.kill('SIGTERM');
      setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2000);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < outputCapBytes) stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < outputCapBytes) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, timedOut: didTimeout, spawnError: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : error.message });
    });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolvePromise({ code, stdout: stdout.slice(0, outputCapBytes), stderr: stderr.slice(0, outputCapBytes), timedOut: didTimeout });
    });
  });
}

export interface DetectResult { installed: boolean; version: string | null; error: string | null; }

export async function detectAgent(bin: string, timeoutMs = 6000): Promise<DetectResult> {
  const r = await runProcess(bin, ['--version'], timeoutMs, 4000);
  if (r.timedOut) return { installed: false, version: null, error: '检测超时' };
  if (r.spawnError === 'ENOENT') return { installed: false, version: null, error: '未检测到该命令，可能未安装或不在 PATH 中' };
  if (r.spawnError) return { installed: false, version: null, error: r.spawnError };
  const text = (r.stdout || r.stderr).trim();
  if (r.code !== 0 && !text) return { installed: false, version: null, error: `退出码 ${r.code ?? '未知'}` };
  return { installed: true, version: (text.split('\n')[0] ?? '').slice(0, 120) || '已安装（无版本输出）', error: null };
}

export interface RunAgentResult { output: string; latencyMs: number; }

/* ---------- AI 工作台（v0.2.1）：Claude Code + HubPooL MCP 工具服务 ----------
 * 目前只对 Claude Code 做了验证过的 MCP 接线：--mcp-config 指向 HubPooL 自己暴露的
 * /mcp 端点，--strict-mcp-config 确保它不会顺带捡到用户机器上其它项目配置的 MCP 服务，
 * --allowedTools 锁死只能用 hubpool 暴露的这些工具（只读查询 + "生成待确认提案"两类），
 * 不给文件系统/命令行访问权限。其它 CLI（Codex 等）要接同样的 MCP 服务，需要各自的
 * 配置方式，目前没有实现——可以在「AI 设置」里用它们自己的执行参数模板手动接。
 */
const HUBPOOL_MCP_ALLOWED_TOOLS = [
  'mcp__hubpool__list_projects',
  'mcp__hubpool__list_requirements',
  'mcp__hubpool__get_requirement_detail',
  'mcp__hubpool__list_versions',
  'mcp__hubpool__propose_create_requirement',
  'mcp__hubpool__propose_edit_requirement',
  'mcp__hubpool__propose_batch_update_requirements',
  'mcp__hubpool__propose_split_requirement',
].join(',');

// 需求标准化规则：这是"AI 工作台"的核心行为约定，不只是措辞——直接决定了 propose_* 工具
// 被调用时草案的质量。用户明确要求了这四条：独立诉求拆分、模块与范围明确、缺失信息标记
// 「待确认」而不是瞎编、验收标准要能逐条独立验证。
const REQUIREMENT_STANDARDIZATION_RULES = [
  '和用户对话时，把模糊的口语化描述整理成规范需求，遵守下面几条规则：',
  '1. 拆分独立诉求：如果用户一句话里其实包含多个互不依赖、可以分开排期验收的诉求，拆成多条 propose_create_requirement，不要揉进一条里；如果多个点其实是同一个诉求的不同方面（比如"做什么"和"为什么"），就不拆。拿不准算不算独立诉求时，先用文字问用户，不要自己猜着拆或不拆。',
  '2. 模块与范围要明确：module（所属模块）和 impactScope（影响范围）尽量给出具体值；用户没说清楚就先追问，而不是空着或编一个。',
  '3. 缺失信息一律标记「待确认」：任何字段如果信息不足以下结论，不要编造，写成「待确认：具体缺什么」（例如"待确认：目标用户群体"），不要留空、也不要用"暂无"这种掩盖信息缺失的说法。',
  '4. 验收标准要可独立测试：acceptanceCriteria 写成分点列表，每一条都是一个能单独判断"过/不过"的具体场景或断言，不要写成笼统的一句话（例如不要写"功能正常可用"，要写"输入合法手机号后点击发送，5 秒内收到验证码短信"这种可验证的条目）。',
  '5. 这是多轮对话：如果关键信息（诉求边界、模块范围、验收场景）明显不足以支撑一条像样的需求草稿，先用文字向用户提问澄清，不要第一轮就急着调用 propose_create_requirement 生成一条全是「待确认」的草稿；但也不要没完没了地追问——如果用户已经明确表示"先这样、别的以后再说"，就按规则 3 把仍然不确定的部分标成待确认，正常生成提案。',
].join('\n');

export interface ChatTurnResult { output: string; latencyMs: number; sessionId: string; isError: boolean; }

/** Claude Code `--model` 接受的模型档位别名（会自动解析成该档位当前最新的具体模型）。
 *  用别名而不是写死具体模型全名，是为了不会因为 Anthropic 发新模型就过期。 */
export const CLAUDE_MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'] as const;
export type ClaudeModelAlias = (typeof CLAUDE_MODEL_ALIASES)[number];

export interface RunClaudeCodeOptions {
  prompt: string;
  projectId: string;
  mcpUrl: string;
  resumeSessionId: string | null;
  model?: ClaudeModelAlias | null;
  timeoutMs?: number;
}

export async function runClaudeCodeWithMcp(options: RunClaudeCodeOptions): Promise<ChatTurnResult> {
  const { prompt, projectId, mcpUrl, resumeSessionId, model, timeoutMs = 180_000 } = options;
  // 上限放宽到 100000：这个 prompt 现在可能是"用户打的字 + 最多 3 个附件（各 ≤20000 字）"拼出来的，
  // 不再是纯手打文字；手打文字本身的 20000 字上限在 server.ts 校验 body.prompt 时已经把过了。
  if (prompt.length > 100_000) throw new Error('消息内容过长（附件+正文合计超过上限）');
  const mcpConfig = JSON.stringify({ mcpServers: { hubpool: { type: 'http', url: mcpUrl } } });
  const systemPrompt = [
    '你是 HubPooL（本地需求池管理软件）的助手，核心任务有两块：一是把用户口述的、简单模糊的需求描述通过对话整理成规范的需求草稿；二是基于需求池的真实数据回答用户的问题（智能问答/检索），或者帮用户把一条大需求拆解成多条子需求。',
    `当前项目 ID：${projectId}（除非用户明确要求换项目，否则默认在这个项目下操作）。`,
    '你只能通过名为 hubpool 的 MCP 工具服务操作需求池，一共八个工具，分两类：',
    '【只读查询】list_projects、list_requirements（支持按状态/优先级/模块/所属版本/关键词筛选）、get_requirement_detail（查单条需求全部字段）、list_versions（查版本列表）——这几个工具可以随便调用，不会改动任何数据。',
    '【生成待确认提案】propose_create_requirement/propose_edit_requirement（新建或编辑单条需求）、propose_batch_update_requirements（批量改一批需求的状态/优先级/所属版本）、propose_split_requirement（把一条需求拆解成多条子需求）——这四个工具都只会生成一条待用户在网页上确认的提案，绝不会直接写入数据，所以可以放心调用，不必因为"要不要写数据"这件事额外向用户确认。',
    '智能问答原则：只要问题涉及需求池里的具体数据（数量、清单、状态、日期、某条需求写了什么等），先调用 list_requirements/get_requirement_detail/list_versions 把真实数据取出来再回答，不要凭记忆或猜测编答案；数据里确实没有的信息就如实说没有，不要编。',
    '需求拆解原则：用户要求拆解某条需求时，先用 get_requirement_detail 看清楚原需求写了什么，再判断能不能拆出至少 2 条边界清晰、可独立排期验收的子需求；拆不出来就直接告诉用户不建议拆，不要硬拆；每条子需求都要遵守下面的需求标准化规则。',
    '除了这八个工具，你在这次会话里没有任何文件系统、命令行或其它 MCP 服务的访问权限。',
    REQUIREMENT_STANDARDIZATION_RULES,
    '请用简洁的中文回复。',
  ].join('\n');
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--append-system-prompt', systemPrompt,
    '--mcp-config', mcpConfig,
    '--strict-mcp-config',
    '--allowedTools', HUBPOOL_MCP_ALLOWED_TOOLS,
  ];
  if (model) args.push('--model', model);
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  const started = Date.now();
  const r = await runProcess('claude', args, timeoutMs, 400_000);
  const latencyMs = Date.now() - started;
  if (r.timedOut) throw new Error(`执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
  if (r.spawnError === 'ENOENT') throw new Error('未检测到 claude 命令，请先安装并登录 Claude Code CLI');
  if (r.spawnError) throw new Error(r.spawnError);
  const raw = r.stdout.trim();
  if (!raw) throw new Error(`退出码 ${r.code ?? '未知'}：${r.stderr.trim().slice(0, 300) || '没有输出'}`);
  let parsed: { result?: string; session_id?: string; is_error?: boolean } | null = null;
  try { parsed = JSON.parse(raw); } catch { /* fall through to raw-text handling below */ }
  if (!parsed || typeof parsed.result !== 'string' || typeof parsed.session_id !== 'string') {
    throw new Error(`输出格式不是预期的 JSON，可能是 Claude Code 版本差异：${raw.slice(0, 300)}`);
  }
  if (!parsed.result.trim()) throw new Error('执行成功但没有任何输出');
  return { output: parsed.result.trim(), latencyMs, sessionId: parsed.session_id, isError: Boolean(parsed.is_error) };
}

export async function runAgentPrompt(bin: string, execTemplate: string, prompt: string, timeoutMs = 120_000): Promise<RunAgentResult> {
  const template = execTemplate.trim();
  if (!template) throw new Error('还没有为这个 Agent 填写执行参数模板');
  const tokens = template.split(/\s+/).filter(Boolean);
  if (!tokens.some((t) => t.includes('{prompt}'))) throw new Error('执行参数模板必须包含 {prompt} 占位符，例如：-p {prompt}');
  if (prompt.length > 50_000) throw new Error('prompt 内容过长（超过 50000 字），请精简后再执行');
  const args = tokens.map((t) => (t.includes('{prompt}') ? t.replaceAll('{prompt}', prompt) : t));
  const started = Date.now();
  const r = await runProcess(bin, args, timeoutMs, 400_000);
  const latencyMs = Date.now() - started;
  if (r.timedOut) throw new Error(`执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`);
  if (r.spawnError === 'ENOENT') throw new Error('未检测到该命令，可能未安装或不在 PATH 中');
  if (r.spawnError) throw new Error(r.spawnError);
  if (r.code !== 0) throw new Error(`退出码 ${r.code ?? '未知'}：${r.stderr.trim().slice(0, 300) || '没有更多输出'}`);
  const output = (r.stdout.trim() || r.stderr.trim());
  if (!output) throw new Error('执行成功但没有任何输出');
  return { output, latencyMs };
}
