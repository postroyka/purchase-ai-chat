<script setup lang="ts">
import type { NavigationMenuItem } from '@bitrix24/b24ui-nuxt'
import type { Ref } from 'vue'
import { computed, ref, inject, onMounted } from 'vue'
import UploadIcon from '@bitrix24/b24icons-vue/outline/UploadIcon'
import GraphsDiagramIcon from '@bitrix24/b24icons-vue/outline/GraphsDiagramIcon'
import GitHubIcon from '@bitrix24/b24icons-vue/social/GitHubIcon'
import HamburgerMenuIcon from '@bitrix24/b24icons-vue/outline/HamburgerMenuIcon'

const toast = useToast()

const open = ref(false)
const isLoading = inject<Ref<boolean>>('isLoading', ref(false))

const links = computed<NavigationMenuItem[][]>(() => [
  [
    {
      label: 'Загрузка счетов',
      icon: UploadIcon,
      to: '/',
      onSelect: () => {
        open.value = false
      }
    },
    {
      label: 'Метрики',
      icon: GraphsDiagramIcon,
      to: '/metrics',
      onSelect: () => {
        open.value = false
      }
    }
  ],
  [
    {
      label: 'GitHub',
      icon: GitHubIcon,
      to: 'https://github.com/postroyka/purchase-ai-chat',
      target: '_blank'
    }
  ]
])

onMounted(() => {
  const cookie = useCookie('cookie-consent')
  if (cookie.value === 'accepted') {
    return
  }

  toast.add({
    title: 'We use first-party cookies to enhance your experience on our app.',
    duration: 0,
    close: false,
    actions: [
      {
        label: 'Accept',
        color: 'air-primary-success',
        onClick: () => {
          cookie.value = 'accepted'
        }
      },
      {
        label: 'Opt out',
        color: 'air-secondary-no-accent'
      }
    ]
  })
})
</script>

<template>
  <HomeLoader v-if="isLoading" />
  <B24DashboardGroup
    v-else
    unit="px"
    storage="local"
  >
    <B24DashboardSidebar
      id="default"
      v-model:open="open"
      mode="slideover"
      collapsible
      resizable
      class="border-e-1"
    >
      <template #header="{ collapsed }">
        <B24DashboardSidebarCollapse :icon="HamburgerMenuIcon" class="size-9 px-2" />
        <AppTitle v-if="!collapsed" />
      </template>

      <template #default="{ collapsed }">
        <B24NavigationMenu
          :collapsed="collapsed"
          :items="links[0]"
          orientation="vertical"
          popover
        />

        <B24NavigationMenu
          :collapsed="collapsed"
          :items="links[1]"
          orientation="vertical"
          class="mt-auto"
        />
      </template>
    </B24DashboardSidebar>

    <slot />
  </B24DashboardGroup>
</template>
