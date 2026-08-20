/* ========== HubPooL MCP 工具服务（v0.2.1，实验性）==========
 *
 * 让本地 AI Agent（目前只验证过 Claude Code）能通过标准 MCP 协议访问需求池数据，
 * 但刻意只暴露"只读查询"和"生成待确认提案"两类工具——不提供任何直接创建/修改/删除
 * 数据的工具。AI 想要新增或编辑需求，只能调用 propose_* 工具生成一条待审核提案；
 * 真正写入 SQLite 仍然要走用户在网页里打开的、原有的需求表单，由人确认后手动保存。
 *
 * 这个边界是刻意设计的，不是偷懒：即使 MCP 本身的权限模型可以做到"AI 直接调用
 * create_requirement 就落库"，我们也不想让一次对话在没有人看一眼的情况下改动需求池。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppDatabase } from './database.js';

const requirementProposalShape = {
  name: z.string().min(1).max(200).describe('需求名称'),
  businessDescription: z.string().max(4000).optional().describe('需求的业务描述'),
  businessValue: z.string().max(2000).optional().describe('业务价值'),
  acceptanceCriteria: z.string().max(4000).optional().describe('验收标准'),
  impactScope: z.string().max(2000).optional().describe('影响范围'),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional().describe('优先级'),
  type: z.string().max(50).optional().describe('需求类型，例如 新功能/功能优化/缺陷修复'),
  source: z.string().max(50).optional().describe('需求来源，例如 业务方/客户/内部'),
  module: z.string().max(100).optional().describe('所属模块'),
};

export function createHubPoolMcpServer(database: AppDatabase): McpServer {
  const mcp = new McpServer({ name: 'hubpool', version: '0.2.1' });

  mcp.registerTool(
    'list_projects',
    {
      title: '列出所有项目',
      description: '获取 HubPooL 里当前所有项目的 id、名称、代码，用于确认要在哪个项目下创建/编辑需求。',
      inputSchema: {},
    },
    async () => {
      const { data } = database.load();
      const list = data.projects.map((p) => ({ id: p.id, name: p.name, code: p.code, archived: Boolean(p.archived) }));
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    },
  );

  mcp.registerTool(
    'list_requirements',
    {
      title: '查询某个项目下的需求（支持筛选，用于智能问答/检索）',
      description: [
        '获取指定项目下的需求列表，支持按状态/优先级/模块/所属版本/关键词筛选——回答"这季度有哪些P0需求""登录相关的需求都有哪些"这类问题时，',
        '优先用这个工具把真实数据取出来再回答，不要凭空编。返回字段包含 id/名称/状态/优先级/模块/类型/来源/所属版本(id+名称)/提出日期/预计上线日期/目标交付日期/业务价值摘要，',
        '足够回答大多数列表类问题；需要某一条的完整字段（业务描述、验收标准全文等）时再用 get_requirement_detail 查单条。',
        '不传筛选参数就是列出该项目全部需求（默认最多 200 条，可用 limit 调整，上限 500）。',
      ].join(''),
      inputSchema: {
        projectId: z.string().describe('项目 ID，来自 list_projects'),
        status: z.array(z.string()).optional().describe('按状态筛选，可多选，例如 ["待评审","开发中"]；不传则不限状态'),
        priority: z.array(z.enum(['P0', 'P1', 'P2', 'P3'])).optional().describe('按优先级筛选，可多选'),
        module: z.string().optional().describe('按所属模块做子串匹配（不区分大小写）'),
        versionId: z.string().optional().describe('按所属版本筛选；传版本 ID，或传 "unassigned" 表示只看未分配版本的需求'),
        keyword: z.string().max(200).optional().describe('关键词，会在需求名称/业务描述/验收标准/原始描述里做子串匹配'),
        limit: z.number().int().min(1).max(500).optional().describe('最多返回多少条，默认 200'),
      },
    },
    async ({ projectId, status, priority, module, versionId, keyword, limit }) => {
      const { data } = database.load();
      if (!data.projects.some((p) => p.id === projectId)) {
        return { content: [{ type: 'text', text: `找不到项目 ${projectId}，请先调用 list_projects 确认 ID。` }], isError: true };
      }
      const versionNameById = new Map(data.versions.map((v) => [v.id, v.name]));
      const kw = keyword?.trim().toLowerCase();
      const moduleKw = module?.trim().toLowerCase();
      let list = data.requirements.filter((r) => r.projectId === projectId);
      if (status && status.length > 0) list = list.filter((r) => status.includes(String(r.status)));
      if (priority && priority.length > 0) list = list.filter((r) => (priority as string[]).includes(String((r as Record<string, unknown>).priority)));
      if (moduleKw) list = list.filter((r) => String((r as Record<string, unknown>).module ?? '').toLowerCase().includes(moduleKw));
      if (versionId === 'unassigned') list = list.filter((r) => !r.versionId);
      else if (versionId) list = list.filter((r) => r.versionId === versionId);
      if (kw) {
        list = list.filter((r) => {
          const rr = r as Record<string, unknown>;
          return [r.name, rr.businessDescription, rr.acceptanceCriteria, rr.rawDescription]
            .some((v) => typeof v === 'string' && v.toLowerCase().includes(kw));
        });
      }
      const total = list.length;
      const capped = list.slice(0, limit ?? 200);
      const result = capped.map((r) => {
        const rr = r as Record<string, unknown>;
        const businessValue = typeof rr.businessValue === 'string' ? rr.businessValue : '';
        return {
          id: r.id, name: r.name, status: r.status,
          priority: rr.priority, module: rr.module, type: rr.type, source: rr.source,
          versionId: r.versionId ?? null, versionName: r.versionId ? (versionNameById.get(r.versionId) ?? null) : null,
          proposedDate: rr.proposedDate, expectedOnlineDate: rr.expectedOnlineDate, targetDeliveryDate: rr.targetDeliveryDate,
          businessValueSnippet: businessValue.length > 80 ? businessValue.slice(0, 80) + '…' : businessValue,
        };
      });
      const meta = total > result.length ? `（共 ${total} 条匹配，已截断为前 ${result.length} 条；需要更多可加大 limit 或加筛选条件收窄）\n` : '';
      return { content: [{ type: 'text', text: meta + JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.registerTool(
    'get_requirement_detail',
    {
      title: '查询单条需求的完整字段',
      description: '按 ID 获取一条需求的全部字段（业务描述、业务价值、验收标准、影响范围全文等），用于需要引用具体内容时——例如给这条需求做质量点评、或以它为基础做需求拆解之前，先看看它现在写了什么。',
      inputSchema: { requirementId: z.string().describe('需求 ID，来自 list_requirements') },
    },
    async ({ requirementId }) => {
      const { data } = database.load();
      const requirement = data.requirements.find((r) => r.id === requirementId);
      if (!requirement) {
        return { content: [{ type: 'text', text: `找不到需求 ${requirementId}，请先调用 list_requirements 确认 ID。` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(requirement, null, 2) }] };
    },
  );

  mcp.registerTool(
    'list_versions',
    {
      title: '列出某个项目下的版本',
      description: '获取指定项目下的版本列表（id/名称/状态/计划时间/是否冻结/已分配需求数），用于回答"有哪些版本""某个版本什么时候测试"之类的问题，或者在做需求拆解、批量操作前查版本 ID。',
      inputSchema: { projectId: z.string().describe('项目 ID，来自 list_projects') },
    },
    async ({ projectId }) => {
      const { data } = database.load();
      if (!data.projects.some((p) => p.id === projectId)) {
        return { content: [{ type: 'text', text: `找不到项目 ${projectId}，请先调用 list_projects 确认 ID。` }], isError: true };
      }
      const list = data.versions.filter((v) => v.projectId === projectId).map((v) => {
        const vv = v as Record<string, unknown>;
        const requirementCount = data.requirements.filter((r) => r.versionId === v.id).length;
        return { id: v.id, name: v.name, status: v.status, plannedDate: vv.plannedDate, testDate: vv.testDate, releasedDate: vv.releasedDate, frozen: Boolean(vv.frozen), requirementCount };
      });
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    },
  );

  mcp.registerTool(
    'propose_create_requirement',
    {
      title: '提议新建一条需求（不会直接写入）',
      description: '为指定项目起草一条新需求。这只会生成一条待用户确认的提案，不会直接写入需求池——用户需要在网页里看到你的提案卡片，自己打开表单确认后才会真正保存。',
      inputSchema: { projectId: z.string().describe('项目 ID，来自 list_projects'), ...requirementProposalShape },
    },
    async ({ projectId, ...fields }) => {
      const { data } = database.load();
      if (!data.projects.some((p) => p.id === projectId)) {
        return { content: [{ type: 'text', text: `找不到项目 ${projectId}，请先调用 list_projects 确认 ID。` }], isError: true };
      }
      const proposal = database.createProposal({ projectId, kind: 'create_requirement', payload: fields, summary: `新建需求：${fields.name}` });
      return { content: [{ type: 'text', text: `已生成提案 ${proposal.id}，等待用户在网页上确认后才会真正创建。` }] };
    },
  );

  mcp.registerTool(
    'propose_edit_requirement',
    {
      title: '提议编辑一条已有需求（不会直接写入）',
      description: '为指定需求起草字段修改。这只会生成一条待用户确认的提案，不会直接修改需求池——用户需要在网页里看到你的提案卡片，自己打开表单确认后才会真正保存。只需要传你想修改的字段，不用传全部字段。',
      inputSchema: {
        requirementId: z.string().describe('需求 ID，来自 list_requirements'),
        ...Object.fromEntries(Object.entries(requirementProposalShape).map(([k, v]) => [k, v.optional()])),
      },
    },
    async ({ requirementId, ...fields }) => {
      const { data } = database.load();
      const requirement = data.requirements.find((r) => r.id === requirementId);
      if (!requirement) {
        return { content: [{ type: 'text', text: `找不到需求 ${requirementId}，请先调用 list_requirements 确认 ID。` }], isError: true };
      }
      const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(changed).length === 0) {
        return { content: [{ type: 'text', text: '没有提供任何要修改的字段。' }], isError: true };
      }
      const proposal = database.createProposal({ projectId: requirement.projectId, kind: 'edit_requirement', requirementId, payload: changed, summary: `编辑需求 ${requirement.name}：${Object.keys(changed).join('、')}` });
      return { content: [{ type: 'text', text: `已生成提案 ${proposal.id}，等待用户在网页上确认后才会真正保存。` }] };
    },
  );

  const BATCH_UPDATE_STATUSES = ['待评审', '评审通过', '开发中', '已上线', '已拒绝', '挂起'];

  mcp.registerTool(
    'propose_batch_update_requirements',
    {
      title: '提议批量修改多条需求的状态/优先级/所属版本（不会直接写入）',
      description: '对一批需求提出同一个字段的批量修改（改状态、改优先级、或批量归入某个版本），只生成一条待用户确认的提案——不会直接改需求池。用户会在网页 AI 工作台看到这批需求和改动内容，自己点击既有的批量操作栏「应用/加入」按钮才会真正生效。三选一：field 传 status 就把 value 填成目标状态的中文名（待评审/评审通过/开发中/已上线/已拒绝/挂起之一）；field 传 priority 就把 value 填成 P0/P1/P2/P3 之一；field 传 versionId 就把 value 填成 list_projects 之外还没有工具能查到的版本 ID——如果不知道版本 ID，先向用户确认版本名称，不要瞎猜。',
      inputSchema: {
        requirementIds: z.array(z.string()).min(1).max(200).describe('要批量修改的需求 ID 列表，来自 list_requirements'),
        field: z.enum(['status', 'priority', 'versionId']).describe('要批量修改的字段'),
        value: z.string().min(1).max(100).describe('目标值：status 传中文状态名，priority 传 P0-P3，versionId 传版本 ID'),
      },
    },
    async ({ requirementIds, field, value }) => {
      const { data } = database.load();
      const requirements = requirementIds.map((id) => data.requirements.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      if (requirements.length === 0) {
        return { content: [{ type: 'text', text: '给的需求 ID 一条都没找到，请先调用 list_requirements 确认 ID。' }], isError: true };
      }
      const missingCount = requirementIds.length - requirements.length;
      if (field === 'status' && !BATCH_UPDATE_STATUSES.includes(value)) {
        return { content: [{ type: 'text', text: `状态值不对，只能是：${BATCH_UPDATE_STATUSES.join('、')} 之一。` }], isError: true };
      }
      if (field === 'priority' && !['P0', 'P1', 'P2', 'P3'].includes(value)) {
        return { content: [{ type: 'text', text: '优先级只能是 P0/P1/P2/P3 之一。' }], isError: true };
      }
      if (field === 'versionId' && !data.versions.some((v) => v.id === value)) {
        return { content: [{ type: 'text', text: `找不到版本 ${value}，请先向用户确认版本名称/ID。` }], isError: true };
      }
      const projectIds = new Set(requirements.map((r) => r.projectId));
      const projectId = projectIds.size === 1 ? [...projectIds][0]! : requirements[0]!.projectId;
      const fieldLabel = field === 'status' ? '状态' : field === 'priority' ? '优先级' : '所属版本';
      const proposal = database.createProposal({
        projectId,
        kind: 'batch_update',
        payload: { requirementIds: requirements.map((r) => r.id), field, value },
        summary: `批量将 ${requirements.length} 条需求的${fieldLabel}改为「${value}」${missingCount > 0 ? `（另有 ${missingCount} 条 ID 未找到，已忽略）` : ''}`,
      });
      return { content: [{ type: 'text', text: `已生成批量提案 ${proposal.id}，涉及 ${requirements.length} 条需求，等待用户在网页上确认后才会真正生效。` }] };
    },
  );

  mcp.registerTool(
    'propose_split_requirement',
    {
      title: '提议把一条大需求拆解成多条子需求（不会直接写入）',
      description: [
        '当一条需求描述太宽泛、包含多个可以分开排期验收的诉求时，把它拆解成边界清晰的多条子需求草稿。',
        '这只生成一条待用户确认的提案，不会直接创建任何需求——用户会在网页 AI 工作台看到拆解结果，打开「快速批量录入」预览逐条检查后自己确认创建。',
        '拆解前建议先用 get_requirement_detail 看一下原需求现在写了什么，避免拆得和原意对不上。每个子需求都要遵守和 propose_create_requirement 一样的规范化规则：',
        '模块与范围明确、缺失信息标记「待确认」、验收标准可独立测试。子需求数量至少 2 条，如果拆不出至少 2 条边界清晰的子需求，说明这条需求本来就不该拆，直接告诉用户不建议拆分即可，不要为了拆而硬拆。',
      ].join(''),
      inputSchema: {
        requirementId: z.string().describe('要拆解的原需求 ID，来自 list_requirements'),
        children: z.array(z.object(requirementProposalShape)).min(2).max(20).describe('拆解后的子需求草稿列表，每条字段规则和 propose_create_requirement 一样'),
      },
    },
    async ({ requirementId, children }) => {
      const { data } = database.load();
      const requirement = data.requirements.find((r) => r.id === requirementId);
      if (!requirement) {
        return { content: [{ type: 'text', text: `找不到需求 ${requirementId}，请先调用 list_requirements 确认 ID。` }], isError: true };
      }
      const proposal = database.createProposal({
        projectId: requirement.projectId,
        kind: 'split_requirement',
        requirementId,
        payload: { sourceRequirementId: requirementId, sourceName: requirement.name, children },
        summary: `将需求「${requirement.name}」拆解为 ${children.length} 条子需求`,
      });
      return { content: [{ type: 'text', text: `已生成拆解提案 ${proposal.id}（${children.length} 条子需求），等待用户在网页上打开「快速批量录入」确认后才会真正创建，原需求「${requirement.name}」不会被自动改动或删除。` }] };
    },
  );

  return mcp;
}
