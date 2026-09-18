import { useCallback, useEffect, useState } from 'react';
import { useLocale, useT } from '../i18n';
import {
  type DraftResult,
  type ImportProgress,
  type PdfUpload,
  convertPdf,
  describeImportError,
} from '../utils/import-api';
import { ImportProgressBar } from './ImportProgress';

/**
 * What a PDF conversion would cost, before it runs.
 *
 * The upload itself is free — it is read by pdfjs and measured with the token
 * counter, no model involved — so the manager sees the size of the job and the
 * bill their own OpenAI key would carry, and then decides. That order is the
 * point: a 200-page scan is a different decision from a 4-page memo, and the
 * only moment to make it is before the request goes out.
 */

type PdfEstimateDialogProps = {
  workspaceId: string;
  upload: PdfUpload;
  /** From `import/status`: false when this workspace converts with the text layer only. */
  llm: boolean;
  onCancel: () => void;
  onConverted: (draft: DraftResult) => void;
};

export function PdfEstimateDialog({ workspaceId, upload, llm, onCancel, onConverted }: PdfEstimateDialogProps) {
  const t = useT();
  const { locale } = useLocale();
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const estimate = upload.estimate;
  const count = (value: number) => value.toLocaleString(locale);
  const usd =
    estimate.estimatedUsd === undefined
      ? null
      : new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 3,
        }).format(estimate.estimatedUsd);

  const handleCancel = useCallback(() => {
    if (converting) return;
    onCancel();
  }, [converting, onCancel]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCancel]);

  const handleConvert = async (event: React.FormEvent) => {
    event.preventDefault();
    if (converting) return;
    setConverting(true);
    setProgress(null);
    setError(null);
    try {
      const draft = await convertPdf(workspaceId, upload.uploadId, setProgress);
      onConverted(draft);
    } catch (err) {
      setError(describeImportError(t, err, t('import.error.convert')));
      setConverting(false);
      setProgress(null);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div
      className="commit-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('import.estimate.aria.dialog')}
    >
      <form className="commit-dialog" onSubmit={handleConvert}>
        <h2 className="commit-dialog-title">{t('import.estimate.title')}</h2>
        <p className="commit-dialog-subtitle">{upload.filename}</p>

        <dl className="import-estimate">
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.pages')}</dt>
            <dd>{count(estimate.pages)}</dd>
          </div>
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.scannedPages')}</dt>
            <dd>{count(estimate.scannedPages)}</dd>
          </div>
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.chunks')}</dt>
            <dd>{count(estimate.chunks)}</dd>
          </div>
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.inputTokens')}</dt>
            <dd>
              {t('import.estimate.value.ofLimit', {
                tokens: count(estimate.inputTokens),
                limit: count(estimate.maxInputTokens),
              })}
            </dd>
          </div>
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.outputTokens')}</dt>
            <dd>{count(estimate.estimatedOutputTokens)}</dd>
          </div>
          {/* Omitted rather than shown as zero when the model has no price we
              know: an invented number is worse than none. */}
          {usd && (
            <div className="import-estimate-row">
              <dt>{t('import.estimate.label.cost')}</dt>
              <dd>{t('import.estimate.value.approxCost', { amount: usd })}</dd>
            </div>
          )}
          <div className="import-estimate-row">
            <dt>{t('import.estimate.label.model')}</dt>
            <dd>{t('import.estimate.value.model', { model: estimate.model, tier: estimate.serviceTier })}</dd>
          </div>
        </dl>

        <p className="commit-dialog-hint">{llm ? t('import.estimate.billing') : t('import.estimate.textMode')}</p>

        {/* Already in the reader's language: the convert handler runs the
            server's code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        {converting && (
          <ImportProgressBar
            progress={progress}
            ariaLabel={t('import.estimate.aria.progress')}
            startingLabel={t('import.estimate.starting')}
          />
        )}

        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancel} disabled={converting}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={converting}>
            {converting ? t('import.estimate.button.converting') : t('import.estimate.button.convert')}
          </button>
        </div>
      </form>
    </div>
  );
}
