import { basename, resolve, sep } from 'node:path'
import { readFile, realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { timedCallV2 } from '~/server/utils/rest-timing'

interface DealResult {
  dealId: number
}

/**
 * Base directory the agent's uploaded files live in. The MCP container mounts
 * the app's `uploads` volume read-only at `/app/uploads` (see
 * docker-compose.prod.yml). `create_deal` receives a `filePath` from the agent
 * and reads the file here to base64-encode it for the deal attachment — so the
 * heavy binary never has to travel through the LLM context window.
 *
 * Read once at module load. NOTE: changing NUXT_UPLOADS_DIR after the process
 * has started does not take effect (acceptable — it is deployment config).
 * Overridable via NUXT_UPLOADS_DIR for local dev / tests.
 */
const UPLOADS_DIR = process.env.NUXT_UPLOADS_DIR || '/app/uploads'

/**
 * Hard cap on the source file size before we read it into memory and base64-
 * encode it (~+33% overhead). Mirrors the app's MAX_FILE_SIZE_MB=20 with head-
 * room; guards the MCP container (512M limit) against a memory-exhaustion DoS
 * via an oversized upload. Overridable via NUXT_MAX_ATTACH_MB.
 */
const MAX_ATTACH_BYTES = (Number(process.env.NUXT_MAX_ATTACH_MB) || 25) * 1024 * 1024

/**
 * Resolve `filePath`, assert it stays inside UPLOADS_DIR, and reject symlinks
 * that escape it. The path comes (indirectly) from a document-driven agent, so
 * a crafted value like `../../etc/passwd` — or a symlink planted in uploads
 * pointing outside — must not let the tool read and exfiltrate arbitrary host
 * files into a Bitrix24 deal. Returns the safe REAL absolute path or throws.
 *
 * Two layers: (1) lexical containment after `resolve()` blocks `..` traversal;
 * (2) `realpath()` dereferences symlinks and we re-check containment so a
 * symlink can't smuggle the read target outside the base.
 */
async function resolveWithinUploads(filePath: string): Promise<string> {
  const base = await realpath(resolve(UPLOADS_DIR))
  const lexical = resolve(base, filePath)
  if (lexical !== base && !lexical.startsWith(base + sep)) {
    // Do NOT echo filePath back — avoid confirming host path structure to a
    // potentially adversarial document. Generic message only.
    throw new Error('filePath escapes the uploads directory')
  }
  // Dereference symlinks (realpath throws ENOENT if the file is missing — that
  // is fine, it surfaces as file_read_failed upstream).
  const real = await realpath(lexical)
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error('filePath resolves (via symlink) outside the uploads directory')
  }
  return real
}

