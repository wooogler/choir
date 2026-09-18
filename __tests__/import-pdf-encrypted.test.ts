/**
 * pdf-lib cannot write an encrypted PDF, so the one thing worth pinning here is
 * the mapping from pdfjs's `PasswordException` to the refusal the route answers
 * with. That needs a fake pdfjs, which is why it lives in its own file: every
 * other inspection test wants the real one.
 */

const getDocument = jest.fn();

jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: (...args: unknown[]) => getDocument(...args) }));

import { DEFAULT_PDF_IMPORT_CONFIG } from 'services/import/sources/pdf/config';
import { inspectPdf } from 'services/import/sources/pdf/inspect';

const PDF_BYTES = Buffer.from('%PDF-1.7\nencrypted\n');

function passwordException(): Error {
  const error = new Error('No password given');
  error.name = 'PasswordException';
  return error;
}

describe('inspectPdf on an encrypted PDF', () => {
  beforeEach(() => getDocument.mockReset());

  it('turns a PasswordException into import_pdf_encrypted', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    getDocument.mockReturnValue({ promise: Promise.reject(passwordException()), destroy });

    await expect(inspectPdf(PDF_BYTES, DEFAULT_PDF_IMPORT_CONFIG)).rejects.toMatchObject({
      name: 'ImportRefusal',
      status: 422,
      code: 'import_pdf_encrypted',
    });
    expect(destroy).toHaveBeenCalled();
  });

  it('lets any other pdfjs failure through as a plain error', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('Invalid XRef stream')), destroy });

    await expect(inspectPdf(PDF_BYTES, DEFAULT_PDF_IMPORT_CONFIG)).rejects.toThrow('Invalid XRef stream');
    expect(destroy).toHaveBeenCalled();
  });

  it('destroys the loading task even when a page read throws', async () => {
    const destroy = jest.fn().mockResolvedValue(undefined);
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        getMetadata: async () => ({ info: {} }),
        getPage: async () => {
          throw new Error('broken page');
        },
      }),
      destroy,
    });

    await expect(inspectPdf(PDF_BYTES, DEFAULT_PDF_IMPORT_CONFIG)).rejects.toThrow('broken page');
    expect(destroy).toHaveBeenCalled();
  });
});
