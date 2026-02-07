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

## Thought Bubbles

The face shows a tiny thought bubble with contextual content:

```
                   ╭──────────────────╮
                   │ tool call #23    │
                   ╰──────────────────╯
                  o
         ╭────────────────────╮
         │      ██      ██    │
         │      ██      ██    │
         │         ◡◡◡        │
         ╰────────────────────╯
```

Content adapts to what's happening: file count when editing multiple files, tool call number, session duration, or idle flavor text ("thinking about types", "contemplating recursion").

## Streaks & Achievements

A persistent counter tracks consecutive successful tool calls. The face gets increasingly confident during long streaks, and when a build finally fails, the reaction is proportional to how long the streak was — first error after 50 successes? *DEVASTATION.* Milestones at 10, 25, 50, 100, 200, and 500 trigger sparkle celebrations. Stats persist across sessions in `~/.claude-face-stats.json`.

## Session Timeline

A thin color-coded bar underneath the face shows a visual history of the session:

```
  ████░░████████▓▓▓▓░░████████████████
```

Each color maps to a state — purple for thinking, green for coding, red for errors, gold for happy. At a glance you can see how the session went: lots of red? rough session. smooth green? clean run. It's a tiny EKG for your AI.

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

| State | Eyes | Mouth | Trigger | Vibe |
|---|---|---|---|---|
| **Idle** | `██ ██` + blinking | `◡◡◡` | No activity | Calm, breathing, floating particles |
| **Thinking** | `● ●` (rotating) | `───` | Between tool calls | Orbiting particles, contemplative |
| **Reading** | `── ──` (narrowed) | `───` | `Read`, `View` | Focused, studying |
| **Searching** | `██ ██` (darting) | `○` | `Grep`, `Glob`, `WebFetch` | Eyes look left and right |
| **Coding** | `▀▀ ▀▀` (focused) | `═══` | `Edit`, `Write` | Determined, in the zone |
| **Executing** | `██ ██` | `◡◡` | `Bash` | Running commands |
| **Happy** | `✦ ✧` (sparkle) | `◡◡◡◡◡` | Successful completion | Sparkle particles everywhere |
| **Error** | `╲╱ ╲╱` (glitch) | `◠◠◠` | Non-zero exit code | Border glitches, distress particles |
| **Sleeping** | `── ──` (closed) | `~~~` | 60s idle | Zzz particles float up, slow breathing, deep indigo |
| **Waiting** | `▄▄ ██` (half-lidded) | `───` | Notification / needs input | Gentle `?` particles, patient pulse |
| **Testing** | `██ ██` (intense) | `═══` | `jest`, `pytest`, `vitest`, etc. | Nervous twitches, sweat drop particles |
| **Installing** | `▄▄` (looking down) | `···` | `npm install`, `pip install`, etc. | Falling dot particles like packages raining down |
| **Caffeinated** | `██` (vibrating) | `▪◡▪` | 5+ tool calls in 10 seconds | Speed line particles, fast breathing, face jitter |
| **Subagent** | `██ ██` | `◡◡` | `Task` / subagent spawn | Ghost echo particles (╭╮╰╯│─), mitosis energy |

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
node claude-face/renderer.js --grid
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

# Grid demo with simulated sessions (run renderer.js --grid first)
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
│  (hooks fire)  │    JSON per         │  state            │
│                │    session           │  sessions/*.json  │
│  Main session  │                     │                   │
│  Subagent 1    │                     │  main.json        │
│  Subagent 2    │                     │  sub-2.json       │
└───────────────┘                      └────────┬──────────┘
                                                │
                                           fs.watch
                                                │
                                    ┌───────────▼──────────┐
                                    │     renderer.js       │
                                    │     @ 15fps           │
                                    │                       │
                                    │  (default) single face│
                                    │  (--grid)  multi-grid │
                                    └───────────────────────┘
```

1. **Hooks fire** on `PreToolUse`, `PostToolUse`, `Stop`, and `Notification` events
2. **`update-state.js`** maps tool names to face states and writes:
   - A single `~/.claude-face-state` file (for the classic renderer)
   - A per-session file in `~/.claude-face-sessions/` (for the grid)
3. **Session ID** is extracted from the hook data (`session_id`), falling back to the parent process ID — each Claude instance and subagent gets its own face
4. **`renderer.js`** watches for file changes and animates transitions (single face by default, `--grid` for multi-face)

## Files

| File | What it does |
|---|---|
| `renderer.js` | Unified renderer — single face (default) or grid (`--grid`) |
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
- Single mode: ~0.5% CPU at 15fps
- Grid mode: ~0.5% CPU at 15fps (even with many faces)
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
rm ~/.claude-face-stats.json
rm ~/.claude-face.pid
rm ~/.claude-face-grid.pid
rm -rf ~/.claude-face-sessions
```

## License

MIT
