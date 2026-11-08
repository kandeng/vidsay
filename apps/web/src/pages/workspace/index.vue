<template>
  <main ref="workspaceEl" class="workspacePage" :inert="workspaceStore.projectLoadingVisible" :style="{ '--chat-w': `${chatWidth}px` }">
    <canvasPanel
      :key="workspaceStore.project?.directory"
      v-model:selectedTool="selectedTool"
      ref="canvasPanelRef"
      class="canvasPanel"
      :class="{ backgroundPanel: activePanel !== 'canvas' }"
      :inert="activePanel !== 'canvas'"
      :aria-hidden="activePanel !== 'canvas'"
      :active="activePanel === 'canvas'" />
    <keep-alive :key="workspaceStore.project?.directory" :max="1">
      <documentPanel
        v-if="activePanel === 'document'"
        class="documentArea"
        :key="workspaceStore.project?.directory"
        :ref="setDocumentPanel"
        :readNode="readDocumentNode"
        :readNodes="readDocumentNodes"
        :focusNode="focusDocumentNode"
        :mountNode="mountDocumentNode"
        :resolveNodeFile="resolveDocumentNodeFile"
        :observeNode="observeDocumentNode"
        :flushNodes="flushDocumentNodes"
        :fileAction="performFileAction"
        :saveNode="saveDocumentNode" />
    </keep-alive>
    <div class="workspaceTools">
      <!-- ACT: 就地模式切换器（Task 4）：在 step-by-step（本页 /studio）与 one-shot（/chat）之间切换，带当前房间过去。
           放在 .workspaceTools（与画布同网格单元）右上角；聊天框为右侧独立网格列，不再遮挡画布。 -->
      <modeSwitcher class="modeSwitch" mode="step-by-step" />
    </div>
    <!-- ACT: 底部按钮条：独立网格行（第二行第一列），顶边 1px 描边即水平分割线；
         画布/文档面板只占第一行，节点与连线视口到线为止，不会渲染到线下。 -->
    <div class="studioBar">
        <!-- ACT: 工作流同步控件（画布权威/冲突策略的入口）：本地改动为待处理覆盖层，
             「更新」提交提案并自动发房间讨论消息，「同步」回滚到客服 Agent 已同意的最新版本，「恢复」重新应用被覆盖的改动。
             画布/文档切换按钮并入本组最左侧（「更新」之前），图标右侧带目标样式名标签；
             文档态本组同样完整显示（仅未连接房间时收起为切换按钮）。整组停靠在底部按钮条左侧。 -->
        <el-card class="syncMenu" shadow="never" :bodyStyle="{ padding: '4px' }">
          <div class="barRow" role="group" :aria-label="translate('工作流同步')">
            <el-tooltip :content="activePanel === 'canvas' ? '切换到文档' : '切换到画布'" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button type="button" class="barButton" :aria-label="activePanel === 'canvas' ? '切换到文档' : '切换到画布'" @click="togglePanel">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${activePanel === 'canvas' ? iconCanvasDocument : iconCanvasPalette}&quot;)` }" aria-hidden="true" />
                <span class="barLabel">{{ activePanel === 'canvas' ? translate("文件样式") : translate("画布样式") }}</span>
              </button>
            </el-tooltip>
            <template v-if="activeRoomId">
              <el-tooltip :content="graphPending ? '有未同步的本地改动，点击提交更新提案' : '当前没有未同步的本地改动'" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
                <button type="button" class="barButton" :disabled="!graphPending" aria-label="更新工作流" @click="submitGraphUpdate">
                  <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasUpdate}&quot;)` }" aria-hidden="true" />
                  <span class="barLabel">更新</span>
                  <span v-if="graphPending" class="pendingDot" aria-hidden="true" />
                </button>
              </el-tooltip>
              <el-tooltip content="回滚到客服 Agent 已同意的最新版本" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
                <button type="button" class="barButton" aria-label="同步工作流" @click="syncGraphToCommitted">
                  <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasSync}&quot;)` }" aria-hidden="true" />
                  <span class="barLabel">同步</span>
                </button>
              </el-tooltip>
              <el-tooltip v-if="graphCanReapply" content="重新应用上次被覆盖的本地改动" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
                <button type="button" class="barButton" aria-label="恢复本地改动" @click="reapplyProposal">
                  <IconRestore :size="18" aria-hidden="true" />
                  <span class="barLabel">恢复</span>
                </button>
              </el-tooltip>
              <!-- ACT: 计划 Task 13 —— 协作授权：用户明确同意后，客服 Agent 才能驱动本机画布/节点与调用本机本地模型。授权按账号记账，随时可关。 -->
              <el-popover trigger="click" placement="top-end" :width="300" popperClass="grantPopover">
                <template #reference>
                  <button type="button" class="barButton" aria-label="协作授权">
                    <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasConsent}&quot;)` }" aria-hidden="true" />
                    <span class="barLabel">授权</span>
                  </button>
                </template>
                <div class="grantMenu">
                  <p class="grantIntro">授权后，客服 Agent 才能在本房间驱动你的设备与调用你的本地模型。授权按账号记录，随时可关闭。</p>
                  <label class="grantRow">
                    <span class="grantLabel">允许驱动我的设备（画布/节点操作）</span>
                    <el-switch :model-value="roomGrant.driveSpokes" :loading="roomGrantSaving" @change="value => updateGrant({ driveSpokes: !!value })" />
                  </label>
                  <label class="grantRow">
                    <span class="grantLabel" :class="{ disabled: !hasLocalModel }">允许调用我的本地模型</span>
                    <el-switch :model-value="roomGrant.invokeLocalModels" :disabled="!hasLocalModel" :loading="roomGrantSaving" @change="value => updateGrant({ invokeLocalModels: !!value })" />
                  </label>
                  <p v-if="!hasLocalModel" class="grantHint">尚未在「设置 → 本地模型」配置可用的本地模型。</p>
                </div>
              </el-popover>
            </template>
          </div>
        </el-card>
        <!-- ACT: 画布工具组，停靠在画布底部右侧；文档态隐藏。组内顺序：添加→分组→搜索→素材库→移动画布→缩放。 -->
        <el-card v-if="activePanel === 'canvas'" class="toolMenu" shadow="never" :bodyStyle="{ padding: '4px' }">
          <div class="barRow" role="toolbar" aria-label="画布工具">
            <el-tooltip content="添加节点" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button type="button" class="barButton iconOnly" :disabled="!canvasPanelRef?.canvasReady" aria-label="添加节点" aria-haspopup="menu" @click="canvasPanelRef?.addNodeAtPointer()">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasAdd}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <!-- ACT: 原「移动/抓手」单按钮切换拆为两个独立按钮：分组节点（移动工具）与移动画布（抓手工具），各自高亮当前工具。 -->
            <el-tooltip content="分组节点" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="selectedTool === 'move'"
                aria-label="分组节点"
                @click="selectedTool = 'move'">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasGrouping}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip content="搜索节点" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button type="button" class="barButton iconOnly" :disabled="!canvasPanelRef?.canvasReady" aria-label="搜索节点" @click="canvasPanelRef?.openNodeSearch()">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasSearch}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :showArrow="false" :content="assetsVisible ? '关闭素材库' : '打开素材库'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="assetsVisible"
                aria-label="素材库"
                @click="assetsVisible = !assetsVisible">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasAsset}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip content="移动画布" placement="top" :showArrow="false" :hideAfter="0" :enterable="false" :triggerKeys="[]">
              <button
                type="button"
                class="barButton iconOnly"
                :aria-pressed="selectedTool === 'hand'"
                aria-label="移动画布"
                @click="selectedTool = selectedTool === 'hand' ? 'move' : 'hand'">
                <span class="toolIcon" :style="{ '--tool-icon': `url(&quot;${iconCanvasMove}&quot;)` }" aria-hidden="true" />
              </button>
            </el-tooltip>
            <el-tooltip :showArrow="false"
              content="缩放菜单（滚轮调整缩放）"
              placement="top"
              :hideAfter="0"
              :enterable="false"
              :triggerKeys="[]"
              :disabled="zoomMenuVisible">
              <span class="zoomTrigger">
                <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-end" :width="216">
                  <template #reference>
                    <button
                      type="button"
                      class="barButton zoomButton"
                      aria-label="缩放菜单"
                      @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(20, zoomPercent - Math.sign($event.deltaY))))">
                      {{ zoomPercent }}%
                    </button>
                  </template>
                  <div class="zoomMenu">
                    <el-input-number
                      class="zoomInput"
                      :model-value="zoomPercent"
                      :min="20"
                      :max="800"
                      :controls="false"
                      aria-label="缩放百分比"
                      @change="applyZoom">
                      <template #suffix>%</template>
                    </el-input-number>
                    <button type="button" class="zoomAction" @click="zoomIn()">放大</button>
                    <button type="button" class="zoomAction" @click="zoomOut()">缩小</button>
                  </div>
                </el-popover>
              </span>
            </el-tooltip>
          </div>
        </el-card>
    </div>
    <!-- ACT: 可拖拽竖直分隔条：按住左右移动实时改右列（聊天框）宽度，与 Chat 页同款；常显 1px 竖直分割线。 -->
    <div class="chatResize" :class="{ dragging: resizing }" @pointerdown="onResizeDown" />
    <!-- ACT: 与 Chat 页共用的房间时间线聊天框：作为网格第三列静态停靠在右侧（取代原悬浮 floatingAgent）。 -->
    <groupChat class="studioChat" mode="step-by-step" />
  </main>
