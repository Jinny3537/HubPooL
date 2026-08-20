/* ========== 任务平台同步编排（v0.2.9，assess-task-mcp 定制版）==========
 *
 * 把某个版本下的需求同步到「研发任务管理」平台：通过项目里配置的 MCP 服务（assess-task-mcp）
 * 调用固定工具创建/更新任务，并把返回的任务 id 回写到需求的 jiraKey 字段。
 *
 * 固定工具映射（不再让用户配工具名/参数）：
 *   - task_current_user：验证账号
 *   - task:project:manage / task:version:manage / task:sprint:manage：加载平台项目/版本/冲刺
 *   - task:item:create：创建任务（必填 projectId/taskType/title）
 *   - task:item:update：更新任务（必填 id/projectId/taskType/title）
 *
 * 字段映射固定：
 *   - 需求名 -> title
 *   - 需求详情拼装 -> descriptionDoc（Tiptap JSON）
 *   - 平台 projectId / taskType / targetVersionId / currentSprintId -> 对应入参
 *   - 需求 priority 经 priorityMap -> priority（整数）
 *
 * 三个入口（路由层）：
 *   - loadPlatformData：连 MCP 调 task_current_user + 查询工具加载平台项目/版本/冲刺。
 *   - previewVersionSync：纯本地 dry-run，不连 MCP。按 jiraKey 判定 create/update/skip。
 *   - executeVersionSync：真正连 MCP 逐条 callTool 并回写 jiraKey。stdio 由路由层保证回环。
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { codedError } from './errors.js';
import type { AppDatabase } from './database.js';
import type { JiraSyncConfig, PlatformSelection, Requirement } from './types.js';
import { withMcpClient, callToolRaw, type RawToolResult } from './mcpClient.js';

/** 固定工具名（assess-task-mcp，下划线+HTTP方法风格）。 */
export const TOOL = {
  CURRENT_USER: 'task_current_user',
  PROJECT_LIST: 'task_project_page_get',
  VERSION_LIST: 'task_version_page_get',
  SPRINT_LIST: 'task_sprint_page_get',
  ITEM_CREATE: 'task_item_create_post',
  ITEM_UPDATE: 'task_item_update_post',
  ITEM_PAGE_ALL: 'task_item_page_all_get',
} as const;

/** 任务类型枚举（assess-task-mcp 父任务类型）。 */
export const TASK_TYPES = [
  { value: 1, label: '1 Story' },
  { value: 2, label: '2 Bug' },
  { value: 3, label: '3 Task' },
  { value: 4, label: '4 Other' },
] as const;

/** 默认优先级映射：P0->1, P1->2, P2->3, P3->4。 */
export const DEFAULT_PRIORITY_MAP: Record<string, number> = { P0: 1, P1: 2, P2: 3, P3: 4 };

/** 描述拼装上下文：所属项目名 / 所属版本名（来自 database 查询，供"需求属性"段使用）。 */
export interface DescriptionCtx {
  projectName?: string;
  versionName?: string;
}

/** 字段缺省兜底：空值返回 fallback（默认「无」），与前端 buildJiraRequirementText 的 jiraSection 一致。 */
function jiraSection(value: unknown, fallback?: string): string {
  const s = (value == null ? '' : String(value)).trim();
  return s || fallback || '无';
}

/** 验收标准规整：空 -> 待确认占位；逐行转 `- [ ] ` 复选框（已是复选框的保留，去掉项目符号/序号前缀）。镜像前端 normalizeAcceptanceForJira。 */
function normalizeAcceptanceForSync(value: unknown): string {
  const s = (value == null ? '' : String(value)).trim();
  if (!s) return '- [ ] 【待确认：验收标准】';
  return s.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (/^[-*]\s*\[[ xX]\]/.test(t)) return t.replace(/^\*\s*/, '- ');
    return '- [ ] ' + t.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').replace(/^\d+[.、)]\s*/, '');
  }).filter(Boolean).join('\n');
}

/**
 * 把需求拼成任务描述文本，结构对齐前端「复制 Jira」(buildJiraRequirementText)：
 * 需求背景/目的 -> 需求描述 -> 业务规则/逻辑细节 -> 验收标准 -> 待确认事项 -> 需求属性 -> 需求ID。
 * 按用户要求「任务名称=需求名称，任务描述=其它所有内容汇总」，去掉开头的「需求标题」行
 * （任务名称已是需求名称，不重复）。各段缺省走待确认占位，与复制 Jira 保持一致。
 */
