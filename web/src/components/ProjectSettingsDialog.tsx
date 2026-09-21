import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fillNodes, useT } from '../i18n';
import { type GlossaryStatus, fetchGlossaryStatus } from '../utils/glossary-api';
import {
  ProjectApiError,
  type ProjectSettingsInput,
  type ProjectSummary,
  type RetrievalScope,
  type SlackChannelSummary,
  type SlackMember,
  type UpdateScope,
  channelMembers,
  deleteProject,
  describeProjectError,
  listChannels,
  saveProject,
} from '../utils/project-api';
import { GlossaryBuilderDialog } from './GlossaryBuilderDialog';

/**
 * Declaring a folder a project, and editing the declaration afterwards.
 *
 * Everything here ends up in one committed file — `.choir/project.json` in the
 * folder — so the dialog is a single form with tabs rather than five screens
 * that each save: a manager who links a channel and then picks core members has
 * made one decision, and it lands as one commit.
 *
 * The people and channel lists are *not* part of that file. Channel membership
 * belongs to Slack and a copy in git would be stale the moment somebody joined
 * (docs/project-folders.md 1), so the Members tab is a live read and only the
 * curated list and the dictation aliases — Slack user IDs, never names — are
 * written. Rows whose person has since left every linked channel are still
 * drawn, greyed: their aliases are in the file, and silently dropping them on
 * the next save is the one outcome nobody asked for.
 *
 * See docs/project-folders.md section 6.
 */

type ProjectSettingsDialogProps = {
  workspaceId: string;
  /** Repository-relative folder, e.g. `projects/alpha`. */
  folder: string;
  /** The project as it stands, or null for a folder that is not one yet. */
  existing: ProjectSummary | null;
  /** The saved project, `'deleted'`, or nothing at all when the manager backed out. */
  onClose: (saved?: ProjectSummary | 'deleted') => void;
};

type Tab = 'basic' | 'channels' | 'members' | 'scope' | 'glossary';

const TABS: Tab[] = ['basic', 'channels', 'members', 'scope', 'glossary'];

/**
 * The two defaults `services/projects/schema.ts` fills in. Repeated rather than
 * imported so the schema module — which is also the validator — stays a
 * type-only dependency of the bundle.
 */
const DEFAULT_MEETINGS_FOLDER = 'meetings';
const DEFAULT_GLOSSARY = 'GLOSSARY.md';

/** One row of the Members tab. */
type MemberRow = SlackMember & {
  /** False for somebody who is only in the file: curated, or carrying aliases. */
  present: boolean;
};

/** `as const` so each value stays a literal `MessageKey` for `t`. */
const TAB_LABEL = {
  basic: 'project.tab.basic',
  channels: 'project.tab.channels',
  members: 'project.tab.members',
  scope: 'project.tab.scope',
  glossary: 'project.tab.glossary',
} as const;

