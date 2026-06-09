import { describe, it, expect } from 'vitest';
import { extractDocumentText } from '../extract-text.js';

describe('extractDocumentText', () => {
  it('returns null for unsupported extensions (agent reads them via FILE_PATH)', async () => {
    expect(await extractDocumentText('/tmp/note.txt')).toBeNull();
    expect(await extractDocumentText('/tmp/archive.zip')).toBeNull();
  });

  it('returns null (never throws) when a supported file cannot be read', async () => {
    // Missing files: the external tool/lib fails → graceful null, not a throw, so the
    // agent can still fall back to reading FILE_PATH itself.
    await expect(extractDocumentText('/tmp/nope-xyz.pdf')).resolves.toBeNull();
    await expect(extractDocumentText('/tmp/nope-xyz.xlsx')).resolves.toBeNull();
    await expect(extractDocumentText('/tmp/nope-xyz.xls')).resolves.toBeNull();
    await expect(extractDocumentText('/tmp/nope-xyz.docx')).resolves.toBeNull();
    await expect(extractDocumentText('/tmp/nope-xyz.png')).resolves.toBeNull();
  });
});