</template>

<script setup lang="ts">
import { locale, translate } from "@toonflow/i18n/vue";
import { computed, defineAsyncComponent, nextTick, onMounted, onScopeDispose, provide, ref, shallowRef, watch, type ComponentPublicInstance } from "vue";
import { onBeforeRouteLeave, useRoute } from "vue-router";
import axios from "axios";
import { IconRestore } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspaceStore } from "@/stores/workspace";
import { useAuthStore } from "@/stores/auth";
import { registerWorkspaceControl, waitForControlValue } from "@/lib/mcpControl";
import anonymousData from "@/lib/anonymousData";
import { useProviderBalances } from "@/lib/providerBilling";
import { useMatrixChat } from "@/composables/useMatrixChat";
import { useRoomSpoke } from "@/composables/useRoomSpoke";
// ACT: 计划 Task 13 —— 每用户授权（consent）状态与本地模型配置：本地模型能力仅在授权 invokeLocalModels 后才向编排器广告。
import { loadRoomGrants, roomGrant, roomGrantSaving, saveRoomGrant } from "@/stores/roomGrants";
import { localModelConfig } from "@/stores/localModels";
import canvasPanel from "./panels/canvas/canvasHost.vue";
import type { DocumentNodeOptions } from "./panels/canvas/canvasFiles";
import modeSwitcher from "@/components/modeSwitcher.vue";
import groupChat from "@/components/groupChat.vue";
// ACT: 画布底部工具栏按钮图标改用本地 svg，经 mask 渲染以跟随按钮文字颜色（与聊天页主面板底部按钮同色同规格）。
import iconCanvasAdd from "@/icons/canvas_add.svg";
import iconCanvasGrouping from "@/icons/canvas_grouping.svg";
import iconCanvasMove from "@/icons/canvas_move.svg";
import iconCanvasSearch from "@/icons/canvas_search.svg";
import iconCanvasAsset from "@/icons/canvas_asset.svg";
import iconCanvasDocument from "@/icons/canvas_document.svg";
import iconCanvasPalette from "@/icons/canvas_palette.svg";
import iconCanvasUpdate from "@/icons/canvas_update.svg";
import iconCanvasSync from "@/icons/canvas_sync.svg";
import iconCanvasConsent from "@/icons/canvas_consent.svg";

