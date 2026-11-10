<template>
  <section class="chatPanel" :class="{ embedded }">
    <header class="chatHeader">
      <el-select
        class="roomSelect"
        :model-value="activeRoomId || undefined"
        :placeholder="translate('切换群聊')"
        :disabled="!ready"
        @update:model-value="setActiveRoom">
        <el-option v-for="room in joinedRooms" :key="room.id" :label="room.name" :value="room.id" />
      </el-select>
      <span class="chatStatus">
        <el-tag v-if="chatError" type="danger" size="small" effect="plain">{{ translate("连接失败") }}</el-tag>
        <el-tag v-else-if="connecting" type="info" size="small" effect="plain">{{ translate("连接中…") }}</el-tag>
        <el-tag v-else-if="ready" type="success" size="small" effect="plain">{{ translate("已连接") }}</el-tag>
        <el-tag v-else type="info" size="small" effect="plain">{{ translate("未连接") }}</el-tag>
        <el-tag v-if="isHost" type="warning" size="small" effect="plain">{{ translate("主持人") }}</el-tag>
      </span>
      <div class="chatHeaderActions">
        <el-popover v-if="invites.length" placement="bottom-end" :width="260" trigger="click">
          <template #reference>
            <el-badge :value="invites.length" :max="9" class="inviteBadge">
              <button class="roomAction" type="button" :aria-label="translate('待接受邀请')">
                <icon-bell :size="18" aria-hidden="true" />
              </button>
            </el-badge>
          </template>
          <ul class="inviteList">
            <li v-for="room in invites" :key="room.id">
              <span class="inviteName">{{ room.name }}</span>
              <el-button size="small" type="primary" plain :loading="busyRoom === room.id" :disabled="!ready" @click="accept(room.id)">
                {{ translate("加入") }}
              </el-button>
            </li>
          </ul>
        </el-popover>
        <el-tooltip :content="translate('新建群聊')" placement="bottom" :show-after="100">
          <button class="roomAction" type="button" :disabled="!ready" :aria-label="translate('新建群聊')" @click="createVisible = true">
            <icon-plus :size="18" aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip :content="translate('加入群聊')" placement="bottom" :show-after="100">
          <button class="roomAction" type="button" :disabled="!ready" :aria-label="translate('加入群聊')" @click="joinVisible = true">
            <icon-link :size="18" aria-hidden="true" />
          </button>
        </el-tooltip>
      </div>
    </header>

    <el-scrollbar ref="scroller" class="chatBody">
      <div class="messageList">
        <p v-if="!activeRoomId" class="emptyHint">{{ translate("还没有群聊，点右上角新建一个。") }}</p>
        <p v-else-if="!timeline.length" class="emptyHint">{{ translate("还没有消息，发送第一条开始讨论吧。") }}</p>
        <div v-for="msg in timeline" :key="msg.id" class="messageRow" :class="{ mine: msg.mine, anchored: anchoredId === msg.id }" :data-event-id="msg.id" @contextmenu.prevent="openQuoteMenu($event, msg)">
          <!-- ACT: 圆形头像置于气泡外侧（他人左/自己右）；无头像时用首字母占位圆。 -->
          <span v-if="!msg.mine" class="msgAvatar" :aria-label="msg.senderName">
            <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
            <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
          </span>
          <div class="bubble">
            <div class="meta">
              <span class="time">{{ formatTime(msg.ts) }}</span>
            </div>
            <button v-if="msg.msgtype === 'm.video' && msg.url" type="button" class="videoCard" :class="{ active: msg.id === selectedVideoId }" @click="selectVideo(msg.id)">
              <span class="videoCardIcon" :style="{ '--tool-icon': `url(&quot;${iconMovieFilm}&quot;)` }" aria-hidden="true" />
              <span class="videoCardName">{{ msg.body || translate("视频") }}</span>
            </button>
            <!-- ACT: 点击图片交主面板（与视频播放器同位）展示；工作室无主面板，保留 el-image 全屏预览。 -->
            <el-image
              v-else-if="msg.msgtype === 'm.image' && msg.url"
              class="media"
              :class="{ clickable: !embedded }"
              :src="msg.url"
              fit="contain"
              :preview-src-list="embedded ? [msg.url] : []"
              @click="openStageImage(msg.id)" />
            <!-- ACT: 附件卡片：m.file 渲染为可下载卡片（blob 已经鉴权媒体解析），点击按原文件名落盘。 -->
            <button v-else-if="msg.msgtype === 'm.file' && msg.url" type="button" class="fileCard" :title="translate('下载')" @click="downloadFile(msg)">
              <span class="fileCardIcon" :style="{ '--tool-icon': `url(&quot;${iconFileUpload}&quot;)` }" aria-hidden="true" />
              <span class="fileCardName">{{ msg.body || translate("文件") }}</span>
            </button>
            <p class="text">{{ msg.body }}</p>
            <!-- ACT: 微信式引用条：回复消息下方以灰底小字展示被引用消息（发送者+正文摘要），点击跳回原文。 -->
            <button v-if="msg.quote" type="button" class="quote" @click="jumpToEvent(msg.quote.id)">
              <span class="quoteSender">{{ msg.quote.senderName }}: </span><span class="quoteBody">{{ msg.quote.body }}</span>
            </button>
          </div>
          <span v-if="msg.mine" class="msgAvatar" :aria-label="msg.senderName">
            <img v-if="msg.senderAvatar" :src="msg.senderAvatar" :alt="msg.senderName" />
            <span v-else class="initial">{{ msg.senderName.charAt(0) }}</span>
          </span>
        </div>
      </div>
    </el-scrollbar>

    <div class="typingBar" aria-live="polite">
      <span v-if="typingNames.length">{{ typingNames.join("、") }} 正在输入…</span>
    </div>

    <!-- ACT: 微信式右键菜单：首项按消息类型变化（视频→播放 / 图片→查看 / 文本→复制），其后恒为「引用」。 -->
    <div v-if="quoteMenu" class="quoteMenu" :style="{ left: `${quoteMenu.x}px`, top: `${quoteMenu.y}px` }" role="menu">
      <button v-if="!embedded && quoteMenu.msg.msgtype === 'm.video' && quoteMenu.msg.url" type="button" role="menuitem" @click="playFromMenu">{{ translate("播放") }}</button>
      <button v-else-if="!embedded && quoteMenu.msg.msgtype === 'm.image' && quoteMenu.msg.url" type="button" role="menuitem" @click="viewFromMenu">{{ translate("查看") }}</button>
      <button v-else-if="quoteMenu.msg.msgtype === 'm.text'" type="button" role="menuitem" @click="copyFromMenu">{{ translate("复制") }}</button>
      <button type="button" role="menuitem" @click="applyQuote">{{ translate("引用") }}</button>
      <!-- ACT: 仅自己的消息可删（Matrix redaction）；危险操作红字展示。 -->
      <button v-if="quoteMenu.msg.mine" type="button" role="menuitem" class="danger" @click="deleteFromMenu">{{ translate("删除") }}</button>
    </div>

    <footer class="chatComposer">
      <!-- ACT: 团队弹层：只读列出房间编排客服与已启用团队（含成员分工）；遮罩层点外关闭。 -->
      <div v-if="teamVisible" class="teamBackdrop" @click="teamVisible = false"></div>
      <div v-if="teamVisible" class="teamPopover" role="dialog" :aria-label="translate('团队')">
        <header class="teamPopoverTitle">{{ translate("团队") }}</header>
        <ul class="teamList">
          <li class="teamItem">
            <span class="teamName">{{ translate("房间编排客服") }}</span>
            <span class="teamDesc">{{ translate("驻守本群聊：理解消息、编排团队、投递成果与回执。") }}</span>
          </li>
          <li v-for="item in teams" :key="item.name" class="teamItem">
            <span class="teamName">{{ item.displayName }}</span>
            <span class="teamDesc">{{ item.description }}</span>
            <ul v-if="item.members.length" class="memberList">
              <li v-for="member in item.members" :key="member.name">
                <span class="memberName">{{ member.name }}</span>
                <span class="teamDesc">{{ member.description }}</span>
              </li>
            </ul>
          </li>
        </ul>
        <p v-if="teamLoading" class="teamEmpty">{{ translate("加载中…") }}</p>
        <p v-else-if="!teams.length" class="teamEmpty">{{ translate("暂无已启用团队") }}</p>
      </div>
      <!-- ACT: 发送前引用预览条：输入框上方灰底一条展示被引用消息，可点 × 取消。 -->
      <div v-if="pendingQuote" class="quotePreview">
        <span class="quotePreviewText"><b>{{ pendingQuote.senderName }}: </b>{{ pendingQuote.body }}</span>
        <button type="button" class="quotePreviewClose" :aria-label="translate('取消引用')" :title="translate('取消引用')" @click="pendingQuote = null">×</button>
      </div>
      <div class="composerMain">
        <el-input
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 5 }"
          resize="none"
          :disabled="!ready || !activeRoomId"
          :placeholder="translate('输入消息，Enter 发送，Shift+Enter 换行')"
          :aria-label="translate('消息输入')"
          @input="noteTyping"
          @keydown.enter.exact.prevent="send" />
        <el-button class="sendButton" type="primary" :disabled="!ready || !activeRoomId || !draft.trim()" :aria-label="translate('发送')" :title="translate('发送')" @click="send">
          <icon-send :size="18" aria-hidden="true" />
        </el-button>
      </div>

      <div class="composerTools">
        <div class="toolGroup">
          <el-button class="toolButton" :aria-label="translate('团队')" :title="translate('团队')" @click="team">
            <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconUserGroup}&quot;)` }" aria-hidden="true" />
          </el-button>
          <el-button class="toolButton" :aria-label="translate('上传文件')" :title="translate('上传文件')" @click="fileInput?.click()">
            <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconFileUpload}&quot;)` }" aria-hidden="true" />
          </el-button>
          <input ref="fileInput" type="file" multiple hidden :disabled="!ready" @change="onPickFiles" />
        </div>
      </div>
    </footer>

    <!-- 新建群聊：名称 + 可选邀请成员 -->
    <el-dialog v-model="createVisible" :title="translate('新建群聊')" width="min(420px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false">
      <el-form class="roomForm" label-position="top" @submit.prevent="submitCreate">
        <el-form-item :label="translate('群聊名称')">
          <el-input v-model="createName" maxlength="60" :disabled="actionBusy" :placeholder="translate('例如：我的剧组')" @keydown.enter="submitCreate" />
        </el-form-item>
        <el-form-item :label="translate('邀请成员')">
          <el-input v-model="createInvite" :disabled="actionBusy" :placeholder="translate('用户名以逗号分隔，例如 friend1, friend2')" @keydown.enter="submitCreate" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialogFooter">
          <el-button :disabled="actionBusy" @click="createVisible = false">{{ translate("取消") }}</el-button>
          <el-button type="primary" :loading="actionBusy" :disabled="!createName.trim()" @click="submitCreate">{{ translate("创建") }}</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 加入群聊：房间 ID 或别名 -->
    <el-dialog v-model="joinVisible" :title="translate('加入群聊')" width="min(420px, calc(100vw - 32px))" alignCenter appendToBody :closeOnClickModal="false">
      <el-form class="roomForm" label-position="top" @submit.prevent="submitJoin">
        <el-form-item :label="translate('房间 ID 或别名')">
          <el-input v-model="joinTarget" :disabled="actionBusy" placeholder="!xxxx:localhost / #name:localhost" @keydown.enter="submitJoin" />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="dialogFooter">
          <el-button :disabled="actionBusy" @click="joinVisible = false">{{ translate("取消") }}</el-button>
          <el-button type="primary" :loading="actionBusy" :disabled="!joinTarget.trim()" @click="submitJoin">{{ translate("加入") }}</el-button>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";
