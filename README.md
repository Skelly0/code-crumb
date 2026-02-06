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

Claude Face hooks into Claude Code's lifecycle events and displays an animated ASCII face that reacts in real time — blinking, searching, coding, celebrating, and occasionally glitching when things go wrong.

Zero dependencies. Just Node.js and vibes.

## Expressions

| State | Eyes | Trigger | Vibe |
|---|---|---|---|
| **Idle** | `██ ██` + blinking | No activity | Calm, breathing, floating particles |
| **Thinking** | `● ●` (rotating) | Between tool calls | Orbiting particles, contemplative |
| **Reading** | `── ──` (narrowed) | `Read`, `View` | Focused, studying |
| **Searching** | `██ ██` (darting) | `Grep`, `Glob`, `WebFetch` | Eyes look left and right |
| **Coding** | `▄▄ ▀▀` (focused) | `Edit`, `Write` | Determined, in the zone |
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

**Option A — Launcher (recommended)**

The launcher automatically opens the face in a new terminal tab and starts Claude Code with whatever arguments you pass:

```bash
# Plain session
node claude-face/launch.js

# With arguments — works with anything
node claude-face/launch.js --dangerously-skip-permissions
node claude-face/launch.js -p "fix the auth bug"
node claude-face/launch.js --resume
```

On Windows you can also use the batch wrapper:

```powershell
claude-face\claude-face.cmd --dangerously-skip-permissions
```

**Option B — Manual split**

Open two terminal panes side by side:

```bash
# Pane 1: the face
node claude-face/renderer.js

# Pane 2: Claude Code as normal
claude
claude --dangerously-skip-permissions
claude -p "whatever"
```

### 4. (Optional) Add to PATH

To use `claude-face` as a command from anywhere:

**Windows (PowerShell):**
```powershell
# Add to your PowerShell profile
function claude-face { node "C:\path\to\claude-face\launch.js" @args }
```

**macOS / Linux:**
```bash
# Symlink the shell wrapper
chmod +x ~/claude-face/claude-face.sh
ln -s ~/claude-face/claude-face.sh /usr/local/bin/claude-face
```

Or use npm link:
```bash
cd claude-face && npm link
```

## How It Works

```
┌───────────────┐     state file      ┌───────────────┐
│  Claude Code   │ ──── writes ────▶  │  ~/.claude-    │
│  (hooks fire)  │    JSON state       │  face-state    │
└───────────────┘                      └───────┬───────┘
                                               │
                                          fs.watch
                                               │
                                       ┌───────▼───────┐
                                       │   renderer.js  │
                                       │  (animation    │
                                       │   loop @ 15fps)│
                                       └───────────────┘
```

1. **Hooks fire** on `PreToolUse`, `PostToolUse`, `Stop`, and `Notification` events in Claude Code
2. **`update-state.js`** maps tool names to face states and writes a tiny JSON blob to `~/.claude-face-state`
3. **`renderer.js`** watches that file and animates transitions between expressions — blinking, particles, color breathing, the works
4. Everything communicates via a single JSON file. No dependencies, no network, no sockets.

## Files

| File | What it does |
|---|---|
| `renderer.js` | The animated face — run this in a terminal |
| `update-state.js` | Hook script called by Claude Code on each event |
| `launch.js` | Auto-starts the renderer and launches Claude with args |
| `setup.js` | Installs the hooks into Claude Code's settings |
| `demo.js` | Cycles through all expressions for preview |
| `claude-face.cmd` | Windows batch wrapper for launch.js |
| `claude-face.sh` | Unix shell wrapper for launch.js |

## Configuration

### Custom state file location

Set `CLAUDE_FACE_STATE` to change where the state file lives:

```bash
export CLAUDE_FACE_STATE=/tmp/my-claude-face-state
```

Defaults:
- **Windows:** `%USERPROFILE%\.claude-face-state`
- **macOS/Linux:** `~/.claude-face-state`

### Manual hook setup

If you prefer to configure hooks yourself instead of running `setup.js`, add this to `~/.claude/settings.json`:

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

## Windows Terminal Tips

Split panes are built in:

- **Alt+Shift+Plus** — vertical split (face on the right)
- **Alt+Shift+Minus** — horizontal split (face on the bottom)
- **Alt+Arrow** — switch panes

## Performance

- Zero dependencies — just Node.js
- Renderer uses ~0.5% CPU at 15fps
- Hook script runs in <50ms per invocation
- State file is <200 bytes
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

Remove the `update-state.js` hook entries from `~/.claude/settings.json` and delete the state file:

```bash
rm ~/.claude-face-state
rm ~/.claude-face.pid
```

## License

MIT
