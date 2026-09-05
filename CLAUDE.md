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
particles.js     ParticleSystem class — 15 visual effect styles (incl. stream, fire)
face.js          ClaudeFace class — main face state machine, rendering, orbital toggle
grid.js          MiniFace + OrbitalSystem classes — subagent orbital rendering
transition.js    SwapTransition class — dissolve/swap/materialize animation state machine
accessories.js   Accessory definitions (hats, glasses, ears, etc.) and rendering helpers
update-state.js  Hook handler — receives editor events via stdin, writes state files
state-machine.js Pure logic — tool→state mapping (multi-editor), error detection, streaks
shared.js        Shared constants — paths, face state sets, prefs, atomic JSON writes, spawn lock, shell quoting, buildRendererCommands
launch.js        Platform-specific launcher — opens renderer + starts editor (--editor flag)
setup.js         Multi-editor setup — installs/uninstalls hooks (setup.js [claude|codex|opencode|openclaw|uninstall]); setupClaude/uninstallClaude are importable
test.js          Test runner — isolates HOME, loads 14 test files from tests/ (~1718 tests); --quiet, name filters
demo.js          Demo script — cycles through all face states in single-face mode
grid-demo.js     Orbital demo — simulates subagent sessions orbiting the main face
code-crumb.sh   Unix shell wrapper for launch.js
code-crumb.cmd  Windows batch wrapper for launch.js
adapters/
  base-adapter.js    Base adapter class with shared functionality for all adapters
  codex-wrapper.js   Wraps `codex exec --json` for rich tool-level face events
  codex-notify.js    Handles Codex CLI `notify` config events (turn-level)
  opencode-adapter.js  Adapter for OpenCode plugin events (stdin JSON)
  openclaw-adapter.js  Adapter for OpenClaw/Pi agent events (stdin JSON)
  engmux-adapter.js  Adapter for engmux agent dispatcher events (stdin JSON)
tests/
  _harness.js      Shared describe/test/test.async runner + temp-home helpers (createSuite, makeTempEnv)
  test-shared.js, test-state-machine.js, test-themes.js, test-animations.js,
  test-particles.js, test-face.js, test-grid.js, test-accessories.js,
  test-teams.js, test-launch.js, test-adapters.js, test-transition.js, test-emotions.js,
  test-platform.js
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
  test.yml         CI — node --check on every script, then npm test on ubuntu/windows/macos × node 18/20/22
