# App Home

How the Slack Home tab is laid out, who sees what, and the rules that keep it
short. Code: `listeners/features/app-home/home-view-builder.ts` (blocks),
`home-tabs.ts` (which tab a person is on),
`management/tab-handlers.ts` (the `home_tab:` buttons), `refresh.ts`
(re-publish).

## Why it looks the way it does

The first version stacked every setting on one page: thirteen sections, each
with a header, a paragraph of explanation, a green button and a divider. A
manager scrolled through AI keys and encryption warnings to reach the Q&A
channel picker, and a regular member saw the same chrome with most of it
missing. The redesign rests on four rules:

1. **One page per job.** Everything a *member* needs fits on the Home tab
   without scrolling. Manager settings are split across three more tabs by
   what they are about, not by when they were added.
2. **A row per setting, not a section.** Each setting is one `section` block
   with a bold label, a one-line status, and a single accessory control
   (button or select). No `header` blocks inside a tab, no divider between
   rows, explanations live in the modal the row opens.
3. **One green button per tab.** `primary` marks the one thing to do next:
   *Start chatting* on Home, or — while setup is incomplete — the first
   unfinished step's *Connect GitHub* / *Choose repository*, which takes the
   green from *Start chatting* rather than sitting beside it. Team and
   Advanced have no green button at all. `danger` is reserved for destructive
   actions (disconnect, rotate key, clear settings). Everything else is
   default. The tab bar's active-tab marker is chrome and does not count
   against this.
4. **Status is a glyph, not a sentence.** `✅` / `❌` / `🟡` prefix the status
   text; the label says what the setting is, the status says where it stands.

## Tabs

The tab bar is an `actions` block of buttons at the top of the view. The
active tab's button is `primary`; the others are unstyled. Members see no bar
at all, since Home is their only tab. Tab buttons carry `action_id`
`home_tab:<tab>` and are handled by one regex listener that records the choice
and re-publishes the view.

The active tab is remembered **per user, in memory** (`home-tabs.ts`, a
`Map` keyed by `workspaceId:userId`). It survives modal round-trips — every
`refreshAppHome*` call rebuilds the tab the person was on — and resets to Home
when the process restarts, which is fine for a navigation preference. A stored
manager-only tab falls back to Home if the person is no longer a manager.

Only the active tab's blocks are built, so a tab costs only its own lookups
(Team no longer pays `users.info` per manager just to render Advanced).

### 🏠 Home — everyone

```
*Welcome, @user* 👋                                         ← one section: greeting line + intro line
CHOIR answers questions from your team's docs and turns Slack conversations into document updates.
[💬 Start chatting]  [📊 Team Insights]          ← primary · url button, CHOIR users only when DOCS_BASE_URL is set
─────
*Your language*  The language CHOIR uses with you.        [ Automatic ▾ ]
```

Managers get a **Setup** card under that. When everything is configured it is
one four-line section, no buttons:

```
─────
*Setup*
✅ GitHub account · woogler
✅ Repository · echo-lab/assets
✅ Q&A channel · #_echolab-2026-fall
✅ 6 CHOIR users · 2 managers
```

Any line that is *not* configured becomes its own row with the control that
fixes it as the accessory — `Connect GitHub` (primary), `Choose repository`
(primary), or the Q&A `channels_select`. Configured lines stay collapsed into
the summary section above the fixes. A Q&A channel CHOIR can no longer read
counts as unconfigured here, since the fix is the same picker.

The repository is workspace-wide while the GitHub account is the viewer's own,
so a repository another manager connected shows as done for everyone. Choosing
one needs the viewer's token, so that fix row only appears once *their* GitHub
is connected; before that the GitHub row already says "connect it to pick a
repository".

Members (non-managers) instead get one row:

```
─────
🔒 Need manager access? Ask your workspace admin.        [ Manager access ]
```

The button opens the password-promotion modal, which can only succeed when
`MANAGER_PROMOTION_PASSWORD` is set. Without it the row keeps the hint and
drops the button rather than offer a dead end.

### 📁 Documents — managers

