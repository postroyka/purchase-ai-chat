<template>
  <B24DashboardPanel>
    <template #header>
      <div class="flex items-center gap-3 px-4 py-3 border-b border-base-300">
        <div>
          <h1 class="text-lg font-semibold text-base-master">
            Загрузка прайс-листов поставщиков
          </h1>
          <p class="text-sm text-base-500 mt-0.5">
            Загрузите файлы — система создаст сделки в Bitrix24 автоматически
          </p>
        </div>
      </div>
    </template>

    <template #body>
      <div class="max-w-2xl mx-auto py-6 px-4 space-y-5">

        <!-- Зона загрузки файлов -->
        <B24FileUpload
          v-model="selectedFiles"
          :multiple="true"
          accept=".pdf,.xlsx,.docx"
          variant="area"
          layout="list"
          label="Перетащите файлы или нажмите для выбора"
          description="PDF, XLSX, DOCX · Максимум 20 МБ на файл · До 10 файлов за раз"
          :file-delete="!uploading"
          :disabled="uploading"
        >
          <template #actions="{ files, open }">
            <div class="flex items-center gap-3">
              <B24Button
                color="air-secondary"
                :disabled="uploading"
                @click="() => open()"
              >
                Выбрать файлы
              </B24Button>
              <B24Button
                color="air-primary"
                :disabled="!files?.length || uploading"
                :loading="uploading"
                @click="doUpload"
              >
                {{ uploading ? 'Загружаем...' : `Загрузить (${files?.length ?? 0})` }}
              </B24Button>
            </div>
          </template>
        </B24FileUpload>

        <!-- Полоса прогресса: пока идёт загрузка или опрос -->
        <B24Progress
          v-if="uploading || polling"
          :model-value="null"
          animation="carousel"
          color="air-primary"
          size="xs"
        />

        <!-- Ошибка -->
        <B24Alert
          v-if="uploadError"
          color="air-primary-alert"
          title="Ошибка"
          :description="uploadError"
          :close="true"
          @update:open="uploadError = null"
        />

        <!-- Карточка статуса задачи -->
        <B24Card v-if="job">
          <template #header>
            <div class="flex items-center justify-between">
              <span class="font-medium text-base-master">Статус обработки</span>
              <B24Badge
                :label="JOB_LABELS[job.status] ?? job.status"
                :color="JOB_COLORS[job.status] ?? 'air-secondary'"
                size="sm"
              />
            </div>
          </template>

          <div class="divide-y divide-base-200">
            <div
              v-for="file in job.files"
              :key="file.name"
              class="flex items-center justify-between py-2.5 first:pt-0 last:pb-0"
            >
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-sm text-base-700 truncate">{{ file.name }}</span>
              </div>
              <div class="flex items-center gap-2 shrink-0 ml-3">
                <span
                  v-if="file.error"
                  class="text-xs text-red-500 max-w-[180px] truncate"
                  :title="file.error"
                >
                  {{ file.error }}
                </span>
                <B24Badge
                  :label="FILE_LABELS[file.status] ?? file.status"
                  :color="FILE_COLORS[file.status] ?? 'air-secondary'"
                  size="sm"
                />
              </div>
            </div>
          </div>

          <template v-if="job.status === 'done'" #footer>
            <div class="flex justify-end">
              <B24Button
                color="air-secondary"
                size="sm"
                @click="resetState"
              >
                Загрузить ещё
              </B24Button>
            </div>
          </template>
        </B24Card>

      </div>
    </template>
  </B24DashboardPanel>
</template>

<script setup lang="ts">
const toast = useToast()
const config = useRuntimeConfig()

// ── Типы ─────────────────────────────────────────────────────────────────────

type BadgeColor =
  | 'air-primary'
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

let pollTimer: ReturnType<typeof setInterval> | null = null
let pollErrors = 0
const MAX_POLL_ERRORS = 5

// ── Метки и цвета статусов ───────────────────────────────────────────────────

const JOB_LABELS: Record<string, string> = {
  pending: 'Ожидание',
  processing: 'Обработка…',
  done: 'Готово',
  error: 'Ошибка',
}

const JOB_COLORS: Record<string, BadgeColor> = {
  pending: 'air-secondary',
  processing: 'air-primary',
  done: 'air-primary-success',
  error: 'air-primary-alert',
}

const FILE_LABELS: Record<string, string> = {
  pending: 'Ожидание',
  processing: 'Обработка…',
  done: 'Готово',
  error: 'Ошибка',
}

const FILE_COLORS: Record<string, BadgeColor> = {
  pending: 'air-secondary',
  processing: 'air-primary',
  done: 'air-primary-success',
  error: 'air-primary-alert',
}

// ── API ───────────────────────────────────────────────────────────────────────

function authHeaders(): Record<string, string> {
  const token = config.public.backendToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

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
    const res = await $fetch<{ jobId: string; files: Array<{ name: string; status: string }> }>(
      '/upload',
      { method: 'POST', body: form, headers: authHeaders() },
    )

    job.value = {
      jobId: res.jobId,
      status: 'pending',
      files: res.files.map(f => ({ name: f.name, status: 'pending' })),
    }

    startPolling(res.jobId)
  }
  catch (e: unknown) {
    const msg = extractErrorMessage(e)
    uploadError.value = msg
    toast.add({
      title: 'Ошибка загрузки',
      description: msg,
      color: 'air-primary-alert',
      duration: 6000,
    })
  }
  finally {
    uploading.value = false
  }
}

// ── Опрос статуса ─────────────────────────────────────────────────────────────

function startPolling(jobId: string) {
  stopPolling()
  polling.value = true
  pollErrors = 0

  pollTimer = setInterval(async () => {
    try {
      const data = await $fetch<JobStatus>(`/job/${jobId}/status`, {
        headers: authHeaders(),
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
            duration: 5000,
          })
        }
        else {
          toast.add({
            title: 'Обработка завершена с ошибками',
            description: 'Некоторые файлы не удалось обработать — проверьте статус',
            color: 'air-primary-warning',
            duration: 6000,
          })
        }
      }
    }
    catch {
      pollErrors++
      if (pollErrors >= MAX_POLL_ERRORS) {
        stopPolling()
        uploadError.value = 'Не удалось получить статус задачи. Обновите страницу.'
      }
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
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
