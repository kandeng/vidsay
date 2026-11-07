<template>
  <panel class="canvasControlsPanel" position="bottom-left">
    <el-card class="canvasControlsCard" shadow="never" :bodyStyle="{ padding: '2px 4px' }">
      <div class="canvasControls">
        <el-tooltip :showArrow="false" :content="assetsVisible ? '关闭素材库' : '打开素材库'" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="assetsVisible ? 'primary' : 'default'"
            :aria-pressed="assetsVisible"
            aria-label="素材库"
            @click="assetsVisible = !assetsVisible">
            <icon-folders :size="18" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false"
          content="缩放菜单（滚轮调整缩放）"
          placement="top"
          :hideAfter="0"
          :enterable="false"
          :triggerKeys="[]"
          :disabled="zoomMenuVisible">
          <span class="toolTrigger">
            <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-start" :width="216">
              <template #reference>
                <el-button
                  class="toolButton"
                  text
                  aria-label="缩放菜单"
                  @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(20, zoomPercent - Math.sign($event.deltaY))))">
                  {{ zoomPercent }}%
                </el-button>
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
                <el-button class="zoomAction" text @click="zoomIn()">放大</el-button>
                <el-button class="zoomAction" text @click="zoomOut()">缩小</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
      </div>
    </el-card>
  </panel>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Panel, useVueFlow } from "@vue-flow/core";

// ACT: 底部控制条精简——仅保留素材库开关与缩放菜单（百分比输入 + 放大/缩小 + 滚轮）。
// 已移除：整理画布（自动排布易误解作者意图，牺牲美观换正确）、小地图（简化单画布下无价值）、
// 网格吸附（收益低）、隐藏/显示连线（隐藏连线有风险，应始终显示）、适应视图按钮与菜单项
// （「图形始终在画布内可见」改由画布面板在内容变化时自动适应视图实现，无需手动适应）。
const assetsVisible = defineModel<boolean>("assetsVisible", { default: false });
const zoomMenuVisible = ref(false);
const { viewport, zoomTo, zoomIn, zoomOut } = useVueFlow();
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100));

function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value)) void zoomTo(value / 100);
}
</script>

<style lang="scss" scoped>
@container canvasWorkspace (max-width: 1040px) {
  .canvasControlsPanel.vue-flow__panel { bottom: 46px; }
}

.canvasControlsCard { height: 34px; box-sizing: border-box; }

.canvasControls {
  display: flex;
  align-items: center;
  gap: 2px;

  .toolTrigger {
    display: inline-flex;
  }

  .toolButton {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    margin-left: 0;
    padding: 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
}

.zoomMenu {
  display: flex;
  flex-direction: column;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    justify-content: flex-start;
    margin-left: 0;
  }
}
</style>
