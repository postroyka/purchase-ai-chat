<template>
  <UDashboardPage>
    <UDashboardPageHeader title="Загрузка предложений поставщиков" />
    <UDashboardPageBody>
      <div class="max-w-2xl space-y-6">
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
const selectedFiles = ref<File[]>([])
const uploading = ref(false)
const jobId = ref<string | null>(null)
const jobFiles = ref<Array<{ name: string; status: string; result?: unknown; error?: string }>>([])
const jobStatus = ref<string>('pending')

let pollInterval: ReturnType<typeof setInterval> | null = null

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement
  selectedFiles.value = input.files ? Array.from(input.files) : []
}

async function uploadFiles() {
  if (!selectedFiles.value.length) return
  uploading.value = true
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
  finally {
    uploading.value = false
  }
}

function startPolling() {
  if (pollInterval) clearInterval(pollInterval)
  pollInterval = setInterval(async () => {
    if (!jobId.value) return
    const data = await $fetch<{ status: string; files: Array<{ name: string; status: string; result?: unknown; error?: string }> }>(`/api/job/${jobId.value}/status`)
    jobStatus.value = data.status
    jobFiles.value = data.files
    if (data.status === 'done') {
      clearInterval(pollInterval!)
      pollInterval = null
    }
  }, 2000)
}

onUnmounted(() => { if (pollInterval) clearInterval(pollInterval) })

const jobStatusLabel = computed(() => ({ pending: 'Ожидание', processing: 'Обработка...', done: 'Готово' }[jobStatus.value] ?? jobStatus.value))
const jobStatusColor = computed(() => ({ pending: 'gray', processing: 'blue', done: 'green' }[jobStatus.value] as 'gray' | 'blue' | 'green' ?? 'gray'))

function fileStatusColor(status: string): 'gray' | 'blue' | 'green' | 'red' {
  return ({ pending: 'gray', processing: 'blue', done: 'green', error: 'red' } as Record<string, 'gray' | 'blue' | 'green' | 'red'>)[status] ?? 'gray'
}
</script>
