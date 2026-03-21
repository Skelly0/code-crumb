# CLAUDE.md

## Project Overview

Code Crumb is a zero-dependency terminal tamagotchi that visualizes what AI coding assistants are doing in real-time. It renders an animated ASCII face that reacts to lifecycle events (thinking, coding, reading, executing, errors, etc.) via hooks, adapters, and file-based IPC. Supports **Claude Code**, **OpenAI Codex CLI**, **OpenCode**, **OpenClaw/Pi**, and any tool that can pipe JSON events.

### Interactive Keybindings

| Key | Action |
|-----|--------|
| `space` | Pet the face (sparkle particles + wiggle) |
| `t` | Cycle color palette (default/neon/pastel/mono/sunset) |
| `s` | Toggle stats (streak, timeline, sparkline) |
| `a` | Toggle accessories (hats, ears, etc.) |
| `o` | Toggle orbital subagents |
| `l` | Open session list |
| `↑↓` / `j/k` | Navigate session list |
| `Enter` | Promote selected orbital to main (dissolve/swap/materialize animation) |
| `h` / `?` | Toggle help overlay |
| `q` / Ctrl+C | Quit |

### Color Palettes

5 palettes: **default** (original colors), **neon** (high saturation cyans/magentas/limes), **pastel** (soft pinks/lavenders/mints), **mono** (greyscale), **sunset** (warm oranges/reds/golds/purples). Press `t` to cycle. All togglable preferences (theme, accessories, stats, orbitals) persist between sessions via `~/.code-crumb-prefs.json`. Indicators below the face box show `● accs` / `○ accs` and `● subs` / `○ subs`.

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
shared.js        Shared constants — paths, config, and utility functions
launch.js        Platform-specific launcher — opens renderer + starts editor (--editor flag)
setup.js         Multi-editor setup — installs hooks (setup.js [claude|codex|opencode|openclaw])
test.js          Test runner — loads 12 modular test files from tests/ (~1469 tests)
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
  test-shared.js, test-state-machine.js, test-themes.js, test-animations.js,
  test-particles.js, test-face.js, test-grid.js, test-accessories.js,
  test-teams.js, test-launch.js, test-adapters.js, test-transition.js
.claude-plugin/
  plugin.json      Claude Code plugin manifest for marketplace distribution
hooks/
  hooks.json       Hook configuration for Claude Code plugin system
```

## Architecture

### Event Flow

```
Editor Event (Claude Code / Codex / OpenCode / OpenClaw) → update-state.js or adapter → State File (JSON) → renderer.js (fs.watch) → Terminal Output
```

### File-Based IPC

State is communicated between the hook handler and renderer via JSON files:

- `~/.code-crumb-state` — single-mode state (written by update-state.js, watched by renderer.js)
- `~/.code-crumb-sessions/{session_id}.json` — per-session state for orbital subagents (includes sticky `taskDescription` field set at SubagentStart)
- `~/.code-crumb-stats.json` — persistent stats (streaks, records, session counters)
- `~/.code-crumb-prefs.json` — persisted user preferences (theme, accessories, stats, orbitals toggle)
- `~/.code-crumb.pid` — renderer process liveness tracking

### State Machine

23 face states: `idle`, `thinking`, `responding`, `reading`, `searching`, `coding`, `executing`, `happy`, `satisfied`, `proud`, `relieved`, `error`, `sleeping`, `waiting`, `testing`, `installing`, `caffeinated`, `subagent`, `starting`, `spawning`, `committing`, `reviewing`, `training`.

States have minimum display durations (1–8 seconds) enforced via a `pendingState` queue to prevent visual flashing.

### Hook Events

Twenty hook event types are handled: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `TeammateIdle`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `PermissionRequest`, `Setup`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `StopFailure`. Tool names from all supported editors are mapped to face states via shared regex patterns (e.g., Edit/apply_diff/file_edit → coding, Grep/search_files/codebase_search → searching, Bash/shell/terminal → executing). PostToolUse includes forensic error detection with 50+ regex patterns.

The newer lifecycle events map to existing face states: `PreCompact` → thinking (with rain particles), `PostCompact` → satisfied, `PermissionRequest` → waiting (with question particles), `Setup` → starting, `Elicitation` → waiting (with question particles), `ElicitationResult` → satisfied/relieved, `ConfigChange` → reading, `InstructionsLoaded` → reading, `StopFailure` → error (breaks streak). `WorktreeCreate`/`WorktreeRemove` are intentionally not registered because they replace default git worktree behavior.

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

Tool name patterns are defined as shared constants (`EDIT_TOOLS`, `BASH_TOOLS`, `READ_TOOLS`, `SEARCH_TOOLS`, `WEB_TOOLS`, `SUBAGENT_TOOLS`, `REVIEW_TOOLS`) in `state-machine.js`. Each pattern matches tool names from Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi. The `modelName` field in state files controls the display name (e.g., "claude is thinking" vs "codex is coding" vs "openclaw is reading").

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
- **Cross-platform paths**: Uses `process.env.USERPROFILE || process.env.HOME` and normalizes backslashes to forward slashes
- **No external dependencies**: All functionality is built with Node.js built-in modules (`fs`, `path`, `child_process`)

## Key Constants

| Constant | Value | Location |
|---|---|---|
| `FPS` | 15 | renderer.js |
| `IDLE_TIMEOUT` | 8000ms | renderer.js |
| `THINKING_TIMEOUT` | 45000ms | renderer.js, grid.js |
| `SLEEP_TIMEOUT` | 60000ms | renderer.js |
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | face.js |
| `STALE_MS` | 120000ms | grid.js (session file mtime purge threshold) |
| `ORPHAN_TIMEOUT` | 90000ms | grid.js (fallback staleness for sessions without PID) |
| `MAX_ORBITALS` | 8 | grid.js (max visible orbital faces) |
| `ROTATION_SPEED` | 0.007 rad/frame | grid.js (~1 revolution per 60s) |
| `INTER_GROUP_GAP` | 0.15 rad | grid.js (angular space between group sectors) |
| `INTRA_GROUP_GAP` | 0.35 rad | grid.js (angular space between faces within a group) |
| `TETHER_BRIGHTNESS` | 0.15 | grid.js (dim factor for sibling tether dots) |
| `GROUP_LABEL_BRIGHTNESS` | 0.45 | grid.js (dim factor for floating group label) |
| `MAX_SEGMENT_BLOCKS` | 5 | face.js (max visual blocks per state segment in timeline) |
| `CYCLE_WORK_STATES` | 5 states | grid.js (activity cycling sequence for synthetic subagent faces) |
| `CYCLE_INTERVAL` | 2500ms | grid.js (ms between cycling state changes) |
| `CYCLE_STALE_MS` | 3000ms | grid.js (start cycling after no real data for this duration) |

## Environment Variables

- `CODE_CRUMB_STATE` — override the single-mode state file path (default: `~/.code-crumb-state`)
- `CLAUDE_SESSION_ID` — set the session identifier (default: parent PID)
- `CODE_CRUMB_MODEL` — override the display name in the status line (default: `claude`; adapters default to `codex`/`opencode`/`openclaw`)
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` — set to `1` to enable Claude Code agent teams; Code Crumb will automatically detect teammate sessions via `TeammateIdle`/`TaskCompleted` hooks and show them in the orbital display with role labels and team-specific colors

