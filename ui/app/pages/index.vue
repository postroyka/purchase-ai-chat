<template>
  <UDashboardPage>
    <UDashboardPageHeader title="Загрузка предложений поставщиков" />
    <UDashboardPageBody>
      <div class="max-w-2xl space-y-6">
        <UAlert
          v-if="uploadError"
          color="red"
          variant="subtle"
          :description="uploadError"
          class="mb-2"
        />

        <UCard>
          <template #header>
            <p class="font-medium">Выберите файлы</p>
            <p class="text-sm text-gray-500 mt-1">Поддерживаются форматы: PDF, XLSX, DOCX. Максимальный размер: 20 МБ.</p>
          </template>
          <div class="space-y-4">
            <UInput
              type="file"
              multiple
              accept=".pdf,.xlsx,.docx"
              @change="onFilesSelected"
            />
            <UButton
              :disabled="!selectedFiles.length || uploading"
              :loading="uploading"
              @click="uploadFiles"
            >
              Загрузить ({{ selectedFiles.length }} файл(ов))
            </UButton>
          </div>
        </UCard>

        <UCard v-if="jobId">
          <template #header>
            <div class="flex items-center gap-2">
              <p class="font-medium">Статус обработки</p>
              <UBadge :color="jobStatusColor" variant="subtle">{{ jobStatusLabel }}</UBadge>
            </div>
          </template>
          <div class="space-y-2">
            <div
              v-for="file in jobFiles"
              :key="file.name"
              class="flex items-center justify-between py-2 border-b last:border-0"
            >
              <span class="text-sm">{{ file.name }}</span>
              <UBadge :color="fileStatusColor(file.status)" variant="subtle" size="sm">
                {{ file.status }}
              </UBadge>
            </div>
          </div>
        </UCard>
      </div>
    </UDashboardPageBody>
  </UDashboardPage>
</template>

<script setup lang="ts">
type BadgeColor = 'gray' | 'blue' | 'green' | 'red'

const selectedFiles = ref<File[]>([])
const uploading = ref(false)
const uploadError = ref<string | null>(null)
const jobId = ref<string | null>(null)
const jobFiles = ref<Array<{ name: string; status: string; result?: unknown; error?: string }>>([])
const jobStatus = ref<string>('pending')

let pollInterval: ReturnType<typeof setInterval> | null = null
let pollErrorCount = 0
const MAX_POLL_ERRORS = 5

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  selectedFiles.value = input.files ? Array.from(input.files) : []
}

async function uploadFiles() {
  if (!selectedFiles.value.length) return
  uploading.value = true
  uploadError.value = null
  const form = new FormData()
  for (const f of selectedFiles.value) form.append('files[]', f)
  try {
    const res = await $fetch<{ jobId: string; files: Array<{ name: string }> }>('/api/upload', {
      method: 'POST',
      body: form,
    })
    jobId.value = res.jobId
    jobFiles.value = res.files.map(f => ({ name: f.name, status: 'pending' }))
    startPolling()
  }
  catch (e: unknown) {
    uploadError.value = e instanceof Error ? e.message : 'Ошибка загрузки файлов'
  }
  finally {
    uploading.value = false
  }
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollErrorCount = 0
  pollInterval = setInterval(async () => {
    if (!jobId.value) return
    try {
      const data = await $fetch<{ status: string; files: Array<{ name: string; status: string; result?: unknown; error?: string }> }>(`/api/job/${jobId.value}/status`)
      pollErrorCount = 0
      jobStatus.value = data.status
      jobFiles.value = data.files
      if (data.status === 'done' || data.status === 'error') {
        clearInterval(pollInterval!)
        pollInterval = null
      }
    }
    catch {
      pollErrorCount++
      if (pollErrorCount >= MAX_POLL_ERRORS) {
        clearInterval(pollInterval!)
        pollInterval = null
        uploadError.value = 'Не удалось получить статус задачи. Попробуйте обновить страницу.'
      }
    }
  }, 2000)
}

onUnmounted(() => { if (pollInterval) clearInterval(pollInterval) })

const JOB_STATUS_LABELS: Record<string, string> = { pending: 'Ожидание', processing: 'Обработка...', done: 'Готово' }
const JOB_STATUS_COLORS: Record<string, BadgeColor> = { pending: 'gray', processing: 'blue', done: 'green' }
const FILE_STATUS_COLORS: Record<string, BadgeColor> = { pending: 'gray', processing: 'blue', done: 'green', error: 'red' }

const jobStatusLabel = computed(() => JOB_STATUS_LABELS[jobStatus.value] ?? jobStatus.value)
const jobStatusColor = computed((): BadgeColor => JOB_STATUS_COLORS[jobStatus.value] ?? 'gray')

function fileStatusColor(status: string): BadgeColor {
  return FILE_STATUS_COLORS[status] ?? 'gray'
}
</script>
