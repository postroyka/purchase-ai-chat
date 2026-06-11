<script setup lang="ts">
import type { Component } from 'vue'

const props = defineProps<{
  label: string
  value: string | number
  sub?: string
  icon?: Component
  accent?: 'default' | 'success' | 'alert' | 'warning'
}>()

const accentClass = computed(() => ({
  default: 'text-base-master',
  success: 'text-green-600 dark:text-green-500',
  alert: 'text-red-600 dark:text-red-500',
  warning: 'text-amber-600 dark:text-amber-500'
}[props.accent ?? 'default']))
</script>

<template>
  <B24Card class="rounded-xl" :b24ui="{ body: 'p-4 sm:p-5' }">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-xs font-medium text-base-500 truncate">
          {{ label }}
        </p>
        <p class="mt-1 text-2xl font-semibold tabular-nums" :class="accentClass">
          {{ value }}
        </p>
        <p v-if="sub" class="mt-0.5 text-xs text-base-500 truncate" :title="sub">
          {{ sub }}
        </p>
      </div>
      <component :is="icon" v-if="icon" class="size-5 shrink-0 text-base-400" />
    </div>
  </B24Card>
</template>
