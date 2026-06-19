<script setup lang="ts">
import type { NavigationMenuItem } from '@bitrix24/b24ui-nuxt'
import type { Ref } from 'vue'
import { computed, ref, inject } from 'vue'
import UploadIcon from '@bitrix24/b24icons-vue/outline/UploadIcon'
import GraphsDiagramIcon from '@bitrix24/b24icons-vue/outline/GraphsDiagramIcon'
import GitHubIcon from '@bitrix24/b24icons-vue/social/GitHubIcon'
import HamburgerMenuIcon from '@bitrix24/b24icons-vue/outline/HamburgerMenuIcon'

const open = ref(false)
const isLoading = inject<Ref<boolean>>('isLoading', ref(false))

// Build version in the footer (ТЗ §6): a short git sha linking to the exact commit on GitHub.
// The sha is baked into the static bundle at build time via NUXT_PUBLIC_GIT_SHA (see nuxt.config
// + Dockerfile.app). For an un-built/local checkout gitSha is 'dev' — then link to the default
// branch tree (there is no commit to point at) and render a plain "vdev" badge.
const config = useRuntimeConfig()
const gitSha = String(config.public.gitSha || 'dev')
const repoUrl = String(config.public.repoUrl || '').replace(/\/+$/, '')
const buildLabel = computed(() => `v${gitSha === 'dev' ? 'dev' : gitSha.slice(0, 7)}`)
const buildUrl = computed(() => (gitSha === 'dev' ? `${repoUrl}/tree/main` : `${repoUrl}/commit/${gitSha}`))

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
      target: '_blank',
      rel: 'noopener noreferrer'
    }
  ]
])
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

        <!-- Build version (ТЗ §6): small muted footer with the short git sha, linking to the
             exact commit (or the default branch for a local 'dev' build). Hidden when the
             sidebar is collapsed — the rail is too narrow for the label. -->
        <a
          v-if="!collapsed"
          :href="buildUrl"
          target="_blank"
          rel="noopener"
          class="block px-2 pt-1 text-xs text-(--ui-color-design-plain-na-content) hover:text-(--ui-color-accent-main-primary)"
        >
          {{ buildLabel }}
        </a>
      </template>
    </B24DashboardSidebar>

    <slot />
  </B24DashboardGroup>
</template>