```

## Architecture

### Event Flow

```
Editor Event (Claude Code / Codex / OpenCode / OpenClaw) → update-state.js or adapter → State File (JSON) → renderer.js (fs.watch) → Terminal Output
```

### File-Based IPC

State is communicated between the hook handler and renderer via JSON files:

- `~/.code-crumb-state` — single-mode state (written by update-state.js, watched by renderer.js)
- `~/.code-crumb-sessions/{session_id}.json` — per-session state for orbital subagents (includes sticky `taskDescription` field set at SubagentStart, and a sticky `editor` provenance field — see Editor Provenance)
- `~/.code-crumb-stats.json` — persistent stats (streaks, records, session counters)
- `~/.code-crumb-prefs.json` — persisted user preferences (theme, accessories, stats, orbitals toggle)
- `~/.code-crumb.pid` — renderer process liveness tracking
- `~/.code-crumb-spawn.lock` — autolaunch spawn lock: when the renderer is down, parallel hooks all notice at once; `acquireSpawnLock` (O_EXCL, 5s staleness) lets exactly one of them open a terminal

Every state/session/stats/prefs write goes through `writeJsonAtomic` (temp file + rename, direct-write fallback) so the watching renderer never reads a half-written file. The stats file is still a lock-free read-modify-write per hook — concurrent parallel tool calls can lose a counter increment; atomic writes prevent corruption, not lost updates.

#### Editor PID Liveness

State file writes include a `pid` field — the writer's parent PID (`process.ppid`) for per-event hook processes (codex-notify; update-state.js on Unix), or the adapter's own PID for long-lived wrappers (codex-wrapper). **On win32, update-state.js and the adapters (`pidField()` in base-adapter.js) write no `pid` at all**: the hook's ppid there is a transient `cmd.exe` shim that dies within milliseconds — useless for protection and a prime PID-recycling target — so those sessions rely on staleness timeouts (`ORPHAN_TIMEOUT`/`STALE_MS`).

PID liveness is **identity-checked**, not just existence-checked: `isOwnedByLiveProcess(pid, lastWriteMs)` in grid.js only lets a PID protect a session if the process's **start time predates the session's last write** (+1s slack) — a recycled PID always fails this because its process was born after the original writer died. Start times resolve asynchronously in a per-PID cache (batched PowerShell on Windows, `/proc` on Linux, `ps` on macOS; one outstanding exec at a time; 60s TTL closes the live→live recycle gap). Unresolved (`pending`) PIDs are protected as a safe default; unreadable start times (Access-Denied on elevated/protected processes) or missing exec capability protect only up to a 1-hour cap past the last write — a real editor refreshes its session file with every hook, so its orbital self-heals on the next write, while a ghost recycled onto a protected process must not be immortal.

The renderer uses the armed-PID mechanism to detect a crashed editor: a candidate PID is **armed** only if it is still alive 2.5s after first being seen in a write AND its start time predates the reporting write (arming defers while resolution is pending). When an armed PID dies without a Stop event, a sticky `editorDead` flag triggers the rescue cascade (responding → happy → idle) and allows a new session to be adopted as main. A write newer than anything applied clears a false `editorDead` (PID-reuse guard).

#### Parallel Session Classification

The shared stats file has a single `session` owner, so a hook arriving from a different session id while the owner has `activeSubagents` used to be classified as that owner's subagent unconditionally — misclassifying unrelated parallel editor windows (sticky wrong `parentSession`, stolen `taskDescription`, frozen stats, blocked main-face ownership, and false retirement of the real subagent's synthetic orbital). `classifyForeignSession` (state-machine.js) now distinguishes the two: a foreign session is **parallel** (independent top-level) if it appears in the `stats.topLevelSessions` registry (populated at `SessionStart`, which real subagents never fire; 7-day TTL, 200-entry cap via `pruneTopLevelSessions`), or if its session file's birthtime predates the earliest active subagent's `startedAt` (a real subagent's file cannot exist before its own spawn). Unknown birthtime (unsupported filesystem) falls back to subagent classification, so real subagent grouping never regresses. Parallel sessions do not steal `stats.session` while the owner is conducting, do not count into the owner's counters, and do not propagate tool state onto subagent orbitals. Top-level sessions (the stats owner, or a classified parallel session) carrying a stale `parentSession`/`taskDescription` stamp are healed on their next write; teammates keep their legitimately-set fields.

#### Editor Provenance

Every state/session write carries an `editor` field (claude/codex/opencode/openclaw/engmux) distinct from `modelName`: update-state.js writes `CODE_CRUMB_EDITOR || 'claude'`, adapters write their own identity, and engmux-adapter writes the `-E`/`--engine` dispatch target. The field is sticky (preserved by `STICKY_FIELDS`, the global owner guard, `guardedWriteState`, and `buildSubagentSessionState`). Fallback session IDs are editor-prefixed (`opencode-47040`, not bare `47040`) so anonymous sessions are self-describing and never collide across editors — update-state.js mints the same `FALLBACK_SESSION_ID` in both its try and catch paths so one session never splits into two orbitals. On the read side, `MiniFace.updateFromFile` derives `editor` best-effort for legacy files (modelName-as-editor, then ID prefix). The session list (`l`) shows each session's editor tag dimmed on row 1 and prefers the full `taskDescription` on row 3.

### State Machine

23 face states: `idle`, `thinking`, `responding`, `reading`, `searching`, `coding`, `executing`, `happy`, `satisfied`, `proud`, `relieved`, `error`, `sleeping`, `waiting`, `testing`, `installing`, `caffeinated`, `subagent`, `starting`, `spawning`, `committing`, `reviewing`, `training`.

States have minimum display durations enforced via a `pendingState` queue to prevent visual flashing. The timings live in one exported table at the top of face.js (`MIN_DISPLAY_MS`): **work** states are short (coding/committing/reviewing 1500ms; reading/searching/executing/testing/installing 1200ms; subagent/spawning 2000ms; training 2500ms) because every PreToolUse refreshes them anyway, while **reward** states (happy 4000, proud 4500, satisfied/relieved 2500) and error (4000) are long because they are the emotions the user actually wants to see; responding keeps 3000 (#67).

`COMPLETION_MIN_SHOW_MS` (1800ms) is the guaranteed on-screen window for a reward face. Inside it nothing but an error replaces it — the next work state is buffered and a newer completion is queued, not shown. After the window, whatever is queued flushes (`_flushPending`), so a reward never sits for its full min display while something newer waits. Work that arrives while a completion is already queued is remembered in `pendingWork` and promoted to `pendingState` when that completion lands, so a long-running tool is never lost behind a reward face; a completion arriving clears `pendingWork` (its tool is finished). Completions never bypass active work — they queue and show when the tool finishes. Same-state writes refresh `lastStateChange` and the detail text, so a reward face stays up with live detail while a burst of identical completions lands. `face.forceState(state, detail, minMs)` applies a state immediately, skips the buffering rules, drops the queue, and records the change for caffeine detection — the renderer's rescue paths (missed Stop, dead editor) use it.

The state sets `ACTIVE_WORK_STATES`, `COMPLETION_STATES`, and `INTERRUPTIBLE_STATES` are defined once in shared.js and imported by face.js, grid.js, and renderer.js; the renderer's `FRESH_READ_STATES` (states worth a fresh file read for a missed Stop) is derived from them so a new work state can never be forgotten there.

### Hook Events

Twenty-one hook event types are handled: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `UserPromptSubmit`, `TeammateIdle`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `PermissionRequest`, `Setup`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`. Tool names from all supported editors are mapped to face states via shared regex patterns (e.g., Edit/apply_diff/file_edit → coding, Grep/search_files/codebase_search → searching, Bash/shell/terminal → executing) — see Multi-Editor Tool Mapping. PostToolUse includes forensic error detection with 39 regex patterns (30 stdout, 9 stderr) guarded by 14 false-positive patterns, and honours the `interrupted`, `isError`/`is_error`, and numeric `exitCode`/`exit_code` fields that `normalizeToolResponse` carries through — an Esc-interrupted command shows `error / "interrupted"`, not `relieved / "command succeeded"`.