export function buildIssueDescription(r: Requirement, ctx?: DescriptionCtx): string {
  const projectName = ctx?.projectName;
  const versionName = ctx?.versionName;
  const background = jiraSection(r.businessValue, '【待确认：需求背景/业务价值】');
  const description = [
    jiraSection(r.businessDescription, '【待确认：业务需求描述】'),
    '',
    `原始需求：${jiraSection(r.rawDescription, '未提供')}`,
  ].join('\n');
  const businessRule = jiraSection(r.businessRule, '【待确认：业务规则/逻辑细节】');
  const attributes = [
    `所属项目：${projectName || '【待确认】'}`,
    `所属模块：${jiraSection(r.module, '【待确认：所属模块/页面】')}`,
    `功能点：${jiraSection(r.functionPoints, '【待确认】')}`,
    `需求类型：${jiraSection(r.type)}`,
    `优先级：${jiraSection(r.priority)}`,
    `影响范围：${jiraSection(r.impactScope, '待评估')}`,
    `所属版本：${versionName || '未分配'}`,
    `期望上线：${jiraSection(r.expectedOnlineDate, 'TBD')}`,
    `目标交付：${jiraSection(r.targetDeliveryDate, 'TBD')}`,
    `原型/资料：${jiraSection(r.protoUrl, '暂无')}`,
  ].join('\n');
  const pending: string[] = [];
  [r.businessDescription, r.businessRule, r.businessValue, r.impactScope, r.acceptanceCriteria].forEach((v) => {
    const matches = String(v ?? '').match(/【待确认[^】]*】/g) || [];
    matches.forEach((x) => { if (!pending.includes(x)) pending.push(x); });
  });
  return [
    '需求背景 / 目的',
    background,
    '',
    '需求描述',
    description,
    '',
    '业务规则 / 逻辑细节',
    businessRule,
    '',
    '验收标准',
    normalizeAcceptanceForSync(r.acceptanceCriteria),
    ...(pending.length ? ['', '待确认事项', ...pending.map((x, i) => `${i + 1}. ${x}`)] : []),
    '',
    '需求属性',
    attributes,
    '',
    `需求ID：${r.id}`,
  ].join('\n');
}

/** 把纯文本转成最小 Tiptap JSON 文档（按行拆 paragraph，空行保留为空段）。assess 的 descriptionDoc 要求 Tiptap JSON。 */
export function buildTiptapDoc(text: string): string {
  const lines = String(text ?? '').split(/\r?\n/);
  const content = lines.map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  }));
  return JSON.stringify({ type: 'doc', content });
}

/** 同步时用户选中的平台目标，作为常量传入 create 工具。taskType 为同步时选定的任务类型。 */
/** 平台目标选择（项目/版本/冲刺/任务类型）。已迁移到 types.ts 统一定义，此处 re-export 保持向后兼容。 */
export type { PlatformSelection } from './types.js';

/** 平台列表项（项目/版本/冲刺通用）。 */
export interface PlatformOption {
  id: string;
  name: string;
  status?: string;
  raw?: unknown;
}

/** loadPlatformData 返回的平台数据。versions 已过滤为规划中+进行中。 */
export interface PlatformData {
  projects: PlatformOption[];
  versions: PlatformOption[];
  sprints: PlatformOption[];
  warnings: string[];
  currentUser?: { account?: string; name?: string; role?: string };
  toolNames?: string[];
}

/** 解析优先级：r.priority 经 cfg.priorityMap 映射为整数；映射不到返回 undefined。 */
export function resolvePriority(r: Requirement, cfg: JiraSyncConfig): number | undefined {
  const p = r.priority as string | number | undefined;
  if (p === undefined || p === null) return undefined;
  const key = String(p);
  const map = cfg.priorityMap && Object.keys(cfg.priorityMap).length ? cfg.priorityMap : DEFAULT_PRIORITY_MAP;
  const v = map[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** 构造 task_item_create_post 入参。create 工具的参数是 {body: {...}} 嵌套结构。 */
export function buildCreateArgs(r: Requirement, cfg: JiraSyncConfig, platform?: PlatformSelection, ctx?: DescriptionCtx): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: r.name,
    descriptionDoc: buildTiptapDoc(buildIssueDescription(r, ctx)),
  };
  const taskType = platform?.taskType ?? cfg.defaultTaskType;
  if (taskType) body.taskType = taskType;
  if (platform?.projectId) body.projectId = Number(platform.projectId);
  if (platform?.versionId) body.targetVersionId = Number(platform.versionId);
  if (platform?.sprintId) body.currentSprintId = Number(platform.sprintId);
  const priority = resolvePriority(r, cfg);
  if (priority !== undefined) body.priority = priority;
  return { body };
}

/** 构造 task_item_update_post 入参。id 来自 jiraKey（create 回写的任务 id）；projectId/taskType 必填，用平台常量。参数是 {body:{...}}。
 *  revision 是平台乐观锁版本号（更新必填，否则平台报「数据已更新，请重新加载」），由调用方先 page_all_get 拉取当前值传入。 */
export function buildUpdateArgs(r: Requirement, cfg: JiraSyncConfig, platform: PlatformSelection | undefined, revision?: number, ctx?: DescriptionCtx): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: Number(r.jiraKey),
    title: r.name,
    descriptionDoc: buildTiptapDoc(buildIssueDescription(r, ctx)),
  };
  const taskType = platform?.taskType ?? cfg.defaultTaskType;
  if (taskType) body.taskType = taskType;
  if (platform?.projectId) body.projectId = Number(platform.projectId);
  // 更新时同样写入版本/冲刺（与 create 一致）。平台 update schema 的 body 直接接受 targetVersionId/currentSprintId（integer），
  // 无需额外布尔开关（那是 batch-update 的字段）。未选则不传，平台保留原值。
  if (platform?.versionId) body.targetVersionId = Number(platform.versionId);
  if (platform?.sprintId) body.currentSprintId = Number(platform.sprintId);
  if (revision !== undefined && Number.isFinite(revision)) body.revision = revision;
  return { body };
}

