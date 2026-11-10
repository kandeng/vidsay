import * as sdk from "matrix-js-sdk";
import { readFile, writeAtomic } from "@toonflow/file";
import { join } from "node:path";
import { run } from "@/agent/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { createCanvasContext } from "@/agent/bridge/canvas";
import { createWorkflowProposalTools } from "@/agent/tools/workflowProposal";
import { createSpokeConsentTools } from "@/agent/tools/spokeConsent";
import { createProductionTools, type ProductionRequester } from "@/agent/tools/production";
import { ensureRoomCanvas } from "./agentWorkspace";
import { getRoomAgentModel } from "./settings";
import { loadRoomGrants } from "./grants";
import { getSpokeCanvas, hasSpoke, sendSpokeCanvasCall } from "./spoke";
import { createRoomPoster } from "./roomPost";

// ACT: 房间编排器 —— 把 customer_service 从「只会触发视频」升级成每个房间唯一的服务器侧 pi-coding 大脑。
// 它读取房间时间线里的人类消息，复用 agent/runtime.run() 在该房间的独立工作区里跑一轮，
// 再把 Agent 产出的正文以 m.text 回帖到房间。同一房间的多条消息串行执行，避免并发写同一会话。
// 设计原则与 bot.ts/trigger.ts 一致：未配置模型或运行失败时降级提示，绝不抛错拖垮机器人。

// ACT: 引用回复上下文：被引用消息的发送者与正文摘要（微信式「引用」）。
export interface QuoteContext {
  senderName: string;
  body: string;
}

export interface RoomResponder {
  // 处理房间里一条人类文本消息；内部按房间串行排队，返回本轮处理完成的 Promise。
  // sender 是发言者的 Matrix 用户 id，供制作工具 @ 请求用户（m.mentions）。
  // eventId 是触发消息的 event_id：供回执引用回复与按事件去重（同一事件不跑两轮）。
  // quote 是用户「引用」的被引用消息摘要：拼进提示词，使逐条引用回复能对应到具体问题。
  respond(roomId: string, body: string, senderName: string, sender?: string, eventId?: string, quote?: QuoteContext): Promise<void>;
}

// 会话文件名记录在房间工作区里，使机器人重启后仍能续上同一房间的上下文。
const SESSION_REF = ".room-session";
const SESSION_REF_PATTERN = /^[\w-]+\.jsonl$/;

