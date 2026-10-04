<template>
  <div class="stock-avatar" :style="bgStyle">
    <img v-if="avatarUrl" :src="avatarUrl" :alt="name" loading="lazy" @error="err = true" />
    <span v-else-if="err || !avatarUrl" class="stock-avatar-fallback">{{ fallback }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{ name: string; avatarUrl?: string | null; size?: number }>();

const err = ref(false);
watch(() => props.avatarUrl, () => { err.value = false; });

const fallback = computed(() => (props.name ? props.name.slice(0, 1) : '?'));
const bgStyle = computed(() => ({
  width: `${props.size || 44}px`,
  height: `${props.size || 44}px`,
  borderRadius: '12px',
}));
</script>

<style scoped>
.stock-avatar {
  flex: none;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(150deg, #f3e3b8, #ddc48f);
  border: 1px solid #d9c392;
}
.stock-avatar img { width: 100%; height: 100%; object-fit: cover; }
.stock-avatar-fallback {
  color: #7c5f24;
  font-weight: 700;
  font-size: 20px;
  font-family: 'Georgia', serif;
}
</style>
