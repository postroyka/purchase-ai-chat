import { contentLocales, DEFAULT_LOCALE } from './i18n/i18n'

const pagesService = [
  '/404.html'
]

const extraAllowedHosts = (process?.env.NUXT_ALLOWED_HOSTS?.split(',').map((s: string) => s.trim()).filter(Boolean)) ?? []

const prodUrl = process?.env.NUXT_PUBLIC_SITE_URL ?? ''

// Dev-only: the dev-proxy (nitro.devProxy below) injects this Bearer token SERVER-SIDE so it never
// enters the browser bundle (#41/#105 P1). Empty in production builds — there the UI authenticates
// via the app-session cookie (set by /login or, inside Bitrix24, /session/b24) plus the X-PAI-Auth
// header that useApi adds; no token is shipped to the browser.
const devApiToken = process?.env.BACKEND_API_TOKEN ?? ''
const devAuthHeaders = devApiToken ? { Authorization: `Bearer ${devApiToken}` } : {}
if (!devApiToken && process?.env.NODE_ENV !== 'production') {
  // Dev only: without a token the dev-proxy forwards API calls unauthenticated → 401 if the
  // backend requires auth. (In prod builds NODE_ENV=production, so this never fires there.)
  console.warn('[nuxt.config] BACKEND_API_TOKEN не задан — dev-proxy проксирует /upload·/job·/metrics без авторизации.')
}

export default defineNuxtConfig({

  modules: [
    '@nuxt/eslint',
    '@bitrix24/b24ui-nuxt',
    '@bitrix24/b24jssdk-nuxt',
    '@vueuse/nuxt',
    '@nuxtjs/i18n'
  ], devtools: { enabled: false },

  app: {
    rootAttrs: { 'data-vaul-drawer-wrapper': '' }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    /**
     * @memo this will be overwritten from .env or Docker_*
     * @see https://nuxt.com/docs/guide/going-further/runtime-config#example
     */
    public: {
      // siteUrl only — the backend API token is intentionally NOT exposed to the browser here
      // (#41/#105 P1). Auth: app-session cookie + X-PAI-Auth (prod) / dev-proxy Bearer (dev), see above.
      siteUrl: prodUrl,
      // Build version shown in the UI footer (ТЗ §6). NUXT_PUBLIC_GIT_SHA is set by Dockerfile.app
      // BEFORE `nuxt build`, so the short sha is baked into the prerendered static output at build
      // time (payloadExtraction is off → runtimeConfig.public can't be overridden at runtime here).
      // 'dev' is the local/un-built fallback. repoUrl drives the commit/tree link in the footer.
      gitSha: process.env.NUXT_PUBLIC_GIT_SHA || 'dev',
      repoUrl: 'https://github.com/postroyka/purchase-ai-chat'
    }
  },

  devServer: {
    // Explicit port so Nuxt dev never clashes with backend on :3000.
    port: 3001
  },

  // Prerendered routes are served as flat `<route>.html` by the backend (express.static with
  // extensions:['html']). Payload extraction would emit per-route `<route>/_payload.json`,
  // creating a `metrics/` directory that shadows the flat `metrics.html` and makes a direct
  // GET /metrics redirect to /metrics/ (then 404). We fetch all data client-side anyway, so
  // there is no SSR payload to lose by turning it off.
  // TODO(tech-debt): global flag — if we add an SSR page with server-side useFetch/useAsyncData,
  // revisit with per-route `routeRules` instead of disabling payload extraction app-wide.
  experimental: {
    payloadExtraction: false
  },

  compatibilityDate: '2024-07-11',

  nitro: {
    // In local dev the UI dev-server runs on :3001; API calls are proxied to backend on :3000.
    // In production the backend Express server serves the built static files directly.
    // Authed data routes inject the Bearer token here (server-side) so the browser never holds it
    // (#41/#105 P1). /health is unauthenticated. The app-session routes (/login·/session·/logout·
    // /session/b24) are proxied WITHOUT a Bearer: they manage the cookie session themselves. In
    // prod these proxies don't exist — Express serves the static UI same-origin and the app-session
    // cookie (X-PAI-Auth header via useApi) authenticates.
    devProxy: {
      '/upload': { target: 'http://localhost:3000/upload', changeOrigin: true, headers: devAuthHeaders },
      '/job': { target: 'http://localhost:3000/job', changeOrigin: true, headers: devAuthHeaders },
      '/health': { target: 'http://localhost:3000/health', changeOrigin: true },
      // Only the JSON data is a backend call; /metrics itself is a Nuxt page.
      '/metrics/data': { target: 'http://localhost:3000/metrics/data', changeOrigin: true, headers: devAuthHeaders },
      // User feedback (issue #182): POST /feedback needs the Bearer in dev; GET /feedback/config is
      // open but routes through the same prefix. (Prod: same-origin, the app-session cookie authenticates.)
      '/feedback': { target: 'http://localhost:3000/feedback', changeOrigin: true, headers: devAuthHeaders },
      // App-session endpoints — forwarded as-is (no Bearer); they set/read the pai_sess cookie.
      '/login': { target: 'http://localhost:3000/login', changeOrigin: true },
      '/session/b24': { target: 'http://localhost:3000/session/b24', changeOrigin: true },
      '/session': { target: 'http://localhost:3000/session', changeOrigin: true },
      '/logout': { target: 'http://localhost:3000/logout', changeOrigin: true }
    },
    prerender: {
      routes: [
        // Корневой маршрут — иначе index.html не генерируется и Express отдаёт 404 на «/».
        '/',
        // Обработчик/установка Bitrix24 — нужен install.html, чтобы бэкенд отдавал его на POST
        // /install (B24 грузит обработчики методом POST). Без явного маршрута страница не
        // префрендерится и бэкенд откатывается на SPA-оболочку index.html.
        '/install',
        // Дашборд метрик — статическая оболочка; данные тянутся с /metrics/data на клиенте.
        '/metrics',
        ...pagesService
      ],
      crawlLinks: true,
      autoSubfolderIndex: false
    }
  },

  vite: {
    plugins: [],
    server: {
      // Fix: "Blocked request. This host is not allowed" when using tunnels like ngrok
      allowedHosts: [...extraAllowedHosts]
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },
  i18n: {
    detectBrowserLanguage: false,
    strategy: 'no_prefix',
    langDir: 'locales',
    locales: contentLocales,
    defaultLocale: DEFAULT_LOCALE
  }
})