const documentPanel = defineAsyncComponent(() => import("./panels/document/index.vue"));

const activePanel = ref<"canvas" | "document">("canvas");
const selectedTool = ref<"move" | "hand">("move");
const sideButtonEvents = ["mousedown", "mouseup", "auxclick"] as const;
// 鼠标侧键会直接触发原生历史导航，需在 DOM 事件阶段拦截，避免生成中的工作区被误关闭。
function preventSideButtonNavigation(event: MouseEvent) {
  if (event.button === 3 || event.button === 4) event.preventDefault();
}
// ACT: 与 Chat 页一致的停靠式聊天框分栏：右列宽度由可拖拽分隔条实时调整，夹紧到 [320, 55vw]；
// 默认取主面板宽度的 1/3（挂载时按实际容器宽度计算一次），拖拽后以拖拽值为准。聊天框常开，不提供收起开关。
const CHAT_MIN = 320;
const workspaceEl = ref<HTMLElement>();
const chatWidth = ref(400);
const resizing = ref(false);
function applyDefaultChatWidth() {
  const panel = workspaceEl.value?.clientWidth ?? 0;
  if (!panel) return;
  const max = Math.round(window.innerWidth * 0.55);
  chatWidth.value = Math.min(max, Math.max(CHAT_MIN, Math.round(panel / 3)));
}
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
onMounted(() => {
  anonymousData.track("workspace.canvas");
  applyDefaultChatWidth();
  for (const eventName of sideButtonEvents) window.addEventListener(eventName, preventSideButtonNavigation, true);
});
onScopeDispose(() => {
  onResizeUp();
  for (const eventName of sideButtonEvents) window.removeEventListener(eventName, preventSideButtonNavigation, true);
});
const workspaceStore = useWorkspaceStore();
const auth = useAuthStore();
const route = useRoute();
// ACT: Matrix 房间状态（模块级单例）：activeRoomId 驱动辐条连接与生成入口。
const { activeRoomId, sendText } = useMatrixChat();