## Testing

### Automated Tests

Run `npm test` (or `node test.js`). The test runner loads 12 modular test files from `tests/`. The suite (~1469 tests) covers:

- **test-shared.js**: `safeFilename` edge cases
- **test-state-machine.js**: `toolToState` mapping (all tool types across Claude Code, Codex, OpenCode, OpenClaw/Pi), multi-editor tool pattern constants incl. `REVIEW_TOOLS`, `extractExitCode`, `looksLikeError` with stdout/stderr patterns, false positive guards, `errorDetail` friendly messages, `classifyToolResult` (full PostToolUse decision tree), `updateStreak` and milestone detection, `defaultStats` initialization
- **test-themes.js**: `lerpColor`/`dimColor`/`breathe`/`dimAnsiOutput` color math, theme completeness (all 23 states), `COMPLETION_LINGER` ordering, thought bubble pools
- **test-animations.js**: mouth/eye functions (shape and randomness)
- **test-particles.js**: `ParticleSystem` (all 15 styles incl. stream, fire, lifecycle, fadeAll)
- **test-face.js**: `ClaudeFace` state machine (`setState`, `setStats`, `update`, pending state buffering, particle spawning, sparkline, orbital toggle)
- **test-grid.js**: `MiniFace`, `OrbitalSystem` (orbit calculation, session exclusion, rotation, connection rendering, conducting animation, stream particles, taskDescription label priority, SessionStart adoption, `_buildGroups` grouping/sorting/color, `_calculateGroupedAngles` sector allocation with pixel-aware spacing, `_renderGroupTethers` dashed sibling lines with all-positions check and spawning exclusion, `_getGroupLabel` 4-tier priority chain (branch/cwd/taskDescription/label fallback, default branch exclusion, truncation), `_renderGroupLabels` floating labels for team/non-team groups, `_resolveOverlaps` bounding box collision resolver), `renderSessionList` selection highlight and footer
- **test-accessories.js**: accessory definitions, rendering, state-specific adornments
- **test-teams.js**: `hashTeamColor` consistency and RGB output, `MiniFace` team fields, `_assignLabels` with `teammateName`, session schema for `TeammateIdle`/`TaskCompleted`, team grouping (clusters by teamName, tethers use team color, auras show team name label, mixed groups separate correctly)
- **test-launch.js**: launcher logic, platform detection, editor flag handling
- **test-adapters.js**: base adapter, engmux adapter, codex/opencode/openclaw adapter behavior
- **test-transition.js**: `SwapTransition` lifecycle (start/tick/cancel), phase progression (dissolve/swap/materialize/done), `dimFactor` brightness curve, constants

### Visual Verification

For visual testing, use the demo scripts:

1. Run `npm start` in one terminal
2. Run `npm run demo` in another terminal
3. Observe the face cycling through all 23 states

For orbital subagents: `npm start` + `npm run demo:orbital`.

## Important Constraints

- **Hook performance**: update-state.js must complete in ~50ms — it runs synchronously in the editor hook pipeline
- **State file size**: Keep state JSON under 200 bytes
- **Terminal minimum size**: Main face requires 38x20 chars; orbitals require 80x30 (graceful degradation below)
- **No network**: All IPC is file-based, no sockets or HTTP
- **Graceful degradation**: Renderer handles terminal resize, missing state files, and stale sessions without crashing
