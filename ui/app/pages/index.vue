<template>
  <B24DashboardPanel id="home">
    <template #header>
      <B24DashboardNavbar title="Загрузка счетов">
        <template #leading>
          <B24DashboardSidebarCollapse />
        </template>
      </B24DashboardNavbar>
    </template>

    <template #body>
      <div class="w-full max-w-2xl mx-auto py-6 sm:py-10">
        <!-- Шапка-герой -->
        <header class="text-center">
          <h1 class="text-3xl sm:text-4xl font-semibold tracking-tight text-base-master">
            Загрузите прайс-листы
          </h1>
          <p class="mt-3 text-base text-base-600 max-w-md mx-auto">
            PDF, фото (JPG/PNG), Excel (XLSX/XLS) или Word. Создадим сделки в Bitrix24 автоматически.
          </p>
        </header>

        <!-- Зона загрузки -->
        <B24Card class="mt-10 rounded-xl" :b24ui="{ body: 'p-6 sm:p-8' }">
          <B24FileUpload
            v-model="selectedFiles"
            :multiple="true"
            accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx"
            variant="area"
            layout="list"
            class="w-full min-h-[220px]"
            label="Перетащите файлы сюда"
            description="или нажмите, чтобы выбрать · до 10 файлов, по 20 МБ"
            :file-delete="!uploading && !polling"
            :disabled="uploading || polling"
          />

          <div v-if="uploading || polling" class="mt-5">
            <B24Progress
              :model-value="null"
              animation="carousel"
              color="air-primary"
              size="xs"
            />
            <p class="mt-2 text-sm text-base-500 text-center">
              {{ uploading ? 'Загружаем файлы…' : 'Обрабатываем…' }}
            </p>
          </div>
        </B24Card>

        <!-- Ошибка -->
        <B24Alert
          v-if="uploadError"
          class="mt-6"
          color="air-primary-alert"
          title="Не получилось"
          :description="uploadError"
          :close="true"
          @update:open="uploadError = null"
        />

        <!-- Статус обработки -->
        <section v-if="job" class="mt-6 space-y-3">
          <div class="flex items-center justify-between px-1">
            <h2 class="text-sm font-medium text-base-700">
              Статус обработки
            </h2>
            <B24Badge
              :label="JOB_LABELS[job.status] ?? job.status"
              :color="JOB_COLORS[job.status] ?? 'air-secondary'"
              size="sm"
            />
          </div>

          <B24Card
            v-for="file in job.files"
            :key="file.name"
            class="rounded-xl"
            :b24ui="{ body: 'p-4' }"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="text-sm text-base-master truncate min-w-0">
                {{ file.name }}
              </span>
              <B24Badge
                :label="FILE_LABELS[file.status] ?? file.status"
                :color="FILE_COLORS[file.status] ?? 'air-secondary'"
                size="sm"
                class="shrink-0"
              />
            </div>

            <B24Progress
              v-if="file.status === 'processing' || file.status === 'pending'"
              class="mt-3"
              :model-value="null"
              animation="carousel"
              color="air-primary"
              size="xs"
            />

            <p
              v-if="file.error"
              class="mt-2 text-xs text-red-500"
              :title="file.error"
            >
              {{ file.error }}
            </p>
          </B24Card>

          <div v-if="job.status === 'done' || job.status === 'error'" class="flex justify-center pt-2">
            <B24Button color="air-secondary" size="sm" @click="resetState">
              Загрузить ещё
            </B24Button>
          </div>
        </section>
      </div>
    </template>
  </B24DashboardPanel>
</template>

<script setup lang="ts">
// Под общим dashboard-каркасом (сайдбар с навигацией) из layouts/default.vue.
definePageMeta({ layout: 'default' })

const toast = useToast()
const config = useRuntimeConfig()

// ── Типы ─────────────────────────────────────────────────────────────────────

type BadgeColor
  = | 'air-primary'
    | 'air-primary-success'
    | 'air-primary-alert'
    | 'air-primary-warning'
    | 'air-secondary'
    | 'air-tertiary'

interface FileEntry {
  name: string
  status: 'pending' | 'processing' | 'done' | 'error'
  result?: unknown
  error?: string | null
}

interface JobStatus {
  jobId: string
  status: 'pending' | 'processing' | 'done' | 'error'
  files: FileEntry[]
}

// ── Состояние ────────────────────────────────────────────────────────────────

const selectedFiles = ref<File[] | null>(null)
const uploading = ref(false)
const polling = ref(false)
const uploadError = ref<string | null>(null)
const job = ref<JobStatus | null>(null)