import { ElMessage, type ScrollbarInstance } from "element-plus";
import { translate } from "@toonflow/i18n/vue";
// ACT: 工具按钮图标统一取自 src/icons（CSS mask + currentColor 着色，与全局外壳一致）。
import iconUserGroup from "@/icons/user_group.svg";
import iconFileUpload from "@/icons/file_upload.svg";
import iconMovieFilm from "@/icons/movie_film.svg";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat, type ChatMessage } from "@/composables/useMatrixChat";

// ACT: 可复用的「房间时间线聊天框」（计划 Task 3）。它是 Chat 页与 Studio 页共用的同一个组件，
// 只渲染 Matrix 房间时间线 + 输入区，不含模型选择器/提及/工具气泡——customer_service（服务器侧
// pi-coding Agent）的工具与画布活动都以房间消息形式出现在这里，两个模式下渲染完全一致。
// 模式专属控件（生成入口/模型选择/画布工具）一律放在工作室页面 chrome，聊天框保持纯净（Task 6）。
// Matrix 状态是模块级单例，页面与本组件共享同一份 timeline/rooms/activeRoomId。
const props = withDefaults(defineProps<{
  // 内嵌到工作室时为 true：仅用于外观微调（聊天框本身两模式一致）。
  embedded?: boolean;
  // 视图模式：one-shot（群聊页）| step-by-step（工作室）。仅作语义标记，聊天框本身两模式一致。
  mode?: "one-shot" | "step-by-step";
}>(), { embedded: false, mode: "one-shot" });

