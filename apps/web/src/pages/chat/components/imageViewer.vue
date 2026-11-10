<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";

// ACT: 群聊页右栏图片查看器：右键图片消息选「查看」时覆盖整个聊天栏展示大图，
// 关闭后回到聊天；不占用左栏视频舞台，也不打断底层时间线。
defineProps<{ url: string; name: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <section class="imageViewer">
    <header class="viewerHeader">
      <span class="viewerName" :title="name">{{ name }}</span>
      <button type="button" class="viewerClose" :aria-label="translate('关闭')" :title="translate('关闭')" @click="emit('close')">×</button>
    </header>
    <div class="viewerBody">
      <img :src="url" :alt="name" />
    </div>
  </section>
</template>

<style lang="scss" scoped>
.imageViewer {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);

  .viewerHeader {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--el-border-color-lighter);

    .viewerName {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--el-text-color-regular);
      font-size: 13px;
    }

    .viewerClose {
      border: none;
      background: transparent;
      color: var(--el-text-color-secondary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;

      &:hover {
        color: var(--el-text-color-primary);
      }
    }
  }

  .viewerBody {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    min-height: 0;
    padding: 12px;

    img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: var(--ui-radius);
    }
  }
}
</style>