// ACT: 计划 Task 4 —— 从群聊主持人的「自动生成视频 / 分步生成视频」按钮跳转过来时，
// 把生成意图与归属账号落到 workspace store，并标记当前项目的归属。
// 真正的自动/分步流水线属于后续任务，这里只负责意图落地与归属记录。
function seedPipeline(mode: "auto" | "step", roomId: string) {
  workspaceStore.setPipeline({ mode, roomId, ownerId: auth.myUserId, createdAt: Date.now() });
  if (workspaceStore.project && auth.myUserId) workspaceStore.markProjectOwner(workspaceStore.project.directory, auth.myUserId);
  ElMessage.success(mode === "auto" ? "已按自动生成模式准备工作室" : "已按分步生成模式准备工作室");
}
function seedPipelineFromQuery() {
  const mode = route.query.mode;
  if (mode !== "auto" && mode !== "step") return;
  seedPipeline(mode, typeof route.query.room === "string" ? route.query.room : "");
}
watch(() => [route.query.mode, route.query.room], seedPipelineFromQuery, { immediate: true });

// ACT: 计划 Task 11 —— 工作流同步动作：把本地待处理覆盖层提交为更新提案 / 回滚到已提交权威版本。
async function submitGraphUpdate() {
  const id = await proposeUpdate();
  if (id) ElMessage.success("已提交更新提案，等待讨论与客服 Agent 审核");
  else ElMessage.error("提交更新提案失败，请确认工作室已连接房间");
}
async function syncGraphToCommitted() {
  await synchronize();
  ElMessage.success("已同步到客服 Agent 已同意的最新版本");
}

// ACT: 计划 Task 13 —— 每用户协作授权：进入/切换房间时拉取本人授权；开关切换时回写服务器（身份由会话校验）。
const hasLocalModel = computed(() => !!localModelConfig.value);
watch(activeRoomId, room => { void loadRoomGrants(room); }, { immediate: true });