const emit = defineEmits<{
  // 点击时间线里的视频卡片：由页面决定加载到视频舞台或预览。
  (event: "select-video", id: string): void;
  // ACT: 右键菜单「播放」：页面把该视频载入左栏视频舞台并自动起播。
  (event: "play-video", id: string): void;
  // ACT: 右键菜单「查看」：页面在右栏图片查看器里展示该图片。
  (event: "view-image", id: string): void;
  // ACT: 点击时间线图片：页面把该图片载入主面板（与视频播放器同位）展示。
  (event: "stage-image", id: string): void;
}>();

const route = useRoute();
const auth = useAuthStore();
const {
  ready, connecting, error: chatError, joinedRooms, invites,
  activeRoomId, isHost, timeline, typingNames, pendingQuote,
  bootstrap, setActiveRoom, createRoom, joinRoom, acceptInvite,
  sendText, sendFile, deleteMessage, noteTyping,
} = useMatrixChat();

const draft = ref("");
const scroller = ref<ScrollbarInstance>();
const fileInput = ref<HTMLInputElement>();
const createVisible = ref(false);
const createName = ref("");
const createInvite = ref("");
const joinVisible = ref(false);
const joinTarget = ref("");
const busyRoom = ref("");
const actionBusy = ref(false);
// 当前在视频舞台选中的消息（仅用于卡片高亮）；真正的播放由页面处理。
const selectedVideoId = ref("");

