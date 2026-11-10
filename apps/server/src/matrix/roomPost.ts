import * as sdk from "matrix-js-sdk";

// ACT: 房间发帖器 —— 在 trigger.ts/responder.ts 的宽松 sendEvent 口径之上，补充两种能力：
// 1) m.mentions（Matrix 规范字段，Synapse 原生支持）：被 @ 的用户会收到高亮与通知；
//    正文同时携带 "@显示名" 纯文本，兼容不解析 m.mentions 的旧客户端。
// 2) 文件投递：uploadContent 后发 m.file 事件，用于把文学剧本等工作区产物贴回房间。
// matrix-js-sdk v42 的 sendEvent 重载按 msgtype 严格约束 content 形状，自定义字段（m.mentions 等）
// 只能断言成宽松签名传入，与 trigger.ts 的处理一致。

export interface RoomPostOptions {
  // 需要 @ 的用户 mxid 列表；正文里应已包含对应的 "@显示名" 文本。
  mentions?: string[];
  // 可选 HTML 富文本正文（format=org.matrix.custom.html）。
  html?: string;
  // ACT: 可选引用回复：指向被回复消息的 event_id，客户端会渲染成引用/盖楼，
  // 使回执、投递等消息在时间线上明确「回应的是哪一条」。
  replyTo?: string;
}

export interface RoomPoster {
  sendText(roomId: string, body: string, options?: RoomPostOptions): Promise<void>;
  sendFile(roomId: string, bytes: Uint8Array, file: { filename: string; mimetype: string }, options?: RoomPostOptions): Promise<void>;
}

export function createRoomPoster(client: sdk.MatrixClient): RoomPoster {
  // ACT: 必须 .bind(client)：v42 的 sendEvent 内部依赖 this（addThreadRelationIfNeeded），
  // 解构/赋值会丢失 this，运行期抛 TypeError。
  const sendRoomMessage = client.sendEvent.bind(client) as unknown as (
    roomId: string, eventType: string, content: Record<string, unknown>,
  ) => Promise<unknown>;
  const relate = (options?: RoomPostOptions) => ({
    ...(options?.mentions?.length ? { "m.mentions": { user_ids: options.mentions } } : {}),
    ...(options?.html ? { format: "org.matrix.custom.html", formatted_body: options.html } : {}),
    ...(options?.replyTo ? { "m.relates_to": { "m.in_reply_to": { event_id: options.replyTo } } } : {}),
  });
  return {
    async sendText(roomId, body, options) {
      await sendRoomMessage(roomId, sdk.EventType.RoomMessage, { msgtype: sdk.MsgType.Text, body, ...relate(options) });
    },
    async sendFile(roomId, bytes, file, options) {
      const uploaded = await client.uploadContent(bytes, { name: file.filename, type: file.mimetype });
      await sendRoomMessage(roomId, sdk.EventType.RoomMessage, {
        msgtype: sdk.MsgType.File,
        body: file.filename,
        filename: file.filename,
        url: uploaded.content_uri,
        info: { mimetype: file.mimetype, size: bytes.byteLength },
        ...relate(options),
      });
    },
  };
}
