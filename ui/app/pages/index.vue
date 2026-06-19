<template>
  <B24DashboardPanel id="home">
    <template #header>
      <B24DashboardNavbar title="Загрузка счетов">
        <template #leading>
          <B24DashboardSidebarCollapse />
        </template>
        <template #right>
          <ThemeToggle />
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

            <!-- Созданная сделка: внутри B24 открываем слайдером, иначе ссылкой -->
            <div
              v-if="file.status === 'done' && dealOf(file)"
              class="mt-3 flex items-center justify-between gap-3"
            >
              <span class="text-xs text-base-500">
                Сделка #{{ dealOf(file)!.dealId }}
              </span>
              <B24Button
                v-if="canOpenDeal(dealOf(file)!)"
                color="air-primary"
                size="xs"
                class="shrink-0"
                @click="openDeal(dealOf(file)!)"
              >
                Открыть сделку
              </B24Button>
            </div>
          </B24Card>

          <div v-if="job.status === 'done' || job.status === 'error'" class="flex justify-center pt-2">
            <B24Button color="air-secondary" size="sm" @click="resetState">
              Загрузить ещё
            </B24Button>
          </div>
        </section>
      </div>

      <!-- Подтверждение ухода со страницы при активной загрузке/обработке -->
      <ClientOnly>
        <B24Modal
          v-model:open="leaveModalOpen"
          title="Уйти со страницы?"
          description="Идёт загрузка или обработка файлов. Если уйти, страница перестанет показывать их прогресс."
        >
          <template #footer>
            <B24Button color="air-secondary" label="Остаться" @click="decideLeave(false)" />
            <B24Button color="air-primary-alert" label="Всё равно уйти" @click="decideLeave(true)" />
          </template>
        </B24Modal>
      </ClientOnly>
    </template>
  </B24DashboardPanel>
</template>

<script setup lang="ts">
// Под общим dashboard-каркасом (сайдбар с навигацией) из layouts/default.vue.
definePageMeta({ layout: 'default' })

const toast = useToast()

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

// ── Созданная сделка ───────────────────────────────────────────────────────────
// Достаём ссылку на сделку из результата файла и открываем её. Внутри Bitrix24 —
// нативным слайдером (не уводит из приложения); вне портала — ссылкой в новой вкладке
// (если бэкенд отдал абсолютный deal.url).
const b24 = useB24()

interface CreatedDeal { dealId: string, url: string | null }

function dealOf(file: FileEntry): CreatedDeal | null {
  const deal = (file.result as { deal?: { dealId?: string | number | null, url?: string | null } } | undefined)?.deal
  const id = deal?.dealId
  if (id == null || String(id).trim() === '') return null
  return { dealId: String(id), url: deal?.url ?? null }
}

// Кнопку показываем только когда сделку реально есть чем открыть: внутри B24 (слайдер)
// или когда есть абсолютная ссылка от бэкенда (standalone).
function canOpenDeal(deal: CreatedDeal): boolean {
  return b24.isInit() || Boolean(deal.url)
}

async function openDeal(deal: CreatedDeal): Promise<void> {
  const path = `/crm/deal/details/${deal.dealId}/`
  const frame = b24.get()
  if (frame) {
    try {
      await frame.slider.openPath(frame.slider.getUrl(path))
      return
    } catch {
      // Слайдер не открылся — пробуем ту же ссылку в новой вкладке.
      try {
        window.open(frame.slider.getUrl(path).toString(), '_blank', 'noopener')
        return
      } catch { /* падаем во фолбэк ниже */ }
    }
  }
  if (deal.url) window.open(deal.url, '_blank', 'noopener')
}

// ── API ───────────────────────────────────────────────────────────────────────
// Backend calls go through useApi (#41/#105 P1): no token in the bundle. In prod the app-session
// cookie (set via /login or, inside Bitrix24, /session/b24) authenticates, and useApi adds the
// X-PAI-Auth CSRF header + credentials:'include' so the cookie rides the cross-site B24 iframe.
// In dev the nitro devProxy injects the Bearer server-side.
const { apiFetch } = useApi()

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
    const res = await apiFetch<{ jobId: string, files: Array<{ name: string, status: string }> }>(
      '/upload',
      { method: 'POST', body: form }
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
    const data = await apiFetch<JobStatus>(`/job/${jobId}/status`, {
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
      // Бэкенд недостижим — помечаем задание ошибочным, иначе hasActiveWork залипнет на
      // 'pending' и guard будет зря удерживать пользователя на странице.
      if (job.value) job.value = { ...job.value, status: 'error' }
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

// ── Защита от потери прогресса при уходе со страницы ───────────────────────────

// Есть незавершённая работа: идёт загрузка/обработка или задание ещё не финализировано.
const hasActiveWork = computed(() =>
  uploading.value || polling.value
  || (!!job.value && job.value.status !== 'done' && job.value.status !== 'error')
)

const leaveModalOpen = ref(false)
let leaveResolver: ((leave: boolean) => void) | null = null

// Завершает ожидание решения: резолвит висящий промис (если есть) и закрывает модалку.
// Resolver обнуляется ДО изменения leaveModalOpen, чтобы реакция watch на закрытие не
// вызвала повторный резолв.
function decideLeave(leave: boolean) {
  const resolve = leaveResolver
  leaveResolver = null
  leaveModalOpen.value = false
  resolve?.(leave)
}

// Закрыли модалку мимо кнопок (Esc / клик вне) — трактуем как «остаться».
watch(leaveModalOpen, (open) => {
  if (!open) decideLeave(false)
})

// Перехватываем клиентскую навигацию (клик «Метрики» в сайдбаре и т.п.): при активной
// работе показываем подтверждение и уходим только если пользователь выбрал «Уйти».
onBeforeRouteLeave(() => {
  if (!hasActiveWork.value) return true
  decideLeave(false) // снять предыдущий висящий промис, если переход сработал повторно
  return new Promise<boolean>((resolve) => {
    leaveResolver = resolve
    leaveModalOpen.value = true
  })
})

// onBeforeRouteLeave не ловит закрытие/перезагрузку вкладки (F5, Ctrl+W) — для этого
// нативное предупреждение браузера при активной работе.
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (hasActiveWork.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

// ── Очистка ───────────────────────────────────────────────────────────────────

onUnmounted(() => {
  stopPolling()
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (leaveResolver) decideLeave(true) // не оставлять навигацию заблокированной висящим промисом
})
</script>