function selectVideo(id: string) {
  selectedVideoId.value = id;
  emit("select-video", id);
}

// ── 广场深链：切到指定房间并滚动到指定消息 ──
// ACT: 广场卡片点击带 ?room=&event= 进来：先切房间，再轮询等事件出现在时间线里，
// 然后 scrollIntoView 到该消息并短暂高亮。锚定期间抑制自动滚底。
const anchoredId = ref("");
let suppressAutoScroll = false;
let anchorTimer: ReturnType<typeof setTimeout> | null = null;

async function anchorFromQuery() {
  const roomId = typeof route.query.room === "string" ? route.query.room : "";
  const eventId = typeof route.query.event === "string" ? route.query.event : "";
  if (!roomId || !auth.signedIn || !ready.value) return;
  suppressAutoScroll = !!eventId;
  if (activeRoomId.value !== roomId) setActiveRoom(roomId);
  if (!eventId) { suppressAutoScroll = false; return; }
  const deadline = Date.now() + 5000;
  while (!timeline.value.some(msg => msg.id === eventId) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await nextTick();
  suppressAutoScroll = false;
  const wrap = scroller.value?.wrapRef;
  const target = wrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`) ?? null;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  anchoredId.value = eventId;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => { anchoredId.value = ""; }, 2600);
}

// ACT: 引用条点击：滚到被引用消息并短暂高亮（复用锚定的滚动+高亮逻辑）。
function jumpToEvent(eventId: string) {
  const wrap = scroller.value?.wrapRef;
  const target = wrap?.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`) ?? null;
  if (!target) return;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  anchoredId.value = eventId;
  if (anchorTimer) clearTimeout(anchorTimer);
  anchorTimer = setTimeout(() => { anchoredId.value = ""; }, 2600);
}
watch([() => route.query.room, () => route.query.event, ready, () => auth.signedIn], () => { void anchorFromQuery(); }, { immediate: true });

