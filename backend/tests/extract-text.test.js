import { describe, it, expect } from 'vitest';
import { extractDocumentText } from '../extract-text.js';

describe('extractDocumentText', () => {
  it('returns null for non-PDF formats (agent reads them via FILE_PATH)', async () => {
    expect(await extractDocumentText('/tmp/invoice.docx')).toBeNull();
    expect(await extractDocumentText('/tmp/invoice.xlsx')).toBeNull();
    expect(await extractDocumentText('/tmp/note.txt')).toBeNull();
  });

  it('returns null (not throws) when a PDF cannot be read at all', async () => {
    // Non-existent .pdf → pdftotext/pdftoppm fail → graceful null, never throws.
    await expect(extractDocumentText('/tmp/does-not-exist-xyz.pdf')).resolves.toBeNull();
  });
});
