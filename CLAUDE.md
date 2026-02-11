# CLAUDE.md

## Project Overview

Claude Face is a zero-dependency terminal tamagotchi that visualizes what Claude Code is doing in real-time. It renders an animated ASCII face that reacts to Claude Code lifecycle events (thinking, coding, reading, executing, errors, etc.) via Claude Code hooks and file-based IPC.

## Tech Stack

- **Runtime**: Node.js 18+ (no npm dependencies)
- **Language**: JavaScript (ES6+, CommonJS modules, strict mode)
- **Platforms**: Windows, macOS, Linux
- **Terminal features**: 24-bit ANSI RGB color, Unicode box-drawing characters, cursor positioning

## File Structure

```
renderer.js      Main rendering engine (single face + grid modes, 15 FPS animation loop)
update-state.js  Hook handler — receives Claude Code events via stdin, writes state files
launch.js        Platform-specific launcher — opens renderer in a new terminal window
setup.js         Installs Claude Code hooks into ~/.claude/settings.json
demo.js          Demo script — cycles through all face states in single-face mode
grid-demo.js     Demo script — simulates 4 concurrent sessions in grid mode
claude-face.sh   Unix shell wrapper for launch.js
claude-face.cmd  Windows batch wrapper for launch.js
```

## Architecture

### Event Flow

```
Claude Code Hook Event → update-state.js (stdin JSON) → State File (JSON) → renderer.js (fs.watch) → Terminal Output
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

Four Claude Code hook events are handled: `PreToolUse`, `PostToolUse`, `Stop`, `Notification`. Tool names are mapped to face states (e.g., Edit/Write → coding, Grep/Glob → searching, Bash → executing). PostToolUse includes forensic error detection with 50+ regex patterns.

## Development Commands

```sh
npm start           # Run the renderer (single-face mode)
npm run grid        # Run the renderer (grid mode)
npm run demo        # Run the single-face demo
npm run demo:grid   # Run the grid demo
npm run setup       # Install Claude Code hooks into ~/.claude/settings.json
npm run launch      # Open renderer in a new terminal + start Claude Code
npm run launch:grid # Same as above, grid mode
```

To develop: run `npm run demo` in one terminal and `npm start` in another.

## Code Conventions

- **Strict mode**: Every file starts with `'use strict'`
- **CommonJS**: Uses `require()` / no ES modules
- **Header blocks**: Each file has a boxed comment header explaining its purpose
- **Section dividers**: Logical sections separated by `// -- Section Name ---...` comments
- **Silent failures in hooks**: Hook code (update-state.js) wraps all I/O in try-catch and never throws — Claude Code must not be interrupted by a broken face
- **Cross-platform paths**: Uses `process.env.USERPROFILE || process.env.HOME` and normalizes backslashes to forward slashes
- **No external dependencies**: All functionality is built with Node.js built-in modules (`fs`, `path`, `child_process`)

## Key Constants

| Constant | Value | Location |
|---|---|---|
| `FPS` | 15 | renderer.js |
| `IDLE_TIMEOUT` | 8000ms | renderer.js |
| `SLEEP_TIMEOUT` | 60000ms | renderer.js |
| `CAFFEINE_THRESHOLD` | 5 calls in 10s | renderer.js |
| `STALE_MS` | 120000ms | renderer.js (grid session timeout) |
| `CELL_W` / `CELL_H` | 12 / 7 | renderer.js (grid cell dimensions) |

## Environment Variables

- `CLAUDE_FACE_STATE` — override the single-mode state file path (default: `~/.claude-face-state`)
- `CLAUDE_SESSION_ID` — set the session identifier (default: parent PID)

## Testing

There are no automated tests. Verification is done via the demo scripts:

1. Run `npm start` in one terminal
2. Run `npm run demo` in another terminal
3. Observe the face cycling through all 16 states

For grid mode: `npm run grid` + `npm run demo:grid`.

## Important Constraints

- **Hook performance**: update-state.js must complete in ~50ms — it runs synchronously in the Claude Code hook pipeline
- **State file size**: Keep state JSON under 200 bytes
- **Terminal minimum size**: Single mode requires 38x20 chars; grid mode requires 14x9 per cell
- **No network**: All IPC is file-based, no sockets or HTTP
- **Graceful degradation**: Renderer handles terminal resize, missing state files, and stale sessions without crashing
