import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type T, useLocale, useT } from '../i18n';
import type { DocFile } from '../types';
import { folderOf, siblingNames } from '../utils/docs';
import { suggestFileNameFromSiblings } from '../utils/file-names';
import { type GlossaryStatus, fetchGlossaryStatus } from '../utils/glossary-api';
import type { ImportGlossaryRow, ImportProgress } from '../utils/import-api';
import {
  type MeetingDraftResult,
  type MeetingFormat,
  type MeetingUpload,
  TRANSCRIPT_ACCEPT,
  TRANSCRIPT_MAX_BYTES,
  convertMeetingNote,
  describeMeetingError,
  estimateMeetingNote,
  isSupportedTranscriptName,
  readFileAsBase64,
} from '../utils/meeting-api';
import { type ProjectSummary, meetingsFolderOf, nearestProject, projectMembers } from '../utils/project-api';
import { ImportPreviewDialog } from './ImportPreviewDialog';
import { ImportProgressBar } from './ImportProgress';

/**
 * "회의록 만들기" — the meeting's details first, the transcript second.
 *
 * Everything that makes a meeting note findable afterwards — which meeting it
 * was, when, who was there, where it belongs — comes from the person making it
 * rather than from the model (docs/meeting-notes-and-glossary.md, 결정 2). A
 * model guessing the folder from the words is exactly how a note ends up filed
 * under the wrong project, so this dialog asks, and the conversion is told.
 *
 * The defaults are the part worth reading. The folder is the nearest project's
 * meetings folder, because a document open inside `projects/alpha` is the
 * strongest statement of intent available; the participants are that project's
 * Slack channel members, live, because they are already a list somebody
 * maintains; the file name follows whatever convention the target folder
 * already keeps. All three are suggestions the manager can overwrite, and the
 * moment they do the suggestion stops following them around.
 *
 * Two buttons, not one: 견적 보기 parses and prices locally (no model, no
 * bill), and only 만들기 spends the workspace's key.
 */

type MeetingNoteDialogProps = {
  workspaceId: string;
  /** The document open behind the dialog; its project decides the defaults. */
  currentPath: string;
  /** Every document in the repository, for the folder's naming convention. */
  files: DocFile[];
  /** The workspace's project folders, for the folder and participant defaults. */
  projects: ProjectSummary[];
  onCancel: () => void;
};

/** How the transcript arrives: a file, or text pasted into the dialog. */
type SourceMode = 'file' | 'paste';

/** `TextKind` as `sources/text/detect.ts` reports it, in the reader's language. */
const KIND_KEY = {
  vtt: 'meeting.kind.vtt',
  srt: 'meeting.kind.srt',
  'transcript-text': 'meeting.kind.transcriptText',
  docx: 'meeting.kind.docx',
  markdown: 'meeting.kind.markdown',
  plain: 'meeting.kind.plain',
} as const satisfies Record<string, Parameters<T>[0]>;

function describeKind(t: T, kind: string): string {
  const key = KIND_KEY[kind as keyof typeof KIND_KEY];
  // A server newer than this bundle may detect a kind we have no word for; its
  // own name is a better answer than a blank row.
  return key ? t(key) : kind;
}

/** Today, in the repository's `YYYY-MM-DD`, read off the reader's own clock. */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What the server creates when the chain has no glossary; repeated, not imported. */
const DEFAULT_GLOSSARY_FILE = 'GLOSSARY.md';

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && date.getDate() === day && date.getMonth() + 1 === month;
}

/** `2026-09-20-weekly.vtt`, `20260920_weekly.txt` — the day the meeting happened. */
function dateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{4})([-._]?)(\d{2})\2(\d{2})/);
  if (!match) return null;
  const candidate = `${match[1]}-${match[3]}-${match[4]}`;
  return Number(match[1]) >= 1900 && Number(match[1]) <= 2999 && isCalendarDate(candidate) ? candidate : null;
}

/** `2026-09-20-weekly-sync.vtt` → `weekly-sync`. The date is its own field. */
function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const stem = base.replace(/\.[^.]+$/, '');
  const withoutDate = stem.replace(/^\d{4}[-._]?\d{2}[-._]?\d{2}[-._ ]*/, '').trim();
  return withoutDate || stem;
}

