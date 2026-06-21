<script setup lang="ts">
import type { B24Frame, Result } from '@bitrix24/b24jssdk'
import type { ToasterProps } from '@bitrix24/b24ui-nuxt'
import { ref, provide, readonly } from 'vue'
import * as locales from '@bitrix24/b24ui-nuxt/locale'
import { sleepAction } from './utils'
import { resolveBootLocale } from './utils/boot-locale'
import CloudErrorIcon from '@bitrix24/b24icons-vue/main/CloudErrorIcon'

const config = useRuntimeConfig()

const toast = useToast()
const { locale, defaultLocale, locales: localesI18n, setLocale } = useI18n()
const b24Instance = useB24()
const appAuth = useAppAuth()
const { needsLogin } = appAuth
const { isBitrixMobile } = useDevice()

const isLoading = ref(true)
const toaster: ToasterProps = { position: isBitrixMobile.value ? 'bottom-center' : 'top-right' }

const lang = computed(() => locales[locale.value]?.code || defaultLocale)
const dir = computed(() => locales[locale.value]?.dir || 'ltr')

useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' }
  ],
  link: [
    { rel: 'icon', href: `${config.app.baseURL}favicon.ico?v=2` }
  ],
  htmlAttrs: {
    lang,
    dir
  }
})

const title = 'Procure AI'
const description = 'Procure AI — upload supplier price lists and create processing jobs.'

// OG/Twitter crawlers require an absolute image URL. Build it from the public
// site URL when configured; otherwise fall back to a root-relative path.
const baseURL = (config.app.baseURL || '/').replace(/\/+$/, '')
const siteUrl = (config.public.siteUrl || '').replace(/\/+$/, '')
const ogImage = `${siteUrl}${baseURL}/og-image.png`

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage,
  twitterCard: 'summary_large_image',
  twitterImage: ogImage
})

provide('isLoading', readonly(isLoading))

onMounted(async () => {
  const result: Result = await b24Instance.init()
  if (!result.isSuccess) {
    toast.add({
      title: 'Error',
      description: result.getErrorMessages().join('\n'),
      color: 'air-primary-alert',
      icon: CloudErrorIcon
    })
  } else {
    // Inside a portal the locale follows the portal's own language; standalone it stays at the i18n
    // default (Russian, DEFAULT_LOCALE), which is what makes the /login form Russian (#177). The
    // decision is a pure function (resolveBootLocale) so it can be unit-tested — see boot-locale.ts.
    const inB24 = b24Instance.isInit()
    const portalLang = inB24 ? (b24Instance.get() as B24Frame).getLang() : null
    const targetCode = resolveBootLocale(inB24, portalLang, localesI18n.value.map(i => i.code))
    if (targetCode) {
      await setLocale(targetCode as never)
    } else if (inB24) {
      // In a portal but we don't ship its language — keep the default and surface the gap.
      console.error(`[i18n] Failed to load messages for locale: ${portalLang}`)
    }
  }

  // Establish the backend app session: inside B24 silently via /session/b24 (from the frame's
  // auth); standalone via GET /session, flipping needsLogin to show the login overlay if no
  // cookie session exists yet. The /install page runs its own flow (installFinish) and is not
  // gated here — see the template guard below.
  await appAuth.bootstrap(b24Instance.isInit(), b24Instance.get())

  // Used to display the connection loading indicator
  await sleepAction(1000)
  isLoading.value = false
})

// Don't cover the Bitrix24 install handler (/install) with the standalone login overlay — that
// page is shown by B24 itself and drives installFinish().
const route = useRoute()
const showLoginGate = computed(() => needsLogin.value && route.path !== '/install')
</script>

<template>
  <B24App :toaster="toaster" :locale="locales[locale]">
    <NuxtLoadingIndicator />

    <!-- Standalone login overlay: shown only outside Bitrix24 when no session exists yet. Inside
         B24 the session is established silently, so this never appears there. -->
    <LoginGate v-if="showLoginGate" />
    <NuxtLayout v-else>
      <NuxtPage />
    </NuxtLayout>
  </B24App>
</template>