The newer hook events map to existing face states: `PreCompact` → thinking (with rain particles), `PostCompact` → satisfied, `PermissionRequest` → waiting (with question particles), `Setup` → starting, `Elicitation` → waiting (with question particles), `ElicitationResult` → satisfied/relieved, `ConfigChange` → reading, `InstructionsLoaded` → reading, `StopFailure` → error (breaks streak). Of these, `PermissionRequest`, `Elicitation`, and `ElicitationResult` are per-session interactive events that route to orbital files in subagent context; the remaining 6 are system-level events excluded from subagent routing via the `LIFECYCLE_EVENTS` Set. `WorktreeCreate`/`WorktreeRemove` are intentionally not registered because they replace default git worktree behavior.

`UserPromptSubmit` → thinking (`reading your message`): the user just sent a prompt, so Claude is thinking before its first tool call — without it the face sat on happy/idle from the last Stop. The write carries no `stopped`, which also flips the renderer back to the active 45s thinking timeout. `Notification` is differentiated by `notification_type`: `permission_prompt` → waiting `allow?` (question particles), `idle_prompt` → waiting `waiting for you`, `elicitation_dialog` → waiting `needs input`, `auth_success` → satisfied `signed in`, anything else → waiting `needs attention`. The catch path (unparseable stdin) and `classifyTruncatedInput`'s event map cover the same events, including `UserPromptSubmit`, `TeammateIdle`, and `TaskCompleted`.

