# CLAUDE.md

## Project Overview

Code Crumb is a zero-dependency terminal tamagotchi that visualizes what AI coding assistants are doing in real-time. It renders an animated ASCII face that reacts to lifecycle events (thinking, coding, reading, executing, errors, etc.) via hooks, adapters, and file-based IPC. Supports **Claude Code**, **OpenAI Codex CLI**, **OpenCode**, **OpenClaw/Pi**, and any tool that can pipe JSON events.

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
| `Enter` | Promote selected orbital to main (dissolve/swap/materialize animation) |
| `h` / `?` | Toggle help overlay |
| `q` / Ctrl+C | Quit |

Any key closes the help overlay or the session list (so `h`/`?` is not a strict toggle once open). `Enter` on row 0 of the session list un-pins the main face and resumes auto-swap; rows > 0 promote. Minimal mode (`--minimal` / `MINIMAL_BOOT=1`) disables every key except `space` and `q`.

### Color Palettes

6 palettes: **default** (original colors), **neon** (high saturation cyans/magentas/limes), **pastel** (soft pinks/lavenders/mints), **mono** (greyscale), **sunset** (warm oranges/reds/golds/purples), **highcontrast** (accessibility palette). Press `t` to cycle. All togglable preferences (theme, accessories, stats, orbitals) persist between sessions via `~/.code-crumb-prefs.json`. Indicators below the face box show `● accs` / `○ accs` and `● subs` / `○ subs`.

## Tech Stack

- **Runtime**: Node.js 18+ (no npm dependencies)
- **Language**: JavaScript (ES6+, CommonJS modules, strict mode)
- **Platforms**: Windows, macOS, Linux
- **Terminal features**: 24-bit ANSI RGB color, Unicode box-drawing characters, cursor positioning

## File Structure

```
renderer.js      Entry point — runtime loops, PID guard, state polling, re-exports for tests
themes.js        ANSI codes, color math, theme definitions, thought bubble data
animations.js    Eye and mouth animation functions (full-size and grid)
particles.js     ParticleSystem class — 16 visual effect styles (incl. stream, fire, bigquestion)
face.js          ClaudeFace class — main face state machine, rendering, orbital toggle
grid.js          MiniFace + OrbitalSystem classes — subagent orbital rendering
transition.js    SwapTransition class — dissolve/swap/materialize animation state machine
accessories.js   Accessory definitions (hats, glasses, ears, etc.) and rendering helpers
update-state.js  Hook handler — receives editor events via stdin, writes state files; takes `[--editor <name>] <Event>`
state-machine.js Pure logic — tool→state mapping (multi-editor), error detection, diff counting, streaks
shared.js        Shared constants — paths, face state sets, prefs, atomic JSON writes, spawn lock, stats lock, shell quoting, buildRendererCommands
launch.js        Platform-specific launcher — opens renderer + starts editor (--editor flag)
setup.js         Multi-editor setup — installs hooks (setup.js [claude|codex|codex-notify|opencode|openclaw|uninstall] [--autolaunch]; opencode also takes --install/--uninstall). `uninstall` removes both the Claude Code hooks and the Codex hooks file. setupClaude/uninstallClaude, setupCodex/uninstallCodex/buildCodexHooks, setupOpenCode/uninstallOpenCode and buildFaceHooks are importable
test.js          Test runner — isolates HOME, loads 15 test files from tests/ (1974 tests); --quiet, name filters
demo.js          Demo script — cycles through all face states in single-face mode
grid-demo.js     Orbital demo — simulates subagent sessions orbiting the main face
code-crumb.sh   Unix shell wrapper for launch.js
code-crumb.cmd  Windows batch wrapper for launch.js
adapters/
  base-adapter.js    Base adapter class with shared functionality for all adapters
  codex-wrapper.js   Wraps `codex exec --json`, parsing the real ThreadEvent schema (thread/turn events plus typed items) for tool-level face events; headless runs only
  codex-notify.js    Codex's legacy turn-level `notify` channel
  opencode-plugin.mjs  The shipped OpenCode plugin (ESM, loaded by OpenCode's Bun runtime); the pure `translate()` rides on the factory
  opencode-adapter.js  Adapter for OpenCode plugin events (stdin JSON)
  openclaw-adapter.js  Adapter for OpenClaw/Pi agent events (stdin JSON)
  engmux-adapter.js  Adapter for engmux agent dispatcher events (stdin JSON); `extractModel`/`extractEngine` are importable behind a `require.main === module` guard
tests/
  _harness.js      Shared describe/test/test.async runner + temp-home helpers (createSuite, makeTempEnv)
  test-shared.js, test-state-machine.js, test-themes.js, test-animations.js,
  test-particles.js, test-face.js, test-grid.js, test-accessories.js,
  test-teams.js, test-launch.js, test-adapters.js, test-transition.js, test-emotions.js,
  test-platform.js, test-subagents.js
.claude-plugin/
  plugin.json      Claude Code plugin manifest for marketplace distribution
  marketplace.json Marketplace listing (source "." so the plugin cache holds the whole repo)
plugin.json        Byte-identical copy of .claude-plugin/plugin.json at the root — the plugin cache reads it from here (commit 5ac4340); keep both in sync
hooks/
  hooks.json       Hook configuration for Claude Code plugin system (21 events)
AGENTS.md          Stub pointing agents at this file (a second copy drifted; do not resurrect it)
README.md, LICENSE, package.json ("files" whitelist keeps tests/demos/images out of the npm tarball)
images/            README screenshots (only referenced images are kept)
.github/workflows/
  test.yml         CI — node --check over `*.js` and `*.mjs`, the trailing-whitespace gate, then npm test on ubuntu/windows/macos × node 18/20/22
```

## Architecture

### Event Flow

```
Claude Code hook  ─┐
Codex native hook ─┴→ update-state.js (--editor <name>)  ─┐
OpenCode          ──→ opencode-plugin.mjs → opencode-adapter.js  ─┤
OpenClaw / engmux ──→ adapters/*.js                              ─┴→ State File (JSON) → renderer.js (fs.watch) → Terminal Output
```

Claude Code and Codex CLI share **one** hook handler: Codex has native hooks (`~/.codex/hooks.json`) with Claude-Code-shaped payloads, so `node setup.js codex` registers `update-state.js` with an `--editor codex` tag on every command. Precedence for the `editor` field is `CODE_CRUMB_EDITOR` env > `--editor` arg > `claude`, and `modelName` defaults to the editor (a codex hook says "codex is coding"). `update-state.js` also falls back to the payload's own `hook_event_name` when no event positional is passed.

### File-Based IPC

State is communicated between the hook handler and renderer via JSON files:

