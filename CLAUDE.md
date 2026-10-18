# CLAUDE.md

## Project Overview

Code Crumb is a zero-dependency terminal tamagotchi that visualizes what AI coding assistants are doing in real time. It renders an animated ASCII face that reacts to lifecycle events (thinking, coding, reading, executing, errors, etc.) via hooks, adapters, and file-based IPC. It supports **Claude Code**, **OpenAI Codex CLI**, **OpenCode**, **OpenClaw/Pi**, and any tool that can pipe JSON events.

This file states the rules. The stories behind them, meaning how each bug showed itself before its rule existed, are in `CHANGELOG.md` under "Why the rules are what they are".

### Interactive Keybindings

| Key | Action |
|-----|--------|
| `space` | Pet the face (sparkle particles + wiggle) |
| `t` | Cycle color palette (default/neon/pastel/mono/sunset/highcontrast); no-op under `NO_COLOR` |
| `s` | Toggle stats (streak, timeline, sparkline) |
| `a` | Toggle accessories (hats, ears, etc.) |
| `o` | Toggle orbital subagents |
| `l` | Open session list |
| `↑↓` / `j/k` | Navigate session list |
| `Enter` | On the main row: pin / unpin it. On any other row: pin and promote it to the center |
| `h` / `?` | Toggle help overlay |
| `q` / Ctrl+C | Quit |

- **Any key closes** the help overlay or the session list, so `h`/`?` is not a strict toggle once open.
- **The session list selects by session id**, not row index. Only live rows are selectable (see Main Session Policy).
- **Minimal mode** (`--minimal` / `MINIMAL_BOOT=1`) disables every key except `space` and `q`.
- **Key splitting.** Each stdin chunk is split into keys by `splitKeys` (renderer.js, pure: a CSI/SS3 sequence stays whole, anything else is one code point). Each key is handled on its own, so a held arrow or a fast `qq` works.

### Color Palettes

Six palettes: **default**, **neon**, **pastel**, **mono**, **sunset** and **highcontrast** (accessibility). Press `t` to cycle.

All togglable preferences (theme, accessories, stats, orbitals) persist via `~/.code-crumb-prefs.json`. Indicators below the face box show `● accs` / `○ accs` and `● subs` / `○ subs`.

## Tech Stack

- **Runtime**: Node.js 18+ (no npm dependencies)
- **Language**: JavaScript (ES6+, CommonJS modules, strict mode)
- **Platforms**: Windows, macOS, Linux
- **Terminal features**: 24-bit ANSI RGB color, Unicode box-drawing characters, cursor positioning

## File Structure

