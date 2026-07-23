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
}

export interface Version {
  id: string;
  projectId: string;
  name: string;
  status: string;
  [key: string]: unknown;
}

export interface Requirement {
  id: string;
  projectId: string;
  versionId?: string | null;
  name: string;
  status: string;
  stage?: string;
  createdAt?: number;
  [key: string]: unknown;
}

export interface AppSettings {
  network?: Record<string, unknown>;
  update?: Record<string, unknown>;
  project?: Record<string, unknown>;
  collaboration?: Record<string, unknown>;
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
