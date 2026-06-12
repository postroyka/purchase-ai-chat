<script setup lang="ts">
import type { DropdownMenuItem } from '@bitrix24/b24ui-nuxt'
import ScreenIcon from '@bitrix24/b24icons-vue/outline/ScreenIcon'
import SunIcon from '@bitrix24/b24icons-vue/outline/SunIcon'
import MoonIcon from '@bitrix24/b24icons-vue/outline/MoonIcon'

// Минимальный переключатель темы оформления (System/Light/Dark) для шапки страниц.
// Заменяет переключатель, что был в удалённом UserMenu. Использует Nuxt Color Mode.
const colorMode = useColorMode()

const triggerIcon = computed(() => {
  if (colorMode.preference === 'light') return SunIcon
  if (colorMode.preference === 'dark') return MoonIcon
  return ScreenIcon
})

const items = computed<DropdownMenuItem[]>(() => [
  {
    label: 'Системная',
    icon: ScreenIcon,
    type: 'checkbox',
    checked: colorMode.preference === 'system',
    onSelect(e: Event) {
      e.preventDefault()
      colorMode.preference = 'system'
    }
  },
  {
    label: 'Светлая',
    icon: SunIcon,
    type: 'checkbox',
    checked: colorMode.preference === 'light',
    onSelect(e: Event) {
      e.preventDefault()
      colorMode.preference = 'light'
    }
  },
  {
    label: 'Тёмная',
    icon: MoonIcon,
    type: 'checkbox',
    checked: colorMode.preference === 'dark',
    onSelect(e: Event) {
      e.preventDefault()
      colorMode.preference = 'dark'
    }
  }
])
</script>

<template>
  <!-- Тема зависит от localStorage клиента — рендерим только на клиенте, чтобы не ловить
       hydration mismatch на иконке-триггере. -->
  <ClientOnly>
    <B24DropdownMenu
      :items="items"
      :content="{ align: 'end', side: 'bottom' }"
      :b24ui="{ content: 'w-[180px]' }"
    >
      <B24Button
        :icon="triggerIcon"
        color="air-tertiary"
        size="sm"
        aria-label="Тема оформления"
      />
    </B24DropdownMenu>

    <template #fallback>
      <B24Button
        :icon="ScreenIcon"
        color="air-tertiary"
        size="sm"
        disabled
        aria-label="Тема оформления"
      />
    </template>
  </ClientOnly>
</template>