export default defineMcpTool({
  name: 'b24_pst_crm_create_deal',
  description:
    'Create a procurement deal in Bitrix24 (funnel "Закупки", category 1, stage C1:NEW, currency BYN). Attaches the source file (read by path from the uploads volume) to the deal card and writes the processing log as a comment and timeline entry. Tax 20%, VAT included in price (Y). Unit always "шт". Deal is always created — no duplicate check. If this tool hinders you (unexpected response shape, an unclear warning, or a missing capability), record it in your result\'s feedback[] (see the system prompt, "Сигналы и обратная связь агента").',
  inputSchema: {
    supplierId: z.string().min(1).describe('Bitrix24 company id of the supplier'),
    contractId: z.string().min(1).describe('Bitrix24 contract id — required: a procurement deal must reference a contract (агент в шаге 3 останавливается, если договор не найден)'),
    responsibleUserId: z.string().min(1).describe('Bitrix24 user id to assign the deal to'),
    filePath: z.string().min(1).describe('Absolute path to the source document (FILE_PATH) — must reside inside the uploads directory. The MCP server reads it and base64-encodes it for attachment.'),
    documentDate: z.string().max(10).regex(/^\d{2}\.\d{2}\.\d{4}$/, 'documentDate must be d.m.Y').optional().describe('Дата документа (счёта) в формате d.m.Y (напр. "15.03.2025") — ставится как дата начала сделки (BEGINDATE). Если не указана/непарсибельна — текущая дата.'),
    processingLog: z.string().describe('Processing log text — written to deal COMMENTS field and posted as a timeline comment'),
    items: z.array(z.object({
      // #259: принимаем string | null | отсутствие — толерантно к `null` от модели (схема промпта
      // описывала поля как `string | null`). Позиции без productId в сделку не попадают (см. PHP-контроллер,
      // #258), поэтому в happy-path оба поля — строки, но null не должен валить вызовом схемы.
      productId: z.string().nullish().describe('Bitrix24 product id (сопоставленный товар каталога). null/опущено — позиция НЕ попадает в сделку (#258).'),
      vendorCode: z.string().nullish().describe('Артикул поставщика из документа. Может быть null/опущен.'),
      name: z.string().describe('Product name from document'),
      // INTENTIONAL by docs/PROJECT_BRIEF.md (lines 42-43): the document price
      // is per-unit and EXCLUDING VAT, but in Bitrix24 we write it with
      // TAX_RATE=20 and TAX_INCLUDED=Y. This is a deliberate business decision,
      // not a bug — do not "fix" it to exclude VAT during review.
      // .max guards against an astronomically large float (overflow → Infinity →
      // JSON.stringify "null" → price silently 0 in the deal). 1e9/unit is far beyond
      // any real procurement unit price; rounded to 2 decimals in the handler (#101).
      priceExclVat: z.number().positive().max(1_000_000_000).describe('Price per unit excluding VAT, as stated in document (rounded to 2 decimals at this boundary)'),
      quantity: z.number().positive().max(1_000_000_000).describe('Quantity from document — may be fractional (e.g. 224.8 for m/kg/m³); rounded to 2 decimals at this boundary'),
    })).describe('Line items. Unit is always шт. Может быть пустым: если ни одна позиция не сопоставлена с каталогом (все артикулы не найдены), сделка создаётся без позиций с warning no_items_matched, а позиции уходят в processingLog.'),
  },
  handler: async ({ supplierId, contractId, responsibleUserId, filePath, documentDate, processingLog, items }) => {
    let fileContent: string
    try {
      const safePath = await resolveWithinUploads(filePath)
      const { size } = await stat(safePath)
      if (size > MAX_ATTACH_BYTES) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: true, code: 'file_too_large', message: `Source file exceeds the ${MAX_ATTACH_BYTES}-byte attachment limit.` }) }],
        }
      }
      const buffer = await readFile(safePath)
      fileContent = buffer.toString('base64')
    } catch (err) {
      // Surface a stable code. For traversal / symlink errors (our own throws)
      // use a neutral message that neither echoes the offending path nor
      // confirms to an attacker that traversal was detected. All other
      // read failures (ENOENT, EPERM, …) pass their message through.
      const isOwnError = err instanceof Error && (
        err.message.includes('escapes') || err.message.includes('resolves (via symlink)')
      )
      const message = isOwnError ? 'file access denied' : (err instanceof Error ? err.message : String(err))
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: true, code: 'file_read_failed', message }) }],
      }
    }

    const b24 = useBitrix24Tenant()
    const params: Record<string, unknown> = {
      supplierId,
      responsibleUserId,
      fileName: basename(filePath),
      fileContent,
      processingLog,
      // Округляем цену И количество до 2 знаков на MCP-границе (#101, #286): защита от
      // float-погрешности OCR/LLM (напр. 12.991) ещё до REST-контроллера. Количество может быть
      // дробным (224.8 м/кг/м³), но не более 2 знаков — как и цена.
      items: items.map((it) => ({
        ...it,
        priceExclVat: Math.round(it.priceExclVat * 100) / 100,
        quantity: Math.round(it.quantity * 100) / 100,
      })),
    }
    // contractId обязателен по схеме (z.string().min(1)), но guard оставляем:
    // юнит-тест вызывает handler напрямую (минуя Zod) и проверяет, что при
    // отсутствии contractId он НЕ попадает в params как undefined.
    if (contractId) params.contractId = contractId
    if (documentDate) params.documentDate = documentDate

    const result = await timedCallV2<DealResult>(
      b24,
      'shef:purchase.api.procuredeal.create',
      params,
      'Failed to create procurement deal',
    )

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result ?? { dealId: null }) }],
    }
  },
})