// ACT: 计划 Task 7 —— 一间房 ↔ 一个服务器工作区 ↔ 一个画布。活动房间变化时向服务器解析该房间的工作区
// 目录（不存在则自动创建并播种一个空画布），并把它作为当前打开的项目；切换房间前先保存当前画布/文档，
// 避免未落盘的编辑丢失。左导航 /studio、modeSwitcher ?room= 与广场深链都经由 activeRoomId 收敛到这里。
const roomBindLifetime = new AbortController();
onScopeDispose(() => roomBindLifetime.abort(new Error("工作区已关闭")));
let boundRoom = "";
watch(activeRoomId, async room => {
  if (!auth.signedIn || !room || room === boundRoom) return;
  const signal = AbortSignal.any([roomBindLifetime.signal, AbortSignal.timeout(30000)]);
  try {
    // 切换到新房间的工作区之前，先把当前画布/文档保存落盘。
    await flushSave();
    signal.throwIfAborted();
    const response = await fetch(`/api/matrix/spoke/workspace?room=${encodeURIComponent(room)}`, {
      headers: { "x-toonflow-workspace": "1", "Accept-Language": locale.value },
      signal,
    });
    const json = await response.json().catch(() => null) as { code?: number; data?: { directory?: string }; message?: string } | null;
    const directory = json?.data?.directory;
    if (!response.ok || json?.code !== 200 || !directory) throw new Error(json?.message || "无法解析房间工作区");
    signal.throwIfAborted();
    boundRoom = room;
    if (directory !== workspaceStore.project?.directory) await workspaceStore.openProject(directory, directory, signal);
  } catch (error) {
    if (signal.aborted) return;
    boundRoom = "";
    console.warn("[workspace] 绑定房间工作区失败：", room, error);
  }
}, { immediate: true });
async function updateGrant(patch: { driveSpokes?: boolean; invokeLocalModels?: boolean }) {
  const next = {
    driveSpokes: patch.driveSpokes ?? roomGrant.driveSpokes,
    invokeLocalModels: patch.invokeLocalModels ?? roomGrant.invokeLocalModels,
  };
  const ok = await saveRoomGrant(next);
  if (ok) ElMessage.success("已更新协作授权");
  else ElMessage.error("更新协作授权失败，请确认已登录且工作室已连接房间");
}

useProviderBalances();
const canvasPanelRef = ref<InstanceType<typeof canvasPanel>>();
watch(() => canvasPanelRef.value?.canvasListReady, ready => {
  workspaceStore.projectLoading = !ready;
}, { immediate: true });
onScopeDispose(() => { workspaceStore.projectLoading = false; });
const documentPanelCache = shallowRef<{ directory: string; instance: InstanceType<typeof documentPanel> }>();
const documentPanelRef = computed(() => documentPanelCache.value?.directory === workspaceStore.project?.directory ? documentPanelCache.value?.instance : undefined);
watch(() => workspaceStore.project?.directory, () => {
  documentPanelCache.value?.instance.cancelSave();
  documentPanelCache.value = undefined;
}, { flush: "sync" });
function setDocumentPanel(value: Element | ComponentPublicInstance | null) {
  const directory = workspaceStore.project?.directory;
  // KeepAlive 失活会清空模板 ref，保留同一工作区实例以协调后台文档保存和文件操作。
  if (value && directory) documentPanelCache.value = { directory, instance: value as InstanceType<typeof documentPanel> };
}
provide("canvas", () => canvasPanelRef.value?.getCanvasContext());
provide("mentionCanvas", () => canvasPanelRef.value?.mentionSource);
provide("activateCanvasPanel", () => switchPanel("canvas"));
provide("performWorkspaceFileAction", (directory: string, action: "copy" | "rename" | "move" | "delete", path: string, target?: string, entryType: "canvas" | "directory" = "canvas") =>
  documentPanelRef.value ? documentPanelRef.value.performFileAction(directory, action, path, target, entryType) : performFileAction(directory, action, path, target));

// ACT: 计划 Task 5 —— 单辐条画布中继。打开的工作室（step-by-step）标签页把自己注册为当前 Matrix
// 房间的辐条：服务器侧编排器（customer_service）经 /api/matrix/spoke/* 下发画布调用，本辐条在实时
// vue-flow 图上执行并回传结果。仅在已登录且有活动房间时保持连接。
// ACT: 计划 Task 11 —— 解构出待处理覆盖层状态与「更新/同步/恢复」动作，供画布工具区的工作流同步控件使用。
const { pending: graphPending, canReapply: graphCanReapply, proposeUpdate, synchronize, reapplyProposal } = useRoomSpoke({
  roomId: () => activeRoomId.value,
  active: () => auth.signedIn && !!activeRoomId.value,
  getCanvasContext: () => canvasPanelRef.value?.getCanvasContext(),
  canvasId: () => canvasPanelRef.value?.canvasId ?? "",
  // ACT: 计划 Task 9/13 —— 上报设备能力（按设备注册）：携带 Matrix 设备 id；本地模型可达性仅在
  // 已配置本地模型且用户已授权 invokeLocalModels 时才广告为 true，未授权则编排器看不到、不会派本地模型任务给本机。
  capabilities: () => ({ deviceId: auth.deviceId || undefined, localModel: !!localModelConfig.value && roomGrant.invokeLocalModels }),
  // ACT: 计划 Task 10 —— 图扇出：编排器变更后上报实时语义图；收到已提交图广播时按 revision 幂等收敛到实时画布。
  getGraph: () => canvasPanelRef.value?.getGraphSnapshot(),
  applyGraph: graph => canvasPanelRef.value?.applyGraphSnapshot(graph),
  // ACT: 计划 Task 11 —— 权限/冲突策略：本地编辑信号驱动待处理覆盖层；提交提案后自动在房间发讨论消息。
  editSignal: () => canvasPanelRef.value?.localEditSignal ?? 0,
  announce: body => sendText(body),
});