- `~/.code-crumb-state` — single-mode state (written by update-state.js, watched by renderer.js)
- `~/.code-crumb-sessions/{session_id}.json` — per-session state for orbital subagents. Sticky fields set once and preserved across later writes: `taskDescription`, `parentSession`, `agentType`, `editor` (see Editor Provenance) and the team fields. A Claude Code subagent's file is named `{parentSession}-agent-{agentId}.json` (see Subagent Attribution).
- `~/.code-crumb-stats.json` — persistent stats (streaks, records, session counters)
- `~/.code-crumb-prefs.json` — persisted user preferences (theme, accessories, stats, orbitals toggle)
- `~/.code-crumb.pid` — renderer process liveness tracking
- `~/.code-crumb-spawn.lock` — autolaunch spawn lock: when the renderer is down, parallel hooks all notice at once; `acquireSpawnLock` (O_EXCL, 5s staleness) lets exactly one of them open a terminal
- `~/.code-crumb-stats.lock` — stats read-modify-write lock: parallel tool calls fire parallel hooks that all read-modify-write the shared stats file; `acquireFileLock` (O_EXCL, 150ms wait, 2s staleness) serializes them so no counter increment is lost. A hook that cannot get the lock in time proceeds unlocked rather than stalling the editor.

Every state/session/stats/prefs write goes through `writeJsonAtomic` (temp file + rename, direct-write fallback) so the watching renderer never reads a half-written file. The stats file's read-modify-write cycle is serialized behind `~/.code-crumb-stats.lock` (`acquireFileLock` / `withStatsLock` in shared.js), so parallel hooks no longer lose counter increments; atomic writes still prevent corruption. A hook that cannot take the lock within `LOCK_WAIT_MS` proceeds unlocked — the lock is a courtesy, never a reason to stall the editor or skip the hook's work.

#### Editor PID Liveness

State file writes include a `pid` field — the writer's parent PID (`process.ppid`) for per-event hook processes (codex-notify; update-state.js on Unix), or the adapter's own PID for long-lived wrappers (codex-wrapper). **On win32, update-state.js and the adapters (`pidField()` in base-adapter.js) write no `pid` at all**: the hook's ppid there is a transient `cmd.exe` shim that dies within milliseconds — useless for protection and a prime PID-recycling target — so those sessions rely on staleness timeouts (`ORPHAN_TIMEOUT`/`STALE_MS`).

PID liveness is **identity-checked**, not just existence-checked: `isOwnedByLiveProcess(pid, lastWriteMs)` in grid.js only lets a PID protect a session if the process's **start time predates the session's last write** (+1s slack) — a recycled PID always fails this because its process was born after the original writer died. Start times resolve asynchronously in a per-PID cache (batched PowerShell on Windows, `/proc` on Linux, `ps` on macOS; one outstanding exec at a time; 60s TTL closes the live→live recycle gap). The platform resolver is swappable through `_setPidResolver` (a test-only seam; resetting it also clears the in-flight latch and queue, since `test.js` runs every test file in one process). Unresolved (`pending`) PIDs are protected as a safe default; unreadable start times (Access-Denied on elevated/protected processes) or missing exec capability protect only up to a 1-hour cap past the last write — a real editor refreshes its session file with every hook, so its orbital self-heals on the next write, while a ghost recycled onto a protected process must not be immortal.

The renderer uses the armed-PID mechanism to detect a crashed editor: a candidate PID is **armed** only if it is still alive 2.5s after first being seen in a write AND its start time predates the reporting write (arming defers while resolution is pending). When an armed PID dies without a Stop event, a sticky `editorDead` flag triggers the rescue cascade (responding → happy → idle) and allows a new session to be adopted as main. A write newer than anything applied clears a false `editorDead` (PID-reuse guard).

#### Subagent Attribution (`agent_id`)

`agent_id` routing comes first and is authoritative. Every hook fired inside a Claude Code subagent carries the **parent's** `session_id` plus `agent_id` and `agent_type` — so without reading `agent_id`, an agent's entire turn lands on the main face. Such an event is routed to `~/.code-crumb-sessions/{parentSession}-agent-{agentId}.json` (`subagentSessionId`), never to the global state file and never to the parent's own session file, and the `classifyForeignSession` heuristic below is skipped entirely.

Stats accounting is deliberately unchanged: a subagent's tool calls still count toward the owning session's `toolCalls`, `frequentFiles` and streak — the face routing is what moved, not the bookkeeping.