The root holds only what is run **by path**: the four entry points and the two shell wrappers. Installed hooks (`~/.claude/settings.json`, the plugin's `hooks/hooks.json`, `~/.codex/hooks.json`), PATH symlinks to `code-crumb.sh` and every `node setup.js` in the docs point at them, so **never move a root entry point**.

Everything else lives in a folder. This document names modules bare (`grid.js`, `shared.js`); unless a module is one of the four entry points, it is in `lib/`.

```
renderer.js      Entry point: runtime loop, PID guard, state polling, re-exports for tests; runUnifiedMode(opts) is the test seam
update-state.js  Hook handler: editor events via stdin → state files; takes `[--editor <name>] <Event>`
launch.js        Opens the renderer, then starts and supervises the editor (--editor <name> / --editor=<name>); package.json `bin`
setup.js         setup.js [claude|codex|codex-notify|opencode|openclaw|uninstall|doctor] [--autolaunch]; opencode also --install/--uninstall.
                 `uninstall` removes the Claude Code hooks, the Codex hooks file and a Code Crumb notify line in Codex's config.toml.
                 A second command word is a usage error (exit 1, no changes): `codex uninstall` used to install.
                 Exports each editor's setup/uninstall, buildFaceHooks, buildCodexHooks, setupCodexNotify/removeCodexNotify, codexHome,
                 claudeConfigDir/claudeSettingsPath, opencodeConfigDir/opencodeConfigPath, enableAutolaunch, doctor, HOOK_EVENTS,
                 CODEX_HOOK_EVENTS, printClaudeUsage
                 (its demo hint prints only when demo/single.js exists; the npm tarball omits it)
code-crumb.sh    Unix shell wrapper for launch.js (resolves its own symlink; ignores an exported CDPATH)
code-crumb.cmd   Windows batch wrapper for launch.js (runs `node.exe`, never a bare `node` cmd.exe would find in the project folder first)
lib/
  themes.js        ANSI codes, color math, theme definitions, thought bubble data
  animations.js    Eye and mouth animation functions (full-size and grid)
  particles.js     ParticleSystem: 16 visual effect styles (incl. stream, fire, bigquestion)
  face.js          ClaudeFace: main face state machine and rendering; monoNow/_setClock (the face clock), cleanMilestone
  grid.js          MiniFace + OrbitalSystem: orbitals, session loading, PID liveness, the session list
  transition.js    SwapTransition: dissolve/swap/materialize animation state machine
  accessories.js   Accessory definitions (hats, glasses, ears, etc.) and rendering helpers
  state-machine.js Pure logic: tool→state mapping, result classification, diff counting, streaks, stats helpers
  shared.js        Paths, face state sets, PERMISSION_CONFIRM_MS/PERMISSION_TOOL_STATES, prefs, writeJsonAtomic, spawn/stats locks, shell quoting,
                   buildRendererCommands/spawnRendererWindow, isRendererAlive, display width (charWidth/strWidth/sliceToWidth/sliceFromEndToWidth)
adapters/
  base-adapter.js      Base adapter class shared by all adapters
  codex-wrapper.js     Wraps `codex exec --json` (the real ThreadEvent schema) for tool-level events; headless runs only
  codex-notify.js      Codex's legacy turn-level `notify` channel
  opencode-plugin.mjs  The shipped OpenCode plugin (ESM, run by OpenCode's Bun); pure `translate()`/`takeBatch()` ride on the factory
  opencode-adapter.js  OpenCode plugin events (stdin JSON)
  openclaw-adapter.js  OpenClaw/Pi agent events (stdin JSON)
  engmux-adapter.js    engmux dispatcher events; `extractModel`/`extractEngine` importable behind `require.main === module`. Its orbital's parent is
                       `CLAUDE_SESSION_ID || CLAUDE_CODE_SESSION_ID || ppid` (Claude Code exports CLAUDE_CODE_SESSION_ID to tools, never CLAUDE_SESSION_ID)
demo/single.js     `npm run demo`: cycles all face states; writes a `demo-main` session file (with `lastPromptAt`) so the policy picks it,
                   unlinked on exit and on SIGINT, SIGTERM and SIGHUP
demo/orbital.js    `npm run demo:orbital`: subagents orbiting the main face; same `demo-main` file plus its children
tests/run.js       `npm test`: runs the 17 test files, in parallel child processes by default, each with its own throwaway home
tests/_harness.js  describe/test runner, temp-home and subprocess helpers; refuses to run outside tests/run.js
tests/test-*.js    shared, state-machine, themes, animations, particles, face, grid, accessories, teams, launch, adapters,
                   transition, emotions, platform, subagents, attention, release
hooks/hooks.json   Claude Code plugin hooks (23 events; PreToolUse/PostToolUse/PostToolUseFailure are "async": true)
.claude-plugin/    plugin.json (manifest) and marketplace.json (source "." so the plugin cache holds the whole repo; it has no version)
plugin.json        Byte-identical copy of .claude-plugin/plugin.json (the plugin cache reads it here); keep both in sync
images/            README screenshots (only referenced images are kept)
.github/workflows/test.yml  CI: node --check over *.js/*.mjs, the trailing-whitespace gate (js/mjs/md/json/yml), the suite on ubuntu/windows/macos × node 18/20/22
AGENTS.md          Stub pointing agents at this file (a second copy drifted; do not resurrect it)
CHANGELOG.md       Release history, review-pass narratives, and the reasons behind this file's rules
README.md, LICENSE
package.json       "files": the four entry points, lib/, adapters/, hooks/, the wrappers, README.md, CHANGELOG.md, LICENSE
```

**Releases.** Bump `package.json` and both `plugin.json` copies together; Claude Code keeps a cached plugin until its version string changes. Add a `CHANGELOG.md` entry. test-release checks that the versions agree, that the two manifests are identical, and that every file the entry points require is covered by `"files"`.

## Architecture

### Event Flow

```
Claude Code hook  ─┐
Codex native hook ─┴→ update-state.js (--editor <name>)  ─┐
OpenCode          ──→ opencode-plugin.mjs → opencode-adapter.js  ─┤
OpenClaw / engmux ──→ adapters/*.js                              ─┴→ Session files (JSON) → renderer.js (fs.watch) → Terminal Output
                                                                    (+ the global state file, for tmux mode and external readers)
```

Claude Code and Codex CLI share **one** hook handler. Codex's native hooks (`~/.codex/hooks.json`) send Claude-Code-shaped payloads, so `node setup.js codex` registers `update-state.js` with `--editor codex` on every command.

- **`editor`** resolves as `CODE_CRUMB_EDITOR` env, then `--editor`, then `claude`.
- **`modelName`** defaults to the editor ("codex is coding").
- **The event name** falls back to the payload's `hook_event_name` when no event positional is given.

### File-Based IPC

#### `~/.code-crumb-state`

The global state file. **The unified renderer does not read it**: the main face follows the chosen session's own file.

- **Who writes it.** Only the *owning* top-level session. `shouldWriteGlobal` is cleared when the file names a different live, unstopped session under 120s old. Every `SessionStart` force-takes ownership.
- **Who reads it.** tmux mode (`readState()` with no argument) and external readers. Ownership and attention are decided separately, so it can report a different session than the center face.

#### `~/.code-crumb-sessions/{session_id}.json`

Per-session state for **every** session: subagents, parallel windows, and the main. A Claude Code subagent's file is `{parentSession}-agent-{agentId}.json`.

- **Sticky fields** are set once and kept: `taskDescription`, `parentSession`, `agentType`, `editor`, `model`, `lastPromptAt`, `firstSeenAt`, and the team fields.
- **Per-write extras:**
  - the ordering fields `eventAt`/`syncAt`/`syncEvent`/`doneToolIds`, on the session file only;
  - the wait fields `waitingOn`/`waitKind`/`waitConfirmed`/`permState`/`permDetail`/`waitAskedAt`, plus `waitForAgents`/`waitPrev`;
  - an adapter's `turnError`;
  - OpenCode's `endSeq`/`pluginId`.
- **`SessionStart`** writes a file too (`isSessionStart: true`), so a fresh window can take the center before its first tool call. It unlinks a stale predecessor first, **except** for `source === 'compact'`. That is the same live session, which keeps its sticky fields and `stats.session` (counters, clock, `activeSubagents`); every other source resets them.

#### The turn-end contract

A non-agent `Stop` writes `idle` / `between turns` with `turnEnded: true` and **no** `stopped`: the session is between turns, not over.

- **Carrying the turn end.** Every event outside `TURN_OPENING_EVENTS` (PreToolUse, UserPromptSubmit, SessionStart, SubagentStart, PreCompact, Setup, PostModelSwitch) carries the turn end forward, along with the global file's `stopped` (`carriesTurnEnd`).
- **Which flag is carried** (`inheritedTurnEnd`):
  - A reward or an error (`TURN_END_SAFE_STATES`) carries `turnEnded`.
  - Any other face carries `turnOver`. The renderer folds `turnEnded` into `stopped` and rescues faces outside `RESCUE_EXCLUDE` to "wrapping up", so a non-reward echo would replay the turn-end celebration.
  - `turnOver` means "not active" (the short idle timeout) but is never rescued. The next echo with a reward or an error turns it back into `turnEnded`.
- **`AMBIENT_EVENTS`** (`PreCompact`, `PostModelSwitch`, `SessionStart`, `Setup`) also happen *between* turns: a `/compact`, a `/model`, or a subagent's auto-compaction sent with the parent's `session_id` and no `agent_id`. After a finished turn they carry `turnOver` instead of clearing it, and all but `SessionStart` re-stamp the global `stopped`. A mid-turn compaction is live work.
- **Failed and interrupted turns.** `StopFailure` fires instead of `Stop` and follows the same contract with an `error` face. So does Codex's `Interrupt` (Esc, which runs no `Stop`), as `error` / `interrupted`, without breaking the streak. An agent's `StopFailure` writes the parent's file but ends nothing there: it is an echo (`closesTurn`) and carries the turn end.
- **`stopped` on a session file is reserved for `SessionEnd`.** A turn-end `stopped` there would retire a live window in the orbital loader. Once set, every event that carries the turn end keeps it, on both paths (`echoesTurnEnd`: `carriesTurnEnd`, plus the ambient events except `SessionStart`), so a late SubagentStop or TaskCompleted cannot bring an ended window back as a candidate.
  - The owner's late `PostToolUse` carries `turnEnded`, like a parallel window's.
  - The global file's `stopped` re-stamp uses a separate `globalStopped` flag, set from the global file's own `stopped` for this session or from the session file's `stopped`/`turnEnded`/`turnOver` (a between-turns wait clears the global one).
  - The renderer folds `stopped || turnEnded` for the face.

#### `~/.code-crumb-stats.json`

Persistent stats.

- **`normalizeStats`** repairs whatever it reads:
  - Every field keeps its default's type.
  - The id- and filename-keyed maps (`sessionCounters`, `frequentFiles`, `topLevelSessions`) have no prototype, so `__proto__` or `toString` is an ordinary key.
- **`sessionCounters`** maps a session id to `{toolCalls, filesEdited, start, commitCount, creditedMs, lastSeen, countedDay}`.
  - Entries last 24h. The map holds 50 entries of up to 200 files each.
  - Over the cap, throwaway entries (≤1 tool call) go first, and entries holding parked agents are never evicted.
  - The helpers (`freshCounter`/`normalizeCounter`/`parkAgents`/`unparkAgents`/`pruneCounters`/`firstSeenFor`) live in state-machine.js and are shared with base-adapter.js.
- **Counting rules:**
  - Files report the writer's own counters.
  - `stats.session` mirrors its owner's entry, and an ownership switch restores counters rather than zeroing them.
  - `daily.sessionCount` counts once per id per day (`countedDay`; a legacy `counted: true` reads as today).
  - `creditedMs` stops time being added to `cumulativeMs` twice; adapters subtract it too.
- **Parked agents.** An ownership switch **parks** the outgoing owner's `activeSubagents`/`subagentCount` on its counter (`_parkAgents`, ≤32, stored only when non-empty) and restores the incoming one's (`_unparkAgents`). This is needed because a parallel window's lifecycle event skips the classifier and takes `stats.session`.
- **Session time** is credited by `creditSession` (shared with adapters) at a turn or session end.
  - An outgoing owner is credited only up to its own last activity (`creditEndFor` → `min(now, lastSeen)`).
  - Adapter and Codex sessions credit themselves at a turn end (`creditOwnerSession`) and count their commits.
  - "Today" is the **local** day (`localDay`).
  - Idle gaps over `IDLE_GAP_MS` (2h) are not session time.
- **Pruning.**
  - `pruneCounters(map, keepIds, now)` never evicts the running hook's session.
  - `pruneFrequentFiles(ff, keep)`, over its 50-entry cap, ages every other entry by one and never cuts the file just touched.
  - A parallel window's edits count in the lifetime totals while the owner conducts.

#### Small files

- **`~/.code-crumb-prefs.json`** holds the persisted preferences.
- **`~/.code-crumb.pid`** is touched by the renderer every `PID_HEARTBEAT_MS` (10s).
  - `isRendererAlive(pidFile, now, platform)` (shared.js) is the one liveness check, used by the hook, `launch.js` and the renderer's start-up guard. A pid ≤ 0 is garbage (`kill(0)` signals our own group). `EPERM` counts as alive only while the file is fresh. A signalable pid is alive, except on win32 when the file is older than `PID_STALE_MS` (60s), since a logoff sends no signal. POSIX trusts a signalable pid because the heartbeat timer stops during a suspend.
  - `spawnRendererWindow` (autolaunch and `launch.js`) opens the window with `process.execPath`, from `HOME`, through an absolute `cmd.exe` (`ComSpec`) and System32's `where.exe`. A hook's cwd is the user's project, and cmd.exe searches it before PATH, so a project's `where.bat`, `wt.cmd`, `node.cmd` or `node.js` (PATHEXT has `.JS`) would run instead. `buildRendererCommands(platform, args, title, { nodeBin, cwd, cmdExe })` takes the same three.
- **`~/.code-crumb-spawn.lock`** lets exactly one of the parallel hooks that notice a dead renderer open a terminal (`acquireSpawnLock`, O_EXCL, 5s staleness).
  - Nothing deletes it, so later launches are stale takeovers. Those are exclusive too: only the hook that creates `<lock>.claim` (O_EXCL) may overwrite the lock, and only while it is still the stale lock it saw.
  - A dead hook's claim is cleared once stale.
  - A lock or claim further in the future than its stale bound is stale (`lockIsStale`: |now − mtime| > staleMs), so a clock stepped back cannot block autolaunch (or the stats lock) until it catches up; a little ahead is clock skew and still held. `isRendererAlive` keeps `now − mtime`: a live renderer's pid file is future-dated for up to 10 s after a backward step, and judging that dead would open a second renderer.
- **`~/.code-crumb-quit`** is written on every normal renderer exit, never by the crash handler. While it exists, autolaunch launches nothing.
  - A `SessionStart` from `EDITOR_START_SOURCES` (`startup`, `resume`, `fork`) clears it, and so does `setup.js --autolaunch`.
  - `/clear` and compaction do not.
- **`~/.code-crumb-stats.lock`** serializes the stats read-modify-write, so no increment is lost. The main hook path, `writeFallback` and the adapters all take it.
  - `acquireFileLock` uses O_EXCL with `LOCK_WAIT_MS` and `LOCK_STALE_MS`.
  - A stale takeover renames the old lock aside (atomic, so exactly one waiter moves it). It re-checks what it moved, restores it if it was a fresh live lock, and retries.
  - `EPERM`/`EACCES`/`EBUSY` on create count as held (`LOCK_HELD_CODES`): on Windows a lock being unlinked is delete-pending and fails `EPERM`.
  - A hook that cannot get the lock in time proceeds unlocked. The lock never stalls the editor.

Every state, session, stats and prefs write goes through `writeJsonAtomic` (temp file + rename, direct-write fallback), so the renderer never reads a half-written file.

- **Rename retries.** A rename refused with `EPERM`/`EACCES`/`EBUSY` (a Windows scanner or another hook holding the target) is retried 3 times, 2ms apart, before the direct write.
- **Birthtime.** The rename resets a file's birthtime on every write, which is why classification reads `firstSeenAt` instead.
- **Symlinks.** A symlinked target is followed (`writeTarget`, dangling included) and the temp file goes beside the real file, so a dotfile manager's link (stow, chezmoi, home-manager) survives instead of being replaced by a regular file.

#### Editor PID Liveness

**Who writes a `pid`:**

- Per-event hook processes write their `process.ppid` (codex-notify; update-state.js on Unix).
- Long-lived wrappers (codex-wrapper) write their own PID.
- **On win32, update-state.js and the adapters (`pidField()`) write no `pid`**: the hook's ppid there is a transient `cmd.exe` shim. Those sessions rely on staleness (`ORPHAN_TIMEOUT`/`STALE_MS`).

**PID liveness is identity-checked.** `isOwnedByLiveProcess(pid, lastWriteMs)` (grid.js) lets a PID protect a session only if the process's **start time predates the session's last write** (+`SLACK_MS`). A recycled PID always fails this.

- **The start-time cache.** Start times resolve asynchronously: batched PowerShell on Windows, `/proc` on Linux, `ps` on macOS, one exec at a time. Entries last `PID_CACHE_TTL_MS` (60s). An entry whose `resolvedAt` lies in the future (a clock stepped back) has no age (`_entryAge`): it counts as expired, past its pending window, and sweepable. An expired entry keeps its value under a `refreshing` marker while it re-resolves.
- **Cache values** are an epoch, `'pending'`, `'dead'`, `'unknown-alive'` or `'unknown-nodata'`.
  - `'pending'` protects for `PID_PENDING_PROTECT_MS` (30s), then falls back to the cap.
  - `'dead'` means the resolver could not find the pid. It is not owned until the TTL, then refreshed once. (Deleting it instead read as pending forever.)
  - Unreadable start times (Access-Denied) or no exec capability protect up to `PID_PROTECT_CAP_MS` (1h) past the last write.
- **win32 pids that are not a multiple of 4 are never alive** (`pidAddressable`, in `isProcessAlive` and `validPid`). Windows ignores a pid's low two bits, so `kill(0)` would alias them.
- **Children.** All protection goes through `pidProtects(pid, lastWriteMs, isChild)`. A **child**'s pid is its parent's editor, so it protects for at most `CHILD_ORPHAN_TIMEOUT` past the child's last write.
- **Test seams.**
  - `_setPidResolver(fn)` swaps the resolver. Resetting it clears the in-flight latch and queue, because `--serial` runs many files in one process.
  - `OrbitalSystem._sessionsDir` (null in production) points the loaders at a temp home.

**Hostile files.** Any adapter writes session files (README documents `model_name` as free-form), so neither reader trusts them.

- **Text and states.** `MiniFace.updateFromFile` and `readState` keep only one-line strings (`detailText` strips C0/C1 controls). An unknown state, or an inherited name like `__proto__`, reads as `idle` (`knownState`/`STATE_NAMES`). An object `session_id` falls back to the file name (`sessionIdOf`).
- **Failed reads.** `readState` returns `failed: true` for a missing, empty, torn or unreadable file, or for non-object JSON. `checkState` then throws before touching `lastMtime` or the trackers, and tmux mode keeps its last line.
- **Sanitising.** `readState` also cleans counters (finite or 0), `frequentFiles` (clean keys, no prototype, ≤200), `milestone` (`cleanMilestone`), `diffInfo` (non-negative ints or null), `pid` (int > 0 or 0) and `waitConfirmed` (bool or null).
- **Guards.** The boot `loadSessions` and the per-frame `orbital.update` are guarded.
- **Paths.** On win32, `_truncatePath`'s `~` match is case-insensitive.
- **Labels.** `_assignLabels` counts folder names in a prototype-less map, so a folder named `constructor` or `__proto__` still labels its face.

**The orbital loader.** `loadSessions` (sync, at boot) and `loadSessionsAsync` (every `SESSION_POLL_MS`) build the same per-file records. `_applySessionResults` makes every purge and face decision.

- **Records.** Each file is read once, then stat'ed after the read (`sessionRecord`/`readSessionRecordSync`), giving a `data`, `empty` or `error` record. An unreadable file has no mtime and is never purged that pass.
- **Parent freshness** is the parent file's mtime (≤ `STALE_MS` old). A parent unreadable this pass keeps the mtime it was last judged at (`_lastMtimes`); the unreadable record itself is still never purged.
- **Junk** is a file that is empty, unparseable or not an object. Junk older than `STALE_MS` is purged, unless it is the main's file or a live face vouches for it (`_vouchedFor`). Fresh junk is a write in progress and keeps the existing face.
- **Ordering.** An async pass that started before a sync load is discarded (`_syncLoads`). A future mtime is dated from first sight (`_judgedMtime`).
- **`MiniFace.updateFromFile`:**
  - skips writes that are not `isNewerWrite`;
  - caps `lastUpdate` at now, and `_clampClock` pulls a future `lastUpdate`/`stoppedAt` back;
  - treats a write without `parentSession` as healing a falsely stamped window;
  - clears `isTeammate`/`teammateName`/`teamName`/`teamColor` on a write without `isTeammate`. Team fields are sticky on a real teammate, so their absence is a heal.

**A crashed editor** is caught by an armed PID.

- **Arming.** A candidate PID is **armed** once it is still alive 2.5s (monotonic, `candidateSince`) after first being seen, and its start time predates the reporting write. Arming defers while resolution is pending.
- **Death.** When an armed PID dies without a Stop, a sticky `editorDead` starts the rescue cascade (responding → happy → idle) and allows another session to be adopted.
- **Recovery.** A write newer than anything applied clears a false `editorDead`. A newer write reporting a *different* pid (the same id resumed under a new editor) retires the armed PID at once.
- **Dead sessions.** `markMainDead()` records the death in `deadSessions` (id → write timestamp), because `adoptMain` must clear `editorDead`. `policySessions` (pure, exported) projects those ids as `stopped` until they write something newer, and prunes vanished ones.
- **Turn ends.** The death check is skipped while `lastStopped` is set, and that includes a plain turn end, because `readState` folds `turnEnded` into `stopped`. An editor that dies between turns is therefore demoted by staleness: a session waiting for a prompt looks exactly like a closed window.

#### Main Session Policy

`pickMainSession({ sessions, currentId, pinnedId })` → `{ mainId, pinnedId }` (renderer.js; pure, exported, table-tested) picks the session the center face follows. Each session is `{ id, parentSession, isTeammate, stopped, stale, attentionAt, lastUpdate }`, projected by `policySessions`.

- **Candidates** are the *live top-level* sessions: no `parentSession`, not a teammate, not `stopped`, not `isStale()`.
  - On win32, with no `pid`, "live" is purely the 90s `ORPHAN_TIMEOUT` write-silence bound. A session on a permission prompt longer than that hands the center to a working window, even though its `waiting` hold lasts 30 minutes. One clock asks "is it alive?", the other "how long do we show the wait?", and only the first decides the center.
- **`isStale()`'s 10s completion cut** (`STOPPED_LINGER_MS`) applies only to a **child whose parent is no longer fresh**. Faces are built and judged in one loader pass before any `tick()`, so a wider rule would kill live windows and children at boot over a stale reward write.
- **The main session's file is never unlinked** by either stale purge. On win32 its `MiniFace` goes stale 30s before the purge.
- **A top-level file naming no `pid`** (win32) is kept `NO_PID_FILE_KEEP_MS` (30 min, the renderer's `WAIT_HOLD_STALE_MS`) after its last write instead of `STALE_MS`, so a long tool cannot cost a window its `lastPromptAt`/`firstSeenAt` (an adapter finding no file stamped a fresh `lastPromptAt` and took the center). Its face still goes stale at `ORPHAN_TIMEOUT`. A positive-integer pid is judged by liveness as before.
- **A live pin wins**, even a promoted child. The pin is released (`pinnedId: null`) once its session is stopped, stale or gone.
- **Otherwise attention wins:** the highest `lastPromptAt` (`attentionAt`), meaning when the user last addressed the session.
- **Ties keep the current main.** On the first pick, the newest write (`lastUpdate`) breaks a tie.
- **No live candidate keeps the current main**, which decays through its `idleCascade`.

**`applyMainPolicy()`** runs at the top of `checkState()`.

- It has its own `try { } catch {}`, because a throw there would take the render loop down. It returns early while a swap animates.
- The **first** pick is silent (`adoptMain` directly). Later changes animate through `SwapTransition`, whose `swap` frame calls `_executeSwap` → `adoptMain`.
- The swap is **not** chrome: minimal mode runs the transition and dim pass too, drawing no ring or list.

**`adoptMain(id)` is the only place `mainSessionId` changes.**

- **It resets the per-session trackers together:** `lastAppliedState`, `lastAppliedTimestamp`, `lastStopped`, `lastTurnOver`, `lastSessionEnded`, `lastCompacting`, `lastWaitingOn`, `pendingPermission`, `editorDead`, `lastEditorPid`, `candidatePid`, `lastNewWriteAt`, `lastMtime`, `lastForceReadTime`. Nothing held (a work state, an armed PID, an open prompt) leaks onto the new face.
- **It clears `face.model`, `cwd`, `gitBranch` and `frequentFiles`**, because `setStats` assigns only truthy values. It then adopts the new session's `modelName`/`model`/`editor`/`cwd`/`gitBranch`.
- **It leaves `candidateSince`/`candidateTs` alone**, because `candidatePid = 0` gates both.

**`_executeSwap`:**

- seeds `lastNewWriteAt` from the adopted write's `timestamp`, so a swapped-in `waiting` starts its silence bound;
- carries a tool or wait state's age onto the monotonic clock (`face.lastStateChange = face.now() - (Date.now() - ts)`, for `ts <= now`; not for responding), so "still running … Ns" and the long-tool hold continue;
- clears `face.stateChangeTimes` after its `forceState`, because caffeine's last 10s belonged to the leaving session;
- settles or arms an unconfirmed permission prompt.

**Around the swap:**

- A dead editor's children do not count: `liveChildren` is 0 while `editorDead`, for `idleCascade` and the status line.
- `checkState()` is guarded **whole** during a transition.
- A resize force-completes a transition, running `_executeSwap` only while `swapTransition.swapPending()`.
- `Enter` on a non-main row sets `face.sessionListPromote`. The loop turns it into `pinnedSessionId`, and the policy swaps. On the main row, `Enter` toggles the pin. Promotion is only a pin; nothing else moves the center.

**Where `lastPromptAt` comes from.**

- **update-state.js** stamps it on `UserPromptSubmit`, and on a `SessionStart` whose `source` is not `compact`. A *compact* `SessionStart` with **no** predecessor file also stamps, because an unstamped file has attention `0` forever.
- **Adapters** keep no memory between events, so the session file is their memory.
  - They stamp on a session's first event, on the first non-turn-ending event after a file marked `stopped` or `turnEnded`, or when a live previous file has no stamp. Otherwise they carry the old stamp.
  - They follow the same turn-end contract: `turnEnded` on the session file, global `stopped`, and session-file `stopped` only for `session_end`. OpenClaw's `session_end` is its own event.
  - A late `tool_end` is not a new turn. It carries the old stamp and whichever end the file records, and `guardedWriteState` re-stamps the global `stopped` only for such a tool end (`opts.toolEnd`).
  - The previous file also carries `model` and `firstSeenAt`, because `writeSessionState` rebuilds from scratch.
- **`codex-wrapper.js`** stamps on `thread.started` and `turn.started`. `turn.completed`/`turn.failed` write `turnEnded`; session-file `stopped` comes only when the wrapper closes.
- **`codex-notify.js`** never stamps, since its only event is a turn end. It carries the hooks' stamp and the other sticky fields forward.

**What the main face reads.** `readState(filePath = STATE_FILE)`: the unified renderer passes the main's session file, and tmux mode passes nothing.

- **Turn ends.** `readState` folds `stopped`/`turnEnded` into `stopped`. A *new* `idle` + stopped write becomes `responding` / `wrapping up`, so the reward cascade runs.
- **`startupGate(ts, stopped, now, rendererStartTime, uptimeMs)`** (pure, exported) returns `apply`, `skip` or `record`. Its window is the renderer's monotonic uptime, and `checkState` passes `now - uptime` as the start.
  - During the first `STARTUP_WINDOW_MS` (5s), two kinds of write are **recorded**: a turn that ended before the start (`ts` before it, 0 included), and a live write more than `STARTUP_STALE_MS` (15s) older than the start. Recorded means never shown, but marked applied (`lastAppliedTimestamp`/`lastAppliedState`), so it cannot read as new later.
  - After the window, only writes over `RUNTIME_STALE_MS` (120s) older than the start are skipped.

#### Subagent Attribution (`agent_id`)

`agent_id` routing is authoritative. Every hook inside a Claude Code subagent carries the **parent's** `session_id`, plus `agent_id` and `agent_type`.

**Routing and counting.**

- Such an event goes to `{parentSession}-agent-{agentId}.json` (`subagentSessionId`), never to the global or parent file, and `classifyForeignSession` is skipped.
- The agent's tool calls count toward the **parent's** `sessionCounters` entry, the lifetime totals and the streak.
- A parent tool call writes `subagent` / `conducting N` only when the newest active entry is a legacy synthetic (no `agentId`), and never over an `error`. Otherwise the parent's own work passes through, and the renderer's `liveChildren` hold fills the gaps.

**The eleven `AGENT_EXCLUDED_EVENTS`** (`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Setup`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`, `PostModelSwitch`) keep their own handlers even with `agent_id`.

- **`Stop` is deliberately not one of them.** An agent's `Stop` is its own turn ending: it writes `responding` / `wrapping up` to the agent's orbital without `stopped`, and leaves the parent and global file alone.
- **`SubagentStop` retires the agent.** If `activeSubagents` lost the agent (a parallel window's lifecycle event reset `stats.session`), it still retires an existing, unstopped `{parent}-agent-{id}.json`. Retirement writes (`_retireSubagent`, shared by SubagentStop and SessionEnd's sweep) carry the agent's sticky fields, `model` included, and its ordering fields, so a late async PreToolUse of the agent's cannot revive it.

**Family heartbeat.** Neither a subagent mid-turn nor a parent waiting on it emits hooks, so mtime alone cannot tell a live family from a dead one (and win32 has no `pid`).

- **Child to parent.** Every agent event stamps the **parent's** file (`_touchSessionFile`) without rewriting it. A child earns the long `CHILD_ORPHAN_TIMEOUT` (15 min) only while its parent's file is fresh, so a crashed parent goes stale normally and takes its orbitals with it.
- **Parent to child is deliberately not symmetric.** `_touchActiveSubagents` touches only *legacy synthetic* entries, which have no writer of their own; the parent writes their state via `_writeSubagentToolState`. Every such parent-written file carries `synthetic: true` (`buildSubagentSessionState` and the no-`agent_id` `SubagentStart` write), and only a face whose last write carried it may cycle fake work (`MiniFace._cyclesActivity`): an OpenCode task session or an engmux run is a real writer. An agent-owned entry must never live on parent activity alone, or a missed `SubagentStop` leaves a ghost.

**Conducting hold.** Agent events do not write the main's file content (the heartbeat moves only its mtime).

- `idleCascade` therefore takes `liveChildren` (`OrbitalSystem.liveChildCount()`: the main's children that are not stopped or stale). It substitutes `subagent` / conducting for a downward transition to idle/sleeping/thinking.
- Rewards, work states and the long-tool hold pass through, and `waiting` outranks conducting.
- The status line's "spawning N subagents" uses the same count.
- Minimal mode passes 0. It still runs the loader and the watcher, but draws no ring.

#### Parallel Session Classification (legacy, no `agent_id`)

A hook without `agent_id`, from another session id while the stats owner has `activeSubagents`, may be the owner's subagent or an unrelated parallel window. `classifyForeignSession` (state-machine.js) calls it **parallel** in two cases:

- It is in `stats.topLevelSessions`. `SessionStart` fills this list, and real subagents never fire it. Entries expire after 7 days, with at most 200 (`pruneTopLevelSessions`).
- Its file was **first seen** before the earliest active subagent's `startedAt`. A subagent's file cannot predate its spawn.

**First seen** is the sticky `firstSeenAt`.

- `firstSeenFor(prev, now)` gives the previous value, else the old file's `timestamp` capped at now, else now.
- update-state.js and base-adapter.js stamp it on every write.
- Birthtime is the fallback only for files that predate the field. An unknown time means subagent, so real grouping never regresses.

**What parallel status changes.** Parallel sessions do not steal `stats.session` while the owner conducts, do not count into its counters, and do not push tool state onto subagent orbitals. A top-level session carrying a stale `parentSession`/`taskDescription` is healed on its next write. Teammates keep theirs. A legacy-classified subagent never writes the global file.

#### Editor Provenance

Every write carries an `editor` (claude/codex/opencode/openclaw/engmux), distinct from `modelName`.

- **Who writes it.** update-state.js writes `CODE_CRUMB_EDITOR || --editor || 'claude'`. Adapters write their own identity, and engmux its `-E`/`--engine` target.
- **It is sticky.** The global owner guard, `guardedWriteState` and `buildSubagentSessionState` preserve it. update-state.js stamps it every write, so it has no `STICKY_FIELDS` entry.
- **Fallback session ids are editor-prefixed** (`opencode-47040`). update-state.js mints the same `FALLBACK_SESSION_ID` in its try and catch paths, so one session never splits in two.
- **Legacy files.** `MiniFace.updateFromFile` infers `editor` from modelName, then from the id prefix.
- **The session list** shows the tag dimmed on row 1, and prefers the full `taskDescription` on row 3.

#### Model Identity

**`modelName` is a misnomer.** It holds the *editor* (`DEFAULT_MODEL_NAME = EDITOR`), so "claude is thinking" names the CLI. The real model is the sticky `model`, a display name (`Opus`, `Sonnet`, `Haiku`, `Fable`).

`prettyModelName(raw)` (pure) strips a `[1m]`-style suffix and a vendor prefix, then matches `MODEL_FAMILIES`. **An unknown id is returned verbatim** (`gpt-5` stays `gpt-5`), and it never truncates.

**Where the model comes from:**

- **Any payload.** A payload `model` (or `to_model`) is taken on **any** event. Codex puts `model` on every hook payload (0.156) and has no `PostModelSwitch`, so this is the only way a Codex session follows `/model`.
- **`SessionStart`'s optional `model`** and **`PostModelSwitch`'s `to_model`** are free payload fields. `PostModelSwitch` is the 22nd event and is absent from `CODEX_HOOK_EVENTS`. It also fires with `source: 'resume'`, and it is the only documented way to follow `/model` in Claude Code.
- **A subagent** gets none of that, because `SubagentStart` is `{agent_id, agent_type}`.
  - Its model comes from its own transcript, `<dirname(transcript_path)>/<session_id>/subagents/agent-<agent_id>.jsonl` (`agentTranscriptPath`). That function rejects an `agent_id` outside `[A-Za-z0-9_-]+`, as a path-traversal guard.
  - The transcript is read on the agent's first tool event that finds a model. The result is then sticky, so it costs one bounded read per agent.
- **`Stop`** re-reads the main transcript's tail **every** turn, deliberately not gated on "no model yet". An install without the `PostModelSwitch` hook would otherwise pin a stale label forever.

**`_readTranscriptModel(path)`** reads the last `TRANSCRIPT_READ_BYTES` (32 KB), newest line first, with at most `TRANSCRIPT_MAX_LINES` (200) JSON parses. It never uses `readFileSync`, since transcripts reach megabytes.

- **Always the tail.** An agent transcript opens with 26–64 KB attachment lines, and a model cannot change within a run.
- **It skips ids starting with `<`.** Claude Code writes `"model":"<synthetic>"` on entries no model produced.
- **It matches `message.model` only**, since a bare `"model"` appears in `attachment` entries. Both traps have tests.
- **It fails silently.** The JSONL is not a documented interface, so every failure returns `''`.

**Four places carry the field**, each load-bearing:

- `STICKY_FIELDS`;
- update-state.js's global owner guard, which runs before the sticky loop and reloads the model from the session file when ownership returns;
- `buildSubagentSessionState`;
- base-adapter.js's `guardedWriteState`. `writeSessionState` rebuilds from scratch, and the OpenCode plugin holds the model only in memory.

**Where it shows:**

- The status line leads with it (`Opus is thinking`), capped at `MAX_STATUS_NAME` (16) and at the room left on the line. The editor becomes a dim tag on the indicators row.
- A **child** orbital's row 5 shows it instead of branch/cwd, which a child shares with its parent.
- The session list's info row gets a segment.

Editors without a model are unchanged.

**Other editors.** codex-wrapper parses `-m`/`--model`. The OpenCode plugin records `message.updated`'s `info.modelID` without spawning (checked against the 1.18.21 binary). engmux is deliberately not wired up.

### The Renderer Loop

**Clocks.** The face measures its own durations on a monotonic clock, `monoNow()`, which is `performance.now()` and swappable via `_setClock`.

- **Monotonic:**
  - `lastStateChange`, `minDisplayUntil`, `stateChangeTimes`, timeline entries, the reward window, caffeine, escalation and pet timers. Compare them with `face.now()`.
  - The renderer's forced reads (`lastForceReadTime` starts at `-Infinity`), PID arming, the permission-answer clock and frame deadlines.
- **Wall clock:** `Date.now()` is used only against a file's JSON `timestamp`, `brokenStreakAt`, milestone freshness and the PID heartbeat.
- **Mtime** is compared with `!==`, so an mtime that moves backwards is still read.
- **Why:** a wall clock stepped back (NTP, a resumed VM) must freeze nothing.

**Frames** run on deadlines (`nextFrameDeadline`, `FRAME_INTERVAL_MS` = 1000/15), restarting from now when more than a frame behind.

**Low power.** The loop drops to `LOW_POWER_FPS` (4) when `canRestLowPower(face, { transitionActive, orbitalsBusy })` holds:

- an idle or sleeping face with no `pendingState`;
- no swap, and no ring face spawning or busy;
- no help or list open;
- no pet, blink, glitch or milestone;
- no particles but ambient `float`/`zzz`.

`wake()` restores full rate at once on a watcher event, a re-opened watcher, a key or a resize.

**One self-healing watcher.** One `fs.watch` handle on `SESSIONS_DIR` (`createDirWatcher`) feeds two consumers:

- **Main-file reads.** An event naming the main's file (or no file) reads it with a 50ms leading-edge throttle, plus one trailing read if events folded.
- **Ring reloads** run 80ms after a burst's first event, never pushed back.

**Self-healing.** The handle closes and re-opens with a backoff (`WATCH_RETRY_MS` 500ms, doubling to `WATCH_RETRY_MAX_MS` 8s) on:

- an `error`;
- a `rename` that leaves no folder;
- a filename that is not a plain basename (`isPlainBasename`). On win32, deleting the folder starts an event storm that pegged a core.

`open()` re-creates a missing folder. A re-open reloads the ring, re-reads the main file and wakes the loop.

**Polling.**

- Every `SESSION_POLL_MS` (2s): an async ring reload, and the watcher's `check()`.
- Every `STATE_POLL_MS` (~467ms): `checkState`. It force-reads the unchanged main file every 2s, beating NTFS's 1s mtime granularity, and that forced read is what catches a missed Stop.
- `stopRuntime` closes the watcher and cancels every timer.

**The terminal.**

- **Start-up** pushes the title (`CSI 22;0 t`).
- **Exit** writes `TERMINAL_RESTORE`: it ends synchronized output, shows the cursor, clears, resets, empties the title and pops it (`CSI 23;0 t`).
- **A crash.** In unified mode, `uncaughtException`/`unhandledRejection` call `crash()`. It stops the runtime, removes the PID file, restores the terminal, prints, and exits 1. It **never** writes the quit flag ("the user closed it"), so autolaunch can bring the face back.
- **Guarded calls.** `face.update`, `orbital.update`, both renders, `orderSessionList`, `listNavigableIds`, `renderSessionList`, the polled `checkState` and the frame write are each guarded.
- **SIGBREAK** on win32 runs the normal cleanup.
- **Screen clearing.** The screen is cleared whole every frame (`ansi.home + ansi.clearBelow`, inside a DEC 2026 synchronized block); that is the only clearing mechanism.

**Test seam.** `runUnifiedMode(opts)` takes `sessionsDir`, `watch`, `schedule`/`cancel`, `write`, `exit`, `installHandlers` and `start`.

- `installHandlers: false` installs no signal, crash, stdin or resize listeners.
- `start: false` boots but runs no frame.
- It returns `{ face, orbital, swapTransition, checkState, loop, wake, onKeys, onResize, cleanup, crash, dispose, mainSession(), trackers() }`.

### State Machine

23 face states: `idle`, `thinking`, `responding`, `reading`, `searching`, `coding`, `executing`, `happy`, `satisfied`, `proud`, `relieved`, `error`, `sleeping`, `waiting`, `testing`, `installing`, `caffeinated`, `subagent`, `starting`, `spawning`, `committing`, `reviewing`, `training`.

**Minimum display times** are enforced via a `pendingState` queue, and defined in one exported table, `MIN_DISPLAY_MS` (face.js).

- **Work states are short**, because every PreToolUse refreshes them: coding/committing/reviewing 1500ms, reading/searching/executing/testing/installing 1200ms, subagent/spawning 2000ms, training 2500ms.
- **Rewards and error are long**, because they are the emotions worth seeing: happy 4000, proud 4500, satisfied/relieved 2500, error 4000.
- **responding** gets 3000.

**`COMPLETION_MIN_SHOW_MS` (1800ms)** guarantees a reward face's time on screen.

- Inside that window, only an error replaces it: the next work state is buffered, and a newer completion is queued.
- After it, the queue flushes (`_flushPending`).
- Work that arrives behind a queued completion is remembered in `pendingWork` and promoted when the completion lands. A completion clears `pendingWork`, since its tool has finished.
- Completions never bypass active work.

**Same-state writes** refresh `lastStateChange` and the detail.

- A same-state **work** write is a new tool call. It drops any queued state except a wait, and `pendingWork` unless that is a wait, so a stale reward never shows over a running tool. `MiniFace.updateFromFile` does the same.
- A same-state **completion** write drops queued work and `pendingWork`. A queued wait or a newer completion stays.
- Errors are never queued.

**Caffeine** never fires or decays while a `pendingState` is queued, so a buffered `caffeinated` cannot overwrite a queued `waiting`.

**`face.forceState(state, detail, minMs)`** applies a state at once, skipping the buffer, dropping the queue, and recording the change for caffeine. Rescue paths (a missed Stop, a dead editor) use it, except on `RESCUE_EXCLUDE` states. Those include `error`, which decays by itself so a late `PostToolUseFailure` after Stop still shows.

**Shared sets.** `ACTIVE_WORK_STATES`, `COMPLETION_STATES` and `INTERRUPTIBLE_STATES` are defined once in shared.js, and imported by face.js, grid.js and renderer.js. So is `PERMISSION_TOOL_STATES` (see Permission waits), for grid.js and renderer.js.

#### The Timeout Cascade (`idleCascade`)

`idleCascade({ state, sinceChangeMs, sessionActive, lingerMs, fileState, fileAgeMs, liveChildren, fileWaiting })` is pure, exported and table-tested. It decides what a face does when no new write has arrived. `sessionActive` is `!lastStopped && (!lastTurnOver || lastCompacting) && !editorDead`.

**Long-running tools.**

- **The hold.** A work face is held while the main's file still names that same unfinished tool (`lastAppliedState`) and the session is active, for up to `LONG_TOOL_HOLD_MS` (10 min). Without it, the face would degrade on the 8s `IDLE_TIMEOUT`. `responding` is excluded, since it is a post-turn state, never a tool.
- **Escalation.** Instead of going stale, the detail line escalates. After `LONG_TOOL_ESCALATE_MS` (8s), `displayDetail()` appends `still running … Ns`; `render()` truncates the base detail, never the suffix. After `LONG_TOOL_SWEAT_MS` (20s), sweat particles start.
- **What escalates.** Escalation is gated on `ESCALATING_STATES` (face.js), not `ACTIVE_WORK_STATES`, which answers "what may interrupt what". `ESCALATING_STATES` is `ACTIVE_WORK_STATES` minus `NON_TOOL_WORK_STATES` (`responding`, `subagent`), derived by subtraction so new work states are covered. `subagent` is re-asserted every frame by the conducting hold, and each agent already has its own orbital.

**Waiting on the user.**

- **The hold.** `waiting` is held regardless of `sessionActive`, with no display cap, because an `idle_prompt` arrives *after* Stop. It holds while the file's state is `waiting`, or while its last write still names an unanswered permission prompt (`fileWaiting`).
- **Escalation.** Past `WAIT_ESCALATE_MS` (30s):
  - `displayDetail()` adds the elapsed seconds;
  - `update()` swaps in 2 bold `bigquestion` particles every 20 frames;
  - `render()` pulses the status line;
  - the renderer flashes `? WAITING FOR YOU` in the title via the pure `buildTitle(modelName, status, flash)`.
- **Frame dedupe.** The dedupe key is `title + output`, so a blink with an unchanged body still writes.
- **The only bound is write silence.** After `WAIT_HOLD_STALE_MS` (30 min) with no new write, the face degrades to idle. This needs no `pid`, which matters on win32.

**Measuring write silence.**

- **`noteNewWrite(ts, lastTs, now, lastAt)`** advances only when a write's own JSON `timestamp` moves forward, so the forced re-read cannot fake freshness.
- **"Moves forward" is `isNewerWrite(ts, lastTs, now)`** (pure, exported), used at every newness check in `checkState` and in `MiniFace.updateFromFile`. It normally means a greater timestamp, since parallel hooks land out of order. Once the last applied write is more than `FUTURE_SLACK_MS` (60s) in the future, any different stamp counts as new.

**Other rules.**

- **An allowed permission prompt becomes its tool** (see Permission waits), and `lastAppliedState = permState` lets the long-tool hold keep it until its PostToolUse.
- **Conducting.** `liveChildren > 0` substitutes `subagent` for a downward transition.

### Hook Events

23 events are handled: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `UserPromptSubmit`, `TeammateIdle`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`, `PostModelSwitch`.

- **Keep the lists in sync.** `HOOK_EVENTS` (setup.js) and `hooks/hooks.json` must match; test-release compares them.
- **Deliberately unregistered.** `WorktreeCreate`/`WorktreeRemove` replace git's default worktree behaviour, so they are not registered.

**Claude Code fires all 23.**

**Codex's native hooks (0.156)** fire 11 of them: `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit` and `Stop`.

- **`Interrupt`.** Codex also fires its own `Interrupt` **instead of** `Stop` on Esc; a failed turn runs neither. `Interrupt` writes `error` / `interrupted`, ending the turn like `StopFailure` but leaving the streak alone.
- **No `Notification` or `PostToolUseFailure`.**
- **Registration.** `setup.js codex` registers exactly these twelve (`CODEX_HOOK_EVENTS`), synchronously with `timeout: 5`. `OUR_COMMAND_RE` matches the union with `HOOK_EVENTS`. Codex parses `hooks.json` leniently, so older versions ignore `Interrupt`.
- **Trust.** Codex hooks need a one-time trust approval, or `--dangerously-bypass-hook-trust`.

#### Async per-tool hooks and their ordering

`PreToolUse`, `PostToolUse` and `PostToolUseFailure` are `"async": true`, in hooks.json and `buildFaceHooks` (`ASYNC_HOOK_EVENTS`).

- **Why.** On Windows each hook is Git Bash plus node (~55–85 ms), so a synchronous Pre + Post blocked the editor ~170 ms per tool call.
- **What stays synchronous.** Every other event: a Stop, a prompt or a permission request must land in order, and the guards measure against them. Codex's hooks are all sync.
- **Existing installs.** `setupClaude` fixes the flag on existing commands in place (`syncAsyncFlags`, reported as `upgraded`).

**Ordering.** update-state.js orders async writes inside the stats lock. If it misses the lock, it proceeds, and that residual race is accepted.

- **What each write records.** Every session-file write records `eventAt`, which is `EVENT_AT` = `performance.timeOrigin`, since no payload carries a time.
  - Sync writes also record `syncAt`/`syncEvent`, which async writes carry forward.
  - A tool end appends its id to `doneToolIds`: the last `DONE_TOOL_IDS_MAX` (16), as 16-char tails.
- **What `asyncWriteIsStale` drops:**
  - a `PreToolUse` whose call already finished (its id is in `doneToolIds`). The commonest inversion is a fast tool's Pre landing after its Post.
  - a `PreToolUse` for the call an open permission prompt waits on (`waitingOn`).
  - any async event older than the newest sync write. The exception is a tool **end** older than a turn-closing event (`Stop`/`StopFailure`/`SessionEnd`/`Interrupt`), which keeps the turn-end carry rules.
- **Clock steps.** A sync write more than `ORDER_SLACK_MS` (60s) ahead is a clock step, not an inversion.
- **What a dropped event still does.** It counts in the stats but writes no state file. The >1 MB fallback applies the same rule.
- **Transcript.** Async hook output never reaches the transcript.

#### Permission waits

**The 6 s notification.** Claude Code fires `Notification(permission_prompt)` 6 s after a permission dialog opens, and cancels it if the dialog is answered first (2.1.300). `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS` turns it off.

**`PermissionRequest`** writes `waiting` / `allow <tool>?` with `waitingOn`, a digest of the tool's name and input (`toolCallKey`).

- **Unconfirmed waits.** Claude Code with the notification on writes an **unconfirmed** wait: `waitKind: 'permission'`, `waitConfirmed: false`, and `permState`/`permDetail`, the tool's work face from `toolToState`.
- **No `waitKind`.** Codex, or the notification disabled, gets no `waitKind`, so the wait is never resolved early. "Disabled" is Claude Code's own parse (2.1.300 reads the switch through its env table as `D.bool()`): `1|true|yes|on`, any case, trimmed. `0`, `false` or empty leave the notification on.

**The Notification confirms** the wait (`waitConfirmed: true`), keeping its detail and `permState`/`permDetail`. It carries only the session id, so it also confirms the session's agents' unconfirmed waits (`_confirmAgentWaits`), if they are at least `PERMISSION_CONFIRM_MIN_AGE_MS` (5s) old, measured from `syncAt`.

**The parent stands in for its agents.** `_confirmAgentWaits` returns every agent whose prompt is open and confirmed once it returns (just now or by an earlier notification). When that is not the parent's own question, the parent records `waitForAgents` (≤8 agent file names) and `waitPrev` (`{ state, detail }`, from before it started waiting).

- A later notification merges with the list the parent already holds, never replaces it. Agents asking seconds apart each get their own notification, and one that confirms nothing new must not forget the first agent.
- A session's own wait still unconfirmed `PERMISSION_CONFIRM_MS` after `waitAskedAt` was allowed. A notification that finds an agent asking does not re-confirm it (that put the parent back on "allow?" over its own running tool): it drops that wait's fields and stands in for the agents, with `waitPrev` = its `permState`/`permDetail`. With no agent asking, the notification is still the session's own.
- When an agent is answered (its tool end on the waited call, or a PermissionDenied), `_releaseParentWait` drops it from the list. When the last one goes, it restores the parent file, and the global file when owned: back to `waitPrev`, or else `subagent` / `conducting`, with `answered: true`, a fresh timestamp, and no wait fields.

**An unconfirmed wait older than `PERMISSION_CONFIRM_MS`** (8s, shared.js) was allowed, and its tool is running. Only an `editor: 'claude'` wait with `waitConfirmed === false` converts.

- **The renderer.** `isUnconfirmedPermission` converts 8s after the write's timestamp or after first sight, whichever comes first. It re-reads the file to confirm it is the same unconfirmed write, then drops the wait and shows `permState`/`permDetail`. A `permState` outside `PERMISSION_TOOL_STATES` (shared.js: thinking + `ACTIVE_WORK_STATES` − responding) stays waiting.
- **`MiniFace._permWait`** does the same in `tick`, with the same set, and shows any other `permState` as `executing`.
- **tmux.** `tmuxDisplayState` maps the wait to `permState`.

**`waitKind`/`waitConfirmed`/`permState`/`permDetail`/`waitAskedAt` live and die with `waitingOn`** (`WAIT_FIELDS`). `waitAskedAt` is the PermissionRequest's own `EVENT_AT`; only the hook reads it (`syncAt` cannot say how long a wait has been open: a background agent's lifecycle event moves it). The waited call's tool end, any other answer, or a turn-closing event clears them all.

**`PermissionDenied`** (2.1.300) fires only when the **auto-mode classifier** refuses a call. A user's "no" fires nothing. The call never runs, so no PostToolUse or PostToolUseFailure follows.

- It shows `thinking` / `<tool> denied` (an MCP tool is named by its server, ≤24 chars).
- It answers the wait on its call, or any wait if none is pending.
- It leaves the streak alone.
- It is per-call, so it is in neither `LIFECYCLE_EVENTS` nor `AGENT_EXCLUDED_EVENTS`, and with `agent_id` it routes to the agent's orbital.
- The fallback path and `classifyTruncatedInput` show `thinking` / `permission denied`.

#### Classifying a tool result

`classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag, opts)` (state-machine.js) checks, in order:

1. `interrupted`
2. a predicate's answer
3. `isError` or a numeric non-zero `exitCode`
4. a background launch
5. an exit code inferred from the text
6. the stderr scan
7. a `cd` failure
8. the stdout scan
9. the per-tool success faces

**Patterns.**

- There are 44 failure patterns (35 stdout, 9 stderr) and 14 false-positive guards. Guards apply **per line**.
- A stdout panic is a crash's own words: Go's `^panic: `, Rust's `panicked at`, or an upper-case `PANIC`. cargo's passing `test x - should panic ... ok` is not one.
- Merged-output git failures are stdout patterns: `^fatal: `, `^error: failed to push some refs`, `^ ! [rejected]`.
- The CONFLICT pattern `\bCONFLICT\s+\([^)\r\n]{1,40}\):` is shared with `isMergeConflict`.
- Every pattern is linear-time, and so is `stripAnsi` (OSC ending in BEL or ESC `\`). Two adjacent `\s*` runs, or a `.*` restarted from every match of an earlier part, are quadratic: `EXIT_TRAILER_RE` ends `\s*(?:\.\s*)?$`, and the pytest echo is `^(?=\S*::).* PASSED\b`.

**`trustSuccess`.** Claude Code 2.1.300 reports a failing Bash as `PostToolUseFailure`, so its `PostToolUse` is a success the host vouches for. update-state.js passes `{ trustSuccess: EDITOR === 'claude' && hookEvent === 'PostToolUse' }`.

- **What trust skips.** A trusted shell result skips the inferred exit code, both scans, and the `cd` and merge-conflict checks. A non-shell tool skips only the stderr scan.
- **What is still scanned:**
  - a command line that can mask a failure (`shellIntent().masked`, from `exitMasked`): an acting (non-read-only) segment whose operator is `|` or `&`, or any `||`, `;`, newline or `&` after it, before the last segment. `&&` alone never masks.
  - shell-management tools (`SHELL_MGMT_TOOLS`: KillShell, BashOutput, EnterWorktree, ExitWorktree).
- **Explicit signals always count:** `interrupted`, `isError` and a numeric `exitCode`.
- **Untrusted callers.** Codex (whose PostToolUse fires for failures too), the adapters, and `PostToolUseFailure` pass no `opts`.

**Before scanning**, a shell tool's output drops its echoed lines (`ECHOED_LINES`):

- git commit summaries, diffstats and ref updates
- non-error `remote:` lines
- stash, switch and rebase notices
- `Shell cwd was reset to`
- pass marks, TAP `ok N`, and pytest `PASSED`

Text over 80 K characters is scanned as its first `SCAN_HEAD_BYTES` (16 K) plus its last `SCAN_TAIL_BYTES` (64 K), measured in string length (`scanWindow`). The truncated (>1 MB) path scans the same window, with escaped `\n` made real.

**Read-only commands.**

- **Content, not errors.** stdout patterns are skipped for read-only commands, whose stdout is content.
- **Exit codes.** They are inferred from text (`Exit code N`, `exit status N`, `exited with [code] N`, never a bare `returned N`) only for shell tools. For a read-only command, only the editor's own trailer line counts, first or last (`extractTrailerExitCode`).
- **Merge conflicts** count only for a command containing `git`, an empty command, or a non-shell tool (`errorDetail`'s `opts.conflicts`). They never count for a read-only git command, nor a trusted success, since git exits 1 on a conflict.
- **`cd` failures** count only in a chain with `cd`/`pushd`/`popd` (`SHELL_MOVE_RE`). There they are errors even though the chain is read-only, because adapters with merged output and no exit code rely on it.
- **Push rejection.** `errorDetail` also names `push rejected`.
- **git's `fatal:`.** For a command containing git (`opts.git`), a `fatal: ` line reads `push failed` for a push and `git failed` otherwise, so a masked `git push … | tail` (or Codex's exit 128) no longer says "something went wrong". It comes after merge conflict, push rejected, command not found and permission denied, and before the generic matches, which inside git's message are fragments of it.

**Shell intent.** `shellIntent(cmd)` returns `{ unquoted, intent, readOnly, masked, segments }`.

- **Unwrapping.** A wrapper is unwrapped first (`unwrapShell`, at most twice): `pwsh`/`powershell -Command|-c`, `cmd /c|/k`, or `sh`/`bash`/`zsh`/`dash -c|-lc`, even when named by a path. Codex runs every command through one. Only a script that is one quoted shell word is unquoted (`shellWord`), the way the shell reads it: a run of quoted pieces (shlex quotes `it's` as `'it'"'"'s'`), with `\"`, `\\`, `\$` and `` \` `` unescaped inside double quotes. Two wrapped scripts in a chain are never joined.
- **Quotes.** Quoted arguments are emptied and heredoc bodies dropped (`stripQuotedArgs`, linear).
- **Segments.** Read-only segments are dropped. Splitting happens on `&&`, `||`, `;`, `|`, `&` and newlines, but never on a redirect's `&` (`2>&1`, `>&2`, `&>file`, `<&3`). `cd`/`pushd`/`popd` are read-only.
- **Words.** `segmentWords` strips a leading `(`/`{` and a trailing `)`. `cmdName` drops the directory and `.exe`/`.cmd`/`.bat`/`.ps1`.
- **git.** `gitCalls`/`gitSubcommand` see past git's global options (`-C`, `-c`, `--git-dir`…). `commit`/`push`/`tag` are checked before test/build/install, so a commit message naming a build is still a commit.

**Command tables.**

- **The read-only table** covers:
  - plain reads, `journalctl`, and git's listing subcommands (log/show/diff/reflog/rev-parse/ls-*/stash list/branch, remote and tag listings…). `git tag` lists when it has no tag to make: bare, `-l`, `--list` or `-n`;
  - the text filters a read is piped through (`sort`, `uniq`, `cut`, `tr`, `nl`, `jq`, `column`…). `sed` and `awk` read unless told to edit in place (`sed -i`/`-Ei`/`-i.bak`/`--in-place`, `gawk -i inplace`), and `xargs` is whatever it runs (`xargs grep` reads, `xargs rm` acts). Without them `grep … | sort | head` was masked, and Codex's `sed -n '1,120p' x.js` had its content scanned;
  - `gh` list/view/status/diff/checks, docker/podman/compose `logs|ps|images|inspect`, and `kubectl logs|get|describe|top`;
  - the PowerShell reads and `findstr`.
- **Builds** are judged by command and subcommand, never an argument (`isBuildCommand`): a build tool by name, or a subcommand-style tool whose subcommand or `run` script is `build`/`compile`. Flags, workspace selectors and `exec`/`dlx`/`compose`/`-p` are skipped.
- **Task runners** (`turbo`, `nx`, `bazel`/`bazelisk`, also behind a package manager or runner) are judged by their task (`runnerTasks`): `turbo [run] <task>…`, `nx <target>`, `nx run <project>:<target>`, `nx run-many|affected -t a,b`, `bazel <command>`. A `build`/`compile` task is a build and a `test`/`e2e`/`coverage` task a test run; `turbo run lint` just finishes.
- **`make`** is a build when bare, or when a target is `all|compile|release|debug|dist|bundle` or contains "build". A test target is a test run, and any other target finishes `make <target> done`.
- **Installs** use one token-based table for both sides of a call (`isPkgInstall`/`isInstallCommand`). Flags, selectors or a `corepack` prefix may come before `install|i|add|ci`, and a bare `yarn` counts, but not `yarn --version`/`-v`/`--help`. `cargo build` is a build.
- **Test runs** (`isToolTestRun`): `node --test` or a test script (also under `tsx`/`ts-node`), gradle/maven test tasks (never one excluded by `-x`), make test targets, task-runner test tasks, `deno test`, and a test runner (`TEST_RUNNERS`: jest, vitest, mocha, pytest, rspec…) **as the command word** (`isRunnerTest`). It may be reached through `npx`/`bunx`/`pnpx`, a package manager's `exec`/`dlx` or bare bin (`yarn mocha`), `python -m`, or `xargs`; `playwright` counts only as `playwright test` and `cypress` as `cypress run`. An argument never counts: `npm i -D jest`, `pip install pytest` and `git add a.test.js` are not test runs. `isTrainingCommand` is linear.
- **Success details** follow toolToState's order: push/commit, test, build, install, then git (`git done`/`merged clean`), then `make <target> done`. A read-only git step names the result only when nothing else in the command acts: `git status && npm install` finished as `installed`.

**Explicit signals.** `normalizeToolResponse` carries `interrupted`, `isError`/`is_error`, numeric `exitCode`/`exit_code`, `backgroundTaskId` and `status`.

Claude Code's `PostToolUseFailure` has **no** `tool_response`. It is `{tool_name, tool_input, tool_use_id, error, is_interrupt, duration_ms}` (2.1.281), so `error` is read as stderr and `is_interrupt` as `interrupted`.

**Predicate commands.** For a command that answers a question, exit 1 means "no" and 2 means trouble. Claude Code sends any non-zero exit as `PostToolUseFailure` ("Exit code 1"), and Codex and OpenCode send a numeric code. So exit 1 from these becomes satisfied plus the detail below, with `neutral: true` (`predicateAnswer`):

| Exit 1 from | Detail | Rule |
|---|---|---|
| `grep`/`egrep`/`fgrep`/`rg`/`ag`/`ack`/`findstr`/`git grep` | `no matches` | silent |
| `grep -c`/`--count` (and `egrep`/`fgrep`) | `no matches` | every line a zero count, `0` or `file:0` (`GREP_ZERO_COUNT_RE`) |
| `diff`, `cmp` | `files differ` | alone |
| `git diff --quiet` | `files differ` | git's line-ending warning only (`GIT_EOL_WARNING_RE`) |
| `git diff --exit-code` (no `--quiet`) | `files differ` | alone |
| `test`, `[`, `[[` | `condition false` | silent |
| `which` | `not found` | miss line: `which: no <name> in (<PATH>)` (`WHICH_MISS_RE`) |
| `where` | `not found` | miss line: `INFO: Could not find files for the given pattern(s).` (`WHERE_MISS_RE`) |
| `pgrep` | `no process` | silent |

- **Position.** The predicate must be the **last** segment, reached only via `&&` or `|` from read-only segments.
- **Silent** means it printed nothing but the editor's `Exit code N` line (`withoutExitTrailer`). A failing `cd`/`cat` in front would print its complaint.
- **Alone** means a single segment, since the output (diff's, or `git diff --exit-code`'s diff) is the answer.
- **Miss line** means nothing, or only that tool's own miss message on every non-blank line: GNU which's (Git Bash, Fedora, Arch) and System32 where.exe's, as worded on Windows 11. A localized where.exe, or anything else printed alongside, stays an error.
- **`git diff --quiet`** may print git's line-ending warning and nothing else: under `core.autocrlf=true` (git for Windows' default) a changed LF file makes it say `warning: in the working copy of '<file>', LF will be replaced by CRLF the next time Git touches it` (git 2.37+; the older `warning: LF will be replaced by CRLF in <file>.` pair also counts).
- **GNU which exits with the number of names it did not find**, so `which a b` with both missing exits 2. Exit N > 1 is an answer for `which` only, and only with exactly N miss lines.
- **Where the status comes from.** The numeric `exitCode`, or else the trailer: on stderr when `isError` is set, otherwise on stdout.
- **Order.** The check runs after `interrupted` and before `isError`, so it overrides Claude's forced error. Shell-management tools are excluded.

**Background launches.** A shell tool with a `backgroundTaskId`, or `run_in_background: true` and empty output, is satisfied / `launched in background` / `neutral: true`.

**Neutral results** leave the streak alone. update-state.js skips `updateStreak` and `commitCount`, and base-adapter's `handleToolEnd` skips `updateStreak`, as it does for an interrupted tool end.

**Commits** are counted by the result's `committed` flag, never its detail. A successful `git commit` sets it, also under `git commit && git push`, whose face is `pushed!`.

**Diff counts.**

- **With a patch.** Claude Code's `tool_response.structuredPatch` wins when present: `diffFromPatch` sums `+`/`-` lines across hunks, so a same-length replacement is `+1 -1`.
- **Without one.** `diffFromInput` counts the edit's inputs, including `MultiEdit`'s `edits[]` and `NotebookEdit`'s `new_source`. A final newline ends the last line rather than starting another (`lineCount`): `'a\nb\n'` is two lines.
- **What is stored.** Only the two totals are persisted.

#### Other events

| Event | Face |
|---|---|
| `PreCompact` | thinking (rain particles) |
| `PostCompact` | satisfied |
| `PermissionRequest`, `Elicitation` | waiting (question particles) |
| `PermissionDenied` | thinking `<tool> denied` |
| `Setup` | starting |
| `ElicitationResult` | satisfied / relieved |
| `ConfigChange`, `InstructionsLoaded` | reading |
| `StopFailure` | error (breaks the streak) |
| `PostModelSwitch` | thinking `now <Model>` |

**Routing.**

- **Agent orbitals.** `PermissionRequest`, `PermissionDenied`, `Elicitation` and `ElicitationResult` route to agent orbitals.
- **Not routed.** The 10 `LIFECYCLE_EVENTS` (`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Setup`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`) are not routed.
- **`PostModelSwitch`** is deliberately not a lifecycle event, so a parallel window's `/model` still classifies and cannot reset a conducting owner's stats.

**`SessionStart` sources** are `startup | resume | clear | compact | fork` (2.1.300), and every comparison names an explicit set:

- `EDITOR_START_SOURCES` (`startup`, `resume`, `fork`) clears the quit flag.
- `clear` is a fresh session inside a running editor.
- `compact` is the same session continuing.

**Answers.** These writes carry `answered: true`, for one write:

- `UserPromptSubmit` and `ElicitationResult`
- a returning `AskUserQuestion`
- a matching `PermissionDenied`
- OpenCode's `permission.replied` and `question.replied`/`question.rejected`
- an adapter's `AskUserQuestion`-family tool end
- the asking tool's own PostToolUse/PostToolUseFailure after a `PermissionRequest`. Allowing it produces nothing else, so the file keeps `waitingOn` until that call (never a parallel one) ends.

The renderer calls `face.dropWait()` before applying such a write, so a wait queued behind a reward cannot reappear.

**`workSince`.** A PostToolUse carries its tool's `workState`/`workDetail`, so the renderer can inject a missed Pre. When the file still holds that Pre, it also carries the Pre's timestamp as `workSince`. The renderer injects only if `workSince` is newer than the last applied write, and never on a stopped write.

**`UserPromptSubmit`** → thinking `reading your message`, with no `stopped`, so the 45s thinking timeout applies. It stamps `lastPromptAt`.

**`Notification`** depends on `notification_type`:

- `permission_prompt` confirms the pending wait and keeps its detail. Without a pending wait it is waiting `allow?`.
- `idle_prompt` → waiting `waiting for you`.
- `elicitation_dialog` → waiting `needs input`.
- `auth_success` → satisfied `signed in`.
- The `INFO_NOTIFICATIONS` (`elicitation_response`, `elicitation_complete`, `agent_completed`, `computer_use_exit`, `push_notification`, `plugin_notification`) draw nothing and only count stats.
- Anything else → waiting `needs attention`.

**The fallback path** (`writeFallback`, under the stats lock) handles:

- unparseable stdin, through `classifyTruncatedInput`'s event map, `PermissionDenied` included;
- payloads over 1 MB. Their `session_id`, `agent_id`, `agent_type`, `hook_event_name`, `source` and `tool_name` are regex-extracted, and `tool_use_id` comes from the stream's tail, since it is serialized after `tool_response`. A tool end's call key is rebuilt from the raw `tool_input` text (`_rawCallKey`, a linear string-aware brace scan), so the waited call's own huge result can answer its prompt;
- payloads that parsed and then threw, which reuse their parsed ids rather than minting a `claude-<ppid>` phantom.

**What the fallback path writes.**

- **Stamps.** It stamps `lastPromptAt` on `SessionStart`/`UserPromptSubmit` and `turnEnded` on `Stop`.
- **Empty stdin.** A fallback `SessionStart` counts as attention, and the global owner's id is used.
- **Routing.** A known `session_id` is used as-is, and `agent_id` routes to the agent orbital.
- **Ownership.** Only the owner writes the global file. Sticky fields, the turn-end carry, a session file's `stopped` and the wait fields come from the session file; the waited call's tool end answers its wait (and releases a parent standing in for an agent). A SubagentStart minted here stamps `synthetic: true`.
- **Coercion.** Non-string fields go through `toText`.

**Top-level registration.** `UserPromptSubmit` and a `Stop` without `agent_id` register the session in `topLevelSessions` before classification, so a window opened before the hooks were installed is not taken for a subagent. The legacy synthetic-retire loop skips agent-owned entries.

**Subagent payloads (2.1.300).**

- `SubagentStart` is just `{agent_id, agent_type}`.
- `SubagentStop` adds `last_assistant_message`, `agent_transcript_path` and `background_tasks`. It matches by `agent_id`, then a legacy `subagent_id`, then FIFO.

**Teams.** `TeammateIdle` needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. In 2.1.300, `TeammateIdle` and `TaskCompleted` both fire from a teammate's stop-hook path with the **lead's** `session_id`. In 2.1.280, `TaskUpdate` also fired `TaskCompleted` for solo sessions.

- **Teammate writes.** Only a payload with `team_name` or `teammate_name` takes the teammate write (`_writeTeammate`). Anything else falls through to the normal path, so a solo session is never tagged `isTeammate`.
- **Routing.** With `agent_id`, the write goes to the teammate's orbital `{lead}-agent-{id}` (with `parentSession`, `agentType` and the sticky fields), never to the lead's file.
- **Healing the lead.** `_healLeadFile(lead)` then strips `isTeammate`/`teammateName`/`teamName`/`taskSubject` from a lead file that has `isTeammate` but no `parentSession`. It does this on disk, keeping the timestamp. `MiniFace` drops team fields on any write without `isTeammate`, so the lead rejoins the policy with no restart.
- **Labels.** Teammate files carry `teamName`, `teammateName` and `isTeammate: true`, for the orbital label and team accent color.

### Orbital Label Priority

A per-face label (≤ 8 chars) follows `teammateName` > `taskDescription` > cwd basename > `modelName` > `sub-N`.

- **`modelName`.** A top-level face uses `modelName` only when its cwd basename is missing or shared.
- **`taskDescription`** is set once at `SubagentStart` by `subagentLabel`. It takes the first non-empty line of `description`/`invocation_prompt`/`prompt`, collapsed to ≤ 40 chars with an ellipsis, falling back to `agent_type`, then `subagent`.
- **`agentType`.** The sticky `agentType` (`Explore`, `Plan`, `general-purpose`, a custom agent) becomes the orbital's `modelName`.
- **The live detail** shows below the label.
- **Row `+5`** of the 7-row `MiniFace` shows the branch, else the cwd basename, else the theme status. A child shows its known `model` instead.

**Group labels** (≤ 12 chars) come from `_getGroupLabel`: `teamName` > a shared non-default branch (not `main`/`master`/`develop`/`dev`) > a shared cwd basename > the first member's `taskDescription` > the first member's label.

#### The Session List (`l`)

**Loading.** `OrbitalSystem` loads **every** session file into `faces`, the main included.

- `setMainSession(id)` marks the main and relabels the ring at once; `getSortedFaces()`/`_assignLabels()` filter it off the ring. So the list, `liveChildCount()` and the policy all read it as a normal `MiniFace`.
- `loadSessions(null)` (at boot) excludes nothing.
- A `MiniFace` carries `lastPromptAt`, `toolCalls` and `filesEdited`.

**Pure functions in grid.js:**

- **`orderSessionList(mainInfo, faces)`** returns `[{ face, depth }]` in **tree order**:
  - the main row (a synthesized `mainInfo`), with its children by `firstSeen`;
  - the other top-level sessions by attention (`lastPromptAt` desc, `firstSeen` tiebreak), each with its children;
  - each child with its own children one level deeper (an OpenCode task's task, depth 2+);
  - then orphans (parent not listed), each with its children. A parent loop lists each session once.
- **`listNavigableIds(entries)`** returns what `j`/`k`/`Enter` may land on: every row that is not `stopped`, plus the main row always (between turns its `stopped` is the folded `turnEnded`). A stopped session still draws for ~10s, but pinning it would be undone on the same tick.
- **`renderSessionList(cols, rows, entriesOrFaces, paletteThemes, mainInfo, selected)`** takes `selected` as a **session id**. A number is still accepted for legacy callers, as is a face array.

**Entries.** Each entry is `SESSION_LIST_ENTRY_ROWS = 4` rows:

1. **The state row:** `▸● statename  editor  ⊛/★/☆ label`.
   - A child gets a `└` prefix.
   - `★` marks the main, `⊛` a pinned main, and `☆` an independent top-level session.
   - When short of room, the label is never sliced, the editor drops first, and the state name truncates last.
2. **The path row:** `⎇ branch  ~/path`.
3. **The detail row:** the full `taskDescription`, else the live detail, else `waiting...`.
4. **The info row:**
   - a top-level session shows `N tools · M files · model · age`;
   - a child shows `<agentType | teamName | agent> · model · age ↳ parent`;
   - the model is omitted when unknown, and is pushed into `parts` before the join, so `sliceToWidth(…, body)` bounds the row;
   - `formatAge(ms)` gives `3s`/`2m`/`1h`.

**The footer** reads `⏎ pin`/`⏎ unpin` on the main row and `⏎ pin+promote` elsewhere.

**Minimum size.** Below `MIN_SESSION_LIST_ROWS = 12` or `MIN_SESSION_LIST_COLS = 50`, the overlay draws nothing. Above that, `maxVisible` comes from the row budget.

- `sessionListFits(cols, rows)` is that test.
- It also gates the `l` key, the `l` hint (`fitKeyHints(width, omit)`), and a resize while the list is open (which closes it), so an invisible list never swallows keys.

**The ended marker.** The main row's marker reads the main file's own SessionEnd flag (`sessionEnded`, tracked as `lastSessionEnded`), because the stopped `MiniFace` is purged after its 10s linger.

### Orbital Grouping

Faces sharing a group key (`teamName || parentSession || sessionId`) cluster in four layers:

1. **Positioning.**
   - Members sit `INTRA_GROUP_GAP` (0.35) apart, and the groups share the rest of the circle evenly.
   - Angles are **box-arc angles**.
   - No neighbours sit closer than the orbit's `minGap`; if that cannot hold, spacing degrades to even.
2. **Tethers.** Dim dashed `·` lines chain siblings at `TETHER_BRIGHTNESS = 0.15`, in the team accent for teams. The dots skip **all** face boxes. Spawning faces are excluded.
3. **Group labels** sit below multi-member clusters at `GROUP_LABEL_BRIGHTNESS = 0.45`. Spawning faces are excluded from the extent, and labels skip the main face's zone. The group cache checks member identity.
4. **Overlap resolver.** At most 3 nudge passes, re-clamped to the terminal. With box-aware spacing it should never fire, so firing every frame shows up as jitter. Joining faces are excluded.

Singletons get no tethers or labels.

#### Orbit Geometry

- **The key-hint bar** is fitted to `cols - 1` by `fitKeyHints(width)` (face.js, pure), dropping `t` first and `h` last. A wrap on the bottom row would scroll the screen.
- **The orbit is sized from `lastPos.keepOut`**, a **worst-case** footprint: the tallest accessory (`MAX_ACCESSORY_H`), the bubble's 4 rows, `MAX_DETAIL_W` (36), and the stats rows.
  - It changes only with the terminal size or the `a`/`s` toggles, never with state, accessory or bubble.
  - `keepOutOf(mainPos)` derives one from a bare box.
- **Drawing order.** The ring is drawn **first** and the main face over it, so a bubble occludes an orbital instead of moving it. The help overlay covers the ring, and the side panel's right column comes from the keep-out.
- **`computeOrbit(cols, rows, keepOut)`** (pure; cached by `calculateOrbit`):
  - centres the ellipse on the keep-out, keeping the expanded rectangle's corner inside it so no box touches the keep-out;
  - reserves the last row;
  - spaces faces by **box-arc length** rather than angle, since an 8×7 box needs 9 columns of travel along the top but 8 rows along the sides;
  - builds a 720-step lookup where each step costs `max(|dx|/(MINI_W+1), |dy|/(MINI_H+1))`. From it come `maxSlots = floor(perimeter / ORBIT_SPACING)` (≤ `MAX_ORBITALS`), `minGap` and `thetaAt(u)`. Rotation and offsets live in the uniform `u`.
- **Joining the ring.**
  - A face joining a ring already on screen starts at its predecessor's current offset (`_startJoiners`/`joinFrom`) and eases forward at full radius, without a radial spawn. It is drawn beneath, and kept out of `_resolveOverlaps` until the ease ends.
  - A face off the ring forgets its offset, so a demoted main rejoins the same way.
  - A first-drawn ring snaps into place.
- **The `+N more` text** (`_overflowRow`) takes its planned row (`mainPos.row + mainPos.h + 7`, ≤ `rows - 2`) only when no ring box covers it, else the nearest free row below the keep-out, else above it, else it is skipped that frame.
- **Space needed.** The ring needs about 80×60 or 114×50 with accessories (78×60 or 104×50 without). Smaller windows get the stable side panel.
- **Tests.** `tests/test-grid.js › layout invariants` sweeps window sizes and asserts:
  - no overlap with the keep-out, between faces, or with the hint row;
  - no frame-to-frame jump over 3 cells;
  - an orbit independent of state, accessory and bubble;
  - nothing written to the last cell.

### Multi-Editor Tool Mapping

Tool patterns are shared constants in state-machine.js: `EDIT_TOOLS`, `BASH_TOOLS`, `READ_TOOLS`, `SEARCH_TOOLS`, `WEB_TOOLS`, `SUBAGENT_TOOLS`, `REVIEW_TOOLS`, `ASK_TOOLS`, `SKILL_TOOLS`, `PLAN_TOOLS` and `PUBLISH_TOOLS`. They match Claude Code, Codex, OpenCode and OpenClaw names.

**The Claude Code set:**

- `NotebookEdit` → coding.
- `NotebookRead`/`ReadMcpResourceTool`/`ListMcpResourcesTool` → reading.
- `LS`/`ToolSearch` → searching (`LS` with a path shows `listing <dir>`).
- `KillShell`/`BashOutput`/`EnterWorktree`/`ExitWorktree` → executing.
- `AskUserQuestion` → waiting `asking you`, then satisfied `got your answer`.
- `Skill` → reading `skill: <name>`, then satisfied `skill loaded`.
- `TodoWrite`/`EnterPlanMode`/`ExitPlanMode` → thinking `planning`, then satisfied.
- `CronCreate`/`CronList`/`CronDelete`/`ScheduleWakeup` → thinking `scheduling`, then satisfied.
- `Workflow`/`SendMessage`/`ListAgents`/`TaskOutput`/`TaskStop`/`Monitor` → subagent (`orchestrating` / `messaging an agent` / `checking on agents`). A returning `Agent`/`Task`/`Workflow`/`TaskOutput` → happy `agent done`; the others → satisfied `checked in` / `message sent`.
- A background agent's result (`status: 'async_launched'`, Claude Code's default, returned at launch; 2.1.281) → satisfied `agent launched`.
- `ReportFindings` → reviewing, then satisfied `reviewed`.
- `Artifact`/`SendUserFile` → coding `publishing` / `sending a file`, then proud `published` / `sent`.
- `patch` is an edit tool.

**MCP tools** (`mcp__<server>__<tool>`) are classified by verb. Kebab- and camelCase names are folded to snake_case first, and search verbs are tested before read verbs.

- `search|find|query|lookup` → searching.
- `read|get|list|fetch|describe|inspect|check|show|view|download|export|whoami|debug` → reading.
- `create|update|write|modify|edit|insert|delete|remove|append|set|move|replace|format|batch|push|merge|upload|import|add|manage|resize|copy|draft` → coding.
- Anything else → executing.
- The detail is `server: tool`, with `plugin_` stripped, a doubled `x_x` collapsed (`plugin_github_github` → `github`), and `_`/`-` turned into spaces. Completion is satisfied `<server> done`.

**Everything else.**

- **Unmatched tools** show `humanizeToolName(name)`.
- **`toText`.** Every text-ish input goes through it: strings pass, numbers stringify, and objects/arrays/null become `''`. So structured input never throws inside `stripAnsi`.
- **`modelName`** controls the display name ("codex is coding").

#### Codex `codex exec --json` items

`codex-wrapper.js` parses codex-cli 0.146's ThreadEvent schema. Each item is classified by `classifyItem(item, phase)` into the same tables.

| Item type | Mapping |
|---|---|
| `command_execution` | `Bash` + the command (so the Bash tables split executing / testing / installing / committing); `declined` → relieved, `failed` → error via `isError`/`exit_code` |
| `file_change` | `Edit` over `changes[].path`; completed → proud `saved <file>` / `saved N files` |
| `mcp_tool_call` | `mcp__<server>__<tool>` through the MCP verb classifier |
| `web_search` | `WebSearch` |
| `collab_tool_call` / `collab_agent_tool_call` | `Task` (Codex's delegation) |
| `todo_list` / `plan_update` | `TodoWrite` → thinking, then satisfied `plan updated` |
| `context_compaction` | thinking `compacting memory` → satisfied `memory compacted` |
| `reasoning` | thinking (detail left alone) |
| `agent_message` | responding |
| `error` | **not shown**: Codex reports run diagnostics as `error` items; a real failure is the top-level `error` event plus `turn.failed` |
| anything else | `humanizeToolName(type)` → executing, then satisfied `done` |

**Streak.** Only `turn.failed` breaks the streak, once per turn (`streakBrokenThisTurn`, which `turn.started` clears). A top-level `error` is shown but not counted, because codex emits one for every retryable stream error and carries on.

**Ending the run.**

- **After `finishSession`**, `handleEvent` returns at once: codex keeps printing while it shuts down.
- **`close`, not `exit`, ends the run**, so buffered stdout drains. Once codex has *exited*, `EXIT_GRACE_MS` (3s) ends the run anyway, since `close` waits for every holder of the pipe.
- **A closed reader** (`| head`, `EPIPE`) retires the session as `error` / `output closed` and destroys codex's stdout. The wrapper then exits `signalExitCode('SIGPIPE')`: 141 on POSIX, 1 on win32.
- **The session-ending write happens once** (`finishSession`), from `close`, a closed reader, or a caught SIGINT/SIGTERM, which is forwarded to codex.
- **Exit codes.** `closeOutcome()` turns a signal-killed codex into an error with exit 128+N (`signalExitCode`).
- **engmux** behaves the same way: a signal writes `error` / `interrupted` with `stopped`, then exits 130/143.

**Living alongside the hooks.** The session id is codex's **bare** thread id, which is the hooks' `session_id` too (before `thread.started` it is `codex-<pid>`). `setup.js codex` installs the hooks *and* suggests the wrapper.

- **Going quiet.** The wrapper goes quiet once the hooks write that session (`hooksAreLive()`/`isHookWrite`). That means editor `codex`, or a legacy untagged `claude` write carrying `isWorktree`, with a pid that is not the wrapper's and a timestamp from this run.
- **codex-notify is not a hook.** Its turn-end write passes every one of those tests (it carries `isWorktree` forward), so it stamps `writer: 'notify'` on the session file (not sticky), and `isHookWrite` refuses it. Before, a notify line beside the wrapper with no hooks silenced every turn after the first.
- **While quiet**, it stops writing what the hooks report better (`HOOK_COVERED`). It still writes `turn.failed`, retries and the run's end, which it closes on the hooks' last frame, stamp and model.

#### The OpenCode 1.18 plugin contract

`adapters/opencode-plugin.mjs` feeds `opencode-adapter.js`. The contract is narrow and easy to get wrong:

- **Bus events** arrive **only** through `event({ event })`. Top-level `session.idle`-style hooks receive nothing.
- **Tool args.** `tool.execute.before` has its args in **output** (`output.args`), but `tool.execute.after` has them in **input**.
- **Throwing tools.** `tool.execute.after` is skipped for a tool that throws; the failed `message.part.updated` covers it (`tool.error`).
- **Exactly one export.** **Every named export is invoked as a plugin factory**, and a second export kills loading with `null is not an object (evaluating 'N.config')`. So `translate()`/`takeBatch()` hang off the factory.
- **Exit codes.** OpenCode reports a command's exit code only in `metadata.exit`. The plugin forwards `exit`, `interrupted` and `timedOut` (`shellOutcome`). Long output keeps its first 1000 and last 2995 chars (`clipOutput`), because a test verdict comes last.
- **Turn ends are synchronous.** `session.idle`/`session.error` are written with `spawnSync`, because `opencode run` exits with the turn.
- **Everything else is fire-and-forget**, one child per session at a time.
  - Payloads arriving meanwhile go out as **one batch** (a JSON array that `processStdinEvent` applies in order) when the child closes, at most `CHAIN_WAIT_MS` (3s) later.
  - A sync turn end takes the session's queue with it, turn end last.
  - The spawn promise never rejects.
  - Reasoning deltas are throttled per session (5s).
- **The node binary** is resolved **per spawn** (`CODE_CRUMB_NODE || 'node'`), because `process.execPath` inside OpenCode is Bun.
- **Size caps.**
  - The adapter reads ≤1 MB of stdin, and judges anything bigger from its raw text.
  - Tool arguments are capped at `MAX_FIELD` (64 KB). `capInput` keeps a long string's line count as newlines, for the "+N" thought.
  - Batches are capped at `MAX_BATCH_BYTES` (900 KB, `takeBatch`), and sent as sequential `spawnSync`s on the sync path.
- **Numbering.** Payloads carry `seq` and `pluginId`. A turn end records `endSeq`/`pluginId` on the session file, and a payload numbered before it is a **straggler**: counted, but not drawn. A late tool end keeps its own rule. The cause: a child spawned just before a sync turn end cannot write before it.
- **Child sessions.** The task tool runs a child session (`sessions.create({ parentID })`). Only `session.created` names the parent, so the plugin remembers it (`parentBySession`) and stamps `parentSession` on the child's payloads. A child is an orbital of its parent:
  - it never stamps attention;
  - it never writes the global file;
  - its tool calls count toward the parent (`statsId`);
  - its `session.idle` retires it (`stopped`).
- **`session.error`.**
  - Without a session id it is dropped, because plugin and skill load failures send them. Otherwise it carries `errorName`.
  - A `ContextOverflowError` is followed by compaction. When no `session.compacted` follows, the next idle is marked `overflowFailed` (`trackOverflow`).
  - `session.compacted` and `question.asked`/`replied`/`rejected` are forwarded.

**State mapping (opencode-adapter.js):**

| Event | Face | Notes |
|---|---|---|
| `session.created` | starting | |
| reasoning | thinking | |
| `permission.asked` / `permission.updated` | waiting `allow?` | |
| `permission.replied` | satisfied | `answered` |
| `question.asked` | waiting `asking you` | |
| `question.replied` | satisfied `got your answer` | `answered`; streak untouched |
| `question.rejected`, or a tool end whose error says the question was dismissed | satisfied `question dismissed` | `answered`; streak untouched |
| `session.compacted` | satisfied `memory compacted` | |
| `ContextOverflowError` | thinking `compacting memory` | |
| `tool.error` | error | |
| an interrupted tool end | error `interrupted` | streak untouched |
| a timed-out tool end | error `timed out` | breaks the streak |
| `overflowFailed` idle | error `context too long` | a failed turn |
| `MessageAbortedError`/`AbortError` (Esc) | error `interrupted` | ends the turn without a streak break, in either arrival order |
| any other session error | error with its detail | ends the turn as failed: `turnError`, kept through the next `session.idle`; breaks the streak once |
| `session.idle` | happy | ends the turn (`turnEnded`; `stopped` only for a child) |

The adapter's `TOOL_ALIASES` map `question` → `AskUserQuestion`, `plan_exit` → `ExitPlanMode` and `plan_enter` → `EnterPlanMode`.

**Every adapter (base-adapter.js):**

- **Identity.** `sessionId`/`modelName`/`editor` are coerced to text.
- **Timestamps** strictly increase within a process (`nextTimestamp`).
- **Hooks for subclasses.** `normaliseEvent` may return `{ skip: true }`, and `mapEvent` may return `breakStreak`.
- **Tool results.** `exitCode`/`interrupted` are passed to `classifyToolResult`.
- **Failed turns.** A `turnError` turn end keeps the error face without breaking the streak again (`failedTurnEnd`).
- **Payloads over 1 MB** reach the session file with their sticky fields, judged by their own event: only a tool end is checked for errors, and a tool start shows its tool.

### The Launcher

`launch.js` opens the renderer (`spawnRendererWindow`), then starts the editor through `buildEditorSpawn`. codex-wrapper uses the same spawn for codex.

- **`buildEditorSpawn`.** `node` runs as `process.execPath`. On win32 any other command gets `shell: true`, `quoteArg`'d args and `NoDefaultCurrentDirectoryInExePath=1`, so a project's own `codex.cmd`/`claude.cmd`/`codex.js` cannot shadow the tool.
- **`superviseEditor(child)`.** While the editor runs, it ignores the terminal's group signals (SIGINT/SIGQUIT on POSIX, SIGINT/SIGBREAK on win32), so Ctrl+C reaches the editor alone.
  - On POSIX it forwards SIGTERM/SIGHUP.
  - It exits with `editorExitCode(code, signal)`: the editor's code, or 128+N for a signal (1 if unknown).
  - A spawn `error` exits 1.

### Setup and `doctor`

**One resolver per editor config.** Setup writes, and doctor reads, through the same functions, each taking `(env, home)`: `claudeConfigDir`/`claudeSettingsPath`, `codexHome` and `opencodeConfigDir`/`opencodeConfigPath`. doctor once honoured `CLAUDE_CONFIG_DIR` while setup did not, and read an OpenCode path setup no longer wrote.

**Claude Code.** `node setup.js` merges `buildFaceHooks` into `claudeSettingsPath()`: `<CLAUDE_CONFIG_DIR>/settings.json`, else `~/.claude/settings.json`. That is Claude Code's own rule (2.1.300: `CLAUDE_CONFIG_DIR ?? ~/.claude`, resolved); an empty value counts as unset. `uninstall` and the `.bak` follow it.

- It writes a `.bak` first, aborts on unreadable or invalid JSON, and uses `writeJsonAtomic`. A leading BOM is skipped, as doctor skips it (`parseJsonText`), and not written back.
- It strips only our own commands (`isOurCommand`: our argv shape, a real event, optionally followed by shell plumbing such as `2>/dev/null || true`, `; true` or `# note`).
- An event is installed only when it holds exactly the command setup builds for it (`isInstalledCommand`, the user's shell suffix allowed); any other command of ours under that key (another path, another event's argument, a missing `--editor` tag) is a stray, removed or replaced (`installEventHooks`).
- It syncs `async` flags in place.

**Codex.** `setup.js codex` writes `<CODEX_HOME or ~/.codex>/hooks.json` (`codexHome(env)`). It then removes a Code Crumb `notify` line from the neighbouring `config.toml` (`removeCodexNotify`, `notifyRemoved`), and `uninstall` does the same.

- Only a key whose value names `codex-notify.js` is touched (`ourNotifyKeys`, a one-line key or an array over several lines), never a foreign notify. Comments are not the value, so `notify = [...]  # replaced codex-notify.js` is foreign.
- `config.toml` edits are textual: a `.bak` first, an abort on any read error but `ENOENT`, a BOM kept first, and the file's own line ending.
- Keys are found by a line scan (`tomlLines`) that tracks multi-line strings and open arrays/inline tables, so a `[` line inside a `"""` string is no table header and a `notify =` inside a string is no key.
- `setupCodexNotify` follows the same rules, and rewrites in place one of ours whose script is not this checkout's (a moved clone).

**OpenCode.** `setup.js opencode --install|--uninstall` edits the config OpenCode reads; without a flag it just prints instructions.

- **The directory** (`opencodeConfigDir`) is `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. That holds on Windows too, since OpenCode uses xdg-basedir off `os.homedir()` (1.18.21 binary).
- **The file** (`opencodeConfigPath`) is `opencode.json`, or an existing `opencode.jsonc` when there is no `opencode.json`. `OPENCODE_CONFIG` is deliberately unused.
- **JSONC.** `parseOpenCodeConfig` (pure) reads strict JSON, then JSONC; setup and doctor both use it. A strict-JSON config is rewritten. A JSONC config is edited textually: only the `plugin` member is rewritten, or added after `{` (past any comment that opens on the `{` line), so comments survive.
- **Comments in the list.** A comment **inside** the plugin list makes install and uninstall refuse, leaving the file byte-identical; install prints the entry to add by hand.
- **The key** is `plugin`, **singular**, and the `.bak` rule applies.

**`setup.js doctor`** (`npm run doctor`; `doctor({ home, env, log, now, nodeVersion, platform })`) is **read-only**.

- It makes no backups or prefs, cleans no quit flag, spawns no process, and never throws on a garbage file.
- Each line is `✓`, `!` plus a fix, or `·`. It exits 1 when it printed a `!`.
- It checks:
  - node ≥18 and on PATH;
  - the renderer (`isRendererAlive`, with the beat's age), autolaunch, and the quit flag;
  - the manual hooks in `claudeSettingsPath` (missing events, duplicates, a moved `update-state.js`, a command filed under one event that reports another);
  - the plugin (enabled, found via `<claudeConfigDir>/plugins/installed_plugins.json`, or older than this copy);
  - the plugin and manual hooks both installed;
  - the Codex hooks under `CODEX_HOME`, and a leftover notify line (`ourNotifyKeys`: exactly what setup would remove), or a notify-only script that no longer exists;
  - on Linux, when autolaunch would open the renderer, an in-process PATH lookup for the terminals `buildRendererCommands` knows (`doctorTerminals`);
  - the OpenCode entry, in `opencodeConfigPath` read as JSONC;
  - the newest hook write (warning past `DOCTOR_QUIET_MS`, 1h).
- With the plugin installed, it prints the plugin's renderer command.

## Development Commands

```sh
npm start              # Run the renderer (unified mode with orbital subagents)
npm test               # Run the test suite (node tests/run.js)
npm run demo           # Run the single-face demo
npm run demo:orbital   # Run the orbital subagent demo
npm run setup          # Install Claude Code hooks (default)
npm run setup:claude   # Install Claude Code hooks (explicit)
npm run setup:codex    # Codex native hooks into $CODEX_HOME/hooks.json (~/.codex), dropping a Code Crumb notify line
npm run setup:opencode # Print OpenCode integration instructions (see --install below)
npm run setup:openclaw # Show OpenClaw/Pi integration instructions
npm run setup:uninstall # Remove the manual Claude Code hooks (settings.json.bak first), the Codex hooks file and the notify line
npm run doctor         # Read-only health check; exits 1 on a problem
npm run launch         # Open renderer + start Claude Code
npm run launch:codex   # Open renderer + start Codex wrapper
npm run launch:opencode # Open renderer + start OpenCode
npm run launch:openclaw # Open renderer + start OpenClaw
npm run minimal        # Run renderer in minimal mode
npm run tmux           # Run renderer with tmux support

node tests/run.js [--serial] [--jobs=N] [--quiet] [filter...]   # e.g. node tests/run.js grid face
node setup.js codex-notify              # Codex's legacy turn-level notify channel (no npm script)
node setup.js opencode --install        # Add "plugin": ["<repo>/adapters/opencode-plugin.mjs"] to OpenCode's config
node setup.js opencode --uninstall      # Remove that entry again
```

To develop: `npm run demo` in one terminal and `npm start` in another (orbitals: `npm start` + `npm run demo:orbital`).

## Code Conventions

- **Strict mode**: Every file starts with `'use strict'`.
- **CommonJS**: `require()`, no ES modules, except `adapters/opencode-plugin.mjs`, which OpenCode's Bun loads as ESM.
- **Layout**: New modules go in `lib/`. The root holds only entry points run by path.
- **Header blocks and dividers**: Every file has a boxed comment header. Sections are separated by `// -- Section Name ---...` comments.
- **Silent failures in hooks**: Hook code (update-state.js, adapters) wraps all I/O in try-catch and never throws. A broken face must not interrupt the editor.
- **Atomic writes**: Never `fs.writeFileSync` a state, session, stats, prefs or settings file; use `writeJsonAtomic` from shared.js.
  - setup.js writes a `.bak` first, and aborts on unreadable or invalid JSON rather than replacing it.
  - The `config.toml` edits do the same, treating only `ENOENT` as "no config".
- **Whitespace and headers**:
  - No trailing whitespace anywhere. The CI gate covers js/mjs/md/json/yml, and `.editorconfig` trims all of them (test-release checks the two agree).
  - Boxed headers keep the `|` rail aligned to the `+===+` border.
  - Non-ASCII glyphs in code strings use `uXXXX` escapes, **control characters included; never a raw NUL**. grid.js's group-cache separator is `\u0000`, so git and ripgrep treat the file as text. Comments may use literal Unicode.
- **Cross-platform paths**: `process.env.USERPROFILE || process.env.HOME`, with backslashes normalized to forward slashes.
- **No external dependencies**: Node.js built-ins only (`fs`, `path`, `child_process`).
- **Line endings**: `.gitattributes` pins LF everywhere except `*.cmd` (CRLF for cmd.exe). `.editorconfig` mirrors it (2-space, LF).
- **Shebangs**: Shebang files carry the executable bit in the index: `launch.js`, `setup.js`, `update-state.js`, `renderer.js`, `demo/*.js`, `tests/run.js`, `code-crumb.sh`, and `adapters/*.js` except `base-adapter.js`. Test files have none (test-release checks this).

## Key Constants

| Constant | Value | Location |
|---|---|---|
| `FPS` / `FRAME_INTERVAL_MS` | 15 / 1000/15 ms | renderer.js |
| `LOW_POWER_FPS` / `LOW_POWER_FRAME_MS` | 4 / 250ms | renderer.js |
| `STATE_POLL_MS` | ~467ms | renderer.js (polled `checkState`) |
| `SESSION_POLL_MS` | 2000ms | renderer.js (async ring reload + watcher `check()`) |
| `WATCH_RETRY_MS` / `WATCH_RETRY_MAX_MS` | 500 / 8000ms | renderer.js |
| `IDLE_TIMEOUT` / `THINKING_TIMEOUT` / `SLEEP_TIMEOUT` | 8000 / 45000 / 60000ms | renderer.js, grid.js |
| `LONG_TOOL_HOLD_MS` | 10 min | renderer.js |
| `WAIT_HOLD_STALE_MS` | 30 min | renderer.js |
| `STARTUP_WINDOW_MS` / `STARTUP_STALE_MS` / `RUNTIME_STALE_MS` | 5000 / 15000 / 120000ms | renderer.js (`startupGate`) |
| `FUTURE_SLACK_MS` | 60000ms | renderer.js, grid.js (`isNewerWrite`) |
| `TMUX_POLL_MS` | 2000ms | renderer.js |
| `PERMISSION_CONFIRM_MS` | 8000ms | shared.js |
| `PERMISSION_CONFIRM_MIN_AGE_MS` | 5000ms | update-state.js |
| `ORDER_SLACK_MS` | 60000ms | update-state.js |
| `DONE_TOOL_IDS_MAX` | 16 | update-state.js |
| `SUBAGENT_MAX_AGE_MS` | 4h | update-state.js (missed-SubagentStop safety net) |
| `TRANSCRIPT_READ_BYTES` / `TRANSCRIPT_MAX_LINES` | 32768 / 200 | update-state.js |
| `SCAN_HEAD_BYTES` / `SCAN_TAIL_BYTES` | 16384 / 65536 | state-machine.js (string length) |
| `IDLE_GAP_MS` | 2h | state-machine.js |
| `LONG_TOOL_ESCALATE_MS` / `LONG_TOOL_SWEAT_MS` | 8000 / 20000ms | face.js |
| `WAIT_ESCALATE_MS` | 30000ms | face.js |
| `STATS_EVENT_FRESH_MS` | 10000ms | face.js (older streak breaks/milestones never react) |
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | face.js |
| `COMPLETION_MIN_SHOW_MS` | 1800ms | face.js |
| `MIN_DISPLAY_MS` | per-state table | face.js |
| `MAX_STATUS_NAME` / `MAX_DETAIL_W` | 16 / 36 | face.js |
| `MAX_SEGMENT_BLOCKS` | 5 | face.js (timeline) |
| `LOCK_WAIT_MS` / `LOCK_STALE_MS` / `LOCK_SPIN_MS` | 150 / 2000 / 2ms | shared.js (stats lock) |
| `PID_HEARTBEAT_MS` / `PID_STALE_MS` | 10000 / 60000ms | shared.js |
| `STALE_MS` | 120000ms | grid.js (session file purge) |
| `STOPPED_LINGER_MS` | 10000ms | grid.js |
| `ORPHAN_TIMEOUT` / `CHILD_ORPHAN_TIMEOUT` | 90000ms / 15 min | grid.js |
| `NO_PID_FILE_KEEP_MS` | 30 min | grid.js (a pid-less top-level file's purge) |
| `PID_PENDING_PROTECT_MS` / `PID_PROTECT_CAP_MS` | 30000ms / 1h | grid.js |
| `PID_CACHE_TTL_MS` / `SLACK_MS` | 60000 / 1000ms | grid.js |
| `MAX_ORBITALS` / `ORBIT_SPACING` | 8 / 1.2 | grid.js |
| `REPOSITION_MS` | 4000ms | grid.js |
| `MIN_SESSION_LIST_ROWS` / `MIN_SESSION_LIST_COLS` | 12 / 50 | grid.js |
| `SESSION_LIST_ENTRY_ROWS` | 4 | grid.js |
| `rotationSpeed` (instance field) | 0.007 rad/frame | grid.js (~1 revolution per 60s) |
| `INTER_GROUP_GAP` / `INTRA_GROUP_GAP` | 0.15 / 0.35 rad | grid.js |
| `TETHER_BRIGHTNESS` / `GROUP_LABEL_BRIGHTNESS` | 0.15 / 0.45 | grid.js |
| `CYCLE_WORK_STATES` / `CYCLE_INTERVAL` / `CYCLE_STALE_MS` | 5 states / 2500 / 3000ms | grid.js (only a face whose last write carried `synthetic: true`, never a `-agent-` orbital or `CYCLE_PROTECTED_STATES`) |
| `EXIT_GRACE_MS` | 3000ms | codex-wrapper.js |
| `MAX_FIELD` / `MAX_BATCH_BYTES` / `CHAIN_WAIT_MS` | 64 KB / 900 KB / 3000ms | opencode-plugin.mjs |
| `DOCTOR_QUIET_MS` | 1h | setup.js |
| `FILE_TIMEOUT_MS` / `IPC_GRACE_MS` | 5 min / 2000ms | tests/run.js |

## Environment Variables

**Renderer and hooks**

| Variable | Effect |
|---|---|
| `CODE_CRUMB_STATE` | Global state file path (default `~/.code-crumb-state`). Read by the hooks, tmux mode and `doctor`; the unified renderer ignores it. |
| `CLAUDE_SESSION_ID` | Session id (default `<editor>-<parent PID>`). |
| `CODE_CRUMB_MODEL` | Display name (`modelName`; default `claude`, adapters their own). A known `model` still outranks it. |
| `CODE_CRUMB_EDITOR` | Editor tag; beats `--editor`. |
| `CODE_CRUMB_NODE` | Node binary the OpenCode plugin spawns, resolved per spawn. |
| `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS` | Claude Code's switch for the 6 s permission notification. At `1`, `true`, `yes` or `on` (any case, trimmed: Claude Code's own parse), waits are written without `waitKind`. |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` enables agent teams and teammate orbitals. |
| `NO_COLOR` | Disables colour and the `t` key. |
| `MINIMAL_BOOT` | Same as `--minimal`. |
| `ENGMUX_PYTHON` / `PYTHON` | engmux's interpreter. |

**Setup**

| Variable | Effect |
|---|---|
| `CODEX_HOME` | Codex's config dir (default `~/.codex`), for setup, uninstall and doctor. |
| `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME` | Where setup and doctor look for OpenCode's config. `OPENCODE_CONFIG` is ignored. |
| `CLAUDE_CONFIG_DIR` | Claude Code's config dir (default `~/.claude`): the `settings.json` setup, uninstall and doctor use, and doctor's `plugins/installed_plugins.json`. |

**Test-only (set by `tests/run.js`)**

| Variable | Effect |
|---|---|
| `CRUMB_TEST_HOME` | The throwaway home; `createSuite()` refuses to run without it. |
| `CRUMB_TEST_FILES` | A `path.delimiter` list replacing the test files, for the runner's own tests. |
| `CRUMB_TEST_QUIET` | Set by `--quiet`. |

**Renderer CLI flags**

- `--minimal`: face and status only, with only `space` and `q`.
- `--no-color`.
- `--tmux`: writes a one-line status file instead of drawing.
  - `tmuxStatusLine(data, now, branchOf)` names the model (else `modelName`) and the branch from `gitBranch`, else from `getGitBranch(data.cwd)`. With no cwd there is no branch.
  - The pure `tmuxDisplayState` decays the state. `waiting` is held until `WAIT_HOLD_STALE_MS`, and an allowed prompt shows its `permState`. A stopped turn rests after `IDLE_TIMEOUT`, a tool after `LONG_TOOL_HOLD_MS`, and anything else after `THINKING_TIMEOUT`.
  - A failed read keeps the last line.

## Testing

### Automated Tests

Run `npm test`, or `node tests/run.js [--serial] [--jobs=N] [--quiet] [filter...]`. **Never run a test file directly.** `createSuite()` (tests/_harness.js) exits 1 unless `CRUMB_TEST_HOME` names the HOME that shared.js resolves, because a direct run would write the real `~/.code-crumb*` files under a live renderer.

**The runner.**

- **Parallel by default.** Each file runs as `run.js --child <file>`, up to `--jobs=N` at once (default `min(4, availableParallelism)`), slowest first.
- **Isolation.** Each child gets its own throwaway `HOME`/`USERPROFILE`/`CODE_CRUMB_STATE` plus `CRUMB_TEST_HOME`, removed afterwards. `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG` are unset, so setup can never reach a real editor config, and so is every variable the code reads that a developer's shell may hold (`CODE_CRUMB_EDITOR`, `CODE_CRUMB_MODEL`, `CODE_CRUMB_NODE`, `CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `MINIMAL_BOOT`, `NO_COLOR`, `ENGMUX_PYTHON`, `PYTHON`). Subprocess tests inherit this environment.
- **Output.** Each file's output is buffered and printed in list order, and its counts come back over IPC.
- **Failures.** A crash, a timeout (`FILE_TIMEOUT_MS`) or a non-zero exit after reporting counts as a failure. A load failure is counted, and the run goes on.
- **Serial mode.** `--serial` runs everything in one process with one home, and a single selected file also runs in-process.
- **Other flags.** `--quiet` prints only the summary. A filter that matches nothing exits 2.
- **CI** (`.github/workflows/test.yml`) runs `node --check`, the whitespace gate, and `node tests/run.js --quiet` on ubuntu/windows/macos × node 18/20/22.

**Counts.** **2715 tests across 17 files on win32**:

| File | Tests | File | Tests |
|---|---|---|---|
| test-shared | 51 | test-launch | 49 |
| test-state-machine | 664 | test-adapters | 312 |
| test-themes | 72 | test-transition | 31 |
| test-animations | 42 | test-emotions | 261 |
| test-particles | 49 | test-platform | 153 |
| test-face | 305 | test-subagents | 74 |
| test-grid | 396 | test-attention | 139 |
| test-accessories | 24 | test-release | 50 |
| test-teams | 43 | | |

**2728 on Linux/macOS**, which match each other. Three files are platform-conditional:

- **test-adapters** has 322 there. It adds 11 POSIX-only tests: the wrapper/engmux/demo SIGTERM and SIGHUP tests, the wrapper's late-event retirement and exit grace, and the OpenCode plugin's per-session ordering and turn-end drain, which need a shell-script stand-in for node. It drops 1 win32-only test, the `codex.cmd` shadow.
- **test-launch** has 50: 2 POSIX-only tests (Ctrl+C reaches the editor, SIGTERM is forwarded), minus the win32 `claude.cmd` shadow.
- **test-platform** has 155: 3 POSIX-only tests (backup modes, a read-only settings backup, the `code-crumb.sh` symlink), minus the win32 `shell:true` quoting round-trip.

Check the total. `test-shared.js › getIsWorktree` fails inside a git worktree by construction, because `.git` is a file there.

**Wall time.** A full run takes ~15 s in parallel and ~43 s with `--serial` on win32. **`test-adapters.js` sets the floor** at ~14 s on its own, because it spawns real `update-state.js` and adapter subprocesses. Use `node tests/run.js <filter>` while iterating. Treat the count as tests, not coverage.

| File | Covers |
|---|---|
| test-shared | `safeFilename`, display-width helpers |
| test-state-machine | `toolToState` for every editor; result classification (patterns, guards, exit codes, `trustSuccess`, echoed lines, scan windows, predicates, background launches); `shellIntent` and git options; diff counting; streaks; `classifyForeignSession`; `prettyModelName`/`agentTranscriptPath`; counter helpers; end-to-end `update-state.js` runs for subagents, SessionStart sources, async ordering, `firstSeenAt` |
| test-themes | colour math, all 23 states themed, `COMPLETION_LINGER`, thought pools |
| test-animations | eye and mouth functions |
| test-particles | all 16 styles, lifecycle, `fadeAll` |
| test-face | buffering and timing, the model on the status line, long-tool and waiting escalation, thoughts, streak/milestone freshness, the timeline |
| test-grid | orbit geometry and the layout sweep, joiners and the swap path, grouping, PID verdicts, the merged loader and junk purge, hostile files, permission settles, row 5, wide characters |
| test-accessories | accessory definitions and rendering |
| test-teams | team colours/labels/grouping, teammate routing by `agent_id`, the lead heal |
| test-launch | launcher logic, `--editor`, editor supervision and exit codes, the `.cmd` shadow |
| test-adapters | every adapter; codex-wrapper vs a fake `codex` (incl. `\| head`, legacy hooks); codex-notify, alone and beside the wrapper; the OpenCode plugin contract; PID liveness; provenance; `firstSeenAt` and neutral results; stats-lock contention; demo signal cleanup |
| test-transition | `SwapTransition` phases and `dimFactor` |
| test-emotions | shell commands → states, the timing table, `idleCascade`, waiting and `buildTitle`, `startupGate`, `needsRescue`, tmux, `splitKeys`; the renderer runtime via `runUnifiedMode` (watcher, allowed prompts, clock steps, failed reads, crash/exit restore, deadlines, low power) |
| test-platform | quoting, `writeJsonAtomic`, the spawn and stats locks, `isRendererAlive`, setup.js on temp configs (Codex notify and `CODEX_HOME`, OpenCode dir and JSONC), launch.js exit codes, `code-crumb.sh` via a symlink |
| test-subagents | `agent_id` attribution, per-agent model, the family heartbeat, the conducting hold, `ESCALATING_STATES` |
| test-attention | `pickMainSession` and the fields feeding it, adapter stamp rules, the main's model, the session list, `readState(path)`, permission-wait confirmation, `PermissionDenied`, informational notifications |
| test-release | packaging (require graph vs `"files"`), plugin manifests and `hooks.json` vs `HOOK_EVENTS`, npm scripts, the runner contract (via `CRUMB_TEST_FILES`), the direct-run refusal, `doctor` and its agreement with setup (`CLAUDE_CONFIG_DIR`, OpenCode's dir and JSONC, notify arrays), `.editorconfig` vs the CI whitespace gate |

**Conventions the suite relies on:**

- **`_harness.js`** (not itself a test file):
  - `createSuite()` returns `{ describe, test, done, passed, failed }`, and `test.async(name, fn)` (or a returned promise) is awaited.
  - `makeTempEnv(sessionId)`/`cleanup(tmp)`/`readJSON(path)` serve subprocess tests.
  - It owns the subprocess runners, so use them, not a local copy.
    - `runUpdateState(event, input, env, { args, strict, timeout })` runs one hook. Objects are JSON-encoded and strings go in raw, so `''` reaches the catch path. Only a non-zero exit or a signal (a hook killed by its timeout) fails, unless `strict`.
    - `runFakeCodex(events, seedStats, args)` replays ThreadEvents through codex-wrapper's real spawn path.
- **Seams.**
  - For a definite PID verdict, seed `_pidStartCache` with a start time before the write, or install `grid._setPidResolver(fn)` (`null` restores the real one).
  - Renderer-runtime tests drive `runUnifiedMode(opts)` with a temp `sessionsDir`, a fake `watch`, manual `schedule`/`cancel`, captured `write`/`exit`, `installHandlers: false` and `start: false`.
- **Behaviour over source.** The remaining `source:` tests are deliberate lint tests for properties with no runtime observable (render-loop lint, adapter hygiene, autolaunch helpers, CLI paths the suite cannot drive portably). Don't add new ones where a behaviour can be driven.
- **A regression test must fail first.** Every review-pass test was checked against the pre-fix sources, in labelled blocks (`Third review pass`, `review fixes`, `round 3`, `round 4`, `review round 5`, `Review round 5 (docs-pass bugs)`). `CHANGELOG.md` says what each pass fixed.
- **"Today"** in a test is `localDay()`, never the UTC date.
- **Timing tests compare growth, not a flat budget.** A linear-time check times n against 8n (best of three, the sizes interleaved) and allows ×20: linear code measures ~×10, quadratic ×64. A loaded CI runner failed a flat 50ms budget. The round-3 fuzz tests keep a deliberately loose 250ms bound against a 1.4s regression.

### Visual Verification

Run `npm start` in one terminal and `npm run demo` (all 23 states) or `npm run demo:orbital` in another.

The demos write a `demo-main` **session** file stamped with `lastPromptAt`, because the main face follows session files. They unlink it on exit and on SIGINT, SIGTERM or SIGHUP. A demo killed with `SIGKILL` leaves a `demo-main` orbital until it goes stale.

## Important Constraints

- **Hook performance**:
  - update-state.js must finish in ~50ms.
  - Pre/PostToolUse/PostToolUseFailure are async. Every other event blocks the editor's hook pipeline.
  - The stats lock costs ~0.3ms median uncontended, and a failed acquire proceeds unlocked.
- **State file size**: a realistic write is ~750–950 bytes, and session files add the ordering fields. Keep writes around 1 KB, and never embed tool output.
- **Terminal minimum size**:
  - The main face needs 38x20 (`MIN_COLS_SINGLE`/`MIN_ROWS_SINGLE`). Below that it draws a "resize me" fallback and clears `lastPos`.
  - Orbitals have no fixed minimum: `computeOrbit` yields `maxSlots: 0`, and the side panel takes over.
  - Nothing may be written to the last cell of the last row.
- **Widths are terminal columns**:
  - File- or tool-sourced text (detail, task, label, cwd, branch, model, editor, thought) is measured with `strWidth` and cut with `sliceToWidth`/`sliceFromEndToWidth`.
  - Wide, Fullwidth and emoji code points are 2 columns (the coloured circles and squares, mahjong, cards and enclosed ideographs included). Combining marks, ZWJ, U+200B–200F and U+2060–2064, variation selectors, the BOM, emoji tags and Hangul vowel/final jamo (U+1160–11FF, U+D7B0–D7FF: NFD Korean measures like NFC) are 0.
  - `safeFilename` keeps `[A-Za-z0-9_-]` and at most 64 characters; a longer id keeps 55 plus `-` and 8 hex of sha1(id), so labelled agent ids (`a${label}-${hex16}`) stay distinct. `${parent}-agent-` prefix matching holds for parent ids up to 48 characters.
  - Every glyph the app draws is pinned at width 1 by a test.
- **No network**: all IPC is file-based.
- **Graceful degradation**: the renderer survives resizes, missing or unreadable files and stale sessions. An uncaught throw restores the terminal before exiting.

## Known Follow-ups

**Hooks (Claude Code 2.1.300):**

- **A user's "no" fires no hook.** Only the auto-mode classifier fires `PermissionDenied`. What follows a "no" is unchecked; if nothing arrives within 8 s, the refused tool shows as running until the next write.
- **Unverified: the interactive TUI dialog uses the same ask path as the 6 s timer.** The timer was read in the binary, and only `claude -p` was observed. If the TUI differs, a dialog left open past 8 s shows its tool running.
- **A prompt approved after the 6 s notification** shows `waiting` until its tool ends.
- **The truncated (>1 MB) PostToolUse path has no `trustSuccess`.** This affects the face only, not the streak.
- **Not handled:** `PostToolBatch`, `PreModelSwitch` and `UserPromptSubmit.source`.
- **Exec-form hooks** (`"command": "node", "args": [...]`) would skip Git Bash on 2.1.300, a real Windows latency win, but they break older Claude Code.
- **`TaskCompleted` fire sites changed.** In 2.1.280 `TaskUpdate` fired it for any session; in 2.1.300 only the teammate stop path does, per the binary. Re-check on the next bump.
- **Installs predating 1.3.0** lack `PermissionDenied` and the async flags (older ones also `PostModelSwitch`). `npm run setup` fixes them; `npm run doctor` reports missing events.

**Launcher and Windows:**

- **The `.cmd` shims still ask "Terminate batch job (Y/N)?"** (npm's shim and `code-crumb.cmd`; native `claude.exe` doesn't). That prompt is cmd.exe's, so Node cannot fix it.
- **The editor inherits `NoDefaultCurrentDirectoryInExePath`.** A bare `foo.bat` no longer resolves from the cwd under cmd, as in Claude Code's own shell. The regression test unsets the variable first, since Claude Code exports it.
- **Unverified: the autolaunch `wt -w 0 new-tab` may steal focus** from the editor's tab. `wt -w new` would avoid it.
- **Unverified: the `wt` `\;` escape on a live Windows Terminal.** It is unit-tested only.
- **`quoteArg` (win32 `shell: true`) cannot neutralise `!VAR!`** under registry-enabled delayed expansion (off by default for `cmd /c`). Other metacharacters are quoted: `"` → `""`, `%` → `"^%"`, line breaks → spaces. `wtEscape` turns `;` into `\;`, because wt splits on `;` even inside quotes.
- **Hook paths are only double-quoted.** A checkout path containing `$` or a backtick is expanded by a POSIX shell, but escaping `$` would break cmd.exe.
- **An old renderer running across an upgrade never heartbeats.** On win32, autolaunch can open a second face once, so restart the renderer after upgrading.

**Adapters:**

- **`engmux-adapter.js` spawns python without `shell: true`.** A `.cmd` shim or a Store python alias cannot run.
- **engmux has no setup or launch entry point.** It is also not wired to `model`; that is one line plus the `'engmux'` sentinel filter that `tests/test-adapters.js` pins.
- **codex-wrapper's spawn-`error` path** exits without a final session write. This is harmless while only the global file exists.
- **A notify-only Codex session never stamps `lastPromptAt`**, so it reaches the center only uncontested. With hooks, codex-notify carries their stamp.

**Models and subagents:**

- **A subagent's model comes from an undocumented JSONL format.** A shape change costs only the orbital's model. `subagentStatusLine` exposes one, but would take over that UI row.
- **A background agent's `async_launched` result carries `resolvedModel`.** It could replace the transcript scrape, but isn't used yet.
- **`SubagentStart` has no task text** (`{agent_id, agent_type}`, an open upstream docs bug). `subagentLabel` therefore always falls back to `agent_type` for Claude Code.
- **A lone subagent vanishes at 120s during a long model turn.** Only agent writes heartbeat the parent, so a silent one-agent family caps at `STALE_MS`. This is accepted: on win32 a long think looks exactly like a crash, and a ghost faking work for 15 min would be worse. Multi-agent families are fine, and on Unix the editor's pid covers `CHILD_ORPHAN_TIMEOUT`.
- **A real agent orbital never fakes activity.** When silent it goes thinking → idle → sleeping.
- **`MAX_ORBITALS` is 8.**
- **Unverified: a teammate running as its own process may take the center.** Its `SessionStart` would stamp a top-level file, and an `agent_id`-routed `TeammateIdle` leaves that file a candidate. This was seen only with synthetic hooks.
- **`UserPromptSubmit`/`Stop` register a session as top-level**, so a legacy host whose subagents `Stop` under their own id would register them as windows.

**Renderer and stats:**

- **`pickMainSession` ranks by raw `lastPromptAt`.** After the clock steps back, an older prompt keeps the center until the clock catches up. Low priority.
- **`daily.cumulativeMs` sums per-session time**, so concurrent windows add up.
- **A cross-terminal flicker check of the per-frame full clear** is still pending, by eye.
- **Four `StopFailure` branches are unasserted:** `max_output_tokens`, `authentication_failed`, `billing_error` and the `'API error'` default.
- **A state file without a `timestamp` is never applied.** Every writer stamps one.
- **`docs/` is gitignored.** The attention-main spec and plan in `docs/superpowers/` won't survive a fresh clone.
