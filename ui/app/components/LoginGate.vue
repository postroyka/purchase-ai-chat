<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <B24Card class="w-full max-w-md rounded-xl" :b24ui="{ body: 'p-8' }">
      <header class="text-center">
        <h1 class="text-lg font-semibold text-base-master">
          {{ t('login.title') }}
        </h1>
        <p class="mt-2 text-sm text-base-500">
          {{ t('login.subtitle') }}
        </p>
      </header>

      <form class="mt-6 space-y-4" @submit.prevent="submit">
        <B24FormField :label="t('login.username')" name="username">
          <B24Input
            v-model="username"
            type="text"
            autocomplete="username"
            :placeholder="t('login.username')"
            :disabled="pending"
            class="w-full"
          />
        </B24FormField>

        <B24FormField :label="t('login.password')" name="password">
          <B24Input
            v-model="password"
            type="password"
            autocomplete="current-password"
            :placeholder="t('login.password')"
            :disabled="pending"
            class="w-full"
          />
        </B24FormField>

        <B24Alert
          v-if="error"
          color="air-primary-alert"
          :title="t('login.failed')"
          :description="error"
        />

        <B24Button
          type="submit"
          color="air-primary"
          block
          :loading="pending"
          :disabled="pending"
          :label="t('login.submit')"
        />
      </form>
    </B24Card>
  </div>
</template>

<script setup lang="ts">
// Standalone login overlay (shown only OUTSIDE Bitrix24, when useAppAuth().needsLogin is true).
// Credentials are the backend's PUBLIC_PAGE_BASIC_AUTH_USER/PASS; on success the session cookie is
// set by the backend and we hide the gate so the real app renders. Inside B24 this never shows —
// the session is established silently via /session/b24 (see useAppAuth).
import { ref } from 'vue'

const { t } = useI18n()
const { apiFetch } = useApi()
const { markLoggedIn } = useAppAuth()

const username = ref('')
const password = ref('')
const pending = ref(false)
const error = ref<string | null>(null)

async function submit() {
  if (pending.value) return
  pending.value = true
  error.value = null
  try {
    await apiFetch('/login', {
      method: 'POST',
      body: { username: username.value, password: password.value }
    })
    markLoggedIn()
  } catch (e: unknown) {
    error.value = extractError(e)
  } finally {
    pending.value = false
  }
}

function extractError(e: unknown): string {
  if (e && typeof e === 'object' && 'status' in e && (e as { status?: number }).status === 401) {
    return t('login.invalid')
  }
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  return t('login.error')
}
</script>
