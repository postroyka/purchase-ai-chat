import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Контракт-тест MCP↔PHP (#90).
 *
 * Имена REST-методов в MCP-инструментах (`shef:purchase.api.procure*.*`) и
 * PHP-контроллеры (`b24-controller/lib/controllers/procure*.php`) деплоятся
 * РАЗДЕЛЬНО (TS — через образ/Watchtower, PHP — через deploy-b24). Если имя
 * метода или action разъедется — инструмент молча получит ERROR_METHOD_NOT_FOUND
 * на проде. Этот тест сверяет имена из инструментов с реальными контроллерами,
 * ловя рассинхрон до деплоя.
 *
 * Каталоги ищем вверх по дереву — путь стабилен и локально (mcp-overlay/...),
 * и в CI (overlay копируется в mcp/, тест — в mcp/tests/overlay/...).
 */
function findUp(rel: string): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    dir = dirname(dir)
  }
  throw new Error(`Не найдено вверх по дереву: ${rel}`)
}

const dealsDir = findUp('server/mcp/tools/deals')
const phpDir = findUp('b24-controller/lib/controllers')

/** Имя метода, которое каждый deal-инструмент реально вызывает (первый литерал
 *  shef:purchase.api.* после вызова обёртки — это аргумент timedCallV2, не докблок). */
function toolMethods(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(dealsDir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.startsWith('_')) continue
    const src = readFileSync(join(dealsDir, f), 'utf8')
    // Имя метода = первый литерал shef:purchase.api.* ПОСЛЕ вызова timedCallV2(...) —
    // обёртки с REST-таймингом (#262), которая делегирует в callV2. `(?:timed)?` —
    // чтобы тест пережил и прямой callV2, и обёртку. Нижний регистр: REST-имена
    // регистронезависимы, PHP-сторона тоже в lower.
    const m = src.match(/(?:timed)?[Cc]allV2\b[\s\S]*?'(shef:purchase\.api\.[^']+)'/)
    if (m) out[f] = m[1].toLowerCase()
  }
  return out
}

/** Валидные REST-имена из PHP: class Procure<Suffix> + ключи configureActions →
 *  shef:purchase.api.procure<suffix>.<action>, всё в нижнем регистре. */
function phpRestNames(): Set<string> {
  const names = new Set<string>()
  for (const f of readdirSync(phpDir)) {
    if (!/^procure.*\.php$/.test(f)) continue
    const src = readFileSync(join(phpDir, f), 'utf8')
    const cls = src.match(/class\s+Procure(\w+)/)
    const actions = src.match(/configureActions[\s\S]*?return\s*\[([\s\S]*?)\];/)
    if (!cls || !actions) continue
    const seg = `procure${cls[1].toLowerCase()}`
    // Только верхнеуровневые action-ключи (`'find' => [`), не вложенные
    // (`'prefilters' => parent::...` без открывающей скобки массива).
    for (const a of actions[1].matchAll(/'(\w+)'\s*=>\s*\[/g)) {
      names.add(`shef:purchase.api.${seg}.${a[1].toLowerCase()}`)
    }
  }
  return names
}

/**
 * PHP-action'ы, которые НАМЕРЕННО не покрыты MCP-инструментом в проверке «нет
 * осиротевших контроллеров» — законное исключение:
 *   - procureinstall.ensureschema — инфраструктурный: самонастройка схемы (создание
 *     полей сделки), её зовёт дашборд/бэкенд напрямую по REST, а не LLM-инструмент
 *     (заводить агенту инструмент для мутации схемы CRM нельзя).
 */
const NON_MCP_PHP_ACTIONS = new Set<string>([
  'shef:purchase.api.procureinstall.ensureschema',
])

describe('contract: MCP tool method names ↔ PHP controllers (#90)', () => {
  const tools = toolMethods()
  const php = [...phpRestNames()]

  it('обнаружены инструменты и контроллеры', () => {
    expect(Object.keys(tools).length).toBeGreaterThanOrEqual(4)
    expect(php.length).toBeGreaterThanOrEqual(4)
  })

  it('каждый MCP-инструмент вызывает метод, существующий в PHP-контроллере', () => {
    for (const [file, method] of Object.entries(tools)) {
      expect(php, `${file} → ${method} нет среди action-ов PHP-контроллеров`).toContain(method)
    }
  })

  it('каждый PHP-action покрыт MCP-инструментом (нет осиротевших контроллеров)', () => {
    const used = new Set(Object.values(tools))
    for (const name of php) {
      if (NON_MCP_PHP_ACTIONS.has(name)) continue // инфраструктурный метод — не агентский (см. выше)
      expect([...used], `${name} не вызывается ни одним MCP-инструментом`).toContain(name)
    }
  })

  it('все имена методов используют colon-разделитель shef:purchase.api.procure*.*', () => {
    for (const [file, method] of Object.entries(tools)) {
      expect(method, file).toMatch(/^shef:purchase\.api\.procure[a-z]+\.[a-z0-9]+$/)
    }
  })
})