The ten events in `AGENT_EXCLUDED_EVENTS` (`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Setup`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`) keep their own handlers even when they carry `agent_id`. `Stop` is deliberately **not** in that set: a `Stop` carrying `agent_id` is the subagent's own turn ending, so it writes `responding` / `wrapping up` to that agent's orbital without `stopped`, and leaves the parent's records and the global state file alone. `SubagentStop` remains the retirement signal.

**Family heartbeat.** A subagent emits no hooks at all during a model turn, and a parent waiting on its agents emits none either — so mtime staleness alone cannot tell a live family from a crashed one (on win32 there is no `pid` to break the tie). The heartbeat runs **child → parent only**: every agent event stamps the **parent's** session file (`_touchSessionFile`) without rewriting it. "Parent file fresh" therefore means the family is alive, and a child orbital only earns the long `CHILD_ORPHAN_TIMEOUT` (15 min) window while its parent's file is fresh; a crashed parent goes stale on the normal `ORPHAN_TIMEOUT`/`STALE_MS` schedule and takes its ghost orbitals with it.

The parent → child direction is deliberately **not** symmetric. `_touchActiveSubagents` touches only the *legacy synthetic* entries (an `activeSubagents` entry with no `agentId`, from a `SubagentStart` that carried none): those have no writer of their own, so the parent — which already writes their state via `_writeSubagentToolState` — must keep their mtime alive too. An **agent-owned** entry is skipped, because a child must never be kept alive solely by its parent's activity. Composed with `grid.js`'s `updateFromFile` accepting a newer mtime on unchanged content, a bare touch alone made `isStale()` false, so a missed `SubagentStop` left a ghost orbital that the parent's own tool calls revived for the full `SUBAGENT_MAX_AGE_MS` window — and pinned the main face at `conducting N` for four hours.

**Conducting hold.** Because agent events no longer write globally, nothing refreshes the main state file between `SubagentStart` and `SubagentStop`. `idleCascade` therefore takes `liveChildren` (from `OrbitalSystem.liveChildCount()` — children of the main session that are neither stopped nor stale, recomputed per read) and substitutes `subagent` / conducting for what would otherwise be a downward transition to `idle`/`sleeping`/`thinking`. Rewards, real work states and the long-tool hold all pass through untouched, and `waiting` outranks conducting while it lasts (an actionable "the editor needs YOU" must not be masked by ambient "your agents are busy"). Minimal mode passes 0.

#### Parallel Session Classification (legacy, no `agent_id`)

This heuristic is now the fallback path, for hooks that arrive without `agent_id`. The shared stats file has a single `session` owner, so a hook arriving from a different session id while the owner has `activeSubagents` used to be classified as that owner's subagent unconditionally — misclassifying unrelated parallel editor windows (sticky wrong `parentSession`, stolen `taskDescription`, frozen stats, blocked main-face ownership, and false retirement of the real subagent's synthetic orbital). `classifyForeignSession` (state-machine.js) now distinguishes the two: a foreign session is **parallel** (independent top-level) if it appears in the `stats.topLevelSessions` registry (populated at `SessionStart`, which real subagents never fire; 7-day TTL, 200-entry cap via `pruneTopLevelSessions`), or if its session file's birthtime predates the earliest active subagent's `startedAt` (a real subagent's file cannot exist before its own spawn). Unknown birthtime (unsupported filesystem) falls back to subagent classification, so real subagent grouping never regresses. Parallel sessions do not steal `stats.session` while the owner is conducting, do not count into the owner's counters, and do not propagate tool state onto subagent orbitals. Top-level sessions (the stats owner, or a classified parallel session) carrying a stale `parentSession`/`taskDescription` stamp are healed on their next write; teammates keep their legitimately-set fields.

#### Editor Provenance

Every state/session write carries an `editor` field (claude/codex/opencode/openclaw/engmux) distinct from `modelName`: update-state.js writes `CODE_CRUMB_EDITOR || 'claude'`, adapters write their own identity, and engmux-adapter writes the `-E`/`--engine` dispatch target. The field is sticky (preserved by `STICKY_FIELDS`, the global owner guard, `guardedWriteState`, and `buildSubagentSessionState`). Fallback session IDs are editor-prefixed (`opencode-47040`, not bare `47040`) so anonymous sessions are self-describing and never collide across editors — update-state.js mints the same `FALLBACK_SESSION_ID` in both its try and catch paths so one session never splits into two orbitals. On the read side, `MiniFace.updateFromFile` derives `editor` best-effort for legacy files (modelName-as-editor, then ID prefix). The session list (`l`) shows each session's editor tag dimmed on row 1 and prefers the full `taskDescription` on row 3.

### State Machine

23 face states: `idle`, `thinking`, `responding`, `reading`, `searching`, `coding`, `executing`, `happy`, `satisfied`, `proud`, `relieved`, `error`, `sleeping`, `waiting`, `testing`, `installing`, `caffeinated`, `subagent`, `starting`, `spawning`, `committing`, `reviewing`, `training`.

States have minimum display durations enforced via a `pendingState` queue to prevent visual flashing. The timings live in one exported table at the top of face.js (`MIN_DISPLAY_MS`): **work** states are short (coding/committing/reviewing 1500ms; reading/searching/executing/testing/installing 1200ms; subagent/spawning 2000ms; training 2500ms) because every PreToolUse refreshes them anyway, while **reward** states (happy 4000, proud 4500, satisfied/relieved 2500) and error (4000) are long because they are the emotions the user actually wants to see; responding keeps 3000 (#67).

`COMPLETION_MIN_SHOW_MS` (1800ms) is the guaranteed on-screen window for a reward face. Inside it nothing but an error replaces it — the next work state is buffered and a newer completion is queued, not shown. After the window, whatever is queued flushes (`_flushPending`), so a reward never sits for its full min display while something newer waits. Work that arrives while a completion is already queued is remembered in `pendingWork` and promoted to `pendingState` when that completion lands, so a long-running tool is never lost behind a reward face; a completion arriving clears `pendingWork` (its tool is finished). Completions never bypass active work — they queue and show when the tool finishes. Same-state writes refresh `lastStateChange` and the detail text, so a reward face stays up with live detail while a burst of identical completions lands. `face.forceState(state, detail, minMs)` applies a state immediately, skips the buffering rules, drops the queue, and records the change for caffeine detection — the renderer's rescue paths (missed Stop, dead editor) use it.

The state sets `ACTIVE_WORK_STATES`, `COMPLETION_STATES`, and `INTERRUPTIBLE_STATES` are defined once in shared.js and imported by face.js, grid.js, and renderer.js; the renderer's `FRESH_READ_STATES` (states worth a fresh file read for a missed Stop) is derived from them so a new work state can never be forgotten there.

#### The Timeout Cascade (`idleCascade`)

`idleCascade` is pure and exported from renderer.js, so the whole timeout cascade is table-tested. It decides what a face does when no new write has arrived, and it carries three holds:

**Long-running tools.** A tool call can outlive the hook cadence — one `Bash` can run for minutes with no further event — so a work face is no longer degraded to `thinking` on the 8s `IDLE_TIMEOUT` alone. The work state is held while the state file still names that same unfinished tool and the session is active, up to `LONG_TOOL_HOLD_MS` (10 min). `responding` is excluded: it is in `ACTIVE_WORK_STATES` but is a post-turn state, never a tool. The renderer tracks the file's state in `lastAppliedState` alongside `lastAppliedTimestamp` for that comparison. Instead of the face going stale the **detail line escalates**: after `LONG_TOOL_ESCALATE_MS` (8s) `ClaudeFace#displayDetail()` appends `still running … Ns` (`render()` truncates the base detail, never the suffix), and after `LONG_TOOL_SWEAT_MS` (20s) sweat particles start.

Escalation is gated on `ESCALATING_STATES` (face.js), **not** on `ACTIVE_WORK_STATES` — the latter answers a different question (what may interrupt what), and borrowing it timed two states that are not tool calls. It is `ACTIVE_WORK_STATES` minus `NON_TOOL_WORK_STATES` (`responding`, `subagent`), derived by subtraction so a genuinely new work state is covered by default. `responding` is a post-turn state, which `idleCascade` already excludes from the hold for the same reason. `subagent` is written by `SubagentStart` and then re-asserted every frame by the conducting hold for as long as agents run, so a multi-agent session used to render `conducting 3 · still running … 240s` and sweat permanently. A `subagent` written by a real `Agent`/`Task` call *is* a running tool, but distinguishing the two is not worth it: each agent now has its own orbital showing its own live state, so a counter on the main face duplicates what is already on screen — while getting it wrong means hours of false distress.

**Waiting on the user.** `waiting` is held regardless of `sessionActive` and with no display-time cap, because an `idle_prompt` notification arrives *after* Stop — the face waits as long as the user does. Past `WAIT_ESCALATE_MS` (30s) it escalates: `displayDetail()` appends the elapsed seconds, `update()` swaps the small `question` particles for 2 bold `bigquestion` every 20 frames, `render()` pulses the status line bold+accent on a ~0.5s cycle, and the renderer flashes `? WAITING FOR YOU` in the terminal title on the same cycle via the exported pure `buildTitle(modelName, status, flash)`. The frame dedupe key is `title + output`, so a blink with an unchanged body still gets written. The one bound on this hold is **write silence**, not display time: once the editor has produced no new write for `WAIT_HOLD_STALE_MS` (30 min) the face degrades to idle. That bound is platform-independent and needs no `pid`, which matters because on win32 nothing else can distinguish a crashed editor from a patient one. It measures silence, not death — a genuine 31-minute wait drops to idle and recovers on the next write. The clock comes from `noteNewWrite(ts, lastTs, now, lastAt)`, which advances only when a write's own JSON `timestamp` moves forward, so the renderer's 2s forced re-read of an unchanged file cannot fake freshness.

**Conducting.** See Subagent Attribution — `liveChildren > 0` substitutes `subagent` for a downward transition.

### Hook Events

Twenty-one hook event types are handled: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `UserPromptSubmit`, `TeammateIdle`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `PermissionRequest`, `Setup`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`. Tool names from all supported editors are mapped to face states via shared regex patterns (e.g., Edit/apply_diff/file_edit → coding, Grep/search_files/codebase_search → searching, Bash/shell/terminal → executing) — see Multi-Editor Tool Mapping. PostToolUse includes forensic error detection with 39 regex patterns (30 stdout, 9 stderr) guarded by 14 false-positive patterns, and honours the `interrupted`, `isError`/`is_error`, and numeric `exitCode`/`exit_code` fields that `normalizeToolResponse` carries through — an Esc-interrupted command shows `error / "interrupted"`, not `relieved / "command succeeded"`. Edit diff counts come from Claude Code's `tool_response.structuredPatch` when it is present (`diffFromPatch` sums the `+`/`-` lines across hunks, so a same-length replacement reports `+1 -1`, not `+2 -2`); when no patch is available — other editors, `Write` to a new file — `diffFromInput` falls back to counting the edit's own inputs, including `MultiEdit`'s `edits[]` and `NotebookEdit`'s `new_source`. Only the two totals reach the state file; the patch itself is never persisted.

**Which editors fire what.** Claude Code fires all 21. Codex CLI's native hooks cover 10 of them (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`) — it has no `Notification` and no `PostToolUseFailure`, so `setup.js codex` registers exactly those ten (`CODEX_HOOK_EVENTS`). Codex hooks need a one-time trust confirmation; `--dangerously-bypass-hook-trust` skips it in automation.

