<template>
  <main ref="chatEl" class="chat" :style="{ '--chat-w': chatWidth + 'px' }">
    <!-- ACT: 未登录时整页只给出登录引导；登录态由顶栏/账户页共用的 loginDialog 提供。 -->
    <section v-if="!auth.signedIn" class="signedOut">
      <el-empty :description="translate('登录后即可参与群聊')">
        <el-button type="primary" @click="loginVisible = true">{{ translate("登录") }}</el-button>
      </el-empty>
    </section>

    <template v-else>
      <!-- 左栏：视频播放与截图舞台；点击图片时同位切换为图片展示（缩放控制） -->
      <videoStage :items="videoItems" v-model="selectedVideoId" :play-token="playToken" :image="stageImage" />

      <!-- ACT: 就地模式切换器（Task 4）：在 one-shot（本页）与 step-by-step（/studio）之间切换，带当前房间过去。
           绝对定位悬浮在视频舞台水平中心，不影响三列网格布局。 -->
      <modeSwitcher class="modeSwitch" mode="one-shot" />

      <!-- ACT: 可拖拽竖直分隔条：按住左右移动实时改右栏（聊天框）宽度。 -->
      <div class="chatResize" :class="{ dragging: resizing }" @pointerdown="onResizeDown" />

      <!-- ACT: 右栏：共用的房间时间线聊天框（与工作室同一个组件，Task 3）；
           右键「查看」图片时，图片查看器覆盖本栏展示，关闭后回到聊天。 -->
      <div class="chatColumn">
        <groupChat mode="one-shot" @select-video="onSelectVideo" @play-video="onPlayVideo" @view-image="onViewImage" @stage-image="onStageImage" />
        <imageViewer v-if="viewedImage" :url="viewedImage.url" :name="viewedImage.name" @close="viewedImage = null" />
      </div>
    </template>

    <loginDialog v-model="loginVisible" />
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { translate } from "@toonflow/i18n/vue";
import loginDialog from "@/components/loginDialog.vue";
import groupChat from "@/components/groupChat.vue";
import modeSwitcher from "@/components/modeSwitcher.vue";
import { useAuthStore } from "@/stores/auth";
import { useMatrixChat } from "@/composables/useMatrixChat";
import videoStage from "./components/videoStage.vue";
import imageViewer from "./components/imageViewer.vue";

// ACT: 群聊页（one-shot 视图）。房间时间线、输入区与房间管理都下沉到共用的 groupChat 组件，
// 本页只保留页面级职责：未登录引导、视频舞台、以及舞台与聊天框之间的可拖拽分隔条。
// Matrix 状态是模块级单例，这里直接读取 timeline 聚合视频卡片，与 groupChat 共享同一份数据。
const auth = useAuthStore();
const loginVisible = ref(false);
const { timeline, activeRoomId } = useMatrixChat();

// ── 视频舞台选择状态 ──
const selectedVideoId = ref("");
const videoItems = computed(() =>
  timeline.value.filter(m => m.msgtype === "m.video" && m.url).map(m => ({ id: m.id, url: m.url!, name: m.body })),
);
// ACT: 右键菜单「播放」的自播令牌：递增时视频舞台自动起播；仅选择（点卡片）不递增。
const playToken = ref(0);
// ACT: 右键菜单「查看」的右栏图片查看器状态；换房间时关闭，避免挂着别的房间的图。
const viewedImage = ref<{ url: string; name: string } | null>(null);
// ACT: 点击时间线图片后的主面板图片态：与视频播放器同位展示，直到选/播视频、换房间或消息被删除。
const stageImage = ref<{ id: string; url: string; name: string } | null>(null);
watch(activeRoomId, () => { viewedImage.value = null; stageImage.value = null; });
// ACT: 图片消息被删除（redaction）后时间线不再含该 id：同步收回舞台图片，避免挂着失效 blob。
watch(timeline, list => {
  const shown = stageImage.value;
  if (shown && !list.some(m => m.id === shown.id)) stageImage.value = null;
});

function onSelectVideo(id: string) {
  stageImage.value = null;
  selectedVideoId.value = id;
}

function onPlayVideo(id: string) {
  stageImage.value = null;
  selectedVideoId.value = id;
  playToken.value++;
}

function onStageImage(id: string) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  stageImage.value = { id, url: msg.url, name: msg.body || translate("图片") };
}

function onViewImage(id: string) {
  const msg = timeline.value.find(m => m.id === id);
  if (!msg?.url) return;
  viewedImage.value = { url: msg.url, name: msg.body || translate("图片") };
}

// ── 视频舞台与聊天区之间的分隔条拖拽 ──
// ACT: pointerdown 记下起始 X，pointermove 用窗口宽度 - clientX 算出右栏宽度，夹紧到 [320, vw*0.55]。
const CHAT_MIN = 320;
const chatWidth = ref(400);
const resizing = ref(false);
const chatEl = ref<HTMLElement>();

// ACT: 默认右栏（聊天框）宽度取主面板（.chat 容器）宽度的 1/3，挂载时按实际容器宽度计算一次；
// 用户拖拽分隔条后以拖拽值为准，不再回退到默认值。
function applyDefaultChatWidth() {
  const panel = chatEl.value?.clientWidth ?? 0;
  if (!panel) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, Math.round(panel / 3)));
}
onMounted(applyDefaultChatWidth);

function onResizeDown(event: PointerEvent) {
  event.preventDefault();
  resizing.value = true;
  document.addEventListener("pointermove", onResizeMove);
  document.addEventListener("pointerup", onResizeUp);
}
function onResizeMove(event: PointerEvent) {
  if (!resizing.value) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, window.innerWidth - event.clientX));
}
function onResizeUp() {
  if (!resizing.value) return;
  resizing.value = false;
  document.removeEventListener("pointermove", onResizeMove);
  document.removeEventListener("pointerup", onResizeUp);
}
onBeforeUnmount(onResizeUp);
</script>

<style lang="scss" scoped>
.chat {
  position: relative;
  display: grid;
  // ACT: 三列：视频舞台（弹性占满）+ 4px 分隔条 + 聊天框（宽度由拖拽变量 --chat-w 决定）。
  grid-template-columns: minmax(0, 1fr) 4px var(--chat-w, 400px);
  height: 100%;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  // ACT: 显式钉住基准字号 14px，与设置页保持一致（不继承 body 的 16px）。
  font-size: 14px;
}

.signedOut {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

// ACT: 右栏容器：聊天框撑满，图片查看器以 absolute 覆盖本栏（position: relative 错定）。
.chatColumn {
  position: relative;
  min-width: 0;
  min-height: 0;
}

// ACT: 模式切换器悬浮在视频舞台（左栏）水平中心：左栏宽 = 100% - 分隔条(4px) - 右栏(--chat-w)。
.modeSwitch {
  position: absolute;
  top: 12px;
  left: calc((100% - var(--chat-w, 400px) - 4px) / 2);
  z-index: 6;
  transform: translateX(-50%);
}

// ACT: 与 Studio 页分隔条一致：4px 命中区居中常显 1px 竖直分割线，悬停/拖拽时线亮主色。
.chatResize {
  position: relative;
  width: 4px;
  cursor: col-resize;
  background: transparent;

  &::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
    background: var(--el-border-color);
    transition: background 0.15s ease;
  }

  &:hover,
  &.dragging {
    &::before { background: var(--el-color-primary); }
  }
}
</style>
