# Code Crumb

A terminal tamagotchi that shows what your AI coding assistant is doing.

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

Code Crumb hooks into AI coding tool lifecycle events and displays an animated face that reacts in real time — blinking, searching, coding, celebrating, and occasionally glitching when things go wrong.

**Supported editors:** Claude Code, OpenAI Codex CLI, OpenCode — and any tool that can pipe JSON events.

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

A persistent counter tracks consecutive successful tool calls. The face gets increasingly confident during long streaks, and when a build finally fails, the reaction is proportional to how long the streak was — first error after 50 successes? *DEVASTATION.* Milestones at 10, 25, 50, 100, 200, and 500 trigger sparkle celebrations. Stats persist across sessions in `~/.code-crumb-stats.json`.

## Session Timeline

A thin color-coded bar underneath the face shows a visual history of the session:

```
  ████░░████████▓▓▓▓░░████████████████
```

Each color maps to a state — purple for thinking, green for coding, red for errors, gold for happy, teal for satisfied, green-gold for proud, amber for relieved. At a glance you can see how the session went: lots of red? rough session. smooth green? clean run. It's a tiny EKG for your AI.

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
| **Happy** | `✦ ✧` (sparkle) | `◡◡◡◡◡` | Session complete (Stop) | Sparkle particles everywhere, lingers 8s |
| **Satisfied** | `▀▀ ▀▀` (content) | `◡◡◡` | Read/search/fetch done | Calm teal glow, gentle floaters |
| **Proud** | `▄▄ ██` (pleased) | `◡◡` | Code edit/write done | Green-gold sparkles, confident squint |
| **Relieved** | `██ ██` (relaxed) | `◡` | Command/test passed | Warm amber, soft exhale particles |
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
git clone https://github.com/Skelly0/code-crumb.git
```

### 2. Install hooks

**Claude Code** (default):
```bash
node code-crumb/setup.js
```

**Codex CLI:**
```bash
node code-crumb/setup.js codex
```

**OpenCode:**
```bash
node code-crumb/setup.js opencode
```

**As a Claude Code plugin** (alternative to manual hook setup):
```bash
claude plugin install --plugin-dir ./code-crumb
```

### 3. Run

**Single face** (the classic big animated face):

```bash
node code-crumb/renderer.js
```

**Grid mode** (one mini-face per session/subagent):

```bash
node code-crumb/renderer.js --grid
```

**Via the launcher** (auto-opens the face in a new terminal tab):

```bash
# Claude Code (default)
node code-crumb/launch.js
node code-crumb/launch.js --grid

# Codex CLI (uses wrapper for rich tool-level events)
node code-crumb/launch.js --editor codex "fix the auth bug"

# OpenCode
node code-crumb/launch.js --editor opencode

# With any editor arguments
node code-crumb/launch.js --dangerously-skip-permissions
node code-crumb/launch.js --grid -p "fix the auth bug"
node code-crumb/launch.js --resume
```

On Windows you can also use the batch wrapper:

```powershell
code-crumb\code-crumb.cmd --grid --dangerously-skip-permissions
```

### 4. Preview

```bash
# Single face demo (run renderer.js in another pane first)
node code-crumb/demo.js

