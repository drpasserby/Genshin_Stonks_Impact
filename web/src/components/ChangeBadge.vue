<template>
  <span class="change-badge" :class="cls">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { fmtSigned } from '@/utils/format';

const props = defineProps<{ value: number | null | undefined; suffix?: string; digits?: number }>();

const cls = computed(() => {
  const v = props.value ?? 0;
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
});
const text = computed(() => fmtSigned(props.value, props.suffix, props.digits ?? 2));
</script>

<style scoped>
.change-badge {
  display: inline-block;
  min-width: 64px;
  padding: 2px 8px;
  border-radius: 6px;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
}
.change-badge.up { background: rgba(176, 65, 62, 0.12); }
.change-badge.down { background: rgba(46, 125, 91, 0.12); }
.change-badge.flat { background: rgba(138, 123, 95, 0.14); }
</style>
