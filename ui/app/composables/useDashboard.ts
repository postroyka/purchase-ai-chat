import { createSharedComposable } from '@vueuse/core'

const _useDashboard = () => {
  const router = useRouter()
  const colorMode = useColorMode()

  defineShortcuts({
    'shift_D': () => colorMode.preference = !(colorMode.value === 'dark') ? 'dark' : 'light',
    'g-h': () => router.push('/')
  })

  return {}
}

export const useDashboard = createSharedComposable(_useDashboard)