# Grid demo with simulated sessions (run renderer.js --grid first)
node code-crumb/grid-demo.js
```

### 5. (Optional) Add to PATH

**Windows (PowerShell):**
```powershell
function code-crumb { node "C:\path\to\code-crumb\launch.js" @args }
```

**macOS / Linux:**
```bash
chmod +x ~/code-crumb/code-crumb.sh
ln -s ~/code-crumb/code-crumb.sh /usr/local/bin/code-crumb
```

Or use npm link:
```bash
cd code-crumb && npm link
```

## Model Name Display

The status line shows the model/tool name: `claude is thinking`, `codex is coding`, etc. This is configurable:

```bash
# Set via environment variable
export CODE_CRUMB_MODEL=kimi-k2.5
node code-crumb/renderer.js
```

Each adapter sets a sensible default:
- **Claude Code**: `claude`
- **Codex CLI**: `codex`
- **OpenCode**: `opencode`

The model name can also be passed in event JSON via the `model_name` field.

## How It Works

```
┌───────────────┐     state files     ┌──────────────────┐
│  Claude Code   │                     │  ~/.code-crumb-  │
│  Codex CLI     │ ──── writes ────▶  │  state            │
│  OpenCode      │    JSON per         │  sessions/*.json  │
│  (any editor)  │    session          │                   │
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

1. **Hooks/adapters fire** on tool use events (PreToolUse, PostToolUse, Stop, Notification)
2. **`update-state.js`** (or an adapter) maps tool names to face states and writes:
   - A single `~/.code-crumb-state` file (for the classic renderer)
   - A per-session file in `~/.code-crumb-sessions/` (for the grid)
3. **Session ID** is extracted from the event data (`session_id`), falling back to the parent process ID — each instance and subagent gets its own face
4. **`renderer.js`** watches for file changes and animates transitions (single face by default, `--grid` for multi-face)

## Editor-Specific Integration

### Claude Code

Hooks are installed via `setup.js` or by installing as a plugin. Events fire automatically via Claude Code's hook system (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`).

### Codex CLI

Codex doesn't have a hook system, so two adapter modes are provided:

| Mode | How it works | Granularity |
|---|---|---|
| **Notify** (`setup.js codex`) | Configures `notify` in `~/.codex/config.toml` | Turn-level (completion only) |
| **Wrapper** (`launch.js --editor codex`) | Wraps `codex exec --json` and parses JSONL | Tool-level (full reactions) |

The wrapper mode gives rich real-time reactions but only works with `codex exec` (non-interactive). The notify mode works with all Codex modes but only fires on turn completion.

### OpenCode

OpenCode uses a plugin system. Create a plugin that pipes events to the adapter:

1. Create `~/.config/opencode/plugins/code-crumb.js`:
```js
const { execSync } = require('child_process');
const adapter = '/path/to/code-crumb/adapters/opencode-adapter.js';

function send(payload) {
  try {
    execSync(`node "${adapter}"`,
      { input: JSON.stringify(payload), timeout: 200, stdio: ['pipe','ignore','ignore'] });
  } catch {}
}

export const CodeCrumbPlugin = async (ctx) => {
  return {
    'tool.execute.before': async (input, output) => {
      send({ type: 'tool.execute.before', input: { tool: input.tool, args: input.args } });
    },
    'tool.execute.after': async (input, output) => {
      send({ type: 'tool.execute.after', input: { tool: input.tool, args: input.args }, output });
    },
    'session.idle': async (input, output) => {
      send({ type: 'session.idle' });
    },
    'session.error': async (input, output) => {
      send({ type: 'session.error', output: { error: input.error || 'Session error' } });
    },
  };
};
```

2. Add to `~/.config/opencode/opencode.json`:
```json
{ "plugins": ["./plugins/code-crumb.js"] }
```

The adapter also accepts a generic format (`{"event":"tool_start",...}`) for backward compatibility.

## Files

| File | What it does |
|---|---|
| `renderer.js` | Unified renderer — single face (default) or grid (`--grid`) |
| `update-state.js` | Hook script — maps tool events to face states |
| `launch.js` | Auto-starts renderer and launches the editor with args |
| `setup.js` | Installs hooks (`setup.js [claude|codex|opencode|openclaw]`) |
| `adapters/codex-wrapper.js` | Wraps `codex exec --json` for rich tool-level events |
| `adapters/codex-notify.js` | Handles Codex `notify` config events |
| `adapters/opencode-adapter.js` | Adapter for OpenCode plugin events |
| `adapters/openclaw-adapter.js` | Adapter for OpenClaw/Pi agent events |
| `.claude-plugin/plugin.json` | Claude Code plugin manifest for marketplace |
| `hooks/hooks.json` | Hook config for Claude Code plugin system |
| `demo.js` | Cycles through all expressions (single face) |
| `grid-demo.js` | Simulates multiple sessions (grid mode) |
| `code-crumb.cmd` | Windows batch wrapper |
| `code-crumb.sh` | Unix shell wrapper |

## Configuration

### Custom state file location

```bash
export CODE_CRUMB_STATE=/tmp/my-code-crumb-state
```

The sessions directory is always `~/.code-crumb-sessions/`.

### Custom model name

```bash
export CODE_CRUMB_MODEL=gpt-4.1
```

### Manual hook setup (Claude Code)

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

### Manual setup (Codex CLI)

Add to `~/.codex/config.toml`:

```toml
notify = ["node", "/path/to/adapters/codex-notify.js"]
```

## Grid Mode Details

- Each session writes to `~/.code-crumb-sessions/{session_id}.json`
- The grid auto-layouts based on terminal size (up to ~8 faces across in an 80-col terminal)
- Sessions are labeled by working directory name — different projects get different labels
- Sessions sharing a directory get `main` / `sub-1` / `sub-2` labels
- Faces linger after a session stops (happy 8s, proud 5s, relieved 4s, satisfied 3.5s)
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

**Claude Code:** Remove the `update-state.js` hook entries from `~/.claude/settings.json` (or run `claude plugin uninstall code-crumb`).

**Codex:** Remove the `notify` line from `~/.codex/config.toml`.

Clean up state files:

```bash
rm ~/.code-crumb-state
rm ~/.code-crumb-stats.json
rm ~/.code-crumb.pid
rm ~/.code-crumb-grid.pid
rm -rf ~/.code-crumb-sessions
```

## License

MIT
