import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import { join } from "node:path";
import { z } from "zod";
import { roomAgentCwd } from "./agentWorkspace";

// ACT: 制作流水线（production pipeline）的房间级状态与产物契约。
// 文学剧本是第一个固定阶段：编排器（customer_service）把用户草稿编译成 brief，
// 委派 productionTeam/scriptwriter 写出 production/script/vN.md + vN.json，
// 本模块用 zod 校验剧本封装（与团队技能 references/envelope.md 保持同一规范）并维护 production.json 状态机。
// 版本文件只追加不覆盖；状态写入内嵌 revision 做乐观并发校验，口径与 workflow.json 一致。

// ---------- 产物契约（与 productionTeam/skills/scriptwriting/references/envelope.md 对应） ----------

export const productionBriefSchema = z.strictObject({
  durationMinutes: z.number().positive().max(120).optional().describe("目标成片时长（分钟）"),
  tone: z.array(z.string().trim().min(1).max(80)).max(10).optional().describe("基调，如 nostalgia、black humor"),
  style: z.string().trim().max(200).optional().describe("风格补充"),
  language: z.string().trim().max(40).optional().describe("剧本语言，如 zh、en"),
  audience: z.string().trim().max(200).optional().describe("目标受众"),
  extra: z.string().trim().max(2000).optional().describe("用户提出的其他约束原文"),
});

export const scriptDialogueSchema = z.strictObject({
  role: z.string().trim().min(1).max(80),
  line: z.string().trim().min(1).max(2000),
});

export const scriptSceneSchema = z.strictObject({
  id: z.string().regex(/^s\d+$/),
  heading: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(4000),
  beats: z.array(z.string().trim().min(1).max(500)).max(50),
  dialogue: z.array(scriptDialogueSchema).max(200),
});

export const scriptEnvelopeSchema = z.strictObject({
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  logline: z.string().trim().min(1).max(1000),
  language: z.string().trim().max(40).optional(),
  estimatedMinutes: z.number().positive().max(120).optional(),
  scenes: z.array(scriptSceneSchema).min(1).max(100),
}).superRefine((envelope, context) => {
  // 场景 id 必须是从 s1 开始的连续唯一序列，防止下游阶段引用歧义。
  envelope.scenes.forEach((scene, index) => {
    if (scene.id !== `s${index + 1}`) {
      context.addIssue({ code: "custom", path: ["scenes", index, "id"], message: `场景 id 必须是连续序列，期望 s${index + 1}` });
    }
  });
});

export const scriptChangesSchema = z.array(z.strictObject({
  aspect: z.string().trim().min(1).max(80).describe("改动维度，如结构/基调/人物/对白/时长"),
  before: z.string().trim().min(1).max(1000).describe("改动前（草稿或上一版）的处理"),
  after: z.string().trim().min(1).max(1000).describe("本版剧本的处理"),
  why: z.string().trim().min(1).max(1000).describe("改编理由"),
})).max(10);

// ---------- 状态机（production.json） ----------

export const productionStatusSchema = z.enum(["writing", "awaitingApproval", "revising", "approved"]);

export const productionStateSchema = z.strictObject({
  revision: z.number().int().min(0),
  stage: z.literal("literaryScript"),
  status: productionStatusSchema,
  round: z.number().int().min(1),
  brief: productionBriefSchema,
  script: z.strictObject({
    version: z.number().int().min(1),
    md: z.string().min(1),
    json: z.string().min(1),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    title: z.string().min(1),
    summary: z.string().min(1),
    changes: scriptChangesSchema,
    openQuestions: z.array(z.string().trim().min(1).max(500)).max(10).optional(),
    at: z.string().datetime(),
  }).optional(),
  approvedVersion: z.number().int().min(1).optional(),
  log: z.array(z.strictObject({ at: z.string().datetime(), event: z.string().min(1).max(80), detail: z.string().max(2000).optional() })).max(200),
});

export type ProductionState = z.infer<typeof productionStateSchema>;
export type ProductionBrief = z.infer<typeof productionBriefSchema>;
export type ScriptEnvelope = z.infer<typeof scriptEnvelopeSchema>;
export type ScriptChanges = z.infer<typeof scriptChangesSchema>;

export const PRODUCTION_FILE = "production.json";

// production/ 产物目录（房间工作区内相对路径固定，绝对路径按房间解析）。
export function productionDir(roomId: string): string {
  return join(roomAgentCwd(roomId), "production");
}

export async function ensureProductionDirs(roomId: string): Promise<string> {
  const dir = productionDir(roomId);
  await mkdir(join(dir, "script"), { recursive: true });
  await mkdir(join(dir, "reviews"), { recursive: true });
  return dir;
}

export async function readProduction(roomId: string): Promise<ProductionState | null> {
  let text: string;
  try {
    text = Buffer.from(await readFile(join(roomAgentCwd(roomId), PRODUCTION_FILE))).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = productionStateSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    // 损坏的状态文件按不存在处理，由调用方决定是否重新开工。
    return null;
  }
}

// 状态写入：revision 自增落盘；传入 expectedRevision 时做乐观并发校验（与 workflow.json 同口径）。
export async function writeProduction(roomId: string, state: Omit<ProductionState, "revision"> & { revision?: number }, expectedRevision?: number): Promise<ProductionState> {
  const current = await readProduction(roomId);
  const baseRevision = current?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== baseRevision) {
    throw Object.assign(new Error("制作状态已被更新，请重新读取后再写入"), { status: 409, code: "EREVISION" });
  }
  const next = productionStateSchema.parse({ ...state, revision: baseRevision + 1 });
  await writeAtomic(join(roomAgentCwd(roomId), PRODUCTION_FILE), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function productionLogEvent(event: string, detail?: string): ProductionState["log"][number] {
  return { at: new Date().toISOString(), event, detail };
}
