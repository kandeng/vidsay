import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "@toonflow/file";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RoomPoster } from "@/matrix/roomPost";
import {
  ensureProductionDirs, productionDir, productionLogEvent, readProduction, writeProduction,
  productionBriefSchema, scriptChangesSchema, scriptEnvelopeSchema,
} from "@/matrix/productionState";

// ACT: 制作流水线「文学剧本」阶段的编排器工具组（customer_service 专用，经 responder 注入 extraTools）。
// 设计遵循「对话在边界、数据流在中间」：编排器负责把用户意图编译成 brief、委派 productionTeam/scriptwriter、
// 用 zod 校验产物、投递到房间并主持审阅门；剧本文件本身由子代理写入，编排器不代笔。
// 状态机落在房间工作区 production.json（乐观并发），产物按 production/script/vN.* 只追加不覆盖。

export interface ProductionRequester { mxid: string; name: string }

// 委派任务模板：第 round 轮的完整任务说明（productionStart / productionRecordFeedback 返回给编排器，保证口径一致）。
function spawnBrief(round: number): string {
  const revision = round > 1
    ? `本轮为修订（第 ${round} 轮）：先读取 production/reviews/r${round - 1}.json（用户反馈）与 production/script/v${round - 1}.md、production/script/v${round - 1}.json（上一版），按技能 references/revision.md 只做最小必要改动，changes 相对上一版。`
    : "";
  return [
    `文学剧本改编（第 ${round} 轮）。工作目录即房间工作区。`,
    `请读取 production/draft.md（用户草稿）与 production/brief.json（时长、基调等约束）。`,
    revision,
    `按成员指令与 scriptwriting 技能完成改编，把新版本写入 production/script/v${round}.md 与 production/script/v${round}.json（version=${round}，格式严格遵守技能 references/envelope.md），创作决策追加到 production/script/notes.md。`,
    `只允许写入 production/script/ 目录；不生成任何媒体。`,
    `最终回复只输出 JSON 报告：{"summary":"整体改编思路","changes":[{"aspect":"...","before":"...","after":"...","why":"..."}],"openQuestions":["..."]}。`,
  ].filter(Boolean).join("\n");
}

// 把子代理报告与剧本封装渲染成房间投递正文（改编说明 + 改动明细；待确认问题另条发送）。
function renderDelivery(envelope: z.infer<typeof scriptEnvelopeSchema>, report: { summary: string; changes: z.infer<typeof scriptChangesSchema>; openQuestions?: string[] }, requester?: ProductionRequester): string {
  const header = `文学剧本 v${envelope.version}《${envelope.title}》已完成。`;
  const lines: string[] = [requester ? `@${requester.name} ${header}` : header];
  lines.push("", `故事梗概：${envelope.logline}`, "", `【改编说明】${report.summary}`, "", "【改动明细】");
  for (const change of report.changes) lines.push(`- ${change.aspect}：${change.before} → ${change.after}（理由：${change.why}）`);
  return lines.join("\n");
}

// ACT: 待确认问题单独成一条消息投递，用户可引用本条逐条回复，粒度更细。
function renderQuestions(openQuestions: string[]): string {
  const lines = ["编剧希望与你确认以下问题（可引用本条消息逐条回复）："];
  openQuestions.forEach((question, index) => lines.push(`${index + 1}. ${question}`));
  return lines.join("\n");
}

// 统一的工具执行包装：zod 校验失败与状态错误都以文本返回，不向 SDK 抛异常（与 workflowProposal 同口径）。
async function attempt(operation: () => Promise<{ text: string; details?: Record<string, unknown> }>) {
  try {
    const result = await operation();
    return { content: [{ type: "text" as const, text: result.text }], details: result.details ?? {} };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: `操作失败：${message}` }], details: { error: message } };
  }
}