// ── 微信式「引用」：右键消息弹菜单，选择后在输入框上方挂引用条，发送时随 in_reply_to 发出 ──
const quoteMenu = ref<{ x: number; y: number; msg: ChatMessage } | null>(null);

function closeQuoteMenu() { quoteMenu.value = null; }

function onQuoteMenuKey(event: KeyboardEvent) { if (event.key === "Escape") quoteMenu.value = null; }

function openQuoteMenu(event: MouseEvent, msg: ChatMessage) {
  // ACT: 菜单约 96×96（最多三项：类型项/引用/删除）：贴右键位置弹出，靠边时收回视口内。
  const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 104));
  const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 104));
  quoteMenu.value = { x, y, msg };
}

function applyQuote() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  pendingQuote.value = { id: msg.id, senderName: msg.senderName, body: msg.body.replace(/\s+/g, " ").trim() };
}

// ACT: 右键菜单「播放」：复用卡片点选的选择链路，再额外发 play-video 让页面自动起播。
function playFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  selectVideo(msg.id);
  emit("play-video", msg.id);
}

// ACT: 右键菜单「查看」：把图片消息 id 交给页面，由右栏查看器展示。
function viewFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  emit("view-image", msg.id);
}

// ACT: 点击时间线图片：群聊页交主面板（与视频播放器同位）展示；工作室（embedded）无主面板，
// 直接返回，由 el-image 自带的全屏预览接管。
function openStageImage(id: string) {
  if (props.embedded) return;
  emit("stage-image", id);
}

// ACT: 右键菜单「复制」：文本正文进系统剪贴板，可粘贴到输入框或任何地方。
async function copyFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  try {
    await navigator.clipboard.writeText(msg.body);
    ElMessage.success(translate("已复制到剪贴板"));
  } catch {
    ElMessage.error(translate("复制失败，请手动复制"));
  }
}

// ACT: 右键菜单「删除」：只对自己的消息展示，走 redaction 后刷新时间线；失败时 toast 提示。
async function deleteFromMenu() {
  const msg = quoteMenu.value?.msg;
  quoteMenu.value = null;
  if (!msg) return;
  try {
    await deleteMessage(msg.id);
    ElMessage.success(translate("已删除"));
  } catch {
    ElMessage.error(translate("删除失败，请稍后重试"));
  }
}
onBeforeUnmount(() => {
  if (anchorTimer) clearTimeout(anchorTimer);
  window.removeEventListener("click", closeQuoteMenu);
  window.removeEventListener("keydown", onQuoteMenuKey);
});

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

async function scrollToBottom() {
  if (suppressAutoScroll) return;
  await nextTick();
  const wrap = scroller.value?.wrapRef;
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

async function send() {
  const text = draft.value.trim();
  if (!text || !ready.value || !activeRoomId.value) return;
  draft.value = "";
  try {
    await sendText(text);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "发送失败");
  }
}

