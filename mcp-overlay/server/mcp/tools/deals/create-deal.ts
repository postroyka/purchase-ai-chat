import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'

export default defineMcpTool({
  name: 'b24_pst_crm_create_deal',
  description: '[NOT IMPLEMENTED] Create a procurement deal in Bitrix24 (funnel "Закупки", category 1, stage C1:NEW, currency BYN). Attaches source file to deal card and writes processing log as a comment and timeline entry. Tax 20%, VAT included in price (Y). Unit always "шт". Deal is always created — no duplicate check.',
  inputSchema: {
    supplierId: z.string().min(1).describe('Bitrix24 company id of the supplier'),
    contractId: z.string().min(1).optional().describe('Bitrix24 contract id, if found'),
    responsibleUserId: z.string().min(1).describe('Bitrix24 user id to assign the deal to'),
    fileName: z.string().min(1).describe('Original filename of the uploaded document (e.g. "invoice.pdf")'),
    fileContent: z.string().min(1).describe('Base64-encoded content of the source file — attached to the deal card via UF_CRM_DEAL_SH_PRCHS_AI_FILE'),
    processingLog: z.string().describe('Processing log text — written to deal COMMENTS field and posted as a timeline comment'),
    items: z.array(z.object({
      productId: z.string().optional().describe('Bitrix24 product id if matched'),
      vendorCode: z.string().optional().describe('Vendor article from document'),
      name: z.string().describe('Product name from document'),
      // INTENTIONAL by docs/PROJECT_BRIEF.md (lines 42-43): the document price
      // is per-unit and EXCLUDING VAT, but in Bitrix24 we write it with
      // TAX_RATE=20 and TAX_INCLUDED=Y. This is a deliberate business decision,
      // not a bug — do not "fix" it to exclude VAT during review.
      priceExclVat: z.number().positive().describe('Price per unit excluding VAT, as stated in document'),
      quantity: z.number().positive().describe('Quantity from document'),
    })).min(1).describe('Line items. Unit is always шт regardless of document.'),
  },
  handler: async (_input) => {
    // TODO Week 2: call b24-controller REST API (shef.purchase.api.procuredeal.create)
    // Rules: CATEGORY_ID=1, STAGE_ID=C1:NEW, CURRENCY_ID=BYN
    // Each item: TAX_RATE=20, TAX_INCLUDED=Y, unit=шт
    // File: pass fileName + fileContent (base64) — controller uses CRestUtil::saveFile()
    // Log: processingLog → COMMENTS + CommentEntry timeline
    // NOTE: priceExclVat is the document's VAT-EXCLUSIVE per-unit price, yet we
    // set TAX_INCLUDED=Y — intentional per docs/PROJECT_BRIEF.md (lines 42-43).
    throw new Error('b24_pst_crm_create_deal is not implemented yet (Week 2)')
  },
})