The newer hook events map to existing face states: `PreCompact` → thinking (with rain particles), `PostCompact` → satisfied, `PermissionRequest` → waiting (with question particles), `Setup` → starting, `Elicitation` → waiting (with question particles), `ElicitationResult` → satisfied/relieved, `ConfigChange` → reading, `InstructionsLoaded` → reading, `StopFailure` → error (breaks streak). Of these, `PermissionRequest`, `Elicitation`, and `ElicitationResult` are per-session interactive events that route to orbital files in subagent context; the remaining 6 are system-level events excluded from subagent routing via the `LIFECYCLE_EVENTS` Set. `WorktreeCreate`/`WorktreeRemove` are intentionally not registered because they replace default git worktree behavior.

`UserPromptSubmit` → thinking (`reading your message`): the user just sent a prompt, so Claude is thinking before its first tool call — without it the face sat on happy/idle from the last Stop. The write carries no `stopped`, which also flips the renderer back to the active 45s thinking timeout. `Notification` is differentiated by `notification_type`: `permission_prompt` → waiting `allow?` (question particles), `idle_prompt` → waiting `waiting for you`, `elicitation_dialog` → waiting `needs input`, `auth_success` → satisfied `signed in`, anything else → waiting `needs attention`. The catch path (unparseable stdin) and `classifyTruncatedInput`'s event map cover the same events, including `UserPromptSubmit`, `TeammateIdle`, and `TaskCompleted`.

`SubagentStart` carries `agent_id`, `agent_type`, `invocation_prompt` and `invocation_method` (there is no `description`, `prompt`, `agent_name` or `subagent_id`). `SubagentStop` carries `agent_id`, `agent_type` and `last_assistant_message`, and is matched by `agent_id` first, then a legacy `subagent_id`, and only FIFO when neither is present — so agents finishing out of order retire the right orbital.

`TeammateIdle` and `TaskCompleted` are agent-teams-specific events (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). They write session files with `teamName`, `teammateName`, and `isTeammate: true` fields so team members appear in the orbital display with their designated name and a team-specific accent color.

### Orbital Label Priority

Each orbital subagent face displays a per-face label (max 8 chars). Priority order: `teammateName` > `taskDescription` > cwd basename > `modelName` > `sub-N`. The `taskDescription` field is set once at `SubagentStart` and preserved across all subsequent session file writes; it comes from `subagentLabel` — the first non-empty line of `description` / `invocation_prompt` / `prompt`, whitespace-collapsed, ≤ 40 chars with a trailing ellipsis — falling back to `agent_type`, then the literal `subagent`. A sticky `agentType` field carries the Claude Code agent type (`Explore`, `Plan`, `general-purpose`, a custom agent name) and is used as the orbital's `modelName`. The live tool detail (e.g., "edit foo") shows separately below the label.

Floating group labels (max 12 chars) use a separate priority chain via `_getGroupLabel`: `teamName` > shared non-default git branch > shared cwd basename > first member's `taskDescription` > first member's face label. Default branches (`main`, `master`, `develop`, `dev`) are excluded from the branch tier.

### Orbital Grouping

Orbital faces that share a group key (`teamName || parentSession || sessionId`) are visually clustered through four layers:

1. **Cluster positioning** — group members occupy adjacent angular sectors on the ellipse (`INTRA_GROUP_GAP = 0.35 rad`) with larger gaps between groups (`INTER_GROUP_GAP = 0.15 rad`). Pixel-aware minimum spacing ensures faces don't overlap even on small ellipses.
2. **Group tethers** — dim dashed `·` lines chain sequential siblings (A→B, B→C) at `TETHER_BRIGHTNESS = 0.15`; team groups use the team accent color. Tether dots skip ALL face bounding boxes (not just endpoints). Spawning faces are excluded from tether segments.
3. **Floating group labels** — short label text positioned below each multi-member cluster at `GROUP_LABEL_BRIGHTNESS = 0.45`. Team groups show the team name; non-team groups select via priority chain: shared git branch > shared cwd basename > first member's taskDescription > first member's face label (see Orbital Label Priority). Spawning faces are excluded from label extent calculation. Labels skip the main face exclusion zone.
4. **Overlap resolver** — post-position iterative nudge pass (max 3 iterations) that detects bounding box collisions between orbital faces and pushes them apart, re-clamping to terminal bounds.

Singleton groups (one member) get no tethers or labels. When all faces are ungrouped, spacing degrades gracefully to near-even distribution identical to pre-grouping behavior.

### Multi-Editor Tool Mapping

Tool name patterns are defined as shared constants (`EDIT_TOOLS`, `BASH_TOOLS`, `READ_TOOLS`, `SEARCH_TOOLS`, `WEB_TOOLS`, `SUBAGENT_TOOLS`, `REVIEW_TOOLS`, `ASK_TOOLS`, `SKILL_TOOLS`, `PLAN_TOOLS`, `PUBLISH_TOOLS`) in `state-machine.js`. Each pattern matches tool names from Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi, including the current Claude Code set: `NotebookEdit` → coding; `NotebookRead`/`ReadMcpResourceTool`/`ListMcpResourcesTool` → reading; `LS`/`ToolSearch` → searching (`LS` with a path shows `listing <dir>`); `KillShell`/`BashOutput`/`EnterWorktree`/`ExitWorktree` → executing; `AskUserQuestion` → waiting `asking you` (question particles) then satisfied `got your answer`; `Skill` → reading `skill: <name>` then satisfied `skill loaded`; `TodoWrite`/`EnterPlanMode`/`ExitPlanMode` → thinking `planning` and `CronCreate`/`CronList`/`CronDelete`/`ScheduleWakeup` → thinking `scheduling`, both → satisfied; `Workflow`/`SendMessage`/`ListAgents`/`TaskOutput`/`TaskStop`/`Monitor` → subagent (`orchestrating` / `messaging an agent` / `checking on agents`), and a returning `Agent`/`Task`/`Workflow`/`TaskOutput` → happy `agent done` (the others → satisfied `checked in` / `message sent`); `ReportFindings` → reviewing then satisfied `reviewed`; `Artifact`/`SendUserFile` → coding `publishing` / `sending a file` then proud `published` / `sent`. `patch` is an edit tool (it was unreachable in `REVIEW_TOOLS`).