// 把 host / @host / @host:localhost 统一补成完整 Matrix ID（邀请成员用）。
function toMxid(input: string) {
  const name = input.trim();
  if (!name) return "";
  if (name.startsWith("@")) return name;
  if (name.includes(":")) return `@${name}`;
  const serverName = auth.myUserId.split(":")[1] || "localhost";
  return `@${name}:${serverName}`;
}

async function submitCreate() {
  if (actionBusy.value || !createName.value.trim()) return;
  actionBusy.value = true;
  try {
    await createRoom({
      name: createName.value,
      invite: createInvite.value.split(/[,，\s]+/).map(toMxid).filter(Boolean),
    });
    createVisible.value = false;
    createName.value = "";
    createInvite.value = "";
    ElMessage.success("群聊已创建");
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "创建群聊失败");
  } finally {
    actionBusy.value = false;
  }
}

async function submitJoin() {
  if (actionBusy.value || !joinTarget.value.trim()) return;
  actionBusy.value = true;
  try {
    await joinRoom(joinTarget.value);
    joinVisible.value = false;
    joinTarget.value = "";
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加入群聊失败");
  } finally {
    actionBusy.value = false;
  }
}

async function accept(roomId: string) {
  if (busyRoom.value) return;
  busyRoom.value = roomId;
  try {
    await acceptInvite(roomId);
    await scrollToBottom();
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加入群聊失败");
  } finally {
    busyRoom.value = "";
  }
}

// ── 团队弹层：只读列出房间编排客服与已启用团队（含成员分工） ──
type TeamMemberInfo = { name: string; description: string };
type TeamInfo = { name: string; displayName: string; description: string; members: TeamMemberInfo[] };
const teamVisible = ref(false);
const teamLoading = ref(false);
const teams = ref<TeamInfo[]>([]);

function team() {
  teamVisible.value = !teamVisible.value;
  if (teamVisible.value) void loadTeams();
}

async function loadTeams() {
  teamLoading.value = true;
  try {
    const { data } = await axios.get("/api/agents/get");
    const agents = data?.code === 200 && Array.isArray(data.data?.agents) ? (data.data.agents as Record<string, unknown>[]) : [];
    teams.value = agents
      .filter(agent => agent.enabled === true)
      .map(agent => ({
        name: String(agent.name ?? ""),
        displayName: String(agent.displayName ?? agent.name ?? ""),
        description: String(agent.description ?? ""),
        members: Array.isArray(agent.members)
          ? (agent.members as Record<string, unknown>[]).map(member => ({ name: String(member.name ?? ""), description: String(member.description ?? "") }))
          : [],
      }));
  } catch {
    teams.value = [];
  } finally {
    teamLoading.value = false;
  }
}

// ACT: 附件上传：逐个走 sendFile（按 MIME 分发 m.image/m.video/m.file）；单文件失败提示后继续其余。
async function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  for (const file of files) {
    try {
      await sendFile(file);
    } catch (err) {
      ElMessage.error(err instanceof Error ? err.message : translate("上传失败，请稍后重试"));
    }
  }
}

// ACT: 文件卡片点击：按原文件名落盘；blob 已经鉴权媒体解析，直接交给 anchor 下载。
function downloadFile(msg: ChatMessage) {
  if (!msg.url) return;
  const anchor = document.createElement("a");
  anchor.href = msg.url;
  anchor.download = msg.body || "file";
  anchor.click();
}

async function start() {
  if (!auth.signedIn) return;
  const ok = await bootstrap();
  if (!ok) ElMessage.error("无法连接 Matrix/Synapse，请确认本地 Synapse 已启动且已配置 config.json 的 synapse 块");
  await scrollToBottom();
}

watch(() => timeline.value.length, scrollToBottom);
watch(activeRoomId, scrollToBottom);
// ACT: 登录/退出都会切换 signedIn；登录后自动接上 Matrix 客户端（退出时的断开由 useMatrixChat 负责）。
watch(() => auth.signedIn, value => { if (value) void start(); });

onMounted(async () => {
  window.addEventListener("click", closeQuoteMenu);
  window.addEventListener("keydown", onQuoteMenuKey);
  await auth.restore();
  await start();
});