/** 预览摘要：title=值; taskType/projectId/...（描述太长跳过）。 */
export function buildMappingPreview(r: Requirement, cfg: JiraSyncConfig, platform?: PlatformSelection): string {
  const parts: string[] = [];
  const v = String(r.name ?? '');
  parts.push(`title=${v.length > 30 ? v.slice(0, 30) + '…' : v}`);
  const taskType = platform?.taskType ?? cfg.defaultTaskType;
  if (taskType) parts.push(`taskType=${taskType}`);
  if (platform?.projectId) parts.push(`projectId=${platform.projectId}`);
  if (platform?.versionId) parts.push(`targetVersionId=${platform.versionId}`);
  if (platform?.sprintId) parts.push(`currentSprintId=${platform.sprintId}`);
  const priority = resolvePriority(r, cfg);
  if (priority !== undefined) parts.push(`priority=${priority}`);
  return parts.join('; ');
}

/** 从 callTool 结果提取任务 id（整数优先）或 taskCode（如 TASK-102）。create 回写到 jiraKey。
 *  assess-task-mcp 的 create/update 可能把任务 id 作为数字直接放进 structuredContent 返回，需容错。 */
export function extractIssueKey(result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; structuredContent?: unknown }): string | null {
  if (result.isError) return null;
  const sc = (result as { structuredContent?: unknown }).structuredContent;
  // assess-task-mcp 直接把数字任务 id 作为 structuredContent 返回的情况
  if (typeof sc === 'number' && Number.isFinite(sc)) return String(sc);
  if (typeof sc === 'bigint') return String(sc);
  if (typeof sc === 'string' && /^\d+$/.test(sc.trim())) return sc.trim();
  const fromObj = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    const o2 = o as Record<string, unknown>;
    const id = o2.id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && /^\d+$/.test(id.trim())) return id.trim();
    for (const k of ['taskCode', 'taskKey', 'key', 'issueKey', 'code']) {
      const v = o2[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  if (sc !== undefined) {
    const direct = fromObj(sc);
    if (direct) return direct;
    const scObj = sc as Record<string, unknown>;
    for (const nk of ['data', 'result', 'task', 'issue', 'issueData', 'item', 'payload']) {
      const v = fromObj(scObj?.[nk]);
      if (v) return v;
    }
  }
  const text = (result.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
  const m = text.match(/\b([A-Z][A-Z0-9_]{1,}-\d+)\b/);
  return m?.[1] ?? null;
}

/**
 * 「任务不存在」识别：更新时平台任务已被删除，更新工具会返回错误。
 * 匹配任务/记录/数据/工作项 + 不存在/未找到/找不到/已删除，或英文 not found / no such / does not exist。
 *刻意要求任务类关键词，避免误判「项目不存在/版本不存在」等配置错误。
 */
const NOT_FOUND_RE = /((任务|记录|数据|工作项|item|task|record)[\s\S]{0,12}(不存在|未找到|找不到|已被?删除|已删除))|((不存在|未找到|找不到|已被?删除|已删除)[\s\S]{0,12}(任务|记录|数据|工作项|item|task|record))|(not\s*found|no\s*such\s+(?:item|task|record)|does\s*not\s*exist|record\s*not\s*found)/i;

/** 把 callToolRaw 结果里所有可能的错误文本拼出来（content text + structuredContent 各种形态）。 */
function collectResultText(res: RawToolResult): string {
  let text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n');
  const sc = res.structuredContent;
  if (typeof sc === 'string') text += '\n' + sc;
  else if (sc && typeof sc === 'object') {
    const o = sc as Record<string, unknown>;
    for (const k of ['message', 'msg', 'error', 'errMsg', 'errorMessage', 'detail']) {
      const v = o[k];
      if (typeof v === 'string') text += '\n' + v;
    }
    for (const k of ['data', 'result', 'body']) {
      const v = o[k];
      if (v && typeof v === 'object') {
        const o2 = v as Record<string, unknown>;
        for (const k2 of ['message', 'msg', 'error', 'errMsg']) {
          if (typeof o2[k2] === 'string') text += '\n' + o2[k2];
        }
      }
    }
  }
  return text;
}

/** 更新结果是否表示平台任务已不存在（被删除）。 */
export function isNotFoundResult(res: RawToolResult): boolean {
  return NOT_FOUND_RE.test(collectResultText(res));
}

/** 异常消息是否表示平台任务已不存在。 */
export function isNotFoundMessage(msg: string): boolean {
  return NOT_FOUND_RE.test(msg);
}

/**
 * 「数据已变更」识别：update 时平台乐观锁校验失败（本地 revision 过期或缺失）。
 * 典型文案「数据已更新，请重新加载后再操作」。匹配 数据已更新/变更/修改、重新加载后操作、
 * 已被他人修改、乐观锁冲突、stale data / concurrent modification / version mismatch 等。
 */
const STALE_DATA_RE = /数据已(更新|变更|修改)|重新加载后(再)?操作|已被(他人|别人)[\s\S]{0,8}(修改|更新|编辑)|乐观锁[\s\S]{0,10}(冲突|失败)|(stale[\s\S]{0,20}(data|version|record)|concurrent\s+(?:modification|update|edit)|version\s+(?:mismatch|conflict)|optimistic\s*lock)/i;

/** 更新结果是否表示平台乐观锁冲突（数据已被他人更新，需重新加载 revision 后重试）。 */
export function isStaleResult(res: RawToolResult): boolean {
  return STALE_DATA_RE.test(collectResultText(res));
}

/** 异常消息是否表示平台乐观锁冲突。 */
export function isStaleMessage(msg: string): boolean {
  return STALE_DATA_RE.test(msg);
}

/**
 * 拉取平台任务的 id->revision 映射（update 乐观锁用）。走 task_item_page_all_get，
 * 优先按 platformVersionId 过滤（versionIds 数组）；未选版本则不带过滤拉全量（按 id 建映射依然正确，只是慢）。
 * 拉取失败返回空 Map——update 将不带 revision，平台会报 stale，前端再走重试。
 */
export async function fetchVersionTaskRevisions(client: Client, platformVersionId: string | number | undefined): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  const vid = (platformVersionId === undefined || platformVersionId === null || platformVersionId === '') ? NaN : Number(platformVersionId);
  try {
    for (let pageNum = 1; pageNum <= 10; pageNum++) {
      const args: Record<string, unknown> = { pageNum, pageSize: 500 };
      if (Number.isFinite(vid)) args.versionIds = [vid];
      const res = await callToolRaw(client, TOOL.ITEM_PAGE_ALL, args);
      if (res.isError) break;
      const list = extractItemsFrom(res.structuredContent) || [];
      for (const t of list as Array<Record<string, unknown>>) {
        const rawId = t?.id;
        const id = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN);
        const rawRev = t?.revision ?? t?.taskRevision ?? t?.rev;
        const rev = typeof rawRev === 'number' ? rawRev : (typeof rawRev === 'string' && /^\d+$/.test(rawRev) ? Number(rawRev) : NaN);
        if (Number.isFinite(id) && Number.isFinite(rev)) {
          map.set(id, rev);
        }
      }
      if (list.length < 500) break;
    }
  } catch {
    /* 拉取失败不阻断同步，update 退化为不带 revision，平台报 stale 后走重试 */
  }
  return map;
}