MCP tools (`mcp__<server>__<tool>`) are classified by verb: `read|get|list|fetch|describe|inspect|check|show|view|download|export|whoami|debug` → reading, `search|find|query|lookup` → searching, `create|update|write|modify|edit|insert|delete|remove|append|set|move|replace|format|batch|push|merge|upload|import|add|manage|resize|copy|draft` → coding, anything else → executing. The detail is `server: tool` with `plugin_` stripped, a doubled `x_x` collapsed (`plugin_github_github` → `github`), and underscores turned into spaces; completion is satisfied `<server> done`. Anything unmatched shows `humanizeToolName(name)` (`AskUserQuestion` → `ask user question`) instead of the raw identifier. Every text-ish input goes through `toText` (strings pass, numbers stringify, objects/arrays/null → `''`), so a structured `command`, `file_path`, or `stdout` never throws inside `stripAnsi`. The `modelName` field in state files controls the display name (e.g., "claude is thinking" vs "codex is coding" vs "openclaw is reading").

#### Codex `codex exec --json` items

`codex-wrapper.js` parses the real ThreadEvent schema (codex-cli 0.146): thread/turn events plus typed items, each classified by `classifyItem(item, phase)` into the same tool tables above.

| Item type | Mapping |
|---|---|
| `command_execution` | `Bash` + the command text (so the Bash tables still split executing / testing / installing / committing); `declined` → relieved, `failed` → error via `isError`/`exit_code` |
| `file_change` | `Edit` over `changes[].path`; completed → proud `saved <file>` / `saved N files` |
| `mcp_tool_call` | `mcp__<server>__<tool>` through the MCP verb classifier |
| `web_search` | `WebSearch` |
| `collab_tool_call` / `collab_agent_tool_call` | `Task` — Codex's own delegation |
| `todo_list` / `plan_update` | `TodoWrite` → thinking, then satisfied `plan updated` |
| `context_compaction` | thinking `compacting memory` → satisfied `memory compacted` |
| `reasoning` | thinking (detail left alone) |
| `agent_message` | responding |
| `error` | **deliberately not shown** — Codex reports run diagnostics ("Skill descriptions were shortened") as `error` items; a real failure arrives as the top-level `error` event plus `turn.failed` |
| anything else | `humanizeToolName(type)` → executing, then satisfied `done` |

A failed turn breaks the streak exactly once, via a per-turn `streakBrokenThisTurn` flag cleared by `turn.started` — Codex emits both a top-level `error` and `turn.failed`, and without the flag the second break zeroed `brokenStreak` (so the face's reaction never fired) and double-counted `totalErrors`. The child's `close` event, not `exit`, ends the run, so buffered stdout (including `turn.completed`) is drained rather than discarded.

#### The OpenCode 1.18 plugin contract

`adapters/opencode-plugin.mjs` is the shipped plugin; it feeds `opencode-adapter.js`. The contract is narrow and easy to get wrong:

- Bus events arrive **only** through `event({ event })` — registering `session.idle` and friends as top-level hooks (what the old documented snippet did) silently receives nothing.
- `tool.execute.before` gets its args in **output** (`output.args`), while `tool.execute.after` gets them in **input**.
- `tool.execute.after` is not called for a tool that throws; the failed `message.part.updated` covers that case (`tool.error`).
- **Every named export is invoked as a plugin factory**, so the module exports exactly one function — a second export, even a pure helper, kills plugin loading with `null is not an object (evaluating 'N.config')`. `translate()` hangs off the factory so tests can still reach it.
- `session.idle` / `session.error` are written **synchronously** (`spawnSync`), because `opencode run` exits with the turn and would take a fire-and-forget child with it. Everything else is fire-and-forget so the face can never block OpenCode, and reasoning deltas are throttled per session (5s) so a streaming turn does not spawn a node process per delta.
- The node binary is resolved **per spawn** via `CODE_CRUMB_NODE || 'node'`, not captured at module load — OpenCode loads a plugin once at startup, and `process.execPath` inside it is the Bun binary.

State mapping: `session.created` → starting, reasoning → thinking, `permission.asked` (and the older `permission.updated`) → waiting `allow?`, `permission.replied` → satisfied, `tool.error` → error, `session.idle` → happy + `stopped`.

Root cause of #120 (phantom orbitals): the old documented snippet registered bus events as top-level hooks and captured an always-empty `session_id`, so every event fell back to `opencode-<ppid>` — and that ppid was a fresh `cmd.exe` shim per event.

## Development Commands

```sh
npm start              # Run the renderer (unified mode with orbital subagents)
npm test               # Run the test suite
npm run demo           # Run the single-face demo
npm run demo:orbital   # Run the orbital subagent demo
npm run setup          # Install Claude Code hooks (default)
npm run setup:claude   # Install Claude Code hooks (explicit)
npm run setup:codex    # Install Codex native hooks into ~/.codex/hooks.json
npm run setup:opencode # Print OpenCode integration instructions (see --install below)
npm run setup:openclaw # Show OpenClaw/Pi integration instructions
npm run setup:uninstall # Remove the manual Claude Code hooks (writes settings.json.bak first) and the Codex hooks file
npm run launch         # Open renderer + start Claude Code
npm run launch:codex   # Open renderer + start Codex wrapper
npm run launch:opencode # Open renderer + start OpenCode
npm run launch:openclaw # Open renderer + start OpenClaw
npm run minimal        # Run renderer in minimal mode
npm run tmux           # Run renderer with tmux support
```

Two setup modes have no npm script yet and are invoked directly:

```sh
node setup.js codex-notify              # Codex's legacy turn-level notify channel
node setup.js opencode --install        # Write "plugin": ["<repo>/adapters/opencode-plugin.mjs"]
                                        #   into ~/.config/opencode/opencode.json
node setup.js opencode --uninstall      # Remove that entry again
```

The OpenCode config key is `plugin`, **singular**. `node setup.js opencode` with no flag only prints instructions.

To develop: run `npm run demo` in one terminal and `npm start` in another. For orbital testing: `npm start` + `npm run demo:orbital`.

## Code Conventions

- **Strict mode**: Every file starts with `'use strict'`
- **CommonJS**: Uses `require()` / no ES modules
- **Header blocks**: Each file has a boxed comment header explaining its purpose
- **Section dividers**: Logical sections separated by `// -- Section Name ---...` comments
- **Silent failures in hooks**: Hook code (update-state.js, adapters) wraps all I/O in try-catch and never throws — the editor must not be interrupted by a broken face
- **Atomic writes**: never `fs.writeFileSync` a state/session/stats/prefs/settings file directly — use `writeJsonAtomic` from shared.js (setup.js also writes a `.bak` first and aborts on unreadable/invalid JSON rather than replacing it)
- **Whitespace and headers**: no trailing whitespace anywhere; every file's boxed header has its `|` rail aligned to the `+===+` border; non-ASCII glyphs in code strings use `uXXXX` escapes, **control characters included — never a raw NUL** (grid.js's group-cache separator is `\u0000`, so git and ripgrep treat the file as text). Comments may use literal Unicode.
- **Cross-platform paths**: Uses `process.env.USERPROFILE || process.env.HOME` and normalizes backslashes to forward slashes
- **No external dependencies**: All functionality is built with Node.js built-in modules (`fs`, `path`, `child_process`)
- **Line endings**: `.gitattributes` pins LF for everything except `*.cmd` (CRLF for cmd.exe); `.editorconfig` mirrors it (2-space, LF, trailing whitespace trimmed). Shebang files (`launch.js`, `setup.js`, `update-state.js`, `renderer.js`, `demo.js`, `grid-demo.js`, `test.js`, `code-crumb.sh`, `adapters/*.js` except `base-adapter.js`) carry the executable bit in the index.