defineExpose({ scrollToBottom, activeRoomId });
// props 目前仅用于模板分支；显式引用避免未使用告警。
void props;
</script>

<style lang="scss" scoped>
.chatPanel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  // ACT: 显式钉住基准字号 14px，与设置页/群聊页保持一致（不继承 body 的 16px）。
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.roomAction {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--el-border-color);
  border-radius: var(--ui-radius);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;

  &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
}

.chatHeader {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--shell-page-header-h, 56px);
  padding: 0 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  .roomSelect {
    flex-shrink: 1;
    min-width: 0;
    max-width: 180px;
  }

  .chatStatus {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .chatHeaderActions {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-inline-start: auto;
    flex-shrink: 0;
  }

  .inviteBadge {
    :deep(.el-badge__content) { z-index: 1; }
  }
}

.inviteList {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;

    &:not(:last-child) { border-bottom: 1px solid var(--el-border-color-lighter); }
  }

  .inviteName {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-size: 13px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
}

.chatBody {
  min-height: 0;

  .messageList {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
  }

  .emptyHint {
    margin: auto;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    text-align: center;
  }

  .messageRow {
    display: flex;
    align-items: flex-end;
    gap: 8px;

    &.mine {
      justify-content: flex-end;

      .bubble {
        background: var(--el-color-primary-light-9);
      }
    }

    &.anchored .bubble {
      background: var(--el-color-primary-light-9);
      outline: 2px solid var(--el-color-primary);
      outline-offset: 2px;
    }
  }

  .msgAvatar {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--el-fill-color);
    color: var(--el-text-color-regular);

    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .initial {
      font-size: 14px;
      font-weight: 600;
    }
  }

  .bubble {
    max-width: min(72%, 640px);
    padding: 8px 12px;
    border-radius: var(--ui-radius);
    background: var(--el-fill-color-light);

    .meta {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;

      .time {
        font-size: 11px;
        color: var(--el-text-color-secondary);
      }
    }

    .media {
      max-width: 100%;
      border-radius: calc(var(--ui-radius) * 0.75);
      margin-bottom: 4px;

      // ACT: 可点进主面板的图片：放大镜光标提示可点击。
      &.clickable { cursor: zoom-in; }
    }

    // ACT: 微信式引用条：灰底、左竖线、最多两行截断；点击跳回被引用消息。
    .quote {
      display: -webkit-box;
      width: 100%;
      margin-top: 6px;
      padding: 4px 8px;
      border: none;
      border-left: 2px solid var(--el-border-color);
      border-radius: 4px;
      background: var(--el-fill-color);
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.5;
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;

      .quoteSender {
        color: var(--el-text-color-regular);
      }
    }

    .videoCard {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--el-border-color);
      border-radius: calc(var(--ui-radius) * 0.75);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: start;
      transition: border-color 0.15s ease, background 0.15s ease;

      &:hover { background: var(--el-fill-color); }
      &.active {
        border-color: var(--el-color-primary);
        background: var(--el-color-primary-light-9);
      }
    }

    .videoCardIcon {
      display: block;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      background-color: currentColor;
      mask-image: var(--tool-icon);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--tool-icon);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
    }

    .videoCardName {
      overflow: hidden;
      font-size: 13px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    // ACT: 附件卡片：与视频卡片同形的通栏边框行；点击按原文件名下载。
    .fileCard {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--el-border-color);
      border-radius: calc(var(--ui-radius) * 0.75);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: start;
      transition: border-color 0.15s ease, background 0.15s ease;

      &:hover {
        background: var(--el-fill-color);
      }
    }

    .fileCardIcon {
      display: block;
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      background-color: currentColor;
      mask-image: var(--tool-icon);
      mask-repeat: no-repeat;
      mask-position: center;
      mask-size: contain;
      -webkit-mask-image: var(--tool-icon);
      -webkit-mask-repeat: no-repeat;
      -webkit-mask-position: center;
      -webkit-mask-size: contain;
    }

    .fileCardName {
      overflow: hidden;
      font-size: 13px;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .text {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
  }
}