/**
 * 取单条任务的平台 revision（update 乐观锁用）。
 * 策略：先查版本过滤映射（调用方已构建则直接命中）；取不到则按 projectIds 不限版本回退查 page_all
 * --任务可能不在所选版本里（versionIds 过滤会漏掉它），这时 update 会因 revision 缺失被平台判 stale，
 * 且 stale 后 update 失败、targetVersionId 不生效、任务留在版本外，形成「取不到 revision -> 更新失败 -> 留在版本外」死循环。
 * 此回退打破该循环：拿到 revision -> update 成功 -> targetVersionId 生效 -> 任务进入所选版本。
 * 返回 undefined 表示找不到或响应无 revision 字段。
 */
export async function fetchTaskRevision(
  client: Client,
  taskId: string | number,
  platform: { projectId?: string | number | null } | undefined,
  revMap?: Map<number, number>,
): Promise<number | undefined> {
  const id = Number(taskId);
  if (!Number.isFinite(id)) return undefined;
  if (revMap) {
    const hit = revMap.get(id);
    if (hit !== undefined) return hit;
  }
  const pidRaw = platform?.projectId;
  const pid = pidRaw === undefined || pidRaw === null || pidRaw === '' ? NaN : Number(pidRaw);
  try {
    for (let pageNum = 1; pageNum <= 20; pageNum++) {
      const args: Record<string, unknown> = { pageNum, pageSize: 500 };
      if (Number.isFinite(pid)) args.projectIds = [pid];
      const res = await callToolRaw(client, TOOL.ITEM_PAGE_ALL, args);
      if (res.isError) break;
      const list = extractItemsFrom(res.structuredContent) || [];
      for (const t of list as Array<Record<string, unknown>>) {
        const rawId = t?.id;
        const tid = typeof rawId === 'number' ? rawId : (typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : NaN);
        if (tid === id) {
          const rawRev = t?.revision ?? t?.taskRevision ?? t?.rev;
          const rev = typeof rawRev === 'number' ? rawRev : (typeof rawRev === 'string' && /^\d+$/.test(rawRev) ? Number(rawRev) : NaN);
          return Number.isFinite(rev) ? rev : undefined;
        }
      }
      if (list.length < 500) break;
    }
  } catch {
    /* 忽略，返回 undefined */
  }
  return undefined;
}

// ===== 平台数据加载 =====

const PLATFORM_KNOWN_KEYS = ['list', 'items', 'records', 'data', 'result', 'projects', 'versions', 'sprints', 'rows', 'content'];