```
*GitHub account*  ✅ woogler · connected 8/30/2026                [ Disconnect ]   ← danger, keeps confirm
                  ❌ Not connected · connect to pick a repository  [ Connect GitHub ] ← primary
*Repository*      ✅ echo-lab/assets (link)                        [ Change ]        ← Change only once the viewer's GitHub is connected
                  ❌ None · choose the repository CHOIR reads      [ Choose repository ] ← primary; row hidden until the viewer's GitHub is connected
*Read-only files* 0 of 23 files are excluded from updates          [ Manage ]
                  context: current list, at most 5 names then "and N more"
                  no repo → "Connect a repository first", no button
                  files not cached yet → "Loading files from GitHub…", no button
*Document language*  Language CHOIR writes new content in           [ Follow the conversation ▾ ]
─────
*Index maintenance*  Run after editing markdown files or when answers look stale.
[Reload from GitHub] [Normalize Markdown] [Rebuild QMD Index]      ← default style, existing confirms
```

Index maintenance only appears when a repository is connected.

The button labels in these sketches are abbreviated. On screen they keep the
catalog wording they already had (`Connect GitHub Account`, `Browse My
Repositories`, `Disconnect GitHub`, `Manage Read-Only Files`, `Manage
Managers`, `Edit Organization Name`, …); only genuinely new controls — the tab
buttons and the repository row's `Change` — needed new strings.

### 👥 Team — managers

```
*Managers* (2)  @Sang, @Sangwook Lee                              [ Manage ]
*CHOIR users*   6 registered                                      [ Manage ]
*Q&A channel*   ✅ #_echolab-2026-fall                            [ #channel ▾ ]
                ❌ Not set · "Ask to Channel" is disabled until you pick one
                ⚠️ The saved channel is gone · pick another one
*Organization*  echolab                                           [ Edit ]
*Workspace language*  Default for members with no preference      [ English ▾ ]
```

Managers are rendered as plain `<@U…>` mentions — Slack shows the display name,
so the `users.info` lookup per manager and the `(Real Name)` suffix are gone.

### ⚙️ Advanced — managers

```
*AI models*  Key: server default · Q&A: server default · Updates: server default   [ Configure ]
context: Classification model: gpt-5.4-nano-2026-03-17 (fixed)
[Clear settings]                                              ← danger + confirm, only when a workspace key is set
─────
*Change history encryption*  ✅ Key configured · created 2026-01-02 · rotated 2026-03-04   [ Import key ]
                             🟡 Not yet generated · created on the first recorded change
[Back up key] [Rotate key]                                    ← only when configured; Rotate is danger
context: ⚠️ Rotating or importing a key makes earlier change history unreadable. Back up first.   ← only when configured
─────
*Interaction logging*  ✅ Enabled · saved to log files for research      [ Disable ] / [ Enable ]
*Download logs*                                               [Today's logs] [All logs]
```

## Block Kit constraints that shaped this

- A `section` takes one accessory. Rows that need two buttons (back up +
  rotate, the three index jobs, the two downloads) use an `actions` block
  directly under the row.
- `action_id`s must be unique within a block, hence `home_tab:home`,
  `home_tab:documents`, … rather than one id with different values.
- Button labels ≤ 75 characters, header ≤ 150, a home view ≤ 100 blocks. The
  catalog test measures the Korean rendering of every capped field.
- Slack Home does not auto-refresh: any handler that changes a setting calls
  `refreshAppHomeSoon`, which republishes the tab the person is on. The tab
  buttons call `refreshAppHome` directly instead — nothing is closing over
  them, and a tab that takes a second to switch feels broken.

## Strings

All copy goes through `src/i18n/locales/{en,ko}/app-home.ts`. A row's own copy
— its bold label and one-line status — is named after the tab it sits on,
`appHome.<tab>.<row>.<element>`, and the tab labels are `appHome.tabs.<tab>`.
Button labels and confirm dialogs keep their older action-shaped keys
(`appHome.documentConnection.reload.*`, `appHome.contextKey.rotate.button`, …):
they describe the *action*, which is the same wherever it is rendered.
Explanatory paragraphs that used to sit under headers were dropped, not
translated — the modal each row opens already explains itself. See
[i18n.md](i18n.md) for the catalog rules.
