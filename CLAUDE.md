# CLAUDE.md

## Project Overview

Claude Face is a zero-dependency terminal tamagotchi that visualizes what AI coding assistants are doing in real-time. It renders an animated ASCII face that reacts to lifecycle events (thinking, coding, reading, executing, errors, etc.) via hooks, adapters, and file-based IPC. Supports **Claude Code**, **OpenAI Codex CLI**, **OpenCode**, **OpenClaw/Pi**, and any tool that can pipe JSON events.

### Interactive Keybindings

| Key | Action | Mode |
|-----|--------|------|
| `space` | Pet the face (sparkle particles + wiggle) | single |
| `t` | Cycle color palette (default/neon/pastel/mono/sunset) | both |
| `s` | Toggle stats (streak, timeline, sparkline) | single |
| `h` / `?` | Toggle help overlay | both |
| `q` / Ctrl+C | Quit | both |

### Color Palettes

5 palettes: **default** (original colors), **neon** (high saturation cyans/magentas/limes), **pastel** (soft pinks/lavenders/mints), **mono** (greyscale), **sunset** (warm oranges/reds/golds/purples). Press `t` to cycle. Grid mode supports theme cycling and help but not pet or stats toggle.

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
particles.js     ParticleSystem class — 10 visual effect styles
face.js          ClaudeFace class — single face mode state machine and rendering
grid.js          MiniFace + FaceGrid classes — multi-session grid mode
update-state.js  Hook handler — receives editor events via stdin, writes state files
state-machine.js Pure logic — tool→state mapping (multi-editor), error detection, streaks
shared.js        Shared constants — paths, config, and utility functions
launch.js        Platform-specific launcher — opens renderer + starts editor (--editor flag)
setup.js         Multi-editor setup — installs hooks (setup.js [claude|codex|opencode|openclaw])
test.js          Test suite — ~343 tests covering all critical paths (node test.js)
demo.js          Demo script — cycles through all face states in single-face mode
grid-demo.js     Demo script — simulates 4 concurrent sessions in grid mode
claude-face.sh   Unix shell wrapper for launch.js
claude-face.cmd  Windows batch wrapper for launch.js
adapters/
  codex-wrapper.js   Wraps `codex exec --json` for rich tool-level face events
  codex-notify.js    Handles Codex CLI `notify` config events (turn-level)
  opencode-adapter.js  Generic adapter for OpenCode and other tools (stdin JSON)
  openclaw-adapter.js  Adapter for OpenClaw/Pi agent events (stdin JSON)
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

- `~/.claude-face-state` — single-mode state (written by update-state.js, watched by renderer.js)
- `~/.claude-face-sessions/{session_id}.json` — per-session state for grid mode
- `~/.claude-face-stats.json` — persistent stats (streaks, records, session counters)
- `~/.claude-face.pid` / `~/.claude-face-grid.pid` — renderer process liveness tracking

### State Machine

16 face states: `idle`, `thinking`, `reading`, `searching`, `coding`, `executing`, `happy`, `satisfied`, `proud`, `relieved`, `error`, `sleeping`, `waiting`, `testing`, `installing`, `caffeinated`, `subagent`.

States have minimum display durations (1–8 seconds) enforced via a `pendingState` queue to prevent visual flashing.

### Hook Events

Four hook event types are handled: `PreToolUse`, `PostToolUse`, `Stop`, `Notification`. Tool names from all supported editors are mapped to face states via shared regex patterns (e.g., Edit/apply_diff/file_edit → coding, Grep/search_files/codebase_search → searching, Bash/shell/terminal → executing). PostToolUse includes forensic error detection with 50+ regex patterns.

### Multi-Editor Tool Mapping

Tool name patterns are defined as shared constants (`EDIT_TOOLS`, `BASH_TOOLS`, `READ_TOOLS`, `SEARCH_TOOLS`, `WEB_TOOLS`, `SUBAGENT_TOOLS`) in `state-machine.js`. Each pattern matches tool names from Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi. The `modelName` field in state files controls the display name (e.g., "claude is thinking" vs "codex is coding" vs "openclaw is reading").

## Development Commands

```sh
npm start              # Run the renderer (single-face mode)
npm run grid           # Run the renderer (grid mode)
npm test               # Run the test suite
npm run demo           # Run the single-face demo
npm run demo:grid      # Run the grid demo
npm run setup          # Install Claude Code hooks (default)
npm run setup:claude   # Install Claude Code hooks (explicit)
npm run setup:codex    # Install Codex CLI integration
npm run setup:opencode # Show OpenCode integration instructions
npm run setup:openclaw # Show OpenClaw/Pi integration instructions
npm run launch         # Open renderer + start Claude Code
npm run launch:grid    # Same as above, grid mode
npm run launch:codex   # Open renderer + start Codex wrapper
npm run launch:opencode # Open renderer + start OpenCode
npm run launch:openclaw # Open renderer + start OpenClaw
```

To develop: run `npm run demo` in one terminal and `npm start` in another.

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
| `SLEEP_TIMEOUT` | 60000ms | renderer.js |
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | face.js |
| `STALE_MS` | 120000ms | grid.js (grid session timeout) |
| `CELL_W` / `CELL_H` | 12 / 7 | grid.js (grid cell dimensions) |

## Environment Variables

- `CLAUDE_FACE_STATE` — override the single-mode state file path (default: `~/.claude-face-state`)
- `CLAUDE_SESSION_ID` — set the session identifier (default: parent PID)
- `CLAUDE_FACE_MODEL` — override the display name in the status line (default: `claude`; adapters default to `codex`/`opencode`/`openclaw`)

## Testing

### Automated Tests

Run `npm test` (or `node test.js`). The test suite covers:

- **shared.js**: `safeFilename` edge cases
- **state-machine.js**: `toolToState` mapping (all tool types across Claude Code, Codex, OpenCode, OpenClaw/Pi), multi-editor tool pattern constants, `extractExitCode`, `looksLikeError` with stdout/stderr patterns, false positive guards, `errorDetail` friendly messages, `classifyToolResult` (full PostToolUse decision tree), `updateStreak` and milestone detection, `defaultStats` initialization
- **themes.js**: `lerpColor`/`dimColor`/`breathe` color math, theme completeness (all 17 states), `COMPLETION_LINGER` ordering, thought bubble pools
- **animations.js**: mouth/eye functions (shape and randomness)
- **particles.js**: `ParticleSystem` (all 10 styles, lifecycle, fadeAll)
- **face.js**: `ClaudeFace` state machine (`setState`, `setStats`, `update`, pending state buffering, particle spawning, sparkline)
- **grid.js**: `MiniFace` grid mode, `FaceGrid` lifecycle

### Visual Verification

For visual testing, use the demo scripts:

1. Run `npm start` in one terminal
2. Run `npm run demo` in another terminal
3. Observe the face cycling through all 17 states

For grid mode: `npm run grid` + `npm run demo:grid`.

## Important Constraints

- **Hook performance**: update-state.js must complete in ~50ms — it runs synchronously in the editor hook pipeline
- **State file size**: Keep state JSON under 200 bytes
- **Terminal minimum size**: Single mode requires 38x20 chars; grid mode requires 14x9 per cell
- **No network**: All IPC is file-based, no sockets or HTTP
- **Graceful degradation**: Renderer handles terminal resize, missing state files, and stale sessions without crashing