/** A folder as the server will read it: no leading or trailing slash. */
function normalizeFolder(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

export function MeetingNoteDialog({ workspaceId, currentPath, files, projects, onCancel }: MeetingNoteDialogProps) {
  const t = useT();
  const { locale } = useLocale();

  // ── The transcript ───────────────────────────────────────────────────────
  const [mode, setMode] = useState<SourceMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);

  // ── The meeting, as the manager describes it ─────────────────────────────
  const [title, setTitle] = useState('');
  const [titleEdited, setTitleEdited] = useState(false);
  const [date, setDate] = useState(todayIso);
  const [dateEdited, setDateEdited] = useState(false);
  const [folder, setFolder] = useState(() => {
    // The nearest project's meetings folder, else the folder being read: the
    // closest thing to an intent this dialog has before anybody types.
    const project = nearestProject(projects, currentPath);
    return project ? meetingsFolderOf(project) : folderOf(currentPath);
  });
  const [fileName, setFileName] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);
  // A ref, not state: nothing renders differently because of it, and the
  // member effect reads it without wanting to re-run when it flips.
  const participantsEdited = useRef(false);
  const [participantDraft, setParticipantDraft] = useState('');
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersFilled, setMembersFilled] = useState(0);
  const [memberWarning, setMemberWarning] = useState<string | null>(null);
  const [context, setContext] = useState('');
  const [format, setFormat] = useState<MeetingFormat>('notes');

  // ── The two requests ─────────────────────────────────────────────────────
  const [upload, setUpload] = useState<MeetingUpload | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [converting, setConverting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MeetingDraftResult | null>(null);

  // ── "용어집에 추가할까요?" — the card under the preview ───────────────────
  // Nothing is ticked by default: a term the model did not recognise is a
  // question, and the answer is the manager's (docs/…/용어집 §5).
  const [glossaryPicked, setGlossaryPicked] = useState<Record<string, boolean>>({});
  const [glossaryDescriptions, setGlossaryDescriptions] = useState<Record<string, string>>({});
  const [glossaryTarget, setGlossaryTarget] = useState<GlossaryStatus | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const busy = estimating || converting;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const handleCancel = useCallback(() => {
    if (busy) return;
    onCancel();
  }, [busy, onCancel]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // The preview has its own Escape handling once it is open.
      if (event.key === 'Escape' && !draft) handleCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleCancel, draft]);

  /**
   * Every field feeds the estimate, so changing one invalidates it: the number
   * the manager approves must be the one for the request that runs.
   */
  const invalidate = useCallback(() => {
    setUpload(null);
    setError(null);
  }, []);

  const normalizedFolder = normalizeFolder(folder);

  // The project that owns the folder being written to — which is not always the
  // one the open document belongs to, because the folder is editable.
  const folderProject = useMemo(() => nearestProject(projects, normalizedFolder), [projects, normalizedFolder]);

  // Participants default to the project's members, read live from Slack. A
  // manager who has already edited the list keeps it: a folder change must not
  // throw away names that were typed by hand.
  useEffect(() => {
    if (!folderProject) {
      setMembersFilled(0);
      setMemberWarning(null);
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    setMemberWarning(null);
    projectMembers(workspaceId, folderProject.folder)
      .then((result) => {
        if (cancelled) return;
        const names = result.members.filter((member) => !member.isBot).map((member) => member.name);
        setMembersFilled(names.length);
        setMemberWarning(result.warning ?? null);
        setParticipants((current) => (participantsEdited.current ? current : names));
      })
      .catch(() => {
        // Not a fault worth a red line: the field is simply empty, and the
        // manager types the names.
        if (!cancelled) setMembersFilled(0);
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, folderProject]);

  // Which glossary the ticked terms would land in — the same chain the server
  // walks at commit time. Only once there is a draft: before that there is no
  // card to caption.
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    fetchGlossaryStatus(workspaceId, normalizedFolder)
      .then((status) => {
        if (!cancelled) setGlossaryTarget(status);
      })
      .catch(() => {
        // The card still works: the caption falls back to the folder's own
        // `GLOSSARY.md`, which is what the server would create anyway.
        if (!cancelled) setGlossaryTarget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, normalizedFolder, draft]);

  const siblings = useMemo(() => siblingNames(files, normalizedFolder), [files, normalizedFolder]);
  const suggestion = useMemo(
    () =>
      suggestFileNameFromSiblings(siblings, {
        title,
        fallback: 'meeting',
        ...(isCalendarDate(date) ? { date: new Date(`${date}T00:00:00`) } : {}),
      }),
    [siblings, title, date],
  );

  const trimmedTitle = title.trim();
  const effectiveFileName = fileName.trim() || suggestion.placeholder;
  const targetPath = normalizedFolder ? `${normalizedFolder}/${effectiveFileName}` : effectiveFileName;

  const handleFile = useCallback(
    (chosen: File) => {
      if (!isSupportedTranscriptName(chosen.name)) {
        setError(t('meeting.error.unsupported'));
        return;
      }
      if (chosen.size > TRANSCRIPT_MAX_BYTES) {
        setError(t('meeting.error.tooLarge', { limit: Math.floor(TRANSCRIPT_MAX_BYTES / (1024 * 1024)) }));
        return;
      }
      setError(null);
      setUpload(null);
      setFile(chosen);
      // The file names the meeting until somebody says otherwise.
      if (!titleEdited) setTitle(titleFromFilename(chosen.name));
      if (!dateEdited) {
        const found = dateFromFilename(chosen.name);
        if (found) setDate(found);
      }
    },
    [t, titleEdited, dateEdited],
  );

  const addParticipant = (value: string) => {
    const name = value.trim().replace(/,+$/, '').trim();
    if (!name) return;
    participantsEdited.current = true;
    invalidate();
    setParticipants((current) => (current.some((entry) => entry === name) ? current : [...current, name]));
  };

  const removeParticipant = (name: string) => {
    participantsEdited.current = true;
    invalidate();
    setParticipants((current) => current.filter((entry) => entry !== name));
  };

  const handleParticipantKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter in a chips field means "add this name", never "submit the form".
      event.preventDefault();
      addParticipant(participantDraft);
      setParticipantDraft('');
      return;
    }
    if (event.key === 'Backspace' && !participantDraft && participants.length > 0) {
      event.preventDefault();
      removeParticipant(participants[participants.length - 1]);
    }
  };

  const hasSource = mode === 'file' ? file !== null : pasted.trim().length > 0;
  const dateValid = isCalendarDate(date);
  // The same three things `parseMeetingMeta` refuses, checked here so a typo is
  // a hint under the field rather than a round trip.
  const fileNameValid = /\.md$/i.test(effectiveFileName) && !/[\\/]/.test(effectiveFileName);
  const ready = hasSource && Boolean(trimmedTitle) && dateValid && fileNameValid;

  const handleEstimate = async () => {
    if (busy || !ready) return;
    setEstimating(true);
    setError(null);
    try {
      const meta = {
        title: trimmedTitle,
        date,
        folder: normalizedFolder,
        fileName: effectiveFileName,
        participants,
        format,
        ...(context.trim() ? { context: context.trim() } : {}),
      };
      const source =
        mode === 'file' && file
          ? { filename: file.name, contentBase64: await readFileAsBase64(file) }
          : { text: pasted };
      setUpload(await estimateMeetingNote(workspaceId, { ...source, meta }));
    } catch (err) {
      setError(describeMeetingError(t, err, t('meeting.error.estimate')));
    } finally {
      setEstimating(false);
    }
  };

  const handleConvert = async () => {
    if (busy || !upload) return;
    setConverting(true);
    setProgress(null);
    setError(null);
    try {
      setDraft(await convertMeetingNote(workspaceId, upload.uploadId, setProgress));
    } catch (err) {
      setError(describeMeetingError(t, err, t('meeting.error.convert')));
      // The upload is spent either way — the server drops it after a
      // conversion — so the next attempt re-estimates rather than 410ing.
      setUpload(null);
      setConverting(false);
      setProgress(null);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (upload) void handleConvert();
    else void handleEstimate();
  };

  // ── The preview, once there is something to preview ──────────────────────
  if (draft) {
    const unknownTerms = draft.unknownTerms;
    // The file the rows would land in, as the server will resolve it: the
    // nearest glossary in the chain, else a new one beside the note.
    const glossaryPath =
      glossaryTarget?.nearestFile ?? `${normalizedFolder ? `${normalizedFolder}/` : ''}${DEFAULT_GLOSSARY_FILE}`;
    const pickedCount = unknownTerms.filter((term) => glossaryPicked[term]).length;

    return (
      <ImportPreviewDialog
        workspaceId={workspaceId}
        draft={draft}
        glossaryRowsProvider={() =>
          unknownTerms
            .filter((term) => glossaryPicked[term])
            .map((term) => {
              const description = (glossaryDescriptions[term] ?? '').trim();
              // Aliases stay empty on purpose: a dictation misspelling cannot
              // be read off the transcript, it is learnt the next time round.
              return description ? { term, description } : { term };
            })
        }
        extraCards={
          unknownTerms.length > 0 ? (
            <div className="import-warnings">
              <div className="import-warnings-title">
                {t('meeting.glossaryCard.title', { count: unknownTerms.length })}
              </div>
              <ul className="meeting-glossary-list">
                {unknownTerms.map((term) => (
                  <li className="meeting-glossary-row" key={term}>
                    <label className="meeting-glossary-check">
                      <input
                        type="checkbox"
                        checked={Boolean(glossaryPicked[term])}
                        onChange={(event) =>
                          setGlossaryPicked((current) => ({ ...current, [term]: event.target.checked }))
                        }
                      />
                      <span className="meeting-glossary-term">{term}</span>
                    </label>
                    <input
                      className="meeting-glossary-description"
                      type="text"
                      autoComplete="off"
                      aria-label={t('meeting.glossaryCard.description.aria', { term })}
                      placeholder={t('meeting.glossaryCard.description.placeholder')}
                      value={glossaryDescriptions[term] ?? ''}
                      onChange={(event) =>
                        setGlossaryDescriptions((current) => ({ ...current, [term]: event.target.value }))
                      }
                    />
                  </li>
                ))}
              </ul>
              <p className="commit-dialog-hint">
                {glossaryTarget?.nearestFile
                  ? t('meeting.glossaryCard.target', { path: glossaryPath })
                  : t('meeting.glossaryCard.target.create', { path: glossaryPath })}
              </p>
              <p className="commit-dialog-hint">
                {pickedCount > 0
                  ? t('meeting.glossaryCard.picked', { count: pickedCount })
                  : t('meeting.glossaryCard.hint')}
              </p>
            </div>
          ) : null
        }
        onCancel={onCancel}
      />
    );
  }

  const count = (value: number) => value.toLocaleString(locale);
  const estimate = upload?.estimate;
  const usd =
    estimate?.estimatedUsd === undefined
      ? null
      : new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
          maximumFractionDigits: 3,
        }).format(estimate.estimatedUsd);

  return (
    // biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal()
    <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('meeting.aria.dialog')}>
      <form className="commit-dialog commit-dialog-wide" onSubmit={handleSubmit}>
        <h2 className="commit-dialog-title">{t('meeting.title')}</h2>
        <p className="commit-dialog-subtitle">{t('meeting.subtitle')}</p>

        {/* ── The transcript ── */}
        <div className="meeting-source-tabs" role="tablist" aria-label={t('meeting.aria.sourceTabs')}>
          {(['file', 'paste'] as SourceMode[]).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={mode === entry}
              className={`project-tab${mode === entry ? ' active' : ''}`}
              onClick={() => {
                setMode(entry);
                invalidate();
              }}
              disabled={busy}
            >
              {entry === 'file' ? t('meeting.source.tab.file') : t('meeting.source.tab.paste')}
            </button>
          ))}
        </div>

        {mode === 'file' ? (
          <>
            <div
              className={`meeting-dropzone${dragging ? ' dragging' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                const dropped = event.dataTransfer.files?.[0];
                if (dropped) handleFile(dropped);
              }}
            >
              <span>{file ? file.name : t('meeting.source.drop')}</span>
              <button
                type="button"
                className="doc-button doc-button-ghost"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                {file ? t('meeting.source.chooseAnother') : t('meeting.source.choose')}
              </button>
            </div>
            <p className="commit-dialog-hint">
              {t('meeting.source.formats', { limit: Math.floor(TRANSCRIPT_MAX_BYTES / (1024 * 1024)) })}
            </p>
            <input
              ref={fileInputRef}
              className="import-file-input"
              type="file"
              accept={TRANSCRIPT_ACCEPT}
              tabIndex={-1}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                // Cleared so choosing the same file twice still fires a change.
                event.target.value = '';
                if (chosen) handleFile(chosen);
              }}
            />
          </>
        ) : (
          <>
            <label className="commit-dialog-label" htmlFor="meeting-paste">
              {t('meeting.source.paste.label')}
            </label>
            <textarea
              id="meeting-paste"
              className="commit-dialog-input meeting-paste"
              rows={6}
              placeholder={t('meeting.source.paste.placeholder')}
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
                invalidate();
              }}
              disabled={busy}
            />
          </>
        )}

        {/* ── The meeting ── */}
        <label className="commit-dialog-label" htmlFor="meeting-title">
          {t('meeting.label.title')}
        </label>
        <input
          ref={titleRef}
          id="meeting-title"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          value={title}
          onChange={(event) => {
            setTitleEdited(true);
            setTitle(event.target.value);
            invalidate();
          }}
          disabled={busy}
        />

        <label className="commit-dialog-label" htmlFor="meeting-date">
          {t('meeting.label.date')}
        </label>
        <input
          id="meeting-date"
          className="commit-dialog-input"
          type="date"
          value={date}
          onChange={(event) => {
            setDateEdited(true);
            setDate(event.target.value);
            invalidate();
          }}
          disabled={busy}
        />
        {!dateValid && <p className="commit-dialog-error">{t('meeting.error.date')}</p>}

        <label className="commit-dialog-label" htmlFor="meeting-folder">
          {t('meeting.label.folder')}
        </label>
        <input
          id="meeting-folder"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
            invalidate();
          }}
          disabled={busy}
        />
        <p className="commit-dialog-hint">{t('meeting.hint.folder')}</p>

        <label className="commit-dialog-label" htmlFor="meeting-filename">
          {t('meeting.label.fileName')}
        </label>
        <input
          id="meeting-filename"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={fileName}
          placeholder={suggestion.placeholder}
          onChange={(event) => {
            setFileName(event.target.value);
            invalidate();
          }}
          disabled={busy}
        />
        {fileName.trim() && !fileNameValid && <p className="commit-dialog-error">{t('meeting.error.fileName')}</p>}
        {suggestion.examples.length > 0 && (
          <p className="commit-dialog-hint">
            {t('fileName.hint.siblings', { examples: suggestion.examples.join(', ') })}
          </p>
        )}
        <p className="commit-dialog-hint">{t('meeting.hint.path', { path: targetPath })}</p>

        <span className="commit-dialog-label" id="meeting-participants-label">
          {t('meeting.label.participants')}
        </span>
        <div className="chips-input">
          {participants.map((name) => (
            <button
              key={name}
              type="button"
              className="chip"
              aria-label={t('meeting.participants.remove.aria', { name })}
              onClick={() => removeParticipant(name)}
              disabled={busy}
            >
              {name}
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <input
            className="chips-input-field"
            type="text"
            autoComplete="off"
            aria-labelledby="meeting-participants-label"
            placeholder={t('meeting.participants.placeholder')}
            value={participantDraft}
            onChange={(event) => setParticipantDraft(event.target.value)}
            onKeyDown={handleParticipantKey}
            onBlur={() => {
              addParticipant(participantDraft);
              setParticipantDraft('');
            }}
            disabled={busy}
          />
        </div>
        {membersLoading && <p className="commit-dialog-hint">{t('meeting.participants.loading')}</p>}
        {!membersLoading && folderProject && membersFilled > 0 && (
          <p className="commit-dialog-hint">{t('meeting.participants.fromProject', { count: membersFilled })}</p>
        )}
        {!membersLoading && !folderProject && (
          <p className="commit-dialog-hint">{t('meeting.participants.noProject')}</p>
        )}
        {memberWarning && (
          <p className="commit-dialog-warning">{t('project.members.channelWarning', { message: memberWarning })}</p>
        )}

        <label className="commit-dialog-label" htmlFor="meeting-context">
          {t('meeting.label.context')}
        </label>
        <input
          id="meeting-context"
          className="commit-dialog-input"
          type="text"
          autoComplete="off"
          placeholder={t('meeting.context.placeholder')}
          value={context}
          onChange={(event) => {
            setContext(event.target.value);
            invalidate();
          }}
          disabled={busy}
        />

        <span className="commit-dialog-label">{t('meeting.label.format')}</span>
        {(['notes', 'transcript'] as MeetingFormat[]).map((value) => (
          <label className="project-radio" key={value}>
            <input
              type="radio"
              name="meeting-format"
              checked={format === value}
              onChange={() => {
                setFormat(value);
                invalidate();
              }}
              disabled={busy}
            />
            <span>
              <span className="project-radio-title">
                {value === 'notes' ? t('meeting.format.notes') : t('meeting.format.transcript')}
              </span>
              <span className="project-radio-hint">
                {value === 'notes' ? t('meeting.format.notes.hint') : t('meeting.format.transcript.hint')}
              </span>
            </span>
          </label>
        ))}

        {/* ── What it would cost, before a single model call ── */}
        {upload && estimate && (
          <>
            <dl className="import-estimate">
              <div className="import-estimate-row">
                <dt>{t('meeting.estimate.label.kind')}</dt>
                <dd>{describeKind(t, upload.detected.kind)}</dd>
              </div>
              <div className="import-estimate-row">
                <dt>{t('meeting.estimate.label.utterances')}</dt>
                <dd>{count(estimate.utterances)}</dd>
              </div>
              <div className="import-estimate-row">
                <dt>{t('meeting.estimate.label.speakers')}</dt>
                <dd>{count(estimate.speakers)}</dd>
              </div>
              {estimate.minutes !== undefined && (
                <div className="import-estimate-row">
                  <dt>{t('meeting.estimate.label.minutes')}</dt>
                  <dd>{count(estimate.minutes)}</dd>
                </div>
              )}
              <div className="import-estimate-row">
                <dt>{t('import.estimate.label.chunks')}</dt>
                <dd>{count(estimate.chunks)}</dd>
              </div>
              <div className="import-estimate-row">
                <dt>{t('import.estimate.label.inputTokens')}</dt>
                <dd>{count(estimate.inputTokens)}</dd>
              </div>
              <div className="import-estimate-row">
                <dt>{t('import.estimate.label.outputTokens')}</dt>
                <dd>{count(estimate.estimatedOutputTokens)}</dd>
              </div>
              {/* Omitted rather than shown as zero when the model has no price
                  we know: an invented number is worse than none. */}
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
              <div className="import-estimate-row">
                <dt>{t('meeting.estimate.label.path')}</dt>
                <dd>{upload.targetPath}</dd>
              </div>
            </dl>
            <p className="commit-dialog-hint">{t('meeting.estimate.billing')}</p>
          </>
        )}

        {/* Already in the reader's language: both handlers run the server's
            code through `describeServerError` first. */}
        {error && <p className="commit-dialog-error">{error}</p>}
        {converting && (
          <ImportProgressBar
            progress={progress}
            ariaLabel={t('meeting.aria.progress')}
            startingLabel={t('meeting.starting')}
          />
        )}

        <div className="commit-dialog-actions">
          <button type="button" className="doc-button doc-button-ghost" onClick={handleCancel} disabled={busy}>
            {t('common.button.cancel')}
          </button>
          <button type="submit" className="doc-button doc-button-primary" disabled={busy || !ready}>
            {converting
              ? t('meeting.button.creating')
              : estimating
                ? t('meeting.button.estimating')
                : upload
                  ? t('meeting.button.create')
                  : t('meeting.button.estimate')}
          </button>
        </div>
      </form>
    </div>
  );
}
