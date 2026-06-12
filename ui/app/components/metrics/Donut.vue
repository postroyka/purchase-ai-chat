<script setup lang="ts">
// Minimal SVG ring gauge (no chart dependency). value is a percentage 0..100.
const props = defineProps<{
  value: number
  label?: string
}>()

const R = 42
const CIRC = 2 * Math.PI * R
const clamped = computed(() => Math.max(0, Math.min(100, props.value)))
const dash = computed(() => `${(clamped.value / 100) * CIRC} ${CIRC}`)
</script>

<template>
  <div class="relative size-32">
    <svg viewBox="0 0 100 100" class="size-full -rotate-90">
      <circle
        cx="50"
        cy="50"
        :r="R"
        fill="none"
        stroke="currentColor"
        stroke-width="10"
        class="text-gray-100 dark:text-gray-800"
      />
      <circle
        cx="50"
        cy="50"
        :r="R"
        fill="none"
        stroke="currentColor"
        stroke-width="10"
        stroke-linecap="round"
        :stroke-dasharray="dash"
        class="text-green-500 transition-all duration-500"
      />
    </svg>
    <div class="absolute inset-0 flex flex-col items-center justify-center">
      <span class="text-2xl font-semibold tabular-nums text-base-master">{{ Math.round(clamped) }}%</span>
      <span v-if="label" class="text-xs text-base-500">{{ label }}</span>
    </div>
  </div>
</template>