const controlLifetime = new AbortController();
onScopeDispose(() => {
  controlLifetime.abort(new Error("工作区已关闭"));
  // 离开守卫已完成保存，先释放文档观察者，避免画布卸载被当成节点删除。
  documentPanelRef.value?.cancelSave();
});
registerWorkspaceControl({
  getState: () => ({
    directory: workspaceStore.project?.directory ?? null,
    canvasId: canvasPanelRef.value?.canvasId || null,
    panel: activePanel.value,
    tools: canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext()?.tools ?? [] : [],
    document: documentPanelRef.value?.getDocument(false),
  }),
  flushSave,
  async call(request, signal) {
    const directory = workspaceStore.project?.directory;
    if (!directory) throw new Error("请先打开工作区");
    const callSignal = AbortSignal.any([signal, controlLifetime.signal]);
    const checkDirectory = () => {
      callSignal.throwIfAborted();
      if (directory !== workspaceStore.project?.directory) throw new Error("工作区已切换，本次调用已停止");
    };
    checkDirectory();
    if (request.name === "switchPanel") {
      if (request.args.panel !== "canvas" && request.args.panel !== "document") throw new Error("未知面板");
      if (!(await switchPanel(request.args.panel))) throw new Error("面板切换失败，请检查文档是否保存成功");
      if (request.args.panel === "document") await waitForControlValue(() => documentPanelRef.value?.ready ? documentPanelRef.value : undefined, callSignal);
      checkDirectory();
      return { panel: activePanel.value };
    }
    if (["getDocument", "openDocument", "writeDocument"].includes(request.name)) {
      if (!(await switchPanel("document"))) throw new Error("文档面板无法打开");
      const panel = await waitForControlValue(() => documentPanelRef.value?.ready ? documentPanelRef.value : undefined, callSignal);
      checkDirectory();
      if (request.name === "openDocument") await panel.openDocument(request.args, callSignal);
      if (request.name === "writeDocument") await panel.writeDocument(request.args, callSignal);
      checkDirectory();
      return panel.getDocument();
    }
    if (!(await switchPanel("canvas"))) throw new Error("画布面板无法打开");
    const context = await waitForControlValue(
      () => (canvasPanelRef.value?.canvasReady || (!canvasPanelRef.value?.canvasId && canvasPanelRef.value?.canvasListReady) ? canvasPanelRef.value.getCanvasContext() : undefined),
      callSignal
    );
    checkDirectory();
    return context.call({ name: request.name, args: request.args }, callSignal);
  },
});

async function flushSave() {
  await documentPanelRef.value?.flushSave();
  await canvasPanelRef.value?.flushSave();
}

onBeforeRouteLeave(async () => {
  if (canvasPanelRef.value?.saveBusy) {
    ElMessage.warning("画布操作尚未完成，请稍后退出");
    return false;
  }
  try {
    await flushSave();
    return true;
  } catch (error) {
    const message = axios.isAxiosError<{ message?: string }>(error)
      ? error.response?.data?.message || error.message
      : error instanceof Error
      ? error.message
      : translate("项目保存失败");
    const leave = await ElMessageBox.confirm(`无法保存项目：${message}。文件或目录可能已被移动或删除。仍然退出将丢弃尚未保存的修改。`, "项目未保存", {
      type: "warning",
      confirmButtonText: "仍然退出",
      cancelButtonText: "留在项目",
      closeOnClickModal: false,
    }).then(
      () => true,
      () => false
    );
    if (leave) {
      documentPanelRef.value?.cancelSave();
      canvasPanelRef.value?.cancelSave();
    }
    return leave;
  }
});