/** 递归找第一个「元素为纯对象且非 MCP content(type/text)」的数组，最多深入 4 层。 */
export function findBusinessArray(obj: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || !obj || typeof obj !== 'object') return null;
  const isBusinessArray = (arr: unknown[]): boolean =>
    arr.length > 0 && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && !arr.some((x) => 'type' in (x as object) && 'text' in (x as object));
  if (Array.isArray(obj)) return isBusinessArray(obj) ? obj : null;
  const o = obj as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v) && isBusinessArray(v)) return v;
  }
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findBusinessArray(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractItemsFrom(src: unknown): unknown[] {
  if (Array.isArray(src)) return src;
  if (src && typeof src === 'object') {
    const found = findBusinessArray(src);
    if (found) return found;
    const o = src as Record<string, unknown>;
    for (const k of PLATFORM_KNOWN_KEYS) {
      if (Array.isArray(o[k])) return o[k];
    }
  }
  return [];
}

/** 从 callTool 结果容错提取列表：structuredContent 优先，其次 content text 解析 JSON。 */
export function extractList(result: unknown): PlatformOption[] {
  const sc = (result as { structuredContent?: unknown })?.structuredContent;
  if (sc !== undefined) {
    const opts = extractItemsFrom(sc).map(normalizeOption).filter((o): o is PlatformOption => !!o);
    if (opts.length) return opts;
  }
  if (Array.isArray((result as { content?: unknown[] })?.content)) {
    const text = ((result as { content: Array<{ type?: string; text?: string }> }).content ?? [])
      .map((c) => (c?.type === 'text' ? c.text ?? '' : ''))
      .join('\n')
      .trim();
    if (text) {
      try {
        const opts = extractItemsFrom(JSON.parse(text)).map(normalizeOption).filter((o): o is PlatformOption => !!o);
        if (opts.length) return opts;
      } catch { /* 非 JSON 文本，忽略 */ }
    }
  }
  return [];
}

export function normalizeOption(item: unknown): PlatformOption | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const id = String(o.id ?? o.uuid ?? o.code ?? o.key ?? o.projectId ?? o.versionId ?? o.sprintId ?? o.projectCode ?? o.versionCode ?? '');
  const name = String(o.name ?? o.title ?? o.label ?? o.projectName ?? o.versionName ?? o.sprintName ?? '');
  const status = o.status ?? o.state ?? o.phase ?? o.statusName ?? o.statusCode ?? o.stateName;
  if (!id && !name) return null;
  return { id: id || name, name: name || id, status: status ? String(status) : undefined, raw: item };
}

/** 过滤版本为「规划中 + 进行中」。若所有项都无 status 字段则全保留；若 status 全为数字码（平台返回 integer 状态）则无法按文本判断，全保留供用户选择。 */
export function filterActiveVersions(versions: PlatformOption[]): PlatformOption[] {
  if (!versions.some((v) => v.status)) return versions;
  const hasTextStatus = versions.some((v) => v.status && !/^\d+$/.test(String(v.status)));
  if (!hasTextStatus) return versions;
  return versions.filter((v) => /规划|进行|plan|progress|active|open|启动|开发|未完|未结/i.test(v.status ?? ''));
}

