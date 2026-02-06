# Claude Face

A terminal tamagotchi that shows what Claude Code is doing.

```
         ╭────────────────────╮
         │                    │
         │      ██      ██    │
         │      ██      ██    │
         │                    │
         │         ◡◡◡        │
         │                    │
         ╰────────────────────╯
           ·  claude is idle  ·
```

Claude Face hooks into Claude Code's lifecycle events and displays an animated face that reacts in real time — blinking, searching, coding, celebrating, and occasionally glitching when things go wrong.

Zero dependencies. Just Node.js and vibes.

## Grid Mode

When you're running multiple Claude Code sessions or using subagents, the **grid renderer** shows one mini-face per session, auto-laid out based on terminal size:

```
  ╭──────╮  ╭──────╮  ╭──────╮  ╭──────╮
  │ ██ ██│  │ ▀▀ ▀▀│  │ ╲╱╲╱│  │ ── ──│
  │ ◡◡◡  │  │ ═══  │  │ ◠◠◠ │  │ ───  │
  ╰──────╯  ╰──────╯  ╰──────╯  ╰──────╯
    main      sub-1     sub-2    api-server
    idle      coding    error!    reading
```

Each face has its own blink timer, color theme, and state. Sessions appear when they start using tools and fade away when they stop. Labels are derived from the working directory — sessions in the same directory get `main`/`sub-N` labels, sessions in different directories show the folder name.

## Expressions

| State | Eyes | Trigger | Vibe |
|---|---|---|---|
| **Idle** | `██ ██` + blinking | No activity | Calm, breathing, floating particles |
| **Thinking** | `● ●` (rotating) | Between tool calls | Orbiting particles, contemplative |
| **Reading** | `── ──` (narrowed) | `Read`, `View` | Focused, studying |
| **Searching** | `██ ██` (darting) | `Grep`, `Glob`, `WebFetch` | Eyes look left and right |
| **Coding** | `▀▀ ▀▀` (focused) | `Edit`, `Write` | Determined, in the zone |
| **Executing** | `██ ██` | `Bash` | Running commands |
| **Happy** | `✦ ✧` (sparkle) | Successful completion | Sparkle particles everywhere |
| **Error** | `╲╱ ╲╱` (glitch) | Non-zero exit code | Border glitches, distress particles |

## Quick Start

Requires **Node.js 18+** (you already have this if you use Claude Code).

Works on **Windows**, **macOS**, and **Linux**.

### 1. Clone

```bash
git clone https://github.com/Skelly0/claude-face.git
```

### 2. Install hooks

```bash
node claude-face/setup.js
```

This adds hooks to `~/.claude/settings.json` so Claude Code writes state updates for the face to read.

### 3. Run

**Single face** (the classic big animated face):

```bash
node claude-face/renderer.js
```

**Grid mode** (one mini-face per session/subagent):

```bash
node claude-face/grid-renderer.js
```

**Via the launcher** (auto-opens the face in a new terminal tab):

```bash
# Single face
node claude-face/launch.js

# Grid mode
node claude-face/launch.js --grid

# With any Claude arguments
node claude-face/launch.js --dangerously-skip-permissions
node claude-face/launch.js --grid -p "fix the auth bug"
node claude-face/launch.js --resume
```

On Windows you can also use the batch wrapper:

```powershell
claude-face\claude-face.cmd --grid --dangerously-skip-permissions
```

### 4. Preview

```bash
# Single face demo (run renderer.js in another pane first)
node claude-face/demo.js

# Grid demo with simulated sessions (run grid-renderer.js first)
node claude-face/grid-demo.js
```

### 5. (Optional) Add to PATH

**Windows (PowerShell):**
```powershell
function claude-face { node "C:\path\to\claude-face\launch.js" @args }
```

**macOS / Linux:**
```bash
chmod +x ~/claude-face/claude-face.sh
ln -s ~/claude-face/claude-face.sh /usr/local/bin/claude-face
```