let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollController: AbortController | null = null
let pollErrors = 0
let pollDelay = 2000
const POLL_MIN_MS = 2000
const POLL_MAX_MS = 30000
const MAX_POLL_ERRORS = 5

// ── Метки и цвета статусов ───────────────────────────────────────────────────

type StatusKey = 'pending' | 'processing' | 'done' | 'error'

const JOB_LABELS: Record<StatusKey, string> = {
  pending: 'Ожидание',
  processing: 'Обработка…',
  done: 'Готово',
  error: 'Ошибка'
}

const JOB_COLORS: Record<StatusKey, BadgeColor> = {
  pending: 'air-secondary',
  processing: 'air-primary',
  done: 'air-primary-success',
  error: 'air-primary-alert'
}

const FILE_LABELS = JOB_LABELS
const FILE_COLORS = JOB_COLORS

// ── API ───────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const token = config.public.backendToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Автозагрузка сразу после выбора файлов — одно действие, без лишней кнопки.
watch(selectedFiles, (files) => {
  if (files?.length && !uploading.value && !polling.value) {
    doUpload()
  }
})

// ── Загрузка ──────────────────────────────────────────────────────────────────

async function doUpload() {
  const files = selectedFiles.value
  if (!files?.length) return

  uploading.value = true
  uploadError.value = null
  job.value = null

  const form = new FormData()
  for (const f of files) form.append('files[]', f)

  try {
    const res = await $fetch<{ jobId: string, files: Array<{ name: string, status: string }> }>(
      '/upload',
      { method: 'POST', body: form, headers: authHeaders() }
    )

    job.value = {
      jobId: res.jobId,
      status: 'pending',
      files: res.files.map(f => ({ name: f.name, status: 'pending' }))
    }

    startPolling(res.jobId)
  } catch (e: unknown) {
    const msg = extractErrorMessage(e)
    uploadError.value = msg
    toast.add({
      title: 'Ошибка загрузки',
      description: msg,
      color: 'air-primary-alert',
      duration: 6000
    })
  } finally {
    uploading.value = false
  }
}

// ── Опрос статуса ─────────────────────────────────────────────────────────────

function startPolling(jobId: string) {
  stopPolling()
  polling.value = true
  pollErrors = 0
  pollDelay = POLL_MIN_MS
  scheduleNextPoll(jobId)
}

function scheduleNextPoll(jobId: string) {
  pollTimer = setTimeout(() => pollOnce(jobId), pollDelay)
}

async function pollOnce(jobId: string) {
  const controller = new AbortController()
  pollController = controller
  try {
    const data = await $fetch<JobStatus>(`/job/${jobId}/status`, {
      headers: authHeaders(),
      signal: controller.signal
    })
    pollErrors = 0
    job.value = data

    if (data.status === 'done' || data.status === 'error') {
      stopPolling()

      if (data.status === 'done') {
        const doneCount = data.files.filter(f => f.status === 'done').length
        toast.add({
          title: 'Обработка завершена',
          description: `${doneCount} из ${data.files.length} файлов успешно обработано`,
          color: 'air-primary-success',
          duration: 5000
        })
      } else {
        toast.add({
          title: 'Обработка завершена с ошибками',
          description: 'Некоторые файлы не удалось обработать — проверьте статус',
          color: 'air-primary-warning',
          duration: 6000
        })
      }
      return
    }

    // Постепенный backoff: длинные задания не опрашиваем каждые 2 с (до 30 с).
    pollDelay = Math.min(pollDelay * 1.5, POLL_MAX_MS)
    scheduleNextPoll(jobId)
  } catch {
    // Запрос отменён (stopPolling / уход со страницы) — выходим без перезапуска.
    if (controller.signal.aborted) return
    pollErrors++
    if (pollErrors >= MAX_POLL_ERRORS) {
      stopPolling()
      uploadError.value = 'Не удалось получить статус задачи. Обновите страницу.'
      return
    }
    pollDelay = Math.min(pollDelay * 1.5, POLL_MAX_MS)
    scheduleNextPoll(jobId)
  }
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  if (pollController) {
    pollController.abort()
    pollController = null
  }
  polling.value = false
}

// ── Сброс ────────────────────────────────────────────────────────────────────

function resetState() {
  stopPolling()
  job.value = null
  uploadError.value = null
  selectedFiles.value = null
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function extractErrorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'data' in e) {
    const data = (e as { data?: { error?: string } }).data
    if (data?.error) return data.error
  }
  if (e instanceof Error) return e.message
  return 'Неизвестная ошибка'
}

// ── Очистка ───────────────────────────────────────────────────────────────────

onUnmounted(stopPolling)
</script>