/** 从 task_current_user 结果提取账号信息。 */
function extractCurrentUser(result: unknown): { account?: string; name?: string; role?: string } | undefined {
  const sc = (result as { structuredContent?: unknown })?.structuredContent;
  const obj = (sc && typeof sc === 'object' ? sc : undefined) as Record<string, unknown> | undefined;
  if (!obj) return undefined;
  const pickStr = (keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  return {
    account: pickStr(['account', 'username', 'loginName']),
    name: pickStr(['name', 'fullName', 'displayName', 'realName']),
    role: pickStr(['role', 'roleName', 'roleCode']),
  };
}

async function fetchAndParse(client: Client, toolName: string, args: Record<string, unknown>, label: string, warnings: string[]): Promise<PlatformOption[]> {
  try {
    const res = await callToolRaw(client, toolName, args);
    const items = extractList(res);
    if (!items.length) {
      warnings.push(`「${toolName}」(${label}) 未解析到数据。原始返回(前500字): ${JSON.stringify(res).slice(0, 500)}`);
    }
    return items;
  } catch (e) {
    warnings.push(`「${toolName}」(${label}) 调用失败: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * 连 MCP，先调 task_current_user 验证账号，再加载平台项目；若提供 platformProjectId 则同时加载版本/冲刺。
 * 项目查询传 {pageNum:1,pageSize:500}；版本/冲刺查询传 {projectId,pageNum:1,pageSize:500}。
 */
export async function loadPlatformData(cfg: JiraSyncConfig, platformProjectId?: string): Promise<PlatformData> {
  return withMcpClient(cfg, async (client) => {
    const warnings: string[] = [];
    let toolNames: string[] = [];
    try {
      const tl = await client.listTools();
      toolNames = (tl.tools ?? []).map((t) => t.name);
    } catch (e) {
      warnings.push(`listTools 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    let currentUser: PlatformData['currentUser'] = undefined;
    try {
      const cu = await callToolRaw(client, TOOL.CURRENT_USER, {});
      currentUser = extractCurrentUser(cu);
      if (!currentUser) warnings.push('task_current_user 未解析到账号信息');
    } catch (e) {
      warnings.push(`验证账号失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    const projects = await fetchAndParse(client, TOOL.PROJECT_LIST, { pageNum: 1, pageSize: 500 }, '项目', warnings);
    let versions: PlatformOption[] = [];
    let sprints: PlatformOption[] = [];
    if (platformProjectId) {
      const pid = Number(platformProjectId);
      versions = await fetchAndParse(client, TOOL.VERSION_LIST, { projectId: pid, pageNum: 1, pageSize: 500 }, '版本', warnings);
      sprints = await fetchAndParse(client, TOOL.SPRINT_LIST, { projectId: pid, pageNum: 1, pageSize: 500 }, '冲刺', warnings);
    }
    return { projects, versions: filterActiveVersions(versions), sprints, warnings, currentUser, toolNames };
  });
}

// ===== 预览 / 执行 =====

export type JiraSyncAction = 'create' | 'update' | 'recreate' | 'skip';

export interface JiraSyncPlanItem {
  requirementId: string;
  requirementName: string;
  priority?: string;
  action: JiraSyncAction;
  jiraKey?: string | null;
  plannedSummary: string;
  mappingPreview: string;
  descriptionPreview: string;
  reason?: string;
}

export interface JiraSyncPreview {
  versionId: string;
  versionName: string;
  items: JiraSyncPlanItem[];
  counts: { create: number; update: number; skip: number };
  warnings: string[];
}

/**
 * 读取任务同步配置。任务同步是全项目通用能力，优先取 settings.taskSync.config；
 * project.jiraSync 仅作为旧数据兼容兜底，避免历史项目在迁移前不可用。
 */
export function readProjectJiraConfig(database: AppDatabase, projectId: string): JiraSyncConfig | undefined {
  const { data } = database.load();
  const g = data.settings?.taskSync?.config;
  if (g && typeof g === 'object' && g.enabled !== undefined) return g;
  const project = data.projects.find((p) => p.id === projectId);
  if (project?.jiraSync && project.jiraSync.enabled !== undefined) return project.jiraSync;
  return undefined;
}

interface Ctx { cfg: JiraSyncConfig; projectName: string; versionName: string; reqs: Requirement[]; warnings: string[]; }

function prepareCtx(database: AppDatabase, projectId: string, versionId: string): Ctx {
  const { data } = database.load();
  const project = data.projects.find((p) => p.id === projectId);
  if (!project) throw codedError('NOT_FOUND', '找不到项目');
  const version = data.versions.find((v) => v.id === versionId && v.projectId === projectId);
  if (!version) throw codedError('NOT_FOUND', '找不到版本');
  const cfg = readProjectJiraConfig(database, projectId);
  const warnings: string[] = [];
  if (!cfg || !cfg.enabled) throw codedError('JIRA_NOT_CONFIGURED', '未启用任务同步，请先在「系统设置 -> 任务同步」里配置');
  const reqs = data.requirements.filter((r) => r.versionId === versionId && r.projectId === projectId);
  return { cfg, projectName: project.name, versionName: version.name, reqs, warnings };
}

/** 判定同步动作：无 jiraKey -> create；jiraKey 为数字 id -> update；jiraKey 非数字（旧 taskCode）-> skip。 */
function decideAction(r: Requirement): { action: JiraSyncAction; reason?: string } {
  const key = typeof r.jiraKey === 'string' ? r.jiraKey.trim() : '';
  if (!key) return { action: 'create' };
  if (/^\d+$/.test(key)) return { action: 'update' };
  return { action: 'skip', reason: '已有非数字 key（旧映射），无法更新，请手动处理' };
}

/** 纯本地 dry-run：不连 MCP，按 jiraKey 判定 create/update/skip。platform 用于预览映射。 */
export function previewVersionSync(database: AppDatabase, projectId: string, versionId: string, platform?: PlatformSelection): JiraSyncPreview {
  const { cfg, projectName, versionName, reqs, warnings } = prepareCtx(database, projectId, versionId);
  if (platform?.taskType === undefined && !cfg.defaultTaskType) warnings.push('未选择任务类型(taskType)，创建任务将失败');
  if (!platform?.projectId) warnings.push('未选择平台项目，创建任务将失败');
  const items: JiraSyncPlanItem[] = reqs.map((r) => {
    const { action, reason } = decideAction(r);
    return {
      requirementId: r.id,
      requirementName: r.name,
      priority: r.priority as string | undefined,
      action,
      jiraKey: r.jiraKey ?? null,
      plannedSummary: r.name,
      mappingPreview: buildMappingPreview(r, cfg, platform),
      descriptionPreview: buildIssueDescription(r, { projectName, versionName }).slice(0, 240),
      reason,
    };
  });
  const counts = {
    create: items.filter((i) => i.action === 'create').length,
    update: items.filter((i) => i.action === 'update').length,
    skip: items.filter((i) => i.action === 'skip').length,
  };
  return { versionId, versionName, items, counts, warnings };
}

export interface JiraSyncResultItem {
  requirementId: string;
  requirementName: string;
  action: JiraSyncAction;
  ok: boolean;
  jiraKey?: string | null;
  error?: string;
  /** 更新时发现平台任务已不存在（被删除），待前端确认后重建。不算作 failed。 */
  missing?: boolean;
  /** 更新时平台乐观锁校验失败（revision 过期/缺失，数据已被他人更新），待前端确认后重试。不算作 failed。 */
  stale?: boolean;
}

export interface JiraSyncExecuteResult {
  versionId: string;
  results: JiraSyncResultItem[];
  counts: { created: number; updated: number; recreated: number; skipped: number; missing: number; stale: number; failed: number };
  revision: number;
}

/**
 * 真正连 MCP 逐条同步。platform 的 projectId/taskType/versionId/sprintId 作为常量传入。stdio 由路由层保证回环。
 *
 * 三种模式：
 * - 正常同步：按 decideAction 决定 create/update。update 前先拉本版本 revision 映射，传入乐观锁版本号。
 *   若平台报「数据已更新」（revision 过期/缺失或被他人改动），标记 stale（不算 failed），前端确认后走 reload。
 * - 重建模式（recreateRequirementIds）：仅处理指定需求，强制走 create（平台任务已删除）。
 * - 重试模式（reloadRequirementIds）：仅处理指定需求，重新拉最新 revision 后再走 update（解决 stale）。
 */
export async function executeVersionSync(
  database: AppDatabase,
  projectId: string,
  versionId: string,
  platform?: PlatformSelection,
  recreateRequirementIds?: string[],
  reloadRequirementIds?: string[],
): Promise<JiraSyncExecuteResult> {
  const { cfg, projectName, versionName, reqs } = prepareCtx(database, projectId, versionId);
  const results: JiraSyncResultItem[] = [];
  const keyUpdates: Array<{ id: string; jiraKey: string | null; syncedAt?: number }> = [];

  const recreateSet = recreateRequirementIds && recreateRequirementIds.length ? new Set(recreateRequirementIds) : null;
  const reloadSet = reloadRequirementIds && reloadRequirementIds.length ? new Set(reloadRequirementIds) : null;

  // 重建模式只处理指定需求；重试模式只处理指定需求；正常模式处理全部。
  const targets = recreateSet ? reqs.filter((r) => recreateSet.has(r.id)) : reloadSet ? reqs.filter((r) => reloadSet.has(r.id)) : reqs;

  await withMcpClient(cfg, async (client) => {
    // 正常模式与重试模式都需要平台最新 revision 映射（update 乐观锁）。重建模式不需要。
    // 用 platform.versionId（平台版本 id）过滤；未选版本则拉全量按 id 建映射。
    let revMap: Map<number, number> | undefined;
    if (!recreateSet) {
      revMap = await fetchVersionTaskRevisions(client, platform?.versionId);
    }

    for (const r of targets) {
      // 重建模式直接走 create；重试模式与正常模式按 decideAction（重试模式下被重试的必然是 update）
      const action: JiraSyncAction = recreateSet ? 'recreate' : decideAction(r).action;
      const reason = recreateSet ? undefined : decideAction(r).reason;
      if (!recreateSet && action === 'skip') {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: true, jiraKey: r.jiraKey ?? null, error: reason });
        continue;
      }
      const toolName = action === 'update' ? TOOL.ITEM_UPDATE : TOOL.ITEM_CREATE;
      // update 时附带平台最新 revision。先查版本过滤映射；取不到（任务不在所选版本里）则按项目不限版本回退查，
      // 否则 update 会因 revision 缺失被平台判 stale，且 stale 后任务留在版本外形成死循环。
      let revision: number | undefined;
      if (action === 'update' && r.jiraKey) {
        revision = revMap ? revMap.get(Number(r.jiraKey)) : undefined;
        if (revision === undefined) {
          revision = await fetchTaskRevision(client, r.jiraKey, platform, revMap);
        }
      }
      const args = action === 'update' ? buildUpdateArgs(r, cfg, platform, revision, { projectName, versionName }) : buildCreateArgs(r, cfg, platform, { projectName, versionName });
      await recordToolOutcome(results, keyUpdates, r, action, () => callToolRaw(client, toolName, args));
    }
  });

  const syncedAt = Date.now();
  if (keyUpdates.length) {
    const revision = database.setRequirementsJiraKeys(keyUpdates.map((u) => ({ ...u, syncedAt })));
    return finalize(versionId, results, revision);
  }
  return finalize(versionId, results, database.load().revision);
}

type JiraKeyUpdate = { id: string; jiraKey: string | null; syncedAt?: number };

/** executeVersionSync / executeRequirementSync 共用的单条工具调用结果处理：
 *  isError / 抛错按 missing（任务不存在）/ stale（乐观锁冲突）/ failed 分类；
 *  update 成功保留原 jiraKey，create/recreate 成功从返回结果解析新任务 id 回填映射。 */
async function recordToolOutcome(
  results: JiraSyncResultItem[],
  keyUpdates: JiraKeyUpdate[],
  r: Requirement,
  action: JiraSyncAction,
  call: () => Promise<RawToolResult>,
): Promise<void> {
  try {
    const res = await call();
    if (res.isError) {
      const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('\n').trim();
      if (action === 'update' && isNotFoundResult(res)) {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, missing: true, jiraKey: r.jiraKey ?? null, error: text || '任务不存在' });
      } else if (action === 'update' && isStaleResult(res)) {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, stale: true, jiraKey: r.jiraKey ?? null, error: text || '数据已更新，请重新加载后再操作' });
      } else {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, error: text || '工具返回错误' });
      }
      return;
    }
    if (action === 'update') {
      results.push({ requirementId: r.id, requirementName: r.name, action, ok: true, jiraKey: r.jiraKey ?? null });
      keyUpdates.push({ id: r.id, jiraKey: r.jiraKey ?? '' });
    } else {
      const key = extractIssueKey(res);
      if (!key) {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: true, jiraKey: null, error: '已创建但未能从返回结果解析出任务 id，未记录映射' });
      } else {
        results.push({ requirementId: r.id, requirementName: r.name, action, ok: true, jiraKey: key });
        keyUpdates.push({ id: r.id, jiraKey: key });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (action === 'update' && isNotFoundMessage(msg)) {
      results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, missing: true, jiraKey: r.jiraKey ?? null, error: msg || '任务不存在' });
    } else if (action === 'update' && isStaleMessage(msg)) {
      results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, stale: true, jiraKey: r.jiraKey ?? null, error: msg || '数据已更新，请重新加载后再操作' });
    } else {
      results.push({ requirementId: r.id, requirementName: r.name, action, ok: false, error: msg });
    }
  }
}

/**
 * 单条需求同步（v0.2.10，列表行内一键同步）。读全局任务同步配置与指定需求，按 jiraKey 决定 create/update。
 * - platform：单次同步时弹窗选择（前端传入），创建任务必填 projectId/taskType。
 * - recreate=true：强制走 create（平台任务已删除后重建）。
 * - reload=true：重新拉最新 revision 后再走 update（解决 stale）。
 * 返回单条结果包装在 JiraSyncExecuteResult 里，复用前端 renderTaskSyncResults 的渲染逻辑。
 */
export async function executeRequirementSync(
  database: AppDatabase,
  projectId: string,
  requirementId: string,
  platform?: PlatformSelection,
  recreate?: boolean,
  reload?: boolean,
): Promise<JiraSyncExecuteResult> {
  const cfg = readProjectJiraConfig(database, projectId);
  if (!cfg || !cfg.enabled) throw codedError('JIRA_NOT_CONFIGURED', '未启用任务同步，请先在「系统设置 -> 任务同步」里配置');
  const { data } = database.load();
  const r = data.requirements.find((x) => x.id === requirementId && x.projectId === projectId);
  if (!r) throw codedError('NOT_FOUND', '找不到需求');

  const results: JiraSyncResultItem[] = [];
  const keyUpdates: Array<{ id: string; jiraKey: string | null; syncedAt?: number }> = [];
  const projectName = data.projects.find((p) => p.id === projectId)?.name ?? '';
  const versionName = r.versionId ? (data.versions.find((v) => v.id === r.versionId)?.name ?? '') : '';
  const descCtx: DescriptionCtx = { projectName, versionName };

  await withMcpClient(cfg, async (client) => {
    const decided = decideAction(r);
    const action: JiraSyncAction = recreate ? 'recreate' : decided.action;
    const reason = recreate ? undefined : decided.reason;
    if (!recreate && action === 'skip') {
      results.push({ requirementId: r.id, requirementName: r.name, action, ok: true, jiraKey: r.jiraKey ?? null, error: reason });
      return;
    }
    const toolName = action === 'create' || action === 'recreate' ? TOOL.ITEM_CREATE : TOOL.ITEM_UPDATE;
    let revision: number | undefined;
    if (action === 'update' && r.jiraKey) {
      const revMap = await fetchVersionTaskRevisions(client, platform?.versionId);
      // 版本过滤取不到则按项目不限版本回退查（任务可能不在所选版本里）。reload 重试也走这条，从而能自愈。
      revision = await fetchTaskRevision(client, r.jiraKey, platform, revMap);
    }
    const args = action === 'update' ? buildUpdateArgs(r, cfg, platform, revision, descCtx) : buildCreateArgs(r, cfg, platform, descCtx);
    await recordToolOutcome(results, keyUpdates, r, action, () => callToolRaw(client, toolName, args));
  });

  const syncedAt = Date.now();
  if (keyUpdates.length) {
    const rev = database.setRequirementsJiraKeys(keyUpdates.map((u) => ({ ...u, syncedAt })));
    return finalize(r.versionId ?? '', results, rev);
  }
  return finalize(r.versionId ?? '', results, database.load().revision);
}

function finalize(versionId: string, results: JiraSyncResultItem[], revision: number): JiraSyncExecuteResult {
  const counts = {
    created: results.filter((r) => r.action === 'create' && r.ok).length,
    updated: results.filter((r) => r.action === 'update' && r.ok).length,
    recreated: results.filter((r) => r.action === 'recreate' && r.ok).length,
    skipped: results.filter((r) => r.action === 'skip' && r.ok).length,
    missing: results.filter((r) => !!r.missing).length,
    stale: results.filter((r) => !!r.stale).length,
    failed: results.filter((r) => !r.ok && !r.missing && !r.stale).length,
  };
  return { versionId, results, counts, revision };
}