Or use npm link:
```bash
cd claude-face && npm link
```

## How It Works

```
┌───────────────┐     state files     ┌──────────────────┐
│  Claude Code   │ ──── writes ────▶  │  ~/.claude-face-  │
│  (hooks fire)  │    JSON per         │  sessions/*.json  │
│                │    session           │                   │
│  Main session  │                     │  main.json        │
│  Subagent 1    │                     │  sub-1.json       │
│  Subagent 2    │                     │  sub-2.json       │
└───────────────┘                      └────────┬──────────┘
                                                │
                                           fs.watch
                                                │
                    ┌───────────────────────────────────────┐
                    │                                       │
              ┌─────▼──────┐                    ┌───────────▼──┐
              │ renderer.js │  (single face)     │ grid-renderer │
              │ @ 15fps     │                    │ .js @ 12fps   │
              └─────────────┘                    └───────────────┘
```

1. **Hooks fire** on `PreToolUse`, `PostToolUse`, `Stop`, and `Notification` events
2. **`update-state.js`** maps tool names to face states and writes:
   - A single `~/.claude-face-state` file (for the classic renderer)
   - A per-session file in `~/.claude-face-sessions/` (for the grid)
3. **Session ID** is extracted from the hook data (`session_id`), falling back to the parent process ID — each Claude instance and subagent gets its own face
4. **Renderers** watch for file changes and animate transitions

## Files

| File | What it does |
|---|---|
| `renderer.js` | Single animated face — the classic view |
| `grid-renderer.js` | Multi-face grid — one face per session |
| `update-state.js` | Hook script called by Claude Code on each event |
| `launch.js` | Auto-starts renderer and launches Claude with args |
| `setup.js` | Installs hooks into Claude Code's settings |
| `demo.js` | Cycles through all expressions (single face) |
| `grid-demo.js` | Simulates multiple sessions (grid mode) |
| `claude-face.cmd` | Windows batch wrapper |
| `claude-face.sh` | Unix shell wrapper |

## Configuration

### Custom state file location

```bash
export CLAUDE_FACE_STATE=/tmp/my-claude-face-state
```

The sessions directory is always `~/.claude-face-sessions/`.

### Manual hook setup

Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" PreToolUse" }]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" PostToolUse" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" Stop" }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" Notification" }]
    }]
  }
}
```

## Grid Mode Details

- Each session writes to `~/.claude-face-sessions/{session_id}.json`
- The grid auto-layouts based on terminal size (up to ~8 faces across in an 80-col terminal)
- Sessions are labeled by working directory name — different projects get different labels
- Sessions sharing a directory get `main` / `sub-1` / `sub-2` labels
- Faces linger for 5 seconds after a session stops (showing the "done!" state)
- Stale sessions (no update for 2 minutes) are cleaned up automatically
- Each face blinks independently and has its own color-breathing phase offset
- Session count is shown in the top-right corner

## Performance

- Zero dependencies — just Node.js
- Single renderer: ~0.5% CPU at 15fps
- Grid renderer: ~0.5% CPU at 12fps (even with many faces)
- Hook script runs in <50ms per invocation
- State files are <200 bytes each
- No network, no IPC, no sockets

## Terminal Compatibility

| Terminal | Status |
|---|---|
| Windows Terminal | Full support |
| iTerm2 | Full support |
| VS Code terminal | Full support |
| tmux | Full support |
| macOS Terminal.app | Works, some Unicode may render oddly |
| ConEmu / cmder | Should work |
| Legacy cmd.exe | Won't render correctly (no ANSI) |

## Uninstall

Remove the `update-state.js` hook entries from `~/.claude/settings.json` and clean up:

```bash
rm ~/.claude-face-state
rm ~/.claude-face.pid
rm ~/.claude-face-grid.pid
rm -rf ~/.claude-face-sessions
```

## License

MIT
