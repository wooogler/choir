import { useEffect, useState } from 'react';
import { type Locale, SUPPORTED_LOCALES, describeServerError, useT } from '../i18n';
import type { LanguageSettings } from '../types';

/**
 * Viewer settings, which today means language.
 *
 * The same three settings the App Home pickers write, so a reader who lives in
 * the viewer does not have to go back to Slack to be understood. Personal
 * language is anyone's; the workspace default and the document-content policy
 * are shown to managers only, because only they can save them.
 *
 * Saving reads the state back from the server rather than trusting the form:
 * "Automatic" resolves to a Slack locale or the workspace default, and the
 * dialog has to show which one it landed on.
 */

type SettingsDialogProps = {
  workspaceId: string;
  isManager: boolean;
  settings: LanguageSettings;
  onClose: () => void;
  /** Applies the language the server resolved, so the UI switches immediately. */
  onSaved: (language: Locale, settings: LanguageSettings) => void;
};

/** A language's own name is the same string in every catalog, so it is not translated. */
const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ko: '한국어' };

type MineChoice = 'auto' | Locale;

export function SettingsDialog({ workspaceId, isManager, settings, onClose, onSaved }: SettingsDialogProps) {
  const t = useT();
  const [mine, setMine] = useState<MineChoice>(settings.mine ?? 'auto');
  const [workspace, setWorkspace] = useState<Locale>(settings.workspace);
  const [content, setContent] = useState<'follow-conversation' | Locale>(settings.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, saving]);

  const dirty =
    mine !== (settings.mine ?? 'auto') ||
    (isManager && (workspace !== settings.workspace || content !== settings.content));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, string> = {};
      if (mine !== (settings.mine ?? 'auto')) body.mine = mine;
      if (isManager && workspace !== settings.workspace) body.workspace = workspace;
      if (isManager && content !== settings.content) body.content = content;

      const response = await fetch(`/api/docs/${encodeURIComponent(workspaceId)}/language`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(describeServerError(t, data) ?? t('settings.error.save'));
        return;
      }
      onSaved(data.language as Locale, data.languageSettings as LanguageSettings);
      onClose();
    } catch {
      setError(t('settings.error.save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('settings.aria.dialog')}>
      <form className="commit-dialog" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('settings.title')}</h2>

        <label className="commit-dialog-label" htmlFor="settings-my-language">
          {t('settings.mine.label')}
        </label>
        <select
          id="settings-my-language"
          className="commit-dialog-input"
          value={mine}
          disabled={saving}
          onChange={(event) => setMine(event.target.value as MineChoice)}
        >
          <option value="auto">{t('settings.option.auto')}</option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
        <p className="commit-dialog-hint">{t('settings.mine.hint')}</p>

        {isManager && (
          <>
            <hr className="settings-divider" />
            <label className="commit-dialog-label" htmlFor="settings-workspace-language">
              {t('settings.workspace.label')}
            </label>
            <select
              id="settings-workspace-language"
              className="commit-dialog-input"
              value={workspace}
              disabled={saving}
              onChange={(event) => setWorkspace(event.target.value as Locale)}
            >
              {SUPPORTED_LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {LOCALE_NAMES[locale]}
                </option>
              ))}
            </select>
            <p className="commit-dialog-hint">{t('settings.workspace.hint')}</p>

            <label className="commit-dialog-label" htmlFor="settings-content-language">
              {t('settings.content.label')}
            </label>
            <select
              id="settings-content-language"
              className="commit-dialog-input"
              value={content}
              disabled={saving}
              onChange={(event) => setContent(event.target.value as 'follow-conversation' | Locale)}
            >
              <option value="follow-conversation">{t('settings.option.followConversation')}</option>
              {SUPPORTED_LOCALES.map((locale) => (
                <option key={locale} value={locale}>
                  {LOCALE_NAMES[locale]}
                </option>
              ))}
            </select>
            <p className="commit-dialog-hint">{t('settings.content.hint')}</p>
          </>
        )}

        {error && <p className="commit-dialog-error">{error}</p>}

        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={onClose} disabled={saving}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={saving || !dirty}>
            {saving ? t('settings.button.saving') : t('settings.button.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
