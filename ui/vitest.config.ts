import { defineConfig } from 'vitest/config'

// Lightweight UI unit tests: we test composables in isolation (happy-dom + stubbed Nuxt
// auto-imports) rather than booting a full Nuxt test environment — fast and dependency-light.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts']
  }
})
