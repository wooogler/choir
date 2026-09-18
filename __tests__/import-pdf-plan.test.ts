import {
  DEFAULT_PDF_IMPORT_CONFIG,
  type PdfImportConfig,
  loadPdfImportConfig,
} from 'services/import/sources/pdf/config';
import type { PdfInspection } from 'services/import/sources/pdf/inspect';
import { countScannedPages, pageRangeLabel, planPdfImport } from 'services/import/sources/pdf/plan';

function inspection(pages: number, scannedPages: number[]): PdfInspection {
  const all = Array.from({ length: pages }, (_, index) => index + 1);
  return {
    pages,
    pageTexts: all.map(() => ''),
    pageLines: all.map(() => []),
    textPages: all.filter((page) => !scannedPages.includes(page)),
    scannedPages,
    imagePages: scannedPages,
    blankPages: [],
  };
}

function config(overrides: Partial<PdfImportConfig> = {}): PdfImportConfig {
  return { ...DEFAULT_PDF_IMPORT_CONFIG, ...overrides };
}

describe('loadPdfImportConfig', () => {
  it('falls back to the documented defaults on an empty environment', () => {
    expect(loadPdfImportConfig({})).toEqual(DEFAULT_PDF_IMPORT_CONFIG);
  });

  it('reads every documented variable', () => {
    expect(
      loadPdfImportConfig({
        IMPORT_PDF_MAX_BYTES: '1048576',
        IMPORT_PDF_MAX_PAGES: '10',
        IMPORT_PDF_MAX_INPUT_TOKENS: '1000',
        IMPORT_PDF_CHUNK_PAGES: '5',
        IMPORT_PDF_DETAIL: 'high',
        IMPORT_PDF_SERVICE_TIER: 'default',
        IMPORT_PDF_MODE: 'text',
        IMPORT_PDF_FIDELITY_THRESHOLD: '0.5',
        IMPORT_PDF_TEXT_PAGE_MIN_CHARS: '40',
      }),
    ).toEqual({
      maxBytes: 1048576,
      maxPages: 10,
      maxInputTokens: 1000,
      chunkPages: 5,
      detail: 'high',
      serviceTier: 'default',
      mode: 'text',
      fidelityThreshold: 0.5,
      textPageMinChars: 40,
    });
  });

  it('ignores nonsense rather than failing every import in the workspace', () => {
    const loaded = loadPdfImportConfig({
      IMPORT_PDF_MAX_PAGES: 'lots',
      IMPORT_PDF_CHUNK_PAGES: '-3',
      IMPORT_PDF_DETAIL: 'medium',
      IMPORT_PDF_MODE: '',
      IMPORT_PDF_FIDELITY_THRESHOLD: '12',
    });
    expect(loaded.maxPages).toBe(DEFAULT_PDF_IMPORT_CONFIG.maxPages);
    expect(loaded.chunkPages).toBe(DEFAULT_PDF_IMPORT_CONFIG.chunkPages);
    expect(loaded.detail).toBe('auto');
    expect(loaded.mode).toBe('auto');
    expect(loaded.fidelityThreshold).toBe(DEFAULT_PDF_IMPORT_CONFIG.fidelityThreshold);
  });
});

describe('planPdfImport', () => {
  it('sends a short text document as one low-detail chunk', () => {
    const plan = planPdfImport(inspection(8, []), config({ chunkPages: 20 }));
    expect(plan.chunks).toEqual([{ from: 1, to: 8, detail: 'low' }]);
    expect(plan.scannedPages).toEqual([]);
  });

  it('splits a long run at the chunk size', () => {
    const plan = planPdfImport(inspection(45, []), config({ chunkPages: 20 }));
    expect(plan.chunks).toEqual([
      { from: 1, to: 20, detail: 'low' },
      { from: 21, to: 40, detail: 'low' },
      { from: 41, to: 45, detail: 'low' },
    ]);
  });

  it('cuts at the scanned/text boundary so text pages stay low detail', () => {
    const plan = planPdfImport(inspection(10, [5, 6]), config({ chunkPages: 20 }));
    expect(plan.chunks).toEqual([
      { from: 1, to: 4, detail: 'low' },
      { from: 5, to: 6, detail: 'high' },
      { from: 7, to: 10, detail: 'low' },
    ]);
  });

  it('splits a long scanned run by length too, keeping it high detail', () => {
    const scanned = [3, 4, 5, 6, 7, 8, 9];
    const plan = planPdfImport(inspection(9, scanned), config({ chunkPages: 3 }));
    expect(plan.chunks).toEqual([
      { from: 1, to: 2, detail: 'low' },
      { from: 3, to: 5, detail: 'high' },
      { from: 6, to: 8, detail: 'high' },
      { from: 9, to: 9, detail: 'high' },
    ]);
  });

  it('honours an explicit detail override for every chunk', () => {
    const forcedHigh = planPdfImport(inspection(6, [4]), config({ detail: 'high', chunkPages: 20 }));
    expect(forcedHigh.chunks.every((chunk) => chunk.detail === 'high')).toBe(true);

    const forcedLow = planPdfImport(inspection(6, [4]), config({ detail: 'low', chunkPages: 20 }));
    expect(forcedLow.chunks.every((chunk) => chunk.detail === 'low')).toBe(true);
    // The boundary split still happens; only the detail is overridden.
    expect(forcedLow.chunks).toHaveLength(3);
  });

  it('never upgrades a chunk for a blank page, which has nothing to render', () => {
    const blank: PdfInspection = {
      pages: 4,
      pageTexts: ['a', '', 'c', 'd'],
      pageLines: [[], [], [], []],
      textPages: [1, 3, 4],
      scannedPages: [],
      imagePages: [],
      blankPages: [2],
    };
    expect(planPdfImport(blank, config({ chunkPages: 20 })).chunks).toEqual([{ from: 1, to: 4, detail: 'low' }]);
  });

  it('carries the scanned pages through for the warning and the estimate', () => {
    expect(planPdfImport(inspection(4, [2, 3]), config()).scannedPages).toEqual([2, 3]);
  });

  it('treats a chunk size of zero as one page per chunk rather than looping forever', () => {
    const plan = planPdfImport(inspection(3, []), config({ chunkPages: 0 }));
    expect(plan.chunks).toEqual([
      { from: 1, to: 1, detail: 'low' },
      { from: 2, to: 2, detail: 'low' },
      { from: 3, to: 3, detail: 'low' },
    ]);
  });
});

describe('countScannedPages', () => {
  it('counts only the scanned pages inside the chunk', () => {
    expect(countScannedPages({ from: 3, to: 6 }, [1, 4, 5, 9])).toBe(2);
    expect(countScannedPages({ from: 1, to: 2 }, [4, 5])).toBe(0);
    expect(countScannedPages({ from: 4, to: 4 }, [4])).toBe(1);
  });
});

describe('pageRangeLabel', () => {
  it('names a single page and a range differently', () => {
    expect(pageRangeLabel({ from: 3, to: 3 })).toBe('p. 3');
    expect(pageRangeLabel({ from: 3, to: 7 })).toBe('pp. 3–7');
  });
});