async function switchPanel(value: string | number | boolean) {
  if (value !== "canvas" && value !== "document") return false;
  try {
    if (activePanel.value === "document") await documentPanelRef.value?.flushSave();
    const changed = activePanel.value !== value;
    activePanel.value = value;
    await nextTick();
    if (changed) anonymousData.track(value === "canvas" ? "workspace.canvas" : "workspace.document");
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文本保存失败");
    return false;
  }
}

// ACT: 底部单按钮切换（Task 2）：在画布与文档之间来回切换，替代原顶部 el-segmented。
function togglePanel() { void switchPanel(activePanel.value === "canvas" ? "document" : "canvas"); }

// ACT: 画布底部工具栏跨组件状态：素材库开关与缩放百分比/动作委托当前画布实例（原左下角 canvasControls 已并入本工具栏）。
const zoomMenuVisible = ref(false);
const assetsVisible = computed({
  get: () => canvasPanelRef.value?.assetsVisible ?? false,
  set: value => { if (canvasPanelRef.value) canvasPanelRef.value.assetsVisible = value; },
});
const zoomPercent = computed(() => canvasPanelRef.value?.zoomPercent ?? 100);
function applyZoom(value: number | undefined) { canvasPanelRef.value?.applyZoom(value); }
function zoomIn() { canvasPanelRef.value?.zoomIn(); }
function zoomOut() { canvasPanelRef.value?.zoomOut(); }

function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.readDocumentNode(directory, canvasPath, nodeId);
}

function readDocumentNodes(directory: string, options?: DocumentNodeOptions) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.readDocumentNodes(directory, options);
}

async function focusDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  if (!directory || workspaceStore.project?.directory !== directory) throw new Error("工作目录已切换，请重新选择节点");
  if (!await switchPanel("canvas")) throw new Error("画布面板无法打开");
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  await canvasPanelRef.value.focusDocumentNode(directory, canvasPath, nodeId);
}

function mountDocumentNode(directory: string, canvasPath: string, nodeId: string, target: HTMLElement) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.mountDocumentNode(directory, canvasPath, nodeId, target);
}

function resolveDocumentNodeFile(directory: string, path: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.resolveDocumentNodeFile(directory, path);
}

function observeDocumentNode(directory: string, canvasPath: string, nodeId: string, onState: (state: { dirty: boolean; error: string; deleted: boolean }) => void) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.observeDocumentNode(directory, canvasPath, nodeId, onState);
}

async function flushDocumentNodes() {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  await canvasPanelRef.value.flushSave();
}

function performFileAction(directory: string, action: "copy" | "rename" | "move" | "delete", path: string, target?: string, nodeId?: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.performFileAction(directory, action, path, target, nodeId);
}

function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) {
  if (!canvasPanelRef.value) throw new Error("画布尚未就绪");
  return canvasPanelRef.value.saveDocumentNode(directory, canvasPath, nodeId, handleId, text, expectedText);
}
</script>

