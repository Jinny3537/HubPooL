import { z } from 'zod';

export const projectSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  code: z.string().min(1).max(32),
  description: z.string().max(500).optional(),
  environment: z.object({
    system: z.string().max(200).optional(),
    jira: z.string().max(200).optional(),
    linear: z.string().max(200).optional(),
    github: z.string().max(200).optional(),
    doc: z.string().max(200).optional(),
    customLinks: z.record(z.string(), z.string().max(200)).optional(),
  }).optional(),
  team: z.object({
    owner: z.string().max(50).optional(),
    members: z.array(z.string().max(50)).optional(),
  }).optional(),
  tags: z.array(z.string().max(30)).optional(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']).optional(),
  archived: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const versionSchema = z.object({
  id: z.string().min(1).max(100),
  projectId: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  status: z.string().min(1).max(30),
}).passthrough();

export const requirementSchema = z.object({
  id: z.string().min(1).max(150),
  projectId: z.string().min(1).max(100),
  versionId: z.string().max(100).nullable().optional(),
  name: z.string().min(1).max(200),
  status: z.string().min(1).max(30),
  stage: z.string().max(30).optional(),
  createdAt: z.number().int().positive().optional(),
}).passthrough();

export const appDataSchema = z.object({
  projects: z.array(projectSchema).max(10_000),
  versions: z.array(versionSchema).max(50_000).default([]),
  requirements: z.array(requirementSchema).max(100_000),
  settings: z.record(z.string(), z.unknown()).default({}),
  seqCounters: z.record(z.string(), z.number().int().nonnegative()).default({}),
}).passthrough();

export const replaceStateSchema = z.object({
  data: appDataSchema,
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const snapshotCreateSchema = z.object({
  reason: z.string().max(200).default('手动快照'),
});

export const settingsPatchSchema = z.record(z.string(), z.unknown());