.typingBar {
  min-height: 20px;
  padding: 0 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

// ACT: 微信式右键菜单：浮层小菜单，目前仅「引用」一项。
.quoteMenu {
  position: fixed;
  z-index: 3000;
  min-width: 88px;
  padding: 4px;
  border-radius: 8px;
  background: var(--el-bg-color-overlay);
  box-shadow: var(--el-box-shadow-light);

  button {
    display: block;
    width: 100%;
    padding: 6px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;

    &:hover {
      background: var(--el-fill-color-light);
    }

    // ACT: 菜单里的危险项（删除）：红字，悬停淡红底。
    &.danger {
      color: var(--el-color-danger);

      &:hover {
        background: var(--el-color-danger-light-9);
      }
    }
  }
}

// ACT: 发送前引用预览条：输入框上方灰底一条，单行截断，可取消。
.quotePreview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 4px 8px;
  border-left: 2px solid var(--el-border-color);
  border-radius: 4px;
  background: var(--el-fill-color);
  color: var(--el-text-color-secondary);
  font-size: 12px;

  .quotePreviewText {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quotePreviewClose {
    border: none;
    background: transparent;
    color: var(--el-text-color-secondary);
    font-size: 14px;
    cursor: pointer;
  }
}

.chatComposer {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);

  // ACT: 团队弹层遮罩：全屏透明层，点外关闭（z 30/31 与既有弹层约定一致）。
  .teamBackdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
  }

  // ACT: 团队弹层：错定在输入区上方（bottom: 100% + 8px），只读花名册。
  .teamPopover {
    position: absolute;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 31;
    width: min(320px, calc(100vw - 32px));
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 10px;
    background: var(--el-bg-color-overlay);
    box-shadow: var(--el-box-shadow-light);

    .teamPopoverTitle {
      margin-bottom: 6px;
      font-size: 13px;
      font-weight: 600;
    }

    .teamList {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .teamItem {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .teamName {
      font-size: 13px;
      color: var(--el-text-color-primary);
    }

    .teamDesc {
      font-size: 12px;
      line-height: 1.5;
      color: var(--el-text-color-secondary);
    }

    .memberList {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 4px;
      padding-left: 10px;
      border-left: 2px solid var(--el-border-color-lighter);
    }

    .memberName {
      font-size: 12px;
      color: var(--el-text-color-regular);
    }

    .teamEmpty {
      margin-top: 6px;
      font-size: 12px;
      color: var(--el-text-color-secondary);
    }
  }

  .composerMain {
    display: flex;
    align-items: flex-end;
    gap: 12px;

    :deep(.el-textarea) {
      flex: 1;
    }

    // ACT: 输入框高度底线（1 行 = 1.5em 行高 + 上下 5px 内边距）：autosize 在个别页面挂载
    // 时机下会算出偏矮的内联 min-height/height（Studio 停靠列复现），内联样式优先级高于普通
    // CSS，故用 !important 钉住与 Chat 页一致的单行高度；多行输入时内联 height 增大不受影响。
    :deep(.el-textarea__inner) {
      min-height: calc(1.5em + 10px) !important;
    }
  }

  .sendButton {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: 10px;
  }

  .composerTools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .toolGroup {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-inline-start: auto;
  }

  .toolButton {
    width: 36px;
    height: 36px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--el-border-color);
    border-radius: 10px;
    background: transparent;
    color: var(--el-text-color-primary);

    &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
  }

  .toolIcon {
    display: block;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    background-color: currentColor;
    mask-image: var(--tool-icon);
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
    -webkit-mask-image: var(--tool-icon);
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-position: center;
    -webkit-mask-size: contain;
  }
}

.roomForm {
  :deep(.el-form-item) { margin-bottom: 16px; }
  :deep(.el-form-item:last-child) { margin-bottom: 0; }
}

.dialogFooter {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
