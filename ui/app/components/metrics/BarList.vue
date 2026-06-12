<script setup lang="ts">
import type { MetricNamedCount } from '../../composables/useMetrics'

const props = defineProps<{
  items: MetricNamedCount[]
  labels?: Record<string, string>
  empty?: string
}>()

const max = computed(() => Math.max(1, ...props.items.map(i => i.count)))
const labelFor = (name: string) => props.labels?.[name] ?? name
</script>

<template>
  <div class="space-y-2">
    <p v-if="!items.length" class="text-sm text-base-500">
      {{ empty ?? 'Нет данных' }}
    </p>

    <div
      v-for="it in items"
      :key="it.name"
      class="flex items-center gap-3"
    >
      <span
        class="w-36 shrink-0 text-xs text-base-600 truncate"
        :title="labelFor(it.name)"
      >
        {{ labelFor(it.name) }}
      </span>
      <div class="flex-1 h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
        <div
          class="h-full rounded-full bg-blue-500 dark:bg-blue-400"
          :style="{ width: `${Math.round((it.count / max) * 100)}%` }"
        />
      </div>
      <span class="w-10 shrink-0 text-right text-xs tabular-nums text-base-700">
        {{ it.count }}
      </span>
    </div>
  </div>
</template>
