export interface ProjectEnvironment {
  system?: string;
  jira?: string;
  linear?: string;
  github?: string;
  doc?: string;
  customLinks?: Record<string, string>;
}

export interface ProjectTeam {
  owner?: string;
  members?: string[];
}

/**
 * 全局任务同步配置（assess-task-mcp 定制版）。
 * 存储在 settings.taskSync.config 上，全项目共用；project.jiraSync 仅保留为历史数据兼容字段。
 * - transport='stdio'：HubPooL 拉起本地 assess-task-mcp 可执行文件，平台地址/账号/密码走 env；仅本机回环可调用。
 * - transport='http'：用户自运行的 MCP 服务，走 url + headers；局域网可用。
 * - 工具映射固定为 assess-task-mcp：创建 task:item:create、更新 task:item:update、
 *   查询 task:project:manage / task:version:manage / task:sprint:manage、验证 task_current_user。
 * - defaultTaskType：创建任务的默认类型（1 Story/2 Bug/3 Task/4 Other）；同步时可在弹窗覆盖。
 * - priorityMap：HubPooL 优先级 -> 平台优先级整数（1-4）。
 */
export interface JiraSyncConfig {
  enabled: boolean;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** 创建任务的默认类型（1 Story/2 Bug/3 Task/4 Other）。 */
  defaultTaskType: number;
  /** HubPooL 优先级 -> 平台优先级整数（1-4）。默认 P0->1,P1->2,P2->3,P3->4。 */
  priorityMap: Record<string, number>;
}

/** 平台目标选择（项目/版本/冲刺/任务类型），用于任务同步与单条同步的默认目标。 */
export interface PlatformSelection {
  projectId?: string;
  versionId?: string;
  sprintId?: string;
  taskType?: number;
}

/**
 * 全局任务同步设置（v0.2.10，原 project.jiraSync 迁移到系统设置全局共享）。
 * - config：assess-task-mcp 的 MCP 连接与字段映射，全应用一份，所有项目共用。
 * - defaultPlatform：单条需求一键同步时使用的默认平台目标（项目/版本/冲刺/任务类型）。
 *   批量同步仍在版本详情里临时选择平台目标，不依赖此项。
 */
export interface TaskSyncSettings {
  config: JiraSyncConfig;
  defaultPlatform?: PlatformSelection;
}

export interface Project {
  id: string;
  name: string;
  code: string;
  description?: string;
  environment?: ProjectEnvironment;
  team?: ProjectTeam;
  tags?: string[];
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  archived?: boolean;
  metadata?: Record<string, unknown>;
  /** 旧版项目级任务同步配置；新配置已迁移到全局 settings.taskSync，此处仅作向后兼容读取。 */
  jiraSync?: JiraSyncConfig;
}

export interface Version {
  id: string;
  projectId: string;
  name: string;
  status: string;
  goal?: string;
  owner?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  risks?: string[];
  signoffs?: Record<string, string>;
  releaseNotes?: string;
  [key: string]: unknown;
}

/** 需求详情图片附件（base64 内嵌，随需求 P2P 同步）。前端压缩后存。 */
export interface ReqImage {
  id: string;
  name: string;
  dataUrl: string;
  uploadedAt: number;
}

export interface Requirement {
  id: string;
  projectId: string;
  versionId?: string | null;
  name: string;
  status: string;
  stage?: string;
  createdAt?: number;
  /** 已同步到 Jira 的 issue key（如 PROJ-123）。再次同步时走 update 而非 create。 */
  jiraKey?: string;
  /** 最近一次同步到 Jira 的时间戳（ms）。 */
  jiraSyncedAt?: number;
  /** 需求详情图片附件（base64），随需求一起存 SQLite + P2P 同步。 */
  images?: ReqImage[];
  /** 录入方式：'manual' 手动录入 / 'ai' AI整理·Jira标准化。手动录入默认 'manual'。 */
  entryMode?: 'manual' | 'ai';
  /** 备注（自由文本，列表展示，随需求 P2P 同步）。 */
  remark?: string;
  [key: string]: unknown;
}

export interface AppSettings {
  network?: Record<string, unknown>;
  update?: Record<string, unknown>;
  project?: Record<string, unknown>;
  appearance?: {
    theme?: 'classic' | 'aurora' | string;
    [key: string]: unknown;
  };
  collaboration?: {
    currentUserName?: string;
    currentUserRole?: string;
    teamRoles?: string[];
    [key: string]: unknown;
  };
  /** 全局任务同步设置（v0.2.10，MCP 配置 + 默认平台目标）。 */
  taskSync?: TaskSyncSettings;
  [key: string]: unknown;
}

export interface AppData {
  projects: Project[];
  versions: Version[];
  requirements: Requirement[];
  settings: AppSettings;
  seqCounters: Record<string, number>;
  [key: string]: unknown;
}

export interface RuntimeConfig {
  host: string;
  port: number;
  openBrowser: boolean;
  dataDir: string;
  publicDir: string;
  projectDir: string;
}