`TeammateIdle` and `TaskCompleted` are agent-teams-specific events (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). They write session files with `teamName`, `teammateName`, and `isTeammate: true` fields so team members appear in the orbital display with their designated name and a team-specific accent color.

### Orbital Label Priority

Each orbital subagent face displays a per-face label (max 8 chars). Priority order: `teammateName` > `taskDescription` > cwd basename > `modelName` > `sub-N`. The `taskDescription` field is set once at `SubagentStart` from the agent's description/prompt and preserved across all subsequent session file writes. The live tool detail (e.g., "edit foo") shows separately below the label.

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

## Development Commands

```sh
npm start              # Run the renderer (unified mode with orbital subagents)
npm test               # Run the test suite
npm run demo           # Run the single-face demo
npm run demo:orbital   # Run the orbital subagent demo
npm run setup          # Install Claude Code hooks (default)
npm run setup:claude   # Install Claude Code hooks (explicit)
npm run setup:codex    # Install Codex CLI integration
npm run setup:opencode # Show OpenCode integration instructions
npm run setup:openclaw # Show OpenClaw/Pi integration instructions
npm run setup:uninstall # Remove the manual Claude Code hooks (writes settings.json.bak first)
npm run launch         # Open renderer + start Claude Code
npm run launch:codex   # Open renderer + start Codex wrapper
npm run launch:opencode # Open renderer + start OpenCode
npm run launch:openclaw # Open renderer + start OpenClaw
npm run minimal        # Run renderer in minimal mode
npm run tmux           # Run renderer with tmux support
```

To develop: run `npm run demo` in one terminal and `npm start` in another. For orbital testing: `npm start` + `npm run demo:orbital`.

## Code Conventions

- **Strict mode**: Every file starts with `'use strict'`
- **CommonJS**: Uses `require()` / no ES modules
- **Header blocks**: Each file has a boxed comment header explaining its purpose
- **Section dividers**: Logical sections separated by `// -- Section Name ---...` comments
- **Silent failures in hooks**: Hook code (update-state.js, adapters) wraps all I/O in try-catch and never throws — the editor must not be interrupted by a broken face
- **Atomic writes**: never `fs.writeFileSync` a state/session/stats/prefs/settings file directly — use `writeJsonAtomic` from shared.js (setup.js also writes a `.bak` first and aborts on unreadable/invalid JSON rather than replacing it)
- **Whitespace and headers**: no trailing whitespace anywhere; every file's boxed header has its `|` rail aligned to the `+===+` border; non-ASCII glyphs in code strings use `uXXXX` escapes (comments may use literal Unicode)
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
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | face.js |
| `COMPLETION_MIN_SHOW_MS` | 1800ms | face.js (guaranteed on-screen window for a reward face; only an error preempts it) |
| `MIN_DISPLAY_MS` | per-state table | face.js (work 1200–1500, subagent/spawning 2000, training 2500, satisfied/relieved 2500, responding 3000, happy/error 4000, proud 4500) |
| `STALE_MS` | 120000ms | grid.js (session file mtime purge threshold) |
| `ORPHAN_TIMEOUT` | 90000ms | grid.js (fallback staleness for sessions without PID) |
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
- `CODE_CRUMB_EDITOR` — override the editor provenance tag shown in the session list (default: `claude` in update-state.js; adapters set their own identity)
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — set to `1` to enable Claude Code agent teams; Code Crumb will automatically detect teammate sessions via `TeammateIdle`/`TaskCompleted` hooks and show them in the orbital display with role labels and team-specific colors
- `NO_COLOR` — disable colour output in the renderer (also disables the `t` palette key)
- `MINIMAL_BOOT` — start the renderer in minimal mode (same as the `--minimal` flag)
- `ENGMUX_PYTHON` / `PYTHON` — interpreter used by `adapters/engmux-adapter.js` (default `python` on Windows, `python3` elsewhere)