export function createProductionTools(roomId: string, options: {
  poster: RoomPoster;
  getRequester: () => ProductionRequester | undefined;
}): ToolDefinition[] {
  const { poster, getRequester } = options;

  const noticeParameters = z.strictObject({
    body: z.string().trim().min(1).max(2000).describe("要立即发送到房间的简短消息"),
    mentionRequester: z.boolean().optional().describe("是否 @ 最近发言的用户"),
  });

  const notice: ToolDefinition = {
    name: "roomNotice", label: "房间即时消息",
    description: "立即向房间发送一条简短消息（不等待本轮结束）。用于长任务开始前的进展告知；房间只会收到这条消息，你的思考与工具日志不会外泄。",
    promptGuidelines: ["服务器已自动发送即时回执；roomNotice 仅用于阶段性进展（如「正在委派编剧改编」「正在按意见修订」），措辞简短、不承诺具体分钟数；已用 roomNotice 或投递工具发出的内容不要在最终正文里重复。"],
    parameters: z.toJSONSchema(noticeParameters), executionMode: "sequential",
    execute: (_id, params, signal) => attempt(async () => {
      signal?.throwIfAborted();
      const { body, mentionRequester } = noticeParameters.parse(params);
      const requester = mentionRequester ? getRequester() : undefined;
      const mentions = requester ? [requester.mxid] : undefined;
      await poster.sendText(roomId, requester ? `@${requester.name} ${body}` : body, { mentions });
      return { text: "已发送到房间。" };
    }),
  };

  const startParameters = z.strictObject({
    draft: z.string().trim().min(1).max(100000).describe("用户的故事草稿/原始描述原文，忠实收录不改写"),
    brief: productionBriefSchema.describe("从用户消息编译出的制作约束"),
  });

  const start: ToolDefinition = {
    name: "productionStart", label: "开始文学剧本制作",
    description: "把用户草稿与制作约束落盘（production/draft.md、production/brief.json）并初始化制作状态，返回委派 productionTeam/scriptwriter 的任务模板。仅当用户明确要求把故事改编为文学剧本/视频剧本等制作请求时调用。",
    promptGuidelines: [
      "用户要求把故事或草稿改编成文学剧本（或给出时长、基调等制作约束）时，按固定流程执行，房间只收到干净结果：1) 服务器已自动向用户发送即时回执（并引用触发消息），你无需再发通用「收到/正在处理」；如确需告知阶段进展（如「正在委派编剧改编」）可再用 roomNotice，措辞简短、不承诺具体分钟数；2) 用 productionStart 落盘草稿与约束；3) 按返回的委派模板原样调用 subAgent（team=productionTeam），不要自己写剧本文件；4) 子代理返回后核验 status=completed，从其报告 JSON 取 summary/changes/openQuestions 调 productionSubmitScript 投递；status 非 completed 或报告缺字段时，整理原因后最多重试一次委派，仍失败则向用户说明；5) 投递成功后最终正文只写一句简短审阅邀请（满意回复「通过」，或直接提修改意见）；6) 用户反馈后调 productionRecordFeedback。不要向房间转述子代理的思考过程与工具日志；任何房间消息都不要提及工作区内部文件路径（如 production/...）；不要向房间透露服务器内部状态（如制作状态文件是否存在、历史轮次、上一版文件缺失、重置或重新启动等），恢复或重开时直接静默继续流程；productionSubmitScript 校验失败时按返回原因重新委派子代理修订，绝不把剧本正文直接贴进房间。",
    ],
    parameters: z.toJSONSchema(startParameters), executionMode: "sequential",
    execute: (_id, params, signal) => attempt(async () => {
      signal?.throwIfAborted();
      const { draft, brief } = startParameters.parse(params);
      const existing = await readProduction(roomId);
      if (existing && existing.status !== "approved") {
        return { text: `当前房间已有进行中的制作（阶段 ${existing.stage}，状态 ${existing.status}，第 ${existing.round} 轮）。请先完成当前流程，或与用户确认放弃后由你删除 production.json 再重新开始。`, details: { state: existing.status } };
      }
      const dir = await ensureProductionDirs(roomId);
      await writeFile(join(dir, "draft.md"), `${draft.trim()}\n`);
      await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief, null, 2)}\n`);
      const state = await writeProduction(roomId, {
        stage: "literaryScript", status: "writing", round: 1, brief,
        log: [productionLogEvent("start", `草稿 ${draft.length} 字；约束：${JSON.stringify(brief)}`.slice(0, 2000))],
      }, existing?.revision);
      return {
        text: `制作已开始（第 1 轮）。草稿与约束已写入 production/。请立即用 subAgent 委派：team=productionTeam，任务如下（原样使用）：\n\n${spawnBrief(state.round)}`,
        details: { round: state.round, revision: state.revision },
      };
    }),
  };

  const submitParameters = z.strictObject({
    summary: z.string().trim().min(1).max(2000).describe("子代理报告的整体改编说明"),
    changes: scriptChangesSchema.describe("子代理报告的改动明细（原样转交，不改写）"),
    openQuestions: z.array(z.string().trim().min(1).max(500)).max(10).optional().describe("子代理报告的待确认问题"),
    deliver: z.boolean().optional().describe("是否把剧本文件与改编说明投递到房间并 @ 请求用户（默认 true）"),
  });

  const submit: ToolDefinition = {
    name: "productionSubmitScript", label: "校验并投递文学剧本",
    description: "校验子代理写入的 production/script/vN.md 与 vN.json（N=当前轮次，zod 严格校验），登记版本指纹后把剧本文件与改编说明投递到房间（@ 请求用户）。校验失败会返回具体原因，应整理后重新委派修订，不要手工改剧本文件。",
    promptGuidelines: ["productionSubmitScript 成功投递后（工具已把改编说明与剧本全文分别单独成条发送），最终正文只需一句简短的审阅邀请，不要复述、节选或重新展示剧本内容，也不要重复改编说明。校验失败时按返回的具体原因重新委派子代理（subAgent team=productionTeam）修订后再次提交；不要手工改剧本文件、不要提及内部文件路径、不要用「投递系统遇到技术问题」之类含糊表述。"],
    parameters: z.toJSONSchema(submitParameters), executionMode: "sequential",
    execute: (_id, params, signal) => attempt(async () => {
      signal?.throwIfAborted();
      const report = submitParameters.parse(params);
      const deliver = report.deliver !== false;
      const state = await readProduction(roomId);
      if (!state) throw new Error("没有进行中的制作，请先用 productionStart 开始");
      if (state.status !== "writing" && state.status !== "revising") throw new Error(`当前状态 ${state.status} 不能提交剧本`);
      const round = state.round;
      const dir = productionDir(roomId);
      const mdPath = join(dir, "script", `v${round}.md`);
      const jsonPath = join(dir, "script", `v${round}.json`);
      let mdBytes: Uint8Array;
      let jsonBytes: Uint8Array;
      try {
        [mdBytes, jsonBytes] = await Promise.all([readFile(mdPath), readFile(jsonPath)]);
      } catch {
        throw new Error(`剧本文件缺失：production/script/v${round}.md 或 v${round}.json 不存在，请确认子代理已按要求写入后重试`);
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(Buffer.from(jsonBytes).toString("utf8"));
      } catch (parseError) {
        throw new Error(`production/script/v${round}.json 不是合法 JSON（${parseError instanceof Error ? parseError.message : String(parseError)}），最常见原因是字符串内未转义的英文双引号。请重新委派子代理修订 JSON，不要手工改文件、不要把剧本贴到房间。`);
      }
      let envelope: z.infer<typeof scriptEnvelopeSchema>;
      try {
        envelope = scriptEnvelopeSchema.parse(parsedJson);
      } catch (schemaError) {
        throw new Error(`production/script/v${round}.json 结构校验失败：${(schemaError instanceof Error ? schemaError.message : String(schemaError)).slice(0, 500)}。请重新委派子代理按 references/envelope.md 修正，不要手工改文件、不要把剧本贴到房间。`);
      }
      if (envelope.version !== round) throw new Error(`剧本 version=${envelope.version} 与当前轮次 ${round} 不一致，请让子代理修正`);
      const md = Buffer.from(mdBytes).toString("utf8");
      if (!md.trim() || md.length > 400000) throw new Error("剧本 Markdown 为空或超过 400000 字符");
      const hash = `sha256:${createHash("sha256").update(mdBytes).update("\0").update(jsonBytes).digest("hex")}`;
      const next = await writeProduction(roomId, {
        ...state, status: "awaitingApproval",
        script: {
          version: round, md: `production/script/v${round}.md`, json: `production/script/v${round}.json`,
          hash, title: envelope.title, summary: report.summary, changes: report.changes,
          ...(report.openQuestions?.length ? { openQuestions: report.openQuestions } : {}),
          at: new Date().toISOString(),
        },
        log: [...state.log, productionLogEvent("submit", `v${round}《${envelope.title}》${hash}`)],
      }, state.revision);
      if (deliver) {
        const requester = getRequester();
        const mentions = requester ? [requester.mxid] : undefined;
        const body = renderDelivery(envelope, report, requester);
        signal?.throwIfAborted();
        await poster.sendText(roomId, body, { mentions });
        // ACT: 剧本全文以可读正文单独一条投递：web 聊天端打不开 m.file 附件（只会留下一行死链），
        // 且模型自行节选展示会失真；直接发 vN.md 原文，保证与改编说明/改动明细同源一致。
        await poster.sendText(roomId, md);
        // ACT: 待确认问题单独一条消息投递，方便用户引用单条问题回复。
        if (report.openQuestions?.length) {
          await poster.sendText(roomId, renderQuestions(report.openQuestions));
        }
      }
      return {
        text: `剧本 v${round}《${envelope.title}》已通过校验${deliver ? "并投递到房间（含剧本文件与改编说明）" : ""}。请在最终正文里邀请用户审阅：满意回复「通过」，或直接提出修改意见。`,
        details: { version: round, hash, scenes: envelope.scenes.length, title: envelope.title },
      };
    }),
  };

  const feedbackParameters = z.strictObject({
    approve: z.boolean().describe("用户是否通过本阶段"),
    feedback: z.string().trim().max(8000).optional().describe("用户的修改意见原文（approve=false 时必填）"),
  });

  const feedback: ToolDefinition = {
    name: "productionRecordFeedback", label: "记录审阅结果",
    description: "记录用户对当前版本文学剧本的审阅结果。通过则阶段完成；否则把意见写入 production/reviews/、轮次加一并返回修订委派模板。仅在用户明确表达通过或给出修改意见后调用，不要把沉默当作用户同意。",
    promptGuidelines: ["productionRecordFeedback 返回修订模板后，先用 roomNotice 告知用户正在修订，再按模板原样调用 subAgent（team=productionTeam）；修订完成仍走 productionSubmitScript 投递。用户消息若带「（引用了 … 的消息：「…」）」前缀，表示用户引用了被引用消息逐条回复（如在回答确认问题）：结合被引用内容判断本条针对哪个问题或哪条意见，不要把它当成无关的新需求。"],
    parameters: z.toJSONSchema(feedbackParameters), executionMode: "sequential",
    execute: (_id, params, signal) => attempt(async () => {
      signal?.throwIfAborted();
      const { approve, feedback: text } = feedbackParameters.parse(params);
      const state = await readProduction(roomId);
      if (!state) throw new Error("没有进行中的制作");
      if (state.status !== "awaitingApproval") throw new Error(`当前状态 ${state.status} 不在等待审阅，不能记录反馈`);
      if (approve) {
        const next = await writeProduction(roomId, {
          ...state, status: "approved", approvedVersion: state.script?.version,
          log: [...state.log, productionLogEvent("approve", `v${state.script?.version ?? state.round} 通过`)],
        }, state.revision);
        return { text: `文学剧本阶段完成：v${next.approvedVersion} 已通过。请向用户确认，并说明后续制作阶段（分镜、成片等）会在此基础上继续。`, details: { approved: true, version: next.approvedVersion } };
      }
      if (!text) throw new Error("记录修改意见需要 feedback 内容");
      const round = state.round;
      const dir = await ensureProductionDirs(roomId);
      await mkdir(join(dir, "reviews"), { recursive: true });
      await writeFile(join(dir, "reviews", `r${round}.json`), `${JSON.stringify({ round, feedback: text, at: new Date().toISOString() }, null, 2)}\n`);
      const next = await writeProduction(roomId, {
        // 保留上一版 script 登记供 productionStatus 展示；新版本提交时覆盖。
        ...state, status: "revising", round: round + 1,
        log: [...state.log, productionLogEvent("feedback", `v${round} 未通过，意见 ${text.length} 字，进入第 ${round + 1} 轮`)],
      }, state.revision);
      return {
        text: `已记录意见（reviews/r${round}.json），进入第 ${next.round} 轮修订。请先用 roomNotice 告知用户正在修订，再用 subAgent 委派：team=productionTeam，任务如下（原样使用）：\n\n${spawnBrief(next.round)}`,
        details: { round: next.round, revision: next.revision },
      };
    }),
  };

  const statusParameters = z.strictObject({});

  const status: ToolDefinition = {
    name: "productionStatus", label: "查看制作状态",
    description: "查看当前房间制作流水线的状态（阶段、轮次、最近版本与审阅情况）。用户询问进度、或服务器重启后需要恢复上下文时使用。",
    promptGuidelines: ["用户询问制作进度或会话恢复后不确定当前阶段时，先用 productionStatus 查看状态再继续，不要凭记忆猜测轮次。productionStatus 的输出仅供你内部决策，不要把它原文转述到房间，也不要据此向用户解释内部机制。"],
    parameters: z.toJSONSchema(statusParameters), executionMode: "sequential",
    execute: (_id, _params, signal) => attempt(async () => {
      signal?.throwIfAborted();
      const state = await readProduction(roomId);
      if (!state) return { text: "当前房间没有进行中的制作。" };
      return {
        text: JSON.stringify({
          stage: state.stage, status: state.status, round: state.round, brief: state.brief,
          script: state.script && { version: state.script.version, title: state.script.title, hash: state.script.hash, at: state.script.at },
          approvedVersion: state.approvedVersion, recentLog: state.log.slice(-5),
        }, null, 2),
        details: { status: state.status, round: state.round },
      };
    }),
  };

  return [notice, start, submit, feedback, status];
}