## Key Constants

| Constant | Value | Location |
|---|---|---|
| `FPS` | 15 | renderer.js |
| `IDLE_TIMEOUT` | 8000ms | renderer.js |
| `THINKING_TIMEOUT` | 45000ms | renderer.js, grid.js |
| `SLEEP_TIMEOUT` | 60000ms | renderer.js, grid.js |
| `LONG_TOOL_HOLD_MS` | 600000ms (10 min) | renderer.js (max time the work face is held while the file still names the same tool) |
| `WAIT_HOLD_STALE_MS` | 1800000ms (30 min) | renderer.js (write-silence bound on the otherwise uncapped `waiting` hold) |
| `LONG_TOOL_ESCALATE_MS` | 8000ms | face.js (detail line gains "still running … Ns"; gated on `ESCALATING_STATES`, which excludes `responding` and `subagent`) |
| `LONG_TOOL_SWEAT_MS` | 20000ms | face.js (sweat particles start) |
| `WAIT_ESCALATE_MS` | 30000ms | face.js (a wait unanswered this long escalates: bigger question marks, counting detail, pulsing status line and flashing terminal title) |
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | face.js |
| `COMPLETION_MIN_SHOW_MS` | 1800ms | face.js (guaranteed on-screen window for a reward face; only an error preempts it) |
| `MIN_DISPLAY_MS` | per-state table | face.js (work 1200–1500, subagent/spawning 2000, training 2500, satisfied/relieved 2500, responding 3000, happy/error 4000, proud 4500) |
| `LOCK_WAIT_MS` | 150ms | shared.js (max wait for the stats lock before proceeding unlocked) |
| `LOCK_STALE_MS` | 2000ms | shared.js (a stats lock older than this belongs to a crashed hook and is taken over) |
| `LOCK_SPIN_MS` | 2ms | shared.js (pause between stats-lock retries) |
| `SUBAGENT_MAX_AGE_MS` | 14400000ms (4h) | update-state.js (safety net for a missed SubagentStop; replaces the old 10-minute cut) |
| `STALE_MS` | 120000ms | grid.js (session file mtime purge threshold) |
| `ORPHAN_TIMEOUT` | 90000ms | grid.js (fallback staleness for sessions without PID) |
| `CHILD_ORPHAN_TIMEOUT` | 900000ms (15 min) | grid.js (staleness for a live child orbital — a subagent emits no hooks during a model turn; earned only while the parent's file is fresh) |
| `MAX_ORBITALS` | 8 | grid.js (max visible orbital faces) |
| `rotationSpeed` (instance field) | 0.007 rad/frame | grid.js `OrbitalSystem` constructor (~1 revolution per 60s) |
| `INTER_GROUP_GAP` | 0.15 rad | grid.js (angular space between group sectors) |
| `INTRA_GROUP_GAP` | 0.35 rad | grid.js (angular space between faces within a group) |
| `TETHER_BRIGHTNESS` | 0.15 | grid.js (dim factor for sibling tether dots) |
| `GROUP_LABEL_BRIGHTNESS` | 0.45 | grid.js (dim factor for floating group label) |
| `MAX_SEGMENT_BLOCKS` | 5 | face.js (max visual blocks per state segment in timeline) |
| `CYCLE_WORK_STATES` | 5 states | grid.js (activity cycling sequence for synthetic subagent faces) |
| `CYCLE_INTERVAL` | 2500ms | grid.js (ms between cycling state changes) |
| `CYCLE_STALE_MS` | 3000ms | grid.js (start cycling after no real data for this duration) |
| `SLACK_MS` | 1000ms | grid.js (start-time vs last-write comparison slack) |
| `PID_PROTECT_CAP_MS` | 3600000ms | grid.js (max protection when start time is unknown) |
| `PID_CACHE_TTL_MS` | 60000ms | grid.js (start-time cache re-resolve interval) |

## Environment Variables

- `CODE_CRUMB_STATE` — override the single-mode state file path (default: `~/.code-crumb-state`)
- `CLAUDE_SESSION_ID` — set the session identifier (default: `<editor>-<parent PID>`, e.g. `claude-47040`; see Editor Provenance)
- `CODE_CRUMB_MODEL` — override the display name in the status line (default: `claude`; adapters default to `codex`/`opencode`/`openclaw`)
- `CODE_CRUMB_EDITOR` — override the editor provenance tag shown in the session list; beats the `--editor <name>` hook argument (default: `claude` in update-state.js; adapters set their own identity)
- `CODE_CRUMB_NODE` — the node binary the OpenCode plugin spawns for the adapter (default: `node` on PATH). Needed because `process.execPath` inside OpenCode is the Bun binary. Resolved per spawn, not at plugin load.
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — set to `1` to enable Claude Code agent teams; Code Crumb will automatically detect teammate sessions via `TeammateIdle`/`TaskCompleted` hooks and show them in the orbital display with role labels and team-specific colors
- `NO_COLOR` — disable colour output in the renderer (also disables the `t` palette key)
- `MINIMAL_BOOT` — start the renderer in minimal mode (same as the `--minimal` flag)
- `ENGMUX_PYTHON` / `PYTHON` — interpreter used by `adapters/engmux-adapter.js` (default `python` on Windows, `python3` elsewhere)

Renderer CLI flags: `--minimal` (face + status only, no chrome, only `space`/`q` keys), `--tmux` (write a one-line status file for tmux instead of drawing), `--no-color`.

## Testing

### Automated Tests

Run `npm test` (or `node test.js [--quiet] [filter...]`, e.g. `node test.js grid face`). Before loading anything the runner redirects `HOME`, `USERPROFILE`, and `CODE_CRUMB_STATE` to a throwaway directory (removed on exit), so the suite never touches the real `~/.code-crumb*` files or fights a running renderer — subprocess tests inherit the same env. Each test file gets its own counters from `tests/_harness.js` (`createSuite()`); `test.async` (or a test that returns a promise) is awaited before the file is counted, so async assertions can actually fail. The runner prints per-file counts and total duration and keeps going if one file fails to load. CI (`.github/workflows/test.yml`) runs `node --check` over `*.js` and `*.mjs`, the trailing-whitespace gate, and the suite on ubuntu/windows/macos × node 18/20/22.

The suite is **1974 tests across 15 files**: test-shared 42, test-state-machine 522, test-themes 72, test-animations 42, test-particles 49, test-face 266, test-grid 308, test-accessories 24, test-teams 39, test-launch 45, test-adapters 238, test-transition 28, test-emotions 143, test-platform 97, test-subagents 59. A few per-file counts shift by one or two across platforms (some tests are platform-conditional), so treat the total as the figure to check. One test, `test-shared.js › getIsWorktree`, fails inside a git worktree by construction — `.git` is a file there — which is environmental, not a regression. **`test-adapters.js` dominates wall time** — it spawns real `update-state.js` and adapter subprocesses, so a full run is mostly waiting on node cold starts; use `node test.js <filter>` while iterating on anything else. Treat the count as tests, not as coverage: a round of behavioural conversion collapsed many one-line source greps into fewer, multi-assertion tests, which lowers the number while raising the assertions behind it.

Coverage by file:

- **_harness.js** (not a test file): `createSuite()` returns `{ describe, test, done, passed, failed }`; `test.async(name, fn)` for promise-based tests; `makeTempEnv(sessionId)` / `cleanup(tmp)` / `readJSON(path)` for subprocess tests that need their own temp home
- **test-shared.js**: `safeFilename` edge cases
- **test-state-machine.js**: `toolToState` mapping (all tool types across Claude Code, Codex, OpenCode, OpenClaw/Pi), multi-editor tool pattern constants incl. `REVIEW_TOOLS`, `extractExitCode`, `looksLikeError` with stdout/stderr patterns, false positive guards, `errorDetail` friendly messages, `classifyToolResult` (full PostToolUse decision tree), `diffFromPatch`/`diffFromInput` (hunk summing, malformed-patch → `null`, MultiEdit/NotebookEdit fallbacks) and the `structuredPatch`-beats-input decision, `updateStreak` and milestone detection, `defaultStats` initialization, `classifyForeignSession` parallel-vs-subagent decision table and `pruneTopLevelSessions` registry pruning (#134) — plus end-to-end `update-state.js` hook runs (subprocess, temp home) for the subagent bookkeeping (own tool state, owner counters/streak/commitCount/session clock untouched, synthetic retirement incl. corrupt-sibling and oldest-first, `LIFECYCLE_EVENTS` inclusion **and** exclusion), the `activeSubagents` 4-hour ageing net, the active-subagent mtime touch, the fallback `SubagentStart` orbital, and a state/detail table for all nine newer hook events with their empty-stdin fallbacks
- **test-themes.js**: `lerpColor`/`dimColor`/`breathe`/`dimAnsiOutput` color math, theme completeness (all 23 states), `COMPLETION_LINGER` ordering, thought bubble pools
- **test-animations.js**: mouth/eye functions (shape and randomness)
- **test-particles.js**: `ParticleSystem` (all 16 styles incl. stream, fire, bigquestion with its bold flag honoured by render, lifecycle, fadeAll)
- **test-face.js**: `ClaudeFace` state machine (`setState`, `setStats`, `update`, pending state buffering, particle spawning, sparkline, orbital toggle), long-running-tool escalation (`heldMs`/`displayDetail`, sweat particles), waiting escalation (`waitEscalated`, counting detail, bigquestion cadence, status-line pulse), and the proud diff thought bubble (`+N -M` / `+N` / `-M lines`)
- **test-grid.js**: `MiniFace`, `OrbitalSystem` (orbit calculation, session exclusion, rotation, connection rendering, conducting animation, stream particles, taskDescription label priority, SessionStart adoption, `_buildGroups` grouping/sorting/color, `_calculateGroupedAngles` sector allocation with pixel-aware spacing, `_renderGroupTethers` dashed sibling lines with all-positions check and spawning exclusion, `_getGroupLabel` 4-tier priority chain (branch/cwd/taskDescription/label fallback, default branch exclusion, truncation), `_renderGroupLabels` floating labels for team/non-team groups, `_resolveOverlaps` bounding box collision resolver), `renderSessionList` selection highlight, footer, editor tag rendering and row-width alignment, `isOwnedByLiveProcess` decision table and recycled-PID purge integration, `MiniFace` editor derivation (explicit field, legacy modelName, ID prefix), mtime-purge protection rules exercised through `loadSessions` (active face protects, no face and stopped face do not), `_applySessionResults` and `loadSessions` face removal leaving session files on disk, and a recycled-PID purge integration test driven by a seeded start-time cache. The start-time resolver is a seam: tests that need a definite PID-ownership verdict either seed `_pidStartCache` with a start time predating the write (so no resolver runs on any platform) or install a fake resolver via `grid._setPidResolver(fn)` / `_setPidResolver(null)` to restore. Without this the same test resolved in-tick on Linux (`/proc`) and stayed `'pending'` on win32/darwin (`execFile`), so seven tests passed only where the start time was never resolved.
- **test-accessories.js**: accessory definitions, rendering, state-specific adornments
- **test-teams.js**: `hashTeamColor` consistency and RGB output, `MiniFace` team fields, `_assignLabels` with `teammateName`, session schema for `TeammateIdle`/`TaskCompleted`, team grouping (clusters by teamName, tethers use team color, auras show team name label, mixed groups separate correctly)
- **test-launch.js**: launcher logic, platform detection, editor flag handling
- **test-adapters.js**: base adapter, engmux adapter (arg parsers unit-tested plus two real dispatches against a stand-in interpreter), codex/opencode/openclaw adapter behavior, codex-wrapper against a fake `codex` on PATH (real ThreadEvent schema, pure `classifyItem`, `item.updated`, the ignored pre-0.146 shape, the `require.main` guard, and the Windows `.cmd` spawn), codex-notify ownership guards, the OpenCode plugin (`translate()` payload table, the one-export rule, turn-end delivery) and the plugin-shaped adapter payloads, editor PID liveness tracking (pid field in state writes incl. win32 omission, `readState` propagation, renderer candidate validation via start-time identity and `editorDead` rescue), editor provenance end to end (each adapter's stamp on the state file, editor-prefixed fallback IDs, the `CODE_CRUMB_EDITOR` > `--editor` > `claude` ladder, owner-editor preservation), the stopped-flag and parallel-orbital hook contracts run in per-test temp homes, parallel session classification (#134), and that parallel `update-state.js` hooks keep every stats increment (6 concurrent PreToolUse → toolCalls 7) with the `process.exit` paths releasing the lock. A small, commented set of `source:`-prefixed tests remains for render-loop lint and CLI paths the suite cannot drive portably.
- **test-transition.js**: `SwapTransition` lifecycle (start/tick/cancel), phase progression (dissolve/swap/materialize/done), `dimFactor` brightness curve, constants
- **test-emotions.js**: the emotion-fidelity contract — table of current Claude Code tool names → pre/post states and details, `humanizeToolName`, non-string input coercion, `normalizeToolResponse` passthrough (interrupted/isError/exitCode → error end to end) plus an end-to-end `PostToolUse` check that `structuredPatch` yields exact `diffInfo` and is never persisted, truncated-input event map, the timing table and the guaranteed-window / `pendingWork` / `forceState` rules, the `idleCascade` timeout-cascade decision table (hold, cap, stopped session, and every pre-existing branch), the indefinite waiting hold with its `WAIT_HOLD_STALE_MS` silence bound and the flashing terminal title (`buildTitle`, title-inclusive frame dedupe), shared state sets and `FRESH_READ_STATES` coverage, question/echo particles, distinct orbital eyes for every state, thought pools, the installer check via `setup.buildFaceHooks()`, and empty-stdin catch-path tests for `TeammateIdle`/`TaskCompleted`/`UserPromptSubmit`
- **test-platform.js**: cross-platform launching (`quoteArg`/`shQuote`, `buildRendererCommands` quoting for wt / cmd / osascript / xfce4, `buildEditorSpawn` shell rules for .cmd shims), `writeJsonAtomic`, `acquireSpawnLock`, `acquireFileLock`/`withStatsLock` semantics (token ownership, stale takeover, `waitMs` timeout) and a 6-worker stats-lock contention test, `normalizeStats`, `normalizePaletteIndex`, base-adapter `pidField` parity and `processStdinEvent` error separation, adapter source hygiene, codex-notify stats, update-state.js catch-path orbital ownership and degenerate-stats survival, renderer source-level fixes (resize redraw, watcher cleanup), face tiny-terminal behaviour, grid cache keys and PID-cache sweep, and setup.js against temp config files (`setupClaude`/`uninstallClaude` on a settings.json: merge, corrupt-file abort, idempotency, moved-path repair, backup; `setupCodex`/`uninstallCodex` on a hooks.json; `setupOpenCode`/`uninstallOpenCode` on an opencode.json; `update-state.js --editor`). The remaining source-text assertions here (adapter hygiene, autolaunch helpers, renderer closures) are deliberate lint tests for properties with no runtime observable.
- **test-subagents.js**: Claude Code `agent_id` attribution — `subagentLabel` / `subagentSessionId`, per-agent orbital routing for PreToolUse/PostToolUse/PermissionRequest/Stop, global-state and parent-file isolation, out-of-order `SubagentStop` matching, the legacy no-`agent_id` path, the `SUBAGENT_MAX_AGE_MS` ageing net, the family heartbeat (including that the parent refreshes a legacy synthetic child but never an agent-owned one), `CHILD_ORPHAN_TIMEOUT` child staleness in `isStale` / `_applySessionResults`, the `idleCascade` conducting hold and its ordering against the `waiting` hold, and `ESCALATING_STATES` — that a held `subagent`/`responding` face neither counts up "still running" nor sweats, while every real work state still does

### Visual Verification

For visual testing, use the demo scripts:

1. Run `npm start` in one terminal
2. Run `npm run demo` in another terminal
3. Observe the face cycling through all 23 states

For orbital subagents: `npm start` + `npm run demo:orbital`.

## Important Constraints

- **Hook performance**: update-state.js must complete in ~50ms — it runs synchronously in the editor hook pipeline. The stats lock costs ~0.3ms median uncontended against that budget, and a failed acquire proceeds unlocked rather than waiting.
- **State file size**: a realistic state write is ~750–950 bytes (`frequentFiles`, `cwd`, `gitBranch` and the stats fields account for most of it); keep it around 1 KB and never embed tool output
- **Terminal minimum size**: Main face requires 38x20 chars (`MIN_COLS_SINGLE`/`MIN_ROWS_SINGLE` in face.js; below that a "resize me" fallback is drawn and `lastPos` is cleared). Orbitals have no fixed minimum: `calculateOrbit` in grid.js derives the ellipse from the space around the main face and yields `maxSlots: 0` when nothing fits, so they degrade gracefully
- **No network**: All IPC is file-based, no sockets or HTTP
- **Graceful degradation**: Renderer handles terminal resize, missing state files, and stale sessions without crashing

## Known Follow-ups

- **Screen clearing**: `renderer.js` clears the whole screen every frame (`ansi.home + ansi.clearBelow`, inside a DEC 2026 synchronized block) — that is now the single clearing mechanism. The old incremental clear buffers (`particles.clearPrevious`, `OrbitalSystem._buildClearBuf`, the 21-row band in `face.js`, `prevSessionListClear`, `_prevHelpBounds`) were removed as dead work, cutting a representative frame from 4027.9 to 2326.5 bytes (−42.2%). **A cross-terminal flicker check is still pending** — that one has to be done by eye and nobody has done it.
- **A lone subagent still vanishes at 120s during a long model turn.** Only *agent* writes heartbeat the parent's file, so when a whole family goes silent — one agent, thinking for over two minutes — nothing refreshes anything and the child window caps at `STALE_MS` instead of `CHILD_ORPHAN_TIMEOUT`. Accepted rather than fixed: on win32 there is no `pid`, so a long think is genuinely indistinguishable from a crash and the only lever is the timeout length. A ghost orbital animating fake work for 15 minutes is worse and more confusing than an orbital that disappears early during a real silence, and this is not a regression (the baseline was 90s/120s). Multi-agent families — the reported symptom — are fully protected. A real fix needs a usable liveness signal on Windows.
- **Agent events from a non-owner parent still increment the owner's counters.** An `agent_id` event whose parent is not the current `stats.session` owner adds to that owner's `toolCalls`/`totalToolCalls`. Cosmetic mis-attribution only — no session reset, no orbital damage, no record corruption. It is the residue of taking the minimal of two available fixes.
- **`renderer.js`'s session-adoption guard is unreachable.** `Date.now() - lastMainUpdate > 120000` (renderer.js:360) keys off `lastMainUpdate`, which is a **read** marker refreshed by the renderer's own 2-second forced re-read — so it can never exceed ~2s and that sub-condition never fires. Pre-existing; it is the identical flaw the `waiting` hold's bound was rewritten to avoid (see `noteNewWrite`). Session adoption may never fire on that path.
- **`STICKY_FIELDS` contains a dead entry.** `update-state.js`'s `STICKY_FIELDS` lists `'editor'`, but the loop's `!extra[field]` guard can never be true for it — `extra.editor` is always set (update-state.js:711). Provenance is actually preserved by the global owner guard a few lines below. Harmless, but misleading to read.
- **`adapters/engmux-adapter.js` spawns python without `shell: true`**, so a `.cmd` shim or a Windows Store python alias cannot be spawned at all — the same bug class fixed for codex in `buildEditorSpawn`. Narrow impact (engmux has no setup/launch entry point), but real for some users.
- **Four `StopFailure` branches are unasserted**: `max_output_tokens`, `authentication_failed`, `billing_error`, and the `errorType || 'API error'` default. Four table rows. Declined during the 1.2.0 round because that would be *new* coverage in a task whose mandate was not to lower existing coverage — cheap to add whenever someone wants those four error faces pinned.
- **Two divergent `runUpdateState` test helpers.** `tests/test-subagents.js`-era work and the behavioural-conversion work each shipped a local copy because neither lane could edit `tests/_harness.js` concurrently. Consolidating them into the harness is a follow-up.
- **`MAX_ORBITALS` is 8.** Now that every Claude Code subagent gets its own orbital, a user running more than eight agents sees only the first eight. Previously they saw none, so this is the new visible ceiling rather than a regression.
- **engmux** has an adapter but no `setup`/`launch` entry point; invoke `adapters/engmux-adapter.js` directly.
- A state file without a `timestamp` is never applied by the renderer (`ts > lastAppliedTimestamp` with both 0). Every writer stamps one, so this only affects hand-written files.