Renderer CLI flags: `--minimal` (face + status only, no chrome, only `space`/`q` keys), `--tmux` (write a one-line status file for tmux instead of drawing), `--no-color`.

## Testing

### Automated Tests

Run `npm test` (or `node test.js [--quiet] [filter...]`, e.g. `node test.js grid face`). Before loading anything the runner redirects `HOME`, `USERPROFILE`, and `CODE_CRUMB_STATE` to a throwaway directory (removed on exit), so the suite never touches the real `~/.code-crumb*` files or fights a running renderer — subprocess tests inherit the same env. Each test file gets its own counters from `tests/_harness.js` (`createSuite()`); `test.async` (or a test that returns a promise) is awaited before the file is counted, so async assertions can actually fail. The runner prints per-file counts and total duration and keeps going if one file fails to load. CI (`.github/workflows/test.yml`) runs `node --check` on every script and the suite on ubuntu/windows/macos × node 18/20/22. The suite (~1718 tests) covers:

- **_harness.js** (not a test file): `createSuite()` returns `{ describe, test, done, passed, failed }`; `test.async(name, fn)` for promise-based tests; `makeTempEnv(sessionId)` / `cleanup(tmp)` / `readJSON(path)` for subprocess tests that need their own temp home
- **test-shared.js**: `safeFilename` edge cases
- **test-state-machine.js**: `toolToState` mapping (all tool types across Claude Code, Codex, OpenCode, OpenClaw/Pi), multi-editor tool pattern constants incl. `REVIEW_TOOLS`, `extractExitCode`, `looksLikeError` with stdout/stderr patterns, false positive guards, `errorDetail` friendly messages, `classifyToolResult` (full PostToolUse decision tree), `updateStreak` and milestone detection, `defaultStats` initialization, `classifyForeignSession` parallel-vs-subagent decision table and `pruneTopLevelSessions` registry pruning (#134)
- **test-themes.js**: `lerpColor`/`dimColor`/`breathe`/`dimAnsiOutput` color math, theme completeness (all 23 states), `COMPLETION_LINGER` ordering, thought bubble pools
- **test-animations.js**: mouth/eye functions (shape and randomness)
- **test-particles.js**: `ParticleSystem` (all 15 styles incl. stream, fire, lifecycle, fadeAll)
- **test-face.js**: `ClaudeFace` state machine (`setState`, `setStats`, `update`, pending state buffering, particle spawning, sparkline, orbital toggle)
- **test-grid.js**: `MiniFace`, `OrbitalSystem` (orbit calculation, session exclusion, rotation, connection rendering, conducting animation, stream particles, taskDescription label priority, SessionStart adoption, `_buildGroups` grouping/sorting/color, `_calculateGroupedAngles` sector allocation with pixel-aware spacing, `_renderGroupTethers` dashed sibling lines with all-positions check and spawning exclusion, `_getGroupLabel` 4-tier priority chain (branch/cwd/taskDescription/label fallback, default branch exclusion, truncation), `_renderGroupLabels` floating labels for team/non-team groups, `_resolveOverlaps` bounding box collision resolver), `renderSessionList` selection highlight, footer, editor tag rendering and row-width alignment, `isOwnedByLiveProcess` decision table and recycled-PID purge integration, `MiniFace` editor derivation (explicit field, legacy modelName, ID prefix)
- **test-accessories.js**: accessory definitions, rendering, state-specific adornments
- **test-teams.js**: `hashTeamColor` consistency and RGB output, `MiniFace` team fields, `_assignLabels` with `teammateName`, session schema for `TeammateIdle`/`TaskCompleted`, team grouping (clusters by teamName, tethers use team color, auras show team name label, mixed groups separate correctly)
- **test-launch.js**: launcher logic, platform detection, editor flag handling
- **test-adapters.js**: base adapter, engmux adapter, codex/opencode/openclaw adapter behavior, editor PID liveness tracking (pid field in state writes incl. win32 omission, renderer candidate validation via start-time identity and `editorDead` rescue), editor provenance field plumbing (buildExtra, defaultEditor, prefixed fallback IDs, guardedWriteState preservation), parallel session classification end-to-end (registry and birthtime paths, subagent regression guard, stale-stamp healing incl. teammate exemption, SessionStart registration)
- **test-transition.js**: `SwapTransition` lifecycle (start/tick/cancel), phase progression (dissolve/swap/materialize/done), `dimFactor` brightness curve, constants
- **test-emotions.js**: the emotion-fidelity contract — table of current Claude Code tool names → pre/post states and details, `humanizeToolName`, non-string input coercion, `normalizeToolResponse` passthrough (interrupted/isError/exitCode → error end to end), truncated-input event map, the timing table and the guaranteed-window / `pendingWork` / `forceState` rules, shared state sets and `FRESH_READ_STATES` coverage, question/echo particles, distinct orbital eyes for every state, thought pools, and subprocess tests for `UserPromptSubmit` and `Notification` types
- **test-platform.js**: cross-platform launching (`quoteArg`/`shQuote`, `buildRendererCommands` quoting for wt / cmd / osascript / xfce4, `buildEditorSpawn` shell rules for .cmd shims), `writeJsonAtomic`, `acquireSpawnLock`, `normalizeStats`, `normalizePaletteIndex`, base-adapter `pidField` parity and `processStdinEvent` error separation, adapter source hygiene, codex-notify stats, update-state.js catch-path orbital ownership and degenerate-stats survival, renderer source-level fixes (resize redraw, watcher cleanup), face tiny-terminal behaviour, grid cache keys and PID-cache sweep, and setup.js (`setupClaude`/`uninstallClaude` against a temp settings.json: merge, corrupt-file abort, idempotency, moved-path repair, backup)

### Visual Verification

For visual testing, use the demo scripts:

1. Run `npm start` in one terminal
2. Run `npm run demo` in another terminal
3. Observe the face cycling through all 23 states

For orbital subagents: `npm start` + `npm run demo:orbital`.

## Important Constraints

- **Hook performance**: update-state.js must complete in ~50ms — it runs synchronously in the editor hook pipeline
- **State file size**: a realistic state write is ~750–950 bytes (`frequentFiles`, `cwd`, `gitBranch` and the stats fields account for most of it); keep it around 1 KB and never embed tool output
- **Terminal minimum size**: Main face requires 38x20 chars (`MIN_COLS_SINGLE`/`MIN_ROWS_SINGLE` in face.js; below that a "resize me" fallback is drawn and `lastPos` is cleared). Orbitals have no fixed minimum: `calculateOrbit` in grid.js derives the ellipse from the space around the main face and yields `maxSlots: 0` when nothing fits, so they degrade gracefully
- **No network**: All IPC is file-based, no sockets or HTTP
- **Graceful degradation**: Renderer handles terminal resize, missing state files, and stale sessions without crashing

## Known Follow-ups

- **Double clearing**: `renderer.js` writes `ansi.home + ansi.clearBelow` every frame (added to fix stale content in tall terminals), which makes the incremental clear buffers (`particles.clearPrevious`, `OrbitalSystem._buildClearBuf`, the 21-row band in `face.js`, `prevSessionListClear`, `_prevHelpBounds`) dead work. Either side could be removed, but each changes rendering behaviour — left as is until someone can compare flicker across terminals.
- **Stats read-modify-write**: parallel tool calls run parallel hooks; the stats file is written atomically but not locked, so a counter increment can still be lost under contention.
- **engmux** has an adapter but no `setup`/`launch` entry point; invoke `adapters/engmux-adapter.js` directly.
- A state file without a `timestamp` is never applied by the renderer (`ts > lastAppliedTimestamp` with both 0). Every writer stamps one, so this only affects hand-written files.