<style scoped lang="scss">
.workspacePage {
  position: relative;
  display: grid;
  // ACT: 三列：画布/文档/工具叠加单元（弹性占满）+ 4px 分隔条 + 聊天框（宽度由拖拽变量 --chat-w 决定），与 Chat 页同构。
  // 两行：第一行放面板与聊天框，第二行（57px）放底部按钮条，其顶边描边即水平分割线。
  grid-template-columns: minmax(0, 1fr) 4px var(--chat-w, 400px);
  grid-template-rows: minmax(0, 1fr) 57px;
  width: 100%;
  height: 100%;
  background-color: var(--el-bg-color);

  :deep(.canvasMenu),
  :deep(.balanceCard),
  .toolMenu,
  .syncMenu {
    background: color-mix(in srgb, var(--el-bg-color-overlay) 70%, transparent);
    backdrop-filter: blur(6px);
    border-color: var(--el-border-color-light);
    box-shadow: var(--el-box-shadow-light);
  }

  // ACT: 画布、文档与工具叠加层共用网格第一单元（grid-area 1/1 重叠）；分隔条与聊天框各占第二/三列。
  .canvasPanel {
    grid-area: 1 / 1;
    min-width: 0;
    min-height: 0;
    container: canvasWorkspace / inline-size;

    &.backgroundPanel {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
  }

  .documentArea {
    grid-area: 1 / 1;
    min-width: 0;
    min-height: 0;
  }

  // ACT: 可拖拽分隔条（第二列，跨两行）：4px 命中区居中常显 1px 竖直分割线，
  // 让画布与聊天框的边界清晰可见；悬停/拖拽时线亮主色。
  .chatResize {
    grid-area: 1 / 2 / 3 / 3;
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

  // ACT: 停靠式聊天框（第三列，跨两行）：与 Chat 页共用 groupChat 组件，静态占位、不悬浮、不可收起。
  .studioChat {
    grid-area: 1 / 3 / 3 / 4;
    min-width: 0;
    min-height: 0;
  }

  .workspaceTools {
    grid-area: 1 / 1;
    position: relative;
    z-index: 5;
    width: 100%;
    height: 100%;
    container: workspaceTools / inline-size;
    pointer-events: none;

    // ACT: 切换器在画布列内水平居中（与 Chat 页在舞台上居中同款）：left 50% + translateX(-50%)。
    // .workspaceTools 宽度即画布列宽，拖拽竖直分隔条改列宽时居中位置自动跟随。
    .modeSwitch {
      position: absolute;
      top: 15px;
      left: 50%;
      z-index: 5;
      transform: translateX(-50%);
      pointer-events: auto;
    }
  }

  // ACT: 底部按钮条（网格第二行第一列）：顶边 1px 描边即水平分割线，不透明底色保证
  // 面板内容不会透到线下；画布/文档视口只占第一行，节点与连线不会渲染到线下。
  .studioBar {
    grid-area: 2 / 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    padding: 0 15px;
    border-top: 1px solid var(--el-border-color);
    background: var(--el-bg-color);

      .syncMenu,
      .toolMenu {
        flex-shrink: 0;
        transition: none;
      }

      .barRow {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      // ACT: 与聊天页主面板底部按钮同规格：32px 高、8px 圆角、--el-border-color 描边、透明底、primary 文字色图标；
      // 选中态（.on）与聊天页 .on 一致：primary 描边 + primary-light-9 底 + primary 文字/图标色。
      .barButton {
        position: relative;
        display: flex;
        flex-shrink: 0;
        align-items: center;
        justify-content: center;
        height: 32px;
        margin: 0;
        padding: 0 10px;
        gap: 6px;
        border: 1px solid var(--el-border-color);
        border-radius: 8px;
        background: transparent;
        color: var(--el-text-color-primary);
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;

        &:hover:not(:disabled) { background: var(--el-fill-color); color: var(--el-text-color-primary); }
        &:disabled { opacity: 0.45; cursor: not-allowed; }

        &.iconOnly { width: 32px; padding: 0; }

        .barLabel { font-size: 12px; line-height: 1; }

        .pendingDot {
          position: absolute;
          top: 3px;
          right: 3px;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--el-color-warning);
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

    .zoomTrigger { display: inline-flex; }

    .zoomButton {
      min-width: 46px;
      font-variant-numeric: tabular-nums;
    }
  }
}

// ACT: 缩放菜单渲染在 teleport 到 body 的 popover 内，作用域样式需置于根级（元素仍带本组件 data-v 属性）。
.zoomMenu {
  display: flex;
  flex-direction: column;
  gap: 4px;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    margin: 0;
    padding: 5px 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 1;
    text-align: left;
    cursor: pointer;

    &:hover { background: var(--el-fill-color); }
  }
}

.grantMenu {
  display: flex;
  flex-direction: column;
  gap: 10px;

  .grantIntro {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.6;
  }

  .grantRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    .grantLabel {
      font-size: 13px;
      line-height: 1.4;

      &.disabled { color: var(--el-text-color-placeholder); }
    }
  }

  .grantHint {
    margin: 0;
    color: var(--el-text-color-placeholder);
    font-size: 12px;
    line-height: 1.5;
  }
}
</style>