async function readSessionRef(cwd: string): Promise<string | undefined> {
  try {
    const name = Buffer.from(await readFile(join(cwd, SESSION_REF))).toString("utf8").trim();
    return SESSION_REF_PATTERN.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

async function writeSessionRef(cwd: string, file: string): Promise<void> {
  if (!SESSION_REF_PATTERN.test(file)) return;
  await writeAtomic(join(cwd, SESSION_REF), file).catch(() => {});
}

export function createResponder(client: sdk.MatrixClient, _botUserId: string): RoomResponder {
  // ACT: matrix-js-sdk v42 的 MatrixClient 没有 sendText，且 sendEvent 重载严格；
  // 与 trigger.ts 同口径，把它断言成宽松签名后发 m.text 消息。
  // 必须 .bind(client)：v42 的 sendEvent 内部调用 this.addThreadRelationIfNeeded，
  // 直接解构/赋值会丢失 this，运行期抛 TypeError。
  const sendRoomMessage = client.sendEvent.bind(client) as unknown as (
    roomId: string, eventType: string, content: Record<string, unknown>,
  ) => Promise<unknown>;
  const sendText = (roomId: string, body: string) =>
    sendRoomMessage(roomId, sdk.EventType.RoomMessage, { msgtype: sdk.MsgType.Text, body }).then(() => {});
  // ACT: 制作流水线工具的发帖器（支持 m.mentions 与文件投递）与每房间最近发言人追踪。
  const poster = createRoomPoster(client);
  const requesters = new Map<string, ProductionRequester>();
  // 每个房间一条 Promise 链，串行化 run()，避免同一会话并发（run 内部会对并发抛 409）。
  const queues = new Map<string, Promise<void>>();
  // ACT: 已处理过的触发事件 id。Matrix 同一条事件可能因 live+回显/重连重放多次进入时间线回调，
  // 按 event_id 去重，保证「一条人类消息只跑一轮、只回一次回执」。
  const processedEvents = new Set<string>();
  // roomId -> 当前会话文件名（内存缓存，缺失时回退到工作区里的 .room-session）。
  const sessions = new Map<string, string>();

  async function respondOnce(roomId: string, body: string, senderName: string, sender?: string, eventId?: string, quote?: QuoteContext): Promise<void> {
    if (sender) requesters.set(roomId, { mxid: sender, name: senderName || sender });
    const model = getRoomAgentModel();
    if (!model) {
      await client.sendNotice(roomId, "尚未配置可用的文本模型，AI 客服暂时无法回复。").catch(() => {});
      return;
    }
    // ACT: 即时回执——服务器一收到人类消息就先回一条「收到，正在处理」，不等模型首 token，
    // 消除「发消息后长时间无任何响应」的观感；模型随后的 roomNotice 只用于阶段性进展告知。
    const requester = requesters.get(roomId);
    await poster.sendText(
      roomId,
      requester ? `@${requester.name} 收到，正在处理…` : "收到，正在处理…",
      // ACT: 回执引用触发它的那条用户消息（m.in_reply_to），时间线上能明确「在回哪一条」。
      requester ? { mentions: [requester.mxid], replyTo: eventId } : { replyTo: eventId },
    ).catch(() => {});
    // ACT: 单画布 1:1:1 绑定（Task 6）——本轮开始确保房间工作区存在并已播种一个画布（幂等）。
    const cwd = await ensureRoomCanvas(roomId);
    // ACT: 计划 Task 13 —— 本轮开始先加载房间授权表到缓存，使随后的 getSpokeCanvas/sendSpokeCanvasCall
    // 能同步按 driveSpokes 门控：只有已授权驱动的用户设备才会被选为主画布辐条、才会被编排器驱动。
    await loadRoomGrants(roomId).catch(() => {});
    const sessionFile = sessions.get(roomId) ?? await readSessionRef(cwd);
    const controller = new AbortController();
    const segments: string[] = [];
    // ACT: runtime 对同一个正文块会在 text_end 与 message_end 各发一次 done=true（blockId 相同），
    // 这里按 blockId 去重，避免房间回复里每段内容重复两遍。
    const seenTextBlocks = new Set<string>();
    let errorMessage: string | undefined;
    const send = (event: AgentEvent) => {
      if (event.type === "text" && event.done && typeof event.content === "string" && event.content.trim()) {
        if (event.blockId) {
          if (seenTextBlocks.has(event.blockId)) return;
          seenTextBlocks.add(event.blockId);
        }
        // ACT: 只收集「完成」的正文块，跳过 thinking/tool/stats 等噪声，拼成一条干净的房间回复。
        segments.push(event.content.trim());
      } else if (event.type === "session") {
        sessions.set(roomId, event.file);
        void writeSessionRef(cwd, event.file);
      } else if (event.type === "error") {
        errorMessage = event.message;
      }
    };
    // ACT: 引用回复上下文拼进提示词：用户「引用」了某条消息时，编排器能看到被引用内容，
    // 从而把「引用问题消息逐条回复」对应到具体问题。
    const quotedPrefix = quote ? `（引用了 ${quote.senderName} 的消息：「${quote.body}」）\n` : "";
    const prompt = senderName ? `${senderName}: ${quotedPrefix}${body}` : `${quotedPrefix}${body}`;
    // ACT: 若该房间有活跃辐条（打开的工作室标签页）且已上报画布上下文，就把画布桥接进 run()：
    // customer_service 的画布工具调用经辐条中继到实时 vue-flow 图执行，结果回流后编排器继续（计划 Task 5）。
    // 无辐条时降级为纯聊天（不带货布工具），与未打开工作室时的行为一致。
    const canvasInfo = getSpokeCanvas(roomId);
    const bridge = canvasInfo && hasSpoke(roomId)
      ? createCanvasContext(cwd, canvasInfo, event => {
          if (!sendSpokeCanvasCall(roomId, event)) throw new Error("画布辐条已断开，请确认工作室标签页仍然打开");
        }, reason => controller.abort(reason))
      : undefined;
    const attempt = (file?: string) => run({
      prompt, cwd, providerId: model.providerId, modelId: model.modelId, sessionFile: file, canvas: bridge?.context, signal: controller.signal,
      // ACT: 计划 Task 11 —— 编排器获得房间级工作流提案工具（list/commit/reject），
      // 以便在用户点「更新」提交提案后，经讨论采纳（revision 门控提交 + 广播）或拒绝。
      // ACT: 计划 Task 13 —— 追加设备与授权视图工具（listRoomDevices），使编排器调度前能确认目标用户已授权、设备具备能力。
      // ACT: 制作流水线工具（文学剧本阶段）：roomNotice 即时进展告知 + production* 状态机/校验/投递（@ 请求用户）。
      extraTools: [
        ...createWorkflowProposalTools(roomId), ...createSpokeConsentTools(roomId),
        ...createProductionTools(roomId, { poster, getRequester: () => requesters.get(roomId) }),
      ],
    }, send);
    try {
      await attempt(sessionFile);
    } catch (error) {
      // ACT: 会话文件被删（404）时丢弃缓存、重开一个新会话再试一次，避免房间永久卡死。
      const status = (error as { status?: number }).status;
      if (status === 404 && sessionFile) {
        sessions.delete(roomId);
        segments.length = 0;
        seenTextBlocks.clear();
        errorMessage = undefined;
        try {
          await attempt(undefined);
        } catch (retryError) {
          errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
        }
      } else {
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    } finally {
      // ACT: 本轮结束即释放画布桥，未完成（挂起）的画布调用会被置为失败，不会泄漏到下一轮。
      bridge?.dispose();
    }
    const reply = segments.join("\n\n").trim();
    if (reply) await sendText(roomId, reply).catch(() => {});
    else if (errorMessage) await client.sendNotice(roomId, `处理失败：${errorMessage}`).catch(() => {});
  }

  return {
    respond(roomId, body, senderName, sender, eventId, quote) {
      // ACT: 同一触发事件只处理一次，避免重复轮次与重复回执。
      if (eventId) {
        if (processedEvents.has(eventId)) return Promise.resolve();
        processedEvents.add(eventId);
      }
      const previous = queues.get(roomId) ?? Promise.resolve();
      // 前一轮无论成功失败都继续排下一条，保证房间消息不丢、不并发。
      const next = previous.then(
        () => respondOnce(roomId, body, senderName, sender, eventId, quote),
        () => respondOnce(roomId, body, senderName, sender, eventId, quote),
      );
      queues.set(roomId, next.catch(() => {}));
      return next;
    },
  };
}