/** Comma-separated text ⇄ the alias list the file stores. */
function parseAliases(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function ProjectSettingsDialog({ workspaceId, folder, existing, onClose }: ProjectSettingsDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('basic');

  // ── The form, seeded from the file or from the folder's own name ─────────
  const [name, setName] = useState(() => existing?.name ?? folder.split('/').pop() ?? folder);
  const [description, setDescription] = useState(() => existing?.description ?? '');
  const [meetingsFolder, setMeetingsFolder] = useState(() => existing?.meetingsFolder ?? DEFAULT_MEETINGS_FOLDER);
  const [glossary, setGlossary] = useState(() => existing?.glossary ?? DEFAULT_GLOSSARY);
  const [selectedChannels, setSelectedChannels] = useState<string[]>(() => existing?.channels ?? []);
  const [curatedOnly, setCuratedOnly] = useState(() => existing?.members.source === 'curated');
  const [curated, setCurated] = useState<string[]>(() => existing?.members.curated ?? []);
  const [aliasText, setAliasText] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(existing?.members.aliases ?? {}).map(([id, list]) => [id, list.join(', ')])),
  );
  const [retrieval, setRetrieval] = useState<RetrievalScope>(() => existing?.scope.retrieval ?? 'boost');
  const [updates, setUpdates] = useState<UpdateScope>(() => existing?.scope.updates ?? 'folder');

  // ── Slack, read live ─────────────────────────────────────────────────────
  const [channels, setChannels] = useState<SlackChannelSummary[] | null>(null);
  const [privateReadable, setPrivateReadable] = useState(true);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState('');

  const [members, setMembers] = useState<SlackMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [memberWarnings, setMemberWarnings] = useState<string[]>([]);
  // Channel → its members, so flipping a checkbox off and on again does not
  // make five requests. Slack caches server-side too, but not the round trip.
  const memberCache = useRef(new Map<string, { members: SlackMember[]; warning?: string }>());

  // ── The folder's glossary chain, read when the tab is opened ─────────────
  const [glossaryStatus, setGlossaryStatus] = useState<GlossaryStatus | null>(null);
  const [glossaryStatusLoading, setGlossaryStatusLoading] = useState(false);
  const [glossaryBuilderOpen, setGlossaryBuilderOpen] = useState(false);

  // ── Saving ───────────────────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The channel a `project_channel_taken` refusal named, so the list can point at it. */
  const [takenChannel, setTakenChannel] = useState<string | null>(null);

  const busy = saving || deleting;
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      // The builder is on top and closes itself; this dialog must not go with it.
      if (event.key === 'Escape' && !busy && !glossaryBuilderOpen) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose, busy, glossaryBuilderOpen]);

  // The channel list is wanted by both the Channels tab and the Basic tab's
  // summary line, and it is one request, so it is fetched on open rather than
  // when a tab is first shown.
  useEffect(() => {
    let cancelled = false;
    listChannels(workspaceId)
      .then((result) => {
        if (cancelled) return;
        setChannels(result.channels);
        setPrivateReadable(result.privateChannelsReadable);
      })
      .catch((err) => {
        if (!cancelled) setChannelsError(describeProjectError(t, err, t('project.channels.error')));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, t]);

  // The glossary chain is a read, and a cheap one, but it belongs to a tab
  // most managers never open — so it waits until they do, and again after the
  // builder has committed something.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `glossaryBuilderOpen` is not read here — closing the builder is how a commit asks for a re-read
  useEffect(() => {
    if (tab !== 'glossary') return;
    let cancelled = false;
    setGlossaryStatusLoading(true);
    fetchGlossaryStatus(workspaceId, folder)
      .then((status) => {
        if (!cancelled) setGlossaryStatus(status);
      })
      .catch(() => {
        // A failure leaves the file field and its hint, which is what this tab
        // was before the chain was readable at all.
        if (!cancelled) setGlossaryStatus(null);
      })
      .finally(() => {
        if (!cancelled) setGlossaryStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, workspaceId, folder, glossaryBuilderOpen]);

  const selectedKey = [...selectedChannels].sort().join(',');

  // Members are the expensive read (one request per channel, each of which may
  // page through Slack), so they wait until somebody looks at the tab.
  useEffect(() => {
    if (tab !== 'members') return;
    const ids = selectedKey ? selectedKey.split(',') : [];
    if (ids.length === 0) {
      setMembers([]);
      setMemberWarnings([]);
      return;
    }

    let cancelled = false;
    setMembersLoading(true);
    setMembersError(null);
    Promise.all(
      ids.map(async (id) => {
        const cached = memberCache.current.get(id);
        if (cached) return cached;
        const result = await channelMembers(workspaceId, id);
        memberCache.current.set(id, result);
        return result;
      }),
    )
      .then((results) => {
        if (cancelled) return;
        const byId = new Map<string, SlackMember>();
        const warnings: string[] = [];
        for (const result of results) {
          if (result.warning) warnings.push(result.warning);
          // Bots are never project members (docs/project-folders.md 5); a
          // workspace's apps would otherwise be half the roster.
          for (const member of result.members) if (!member.isBot) byId.set(member.id, member);
        }
        setMembers([...byId.values()].sort((a, b) => a.name.localeCompare(b.name)));
        setMemberWarnings(warnings);
      })
      .catch((err) => {
        if (!cancelled) setMembersError(describeProjectError(t, err, t('project.members.error')));
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tab, selectedKey, workspaceId, t]);

  const toggleChannel = useCallback((id: string) => {
    setTakenChannel(null);
    setSelectedChannels((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const visibleChannels = useMemo(() => {
    if (!channels) return [];
    const needle = channelFilter.trim().toLowerCase();
    if (!needle) return channels;
    // A selected channel stays visible whatever the filter says: it is part of
    // the answer, and hiding it makes the count below look wrong.
    return channels.filter(
      (channel) => channel.name.toLowerCase().includes(needle) || selectedChannels.includes(channel.id),
    );
  }, [channels, channelFilter, selectedChannels]);

  /**
   * Everyone the Members tab draws: the live union, then whoever the file
   * still carries. The second group is why this is not simply `members`.
   */
  const memberRows = useMemo<MemberRow[]>(() => {
    const rows: MemberRow[] = (members ?? []).map((member) => ({ ...member, present: true }));
    const known = new Set(rows.map((row) => row.id));
    const remembered = new Set([...curated, ...Object.keys(aliasText).filter((id) => aliasText[id].trim())]);
    for (const id of remembered) {
      if (!known.has(id)) rows.push({ id, name: id, isBot: false, present: false });
    }
    return rows;
  }, [members, curated, aliasText]);

  const toggleCurated = (id: string) => {
    setCurated((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const trimmedName = name.trim();
  const ready = Boolean(trimmedName);

  const settingsInput = (): ProjectSettingsInput => {
    const aliases: Record<string, string[]> = {};
    for (const [id, text] of Object.entries(aliasText)) {
      const list = parseAliases(text);
      if (list.length > 0) aliases[id] = list;
    }
    return {
      name: trimmedName,
      description: description.trim(),
      channels: [...selectedChannels].sort(),
      members: {
        // `curated` is kept even while the toggle is off, so turning it back on
        // does not start from an empty list.
        source: curatedOnly ? 'curated' : 'channels',
        curated: [...curated].sort(),
        aliases,
      },
      scope: { retrieval, updates },
      meetingsFolder: meetingsFolder.trim() || DEFAULT_MEETINGS_FOLDER,
      glossary: glossary.trim() || DEFAULT_GLOSSARY,
    };
  };

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;

    setSaving(true);
    setError(null);
    setTakenChannel(null);
    try {
      const result = await saveProject(workspaceId, folder, settingsInput());
      onClose(result.project);
    } catch (err) {
      setError(describeProjectError(t, err, t('project.error.saveFailed')));
      // The one refusal with somewhere to point: show the manager the channel
      // rather than a sentence about it.
      if (err instanceof ProjectApiError && err.payload.error === 'project_channel_taken') {
        const detail = err.payload.detail;
        const channel = typeof detail === 'object' && detail !== null ? detail.channel : undefined;
        if (typeof channel === 'string') setTakenChannel(channel);
        setTab('channels');
      }
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteProject(workspaceId, folder);
      onClose('deleted');
    } catch (err) {
      setError(describeProjectError(t, err, t('project.error.deleteFailed')));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const panelId = 'project-settings-panel';

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: matches CommitDialog — a native <dialog> would need showModal() */}
      <div className="commit-dialog-backdrop" role="dialog" aria-modal="true" aria-label={t('project.aria.dialog')}>
        <form className="commit-dialog commit-dialog-wide project-dialog" onSubmit={handleSave}>
          <h2 className="commit-dialog-title">{existing ? t('project.title.edit') : t('project.title.new')}</h2>
          <p className="commit-dialog-subtitle">
            {fillNodes(t('project.subtitle'), {
              folder: <code>{folder}</code>,
              file: <code>.choir/project.json</code>,
            })}
          </p>

          <div className="project-tabs" role="tablist" aria-label={t('project.aria.tabs')}>
            {TABS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                id={`project-tab-${entry}`}
                aria-selected={tab === entry}
                aria-controls={panelId}
                className={`project-tab${tab === entry ? ' active' : ''}`}
                onClick={() => setTab(entry)}
              >
                {t(TAB_LABEL[entry])}
              </button>
            ))}
          </div>

          <div className="project-panel" id={panelId} role="tabpanel" aria-labelledby={`project-tab-${tab}`}>
            {tab === 'basic' && (
              <>
                <label className="commit-dialog-label" htmlFor="project-name">
                  {t('project.basic.name.label')}
                </label>
                <input
                  ref={nameRef}
                  id="project-name"
                  className="commit-dialog-input"
                  type="text"
                  autoComplete="off"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
                {!trimmedName && <p className="commit-dialog-error">{t('project.error.nameRequired')}</p>}

                <label className="commit-dialog-label" htmlFor="project-description">
                  {t('project.basic.description.label')}
                </label>
                <textarea
                  id="project-description"
                  className="commit-dialog-input"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={busy}
                />
                <p className="commit-dialog-hint">{t('project.basic.description.hint')}</p>

                <label className="commit-dialog-label" htmlFor="project-meetings">
                  {t('project.basic.meetings.label')}
                </label>
                <input
                  id="project-meetings"
                  className="commit-dialog-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={meetingsFolder}
                  placeholder={DEFAULT_MEETINGS_FOLDER}
                  onChange={(event) => setMeetingsFolder(event.target.value)}
                  disabled={busy}
                />
                <p className="commit-dialog-hint">{t('project.basic.meetings.hint')}</p>
              </>
            )}

            {tab === 'channels' && (
              <>
                {!privateReadable && <p className="commit-dialog-warning">{t('project.channels.privateUnreadable')}</p>}
                <input
                  className="commit-dialog-input"
                  type="search"
                  autoComplete="off"
                  aria-label={t('project.channels.filter.placeholder')}
                  placeholder={t('project.channels.filter.placeholder')}
                  value={channelFilter}
                  onChange={(event) => setChannelFilter(event.target.value)}
                  // Enter in a filter box means "filter", not "commit this file".
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault();
                  }}
                  disabled={busy}
                />
                {channelsError && <p className="commit-dialog-error">{channelsError}</p>}
                {!channels && !channelsError && <p className="commit-dialog-hint">{t('project.channels.loading')}</p>}
                {channels && channels.length === 0 && (
                  <p className="commit-dialog-hint">{t('project.channels.empty')}</p>
                )}
                {channels && channels.length > 0 && visibleChannels.length === 0 && (
                  <p className="commit-dialog-hint">{t('project.channels.noMatch')}</p>
                )}
                {visibleChannels.length > 0 && (
                  <ul className="project-channel-list">
                    {visibleChannels.map((channel) => {
                      const takenBy =
                        channel.linkedFolder && channel.linkedFolder !== folder ? channel.linkedFolder : null;
                      const checked = selectedChannels.includes(channel.id);
                      return (
                        <li
                          key={channel.id}
                          className={`project-channel${takenBy ? ' disabled' : ''}${
                            takenChannel === channel.id ? ' flagged' : ''
                          }`}
                        >
                          <label className="project-channel-main">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy || Boolean(takenBy)}
                              onChange={() => toggleChannel(channel.id)}
                            />
                            <span className="project-channel-name">#{channel.name}</span>
                            {channel.isPrivate && <span className="project-tag">{t('project.channels.private')}</span>}
                            {channel.isArchived && (
                              <span className="project-tag warn">{t('project.channels.archived')}</span>
                            )}
                            {takenBy && (
                              <span className="project-tag">{t('project.channels.linked', { folder: takenBy })}</span>
                            )}
                          </label>
                          {typeof channel.memberCount === 'number' && (
                            <span className="project-channel-count">
                              {t('project.channels.memberCount', { count: channel.memberCount })}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="commit-dialog-hint">
                  {t('project.channels.selected', { count: selectedChannels.length })}
                </p>
              </>
            )}

            {tab === 'members' && (
              <>
                <label className="project-toggle">
                  <input
                    type="checkbox"
                    checked={curatedOnly}
                    onChange={(event) => setCuratedOnly(event.target.checked)}
                    disabled={busy}
                  />
                  <span>{t('project.members.curatedToggle')}</span>
                </label>
                <p className="commit-dialog-hint">{t('project.members.curatedHint')}</p>
                <p className="commit-dialog-hint">{t('project.members.aliases.hint')}</p>

                {membersError && <p className="commit-dialog-error">{membersError}</p>}
                {memberWarnings.map((warning) => (
                  <p className="commit-dialog-warning" key={warning}>
                    {t('project.members.channelWarning', { message: warning })}
                  </p>
                ))}
                {membersLoading && <p className="commit-dialog-hint">{t('project.members.loading')}</p>}
                {!membersLoading && selectedChannels.length === 0 && (
                  <p className="commit-dialog-hint">{t('project.members.noChannels')}</p>
                )}
                {!membersLoading && selectedChannels.length > 0 && memberRows.length === 0 && (
                  <p className="commit-dialog-hint">{t('project.members.empty')}</p>
                )}

                {memberRows.length > 0 && (
                  <ul className="project-member-list">
                    {memberRows.map((row) => (
                      <li className={`project-member${row.present ? '' : ' gone'}`} key={row.id}>
                        {curatedOnly && (
                          <input
                            type="checkbox"
                            className="project-member-check"
                            aria-label={t('project.members.curated.aria', { name: row.name })}
                            checked={curated.includes(row.id)}
                            onChange={() => toggleCurated(row.id)}
                            disabled={busy}
                          />
                        )}
                        {row.avatar ? (
                          <img className="project-member-avatar" src={row.avatar} alt="" />
                        ) : (
                          <span className="project-member-avatar placeholder" aria-hidden="true">
                            {row.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="project-member-identity">
                          <span className="project-member-name">{row.name}</span>
                          <span className="project-member-title">
                            {row.present ? (row.title ?? '') : t('project.members.gone')}
                          </span>
                        </span>
                        <input
                          className="project-member-aliases"
                          type="text"
                          autoComplete="off"
                          aria-label={t('project.members.aliases.aria', { name: row.name })}
                          placeholder={t('project.members.aliases.placeholder')}
                          value={aliasText[row.id] ?? ''}
                          onChange={(event) =>
                            setAliasText((current) => ({ ...current, [row.id]: event.target.value }))
                          }
                          disabled={busy}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {tab === 'scope' && (
              <>
                <span className="commit-dialog-label">{t('project.scope.retrieval.label')}</span>
                {(['boost', 'exclusive', 'off'] as RetrievalScope[]).map((value) => (
                  <label className="project-radio" key={value}>
                    <input
                      type="radio"
                      name="project-retrieval"
                      checked={retrieval === value}
                      onChange={() => setRetrieval(value)}
                      disabled={busy}
                    />
                    <span>
                      <span className="project-radio-title">
                        {value === 'boost'
                          ? t('project.scope.retrieval.boost')
                          : value === 'exclusive'
                            ? t('project.scope.retrieval.exclusive')
                            : t('project.scope.retrieval.off')}
                      </span>
                      <span className="project-radio-hint">
                        {value === 'boost'
                          ? t('project.scope.retrieval.boost.hint')
                          : value === 'exclusive'
                            ? t('project.scope.retrieval.exclusive.hint')
                            : t('project.scope.retrieval.off.hint')}
                      </span>
                    </span>
                  </label>
                ))}

                <span className="commit-dialog-label">{t('project.scope.updates.label')}</span>
                {(['folder', 'workspace'] as UpdateScope[]).map((value) => (
                  <label className="project-radio" key={value}>
                    <input
                      type="radio"
                      name="project-updates"
                      checked={updates === value}
                      onChange={() => setUpdates(value)}
                      disabled={busy}
                    />
                    <span>
                      <span className="project-radio-title">
                        {value === 'folder' ? t('project.scope.updates.folder') : t('project.scope.updates.workspace')}
                      </span>
                      <span className="project-radio-hint">
                        {value === 'folder'
                          ? t('project.scope.updates.folder.hint')
                          : t('project.scope.updates.workspace.hint')}
                      </span>
                    </span>
                  </label>
                ))}
              </>
            )}

            {tab === 'glossary' && (
              <>
                <label className="commit-dialog-label" htmlFor="project-glossary">
                  {t('project.glossary.label')}
                </label>
                <input
                  id="project-glossary"
                  className="commit-dialog-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={glossary}
                  placeholder={DEFAULT_GLOSSARY}
                  onChange={(event) => setGlossary(event.target.value)}
                  disabled={busy}
                />
                <p className="commit-dialog-hint">
                  {fillNodes(t('project.glossary.hint'), {
                    path: <code>{`${folder}/${glossary.trim() || DEFAULT_GLOSSARY}`}</code>,
                  })}
                </p>
                {glossaryStatusLoading && <p className="commit-dialog-hint">{t('glossaryBuilder.status.loading')}</p>}
                {!glossaryStatusLoading && glossaryStatus && (
                  <p className="commit-dialog-hint">
                    {glossaryStatus.files.length === 0
                      ? t('glossaryBuilder.status.none')
                      : t('glossaryBuilder.status.chain', {
                          files: glossaryStatus.files.join(', '),
                          count: glossaryStatus.entries,
                        })}
                  </p>
                )}
                <button
                  type="button"
                  className="doc-button doc-button-ghost project-glossary-build"
                  onClick={() => setGlossaryBuilderOpen(true)}
                  disabled={busy}
                >
                  {t('project.glossary.build')}
                </button>
                <p className="commit-dialog-hint">{t('project.glossary.build.hint')}</p>
              </>
            )}
          </div>

          {/* Already in the reader's language: every failure above runs the
            server's code through `describeServerError` first. */}
          {error && <p className="commit-dialog-error">{error}</p>}

          <div className="commit-dialog-actions">
            {confirmingDelete ? (
              <>
                <span className="project-delete-confirm">{t('project.delete.confirm')}</span>
                <button
                  type="button"
                  className="doc-button doc-button-ghost"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={busy}
                >
                  {t('common.button.cancel')}
                </button>
                <button type="button" className="doc-button doc-button-danger" onClick={handleDelete} disabled={busy}>
                  {deleting ? t('project.button.deleting') : t('project.button.deleteConfirm')}
                </button>
              </>
            ) : (
              <>
                {existing && (
                  <button
                    type="button"
                    className="doc-button doc-button-ghost project-delete-button"
                    onClick={() => setConfirmingDelete(true)}
                    disabled={busy}
                  >
                    {t('project.button.delete')}
                  </button>
                )}
                <button type="button" className="doc-button doc-button-ghost" onClick={() => onClose()} disabled={busy}>
                  {t('common.button.cancel')}
                </button>
                <button type="submit" className="doc-button doc-button-primary" disabled={busy || !ready}>
                  {saving
                    ? existing
                      ? t('project.button.saving')
                      : t('project.button.creating')
                    : existing
                      ? t('project.button.save')
                      : t('project.button.create')}
                </button>
              </>
            )}
          </div>
        </form>
      </div>
      {/* A sibling rather than a child: this dialog is a <form>, and a form
          inside a form is not markup a browser will honour. */}
      {glossaryBuilderOpen && (
        <GlossaryBuilderDialog
          workspaceId={workspaceId}
          folder={folder}
          onClose={() => setGlossaryBuilderOpen(false)}
        />
      )}
    </>
  );
}
