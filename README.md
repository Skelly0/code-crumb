# Code Crumb

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-brightgreen.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#)
[![2715 Tests](https://img.shields.io/badge/tests-2715-brightgreen.svg)](#)

A terminal tamagotchi that shows what your AI coding assistant is doing.

![Code Crumb proud state — crown accessory, 43 streak, diff info, neon theme](images/proud-crown-diffinfo.png)

Code Crumb hooks into AI coding tool lifecycle events and displays an animated ASCII face that reacts in real time — blinking, searching, coding, celebrating, and occasionally glitching when things go wrong. 23 expressive states, 16 particle effects, 6 color palettes, orbital subagent tracking, streak counters, and you can pet it.

**Supported tools:** [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex CLI](https://github.com/openai/codex), [OpenCode](https://github.com/sst/opencode), [OpenClaw/Pi](https://github.com/anthropics/claw) — and anything that can pipe JSON events.

Zero dependencies. Just Node.js.

## Quick Start

Requires **Node.js 18+**. Works on **Windows**, **macOS**, and **Linux**.

> [!IMPORTANT]
> **`node` must be on your `PATH`** — every hook runs `node …`. On Windows, Claude Code runs hooks through Git Bash, so that is the `PATH` that counts. If you installed Claude Code with the native installer and never installed Node.js, there is no `node` for the hooks and every one of them fails.

### Claude Code (marketplace — recommended)

Install directly from the Code Crumb marketplace — no cloning required:

```bash
/plugin marketplace add Skelly0/code-crumb
/plugin install code-crumb@code-crumb
```

The plugin lives in Claude Code's plugin cache, one folder per version. After an update the old folder lingers for a while, marked with an `.orphaned_at` file, so a plain `*` glob can pick the wrong one. Open a second terminal and start the face from the current folder:

**macOS / Linux / Git Bash**

```bash
CRUMB="$(ls -td ~/.claude/plugins/cache/code-crumb/code-crumb/*/ | while IFS= read -r d; do [ -e "$d.orphaned_at" ] || { echo "$d"; break; }; done)"
node "${CRUMB}renderer.js"
```

**Windows (PowerShell)**

```powershell
$crumb = Get-ChildItem "$HOME\.claude\plugins\cache\code-crumb\code-crumb" -Directory |
  Where-Object { -not (Test-Path (Join-Path $_.FullName '.orphaned_at')) } |
  Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName
node "$crumb\renderer.js"
```

**Rather not open it by hand?** Turn on autolaunch once and the hooks open the face in a terminal of its own whenever it is not running. They open the renderer that sits next to them, so it keeps working across plugin updates:

```bash
node "${CRUMB}setup.js" --autolaunch
```

```powershell
node "$crumb\setup.js" --autolaunch
```

> [!TIP]
> The renderer runs in its own terminal window alongside your editor — it doesn't block anything. If you want a stable path, clone the repo and run `node code-crumb/renderer.js` instead. After you quit the renderer, autolaunch leaves it closed until your editor starts a new session.

### Claude Code (local plugin)

Clone and install as a local plugin:

```bash
git clone https://github.com/Skelly0/code-crumb.git
claude plugin marketplace add ./code-crumb
claude plugin install code-crumb@code-crumb
```

Then run the face in a second terminal:

```bash
node code-crumb/renderer.js
```

That's it. Start coding and the face reacts.

### Claude Code (manual hooks)

If you prefer not to use the plugin system:

```bash
git clone https://github.com/Skelly0/code-crumb.git
node code-crumb/setup.js
node code-crumb/renderer.js   # in a separate terminal
```

> [!TIP]
> Pass `--autolaunch` to have the renderer start automatically whenever your editor fires a hook — no need to open a second terminal manually:
> ```bash
> node code-crumb/setup.js --autolaunch
> ```
> You can also enable it later with `node setup.js --autolaunch`. The setting persists in `~/.code-crumb-prefs.json`.

### Other editors

```bash
git clone https://github.com/Skelly0/code-crumb.git

node code-crumb/setup.js codex              # Codex CLI (native hooks)
node code-crumb/setup.js opencode --install # OpenCode (installs the shipped plugin)
node code-crumb/setup.js openclaw           # OpenClaw/Pi

node code-crumb/renderer.js           # in a separate terminal
```

Add `--autolaunch` to the `claude` or `codex` setup command to skip the manual renderer step entirely. Autolaunch is driven by the hook script, so the OpenCode, OpenClaw and codex-notify integrations never start the renderer; run it yourself (or use the launcher below). After you quit the renderer it stays closed until your editor starts a new session.

### Launcher (auto-opens face + editor)

```bash
node code-crumb/launch.js                            # Claude Code
node code-crumb/launch.js --editor codex "fix bug"   # Codex CLI
node code-crumb/launch.js --editor opencode           # OpenCode
node code-crumb/launch.js --editor openclaw            # OpenClaw/Pi
```

Ctrl+C goes to the editor, not the launcher: while the editor runs, the launcher ignores the terminal's interrupt and leaves when the editor does, with the editor's exit code. On Windows, starting it through a `.cmd` shim (`code-crumb.cmd`, an npm shim) still gets cmd.exe's "Terminate batch job (Y/N)?" prompt; that one is cmd's own.

### Check it's working

```bash
npm run doctor                     # in a clone (or: node code-crumb/setup.js doctor)
node "${CRUMB}setup.js" doctor     # plugin install ($CRUMB from above)
```

```powershell
node "$crumb\setup.js" doctor      # plugin install ($crumb from above)
```

`doctor` only reads. It checks that `node` is new enough and on `PATH`, whether the renderer is running, your Claude Code hooks (manual, plugin, or — a problem — both), the Codex hooks, the OpenCode plugin entry, autolaunch, and when a hook last wrote anything, and it prints a fix for every problem it finds. It looks in the same files setup writes, so it honours `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME` too. It exits 1 when it found one. With the plugin installed it also prints the exact command that starts the plugin's renderer.

### Try the demo

```bash
node code-crumb/demo/single.js    # Cycles through all 23 states
node code-crumb/demo/orbital.js   # Orbital subagent constellation
```

## Features

### Expressions

The face has 23 distinct states — each with unique eyes, mouth, particles, and color:

| State | Face | Trigger |
|---|---|---|
| **Idle** | `██ ██` `◡◡◡` — calm, blinking, floating particles | No activity |
| **Thinking** | `● ●` `───` — orbiting particles, contemplative | You sent a prompt; before the first tool call. Also planning tools (`TodoWrite`, plan mode) |
| **Responding** | `▄▄ ██` `◡◡` — soft teal glow | Generating final response |
| **Reading** | `── ──` `───` — narrowed, focused | `Read`, `NotebookRead`, `Skill`, MCP `read_*`/`get_*`/`list_*` |
| **Searching** | `██ ██` `○` — eyes darting left and right | `Grep`, `Glob`, `LS`, `ToolSearch`, `WebFetch`, MCP `search_*` |
| **Coding** | `▀▀ ▀▀` `═══` — determined, in the zone | `Edit`, `Write`, `NotebookEdit`, `Artifact`, MCP `create_*`/`update_*` |
| **Executing** | `██ ██` `◡◡` — running commands | `Bash`, `PowerShell`, `KillShell`, other MCP tools |
| **Happy** | `✦ ✧` `◡◡◡◡◡` — sparkles everywhere, lingers 8s | Session complete, `Agent`/`Workflow` finished |
| **Satisfied** | `▀▀ ▀▀` `◡◡◡` — calm teal glow | Read/search done, a search with no matches, review done, your answer received, a command launched in the background |
| **Proud** | `▄▄ ██` `◡◡` — green-gold sparkles | Code edit done, commit, artifact published |
| **Relieved** | `██ ██` `◡` — warm amber, soft exhale | Test/command passed |
| **Error** | `╲╱ ╲╱` `◠◠◠` — border glitches, distress | Non-zero exit code (but `grep` finding nothing is an answer, not an error), interrupted command, tool failure, API error |
| **Sleeping** | `── ──` `~~~` — Zzz particles, deep indigo | 60s idle |
| **Waiting** | `▄▄ ██` `───` — gentle `?` particles | `AskUserQuestion`, permission prompt, idle prompt, elicitation |
| **Testing** | `██ ██` `═══` — nervous twitches, sweat drops | `jest`, `pytest`, etc. |
| **Installing** | `▄▄` `···` — packages raining down | `npm install`, `pip install` |
| **Caffeinated** | `██` `▪◡▪` — speed lines, jitter | 5+ tool calls in 10s |
| **Subagent** | scanning `═══` — stream particles radiate outward | `Agent` / `Task` / `Workflow`, checking on agents |
| **Starting** | `▄▄ ██` `◡◡` — fresh session glow | Session begins |
| **Spawning** | `██ ██` `○` — materialization particles | Subagent launching |
| **Committing** | `▀▀ ▀▀` `═══` — push particles upward | `git commit` / `push` / `tag` |
| **Reviewing** | `── ──` `───` — careful scanning | `ReportFindings`, diff / review tools |
| **Training** | `● ●` `═══` — pulsing concentration | ML training runs |

Reward faces (happy, proud, satisfied, relieved) are guaranteed at least 1.8s on screen before the next tool takes over; errors always preempt and hold for 4s. Work faces update live as tools run.

**A tool that runs for a long time keeps its work face.** A single `Bash` can run for minutes with no further event, so instead of drifting back to *thinking* the face holds — the detail line counts up (`still running … 42s`) and after 20 seconds the face starts to sweat.

**If Code Crumb has been waiting on you for more than 30 seconds it gets louder** — big bold question marks, a counter on the detail line, a pulsing status line, and a flashing terminal title so you notice from another window. Approve a Claude Code permission prompt within about 6 seconds and, a moment later, the face moves on to the tool that is now running instead of waiting until it finishes.

![Sleeping state with Zzz particles and thought bubble](images/sleeping.png)

![Error state — X X eyes, merge conflict, broken streak](images/error-merge-conflict.png)

### Thought Bubbles

A tiny thought bubble floats above the face with contextual content — file count when editing multiple files, tool call number, session duration, or idle flavor text ("thinking about types", "contemplating recursion").

![Idle state with "imagining clean code" thought bubble](images/idle-thought-bubble.png)

### Streaks & Achievements

A persistent counter tracks consecutive successful tool calls. The face gets increasingly confident during long streaks, and when a build finally fails, the reaction is proportional — first error after 50 successes? *DEVASTATION.* Milestones at 10, 25, 50, 100, 200, and 500 trigger sparkle celebrations.

![OpenCode proud with 21-streak and crown accessory](images/opencode-proud-streak.png)

### Session Timeline

A thin color-coded bar underneath the face shows a visual history:

```
  ████░░████████▓▓▓▓░░████████████████
```

Purple for thinking, green for coding, red for errors, gold for happy. A tiny EKG for your AI.

### Orbital Subagents

When your session spawns subagents (e.g. Claude Code's `Task` tool), mini-faces orbit the main face like satellites:

![Orbital subagents — four mini-faces orbiting the main face in neon theme](images/orbital-neon-thinking.png)

- **Every Claude Code subagent gets its own orbital**, labelled from its prompt (or its agent type — `Explore`, `Plan`, a custom agent name)
- Elliptical orbits, slowly rotating as a constellation
- Faint dotted connection lines pulse outward from the main face
- The main face adopts a **conducting** expression — eyes scanning, stream particles radiating — and holds it for as long as agents are alive, instead of dozing off while they work
- Up to 8 orbitals; graceful degradation on small terminals
- Sessions appear when subagents start, linger briefly after they stop, then fade
- Toggle with `o`

**Which face is in the center?** The center follows your attention: the session you most recently sent a prompt to. Start a new window or type in an old one and the big face swaps to it (a `SessionStart` from `/compact` does not count). Promoting a session from the list (`l`, then `Enter`) pins it there, shown as `⊛`; the pin releases by itself when that session ends or goes quiet, and `Enter` on the main row un-pins it. Each entry in the list has an info row: tool and file counts with the age of the last write for a session, agent type with its parent for a subagent. A window keeps the center between turns and only gives it up when you address another one (or when it ends); a `codex exec` run gives it up when the run ends.

### Color Palettes

Six palettes — press `t` to cycle. Preferences persist between sessions.

| Palette | Vibe |
|---|---|
| **default** | Soft purples and blues |
| **neon** | High saturation cyans, magentas, limes |
| **pastel** | Soft pinks, lavenders, mints |
| **mono** | Greyscale |
| **sunset** | Warm oranges, reds, golds, purples |
| **highcontrast** | Accessibility palette — maximum contrast, no subtle dims |

<p>
  <img src="images/satisfied-neon-streak.png" width="49%" alt="Satisfied state — neon theme, 30 streak" />
  <img src="images/opencode-neon-pink.png" width="49%" alt="Neon pink with party hat accessory" />
</p>
<p>
  <img src="images/opencode-searching-sunset.png" width="49%" alt="Sunset palette searching state" />
  <img src="images/opencode-proud-streak.png" width="49%" alt="Green neon proud state with crown" />
</p>

### Interactive Keybindings

| Key | Action |
|-----|--------|
| `space` | Pet the face (sparkle particles + wiggle) |
| `t` | Cycle color palette |
| `s` | Toggle stats (streak, timeline, sparkline) |
| `a` | Toggle accessories (hats, glasses, ears — thought bubbles stay on) |
| `o` | Toggle orbital subagents |
| `l` | Open session list |
| `↑↓` / `j/k` | Navigate session list |
| `Enter` | On the main row: pin / unpin it. On any other row: pin and promote it to the center |
| `h` / `?` | Toggle help overlay |
| `q` / Ctrl+C | Quit |

Any key closes the help overlay or the session list. `t` is disabled when `NO_COLOR` is set. In minimal mode (`--minimal`) only `space` and `q` are active.

![Help overlay showing keybindings](images/help-overlay.png)

## How It Works

```
┌────────────────┐     state files     ┌───────────────────┐
│  Claude Code   │                     │  ~/.code-crumb-   │
│  Codex CLI     │ ──── writes ────▶  │  state            │
│  OpenCode      │    JSON per         │  sessions/*.json  │
│  OpenClaw/Pi   │    session          │                   │
└────────────────┘                     └────────┬──────────┘
                                                │
                                           fs.watch
                                                │
                                    ┌───────────▼──────────┐
                                    │     renderer.js       │
                                    │     @ 15fps           │
                                    │                       │
                                    │  Main face + orbital  │
                                    │  subagent mini-faces  │
                                    └───────────────────────┘
```

1. **Hooks/adapters** fire on lifecycle events (23 for Claude Code: your prompt, tool use, Stop, notifications, subagents, sessions, compaction, permissions, model switches, and more)
2. **`update-state.js`** maps tool names and results to face states and writes JSON state files (atomically — the renderer never sees a half-written file)
3. **Session IDs** isolate the main session from subagent sessions (orbital mini-faces). Claude Code subagents report under the parent's session id, so they are separated by `agent_id` and each gets its own orbital file
4. **`renderer.js`** watches for changes and animates at 15fps

## Editor Integration

### Claude Code

**Plugin install** (recommended): `claude plugin marketplace add ./code-crumb` then `claude plugin install code-crumb@code-crumb` — hooks into all 23 lifecycle events automatically: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, StopFailure, Notification, PermissionRequest, PermissionDenied (the auto-mode classifier refused a tool call), Elicitation, ElicitationResult, SubagentStart, SubagentStop, TeammateIdle, TaskCompleted, SessionStart, SessionEnd, PreCompact, PostCompact, Setup, ConfigChange, InstructionsLoaded, and PostModelSwitch (follows a `/model` switch). Subagent sessions appear as orbital mini-faces.

> [!NOTE]
> Agent teams support requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. When enabled, team members appear in the orbital display with role labels and accent colors.

**Manual hooks**: `node setup.js` writes the same 23 hooks into `~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json` when you set that (backing the file up to `settings.json.bak` first and refusing to touch a file it cannot parse). `node setup.js uninstall` removes them again. Use either the plugin or the manual hooks, not both — with both installed every event fires twice. See the [manual config](#manual-hook-setup) section for the JSON shape.

### Codex CLI

Codex has **native hooks** now, so it uses the same handler Claude Code does. That is the primary integration:

```bash
node setup.js codex        # writes ~/.codex/hooks.json (backing it up first)
```

Codex asks for a one-time trust confirmation the first time hooks fire; approve it and you're done. This works in interactive TUI sessions. Setup honours `CODEX_HOME` (hooks in `$CODEX_HOME/hooks.json`), and it removes a Code Crumb `notify` line left in `config.toml` by the legacy mode, since the hooks replace it. A notify line that is not Code Crumb's is never touched.

| Mode | Setup | Granularity | Works with |
|---|---|---|---|
| **Hooks** (recommended) | `setup.js codex` | Tool-level | Interactive + `codex exec` |
| **Wrapper** | `launch.js --editor codex` | Tool-level | `codex exec` only — no trust prompt |
| **Notify** (legacy) | `setup.js codex-notify` | Turn-level (completion only) | Any |

Codex fires 11 of Claude Code's 23 events (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `Stop`) plus one of its own, `Interrupt`, which it runs instead of `Stop` when you press Esc. It has no `Notification`, `PostToolUseFailure`, `PermissionDenied` or `PostModelSwitch`, and setup registers exactly the 12 it does fire. The wrapper parses `codex exec --json` against codex-cli 0.146's ThreadEvent schema; with the hooks also installed it counts each run once, and piped into `head` or another reader that quits early it ends the session cleanly instead of crashing.

> [!NOTE]
> Upgrading from an older Code Crumb? Re-run `node setup.js codex`. A hooks file migrated from `~/.claude/settings.json` by hand has no `--editor codex` tag (so Codex sessions render as "claude", and a `codex exec` run through the wrapper is counted twice) and may register a `Notification` event Codex never fires. Re-running rewrites every entry and prunes the unsupported one; `npm run doctor` tells you whether yours needs it.

### OpenCode

Code Crumb ships a real OpenCode plugin. Install it and start the renderer:

```bash
node setup.js opencode --install     # adds the plugin to OpenCode's config (location below)
node renderer.js                     # in a separate terminal
```

Setup edits the config OpenCode itself reads: `opencode.json` in `$OPENCODE_CONFIG_DIR` if set, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. That is the same on Windows: `%USERPROFILE%\.config\opencode`, not `%APPDATA%`. An existing `opencode.jsonc` is used when there is no `opencode.json`.

The file may contain comments and trailing commas (OpenCode reads it as JSONC). Setup rewrites only the `plugin` entry and leaves every other comment alone. If there is a comment *inside* the `plugin` list itself, setup stops without changing the file and prints the line to add by hand.

Or add it by hand — note the config key is `plugin`, **not** `plugins`:

```json
{ "plugin": ["/absolute/path/to/code-crumb/adapters/opencode-plugin.mjs"] }
```

`node setup.js opencode --uninstall` removes the entry again.

What the face shows for OpenCode:

| OpenCode event | Face |
|---|---|
| A tool runs / finishes | The tool's work face, then its reward |
| A shell command exits non-zero | Error (OpenCode reports the exit code only to the plugin, which forwards it) |
| A command times out | Error, `timed out` |
| A permission request / reply | Waiting `allow?`, then satisfied |
| The `question` tool asks you | Waiting `asking you`; answering or dismissing it is satisfied |
| Context overflow → compaction | Thinking `compacting memory`, then satisfied `memory compacted` |
| Context overflow with no compaction | Error, `context too long` (a failed turn) |
| Esc | Error, `interrupted` (the streak is kept) |
| Any other session error | Error, ending the turn (the streak breaks once) |
| The turn ends (`session.idle`) | Happy |

> [!WARNING]
> If you followed the old instructions you have a hand-written `~/.config/opencode/plugins/code-crumb.js` and a `"plugin": ["./plugins/code-crumb.js"]` entry. **Delete both.** That file targets an API OpenCode no longer has — it never receives a session id and its tool input is always empty, which is what produced phantom orbitals (#120). Leaving the old entry alongside the new one makes every event fire twice.

> [!TIP]
> If `node` is not on `PATH` inside OpenCode, set `CODE_CRUMB_NODE` to the node binary — `process.execPath` inside OpenCode is the Bun binary, so the plugin cannot use it.

### OpenClaw/Pi

Uses Pi's extension system. Run `node setup.js openclaw` for instructions. The adapter supports both Pi-native event names and the generic Code Crumb format.

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `CODE_CRUMB_STATE` | `~/.code-crumb-state` | Override state file path |
| `CODE_CRUMB_MODEL` | `claude` | Display name in status line (the editor fallback, not the real model) |
| `CODE_CRUMB_EDITOR` | `claude` (adapters set their own) | Editor tag shown in the session list; beats the `--editor` hook argument |
| `CODE_CRUMB_NODE` | `node` | Node binary the OpenCode plugin spawns for the adapter |
| `CODEX_HOME` | `~/.codex` | Where `setup.js codex` / `uninstall` / `doctor` find Codex's `hooks.json` and `config.toml` |
| `OPENCODE_CONFIG_DIR` | `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` | Where `setup.js opencode` and `doctor` find OpenCode's config |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's config folder: where `setup.js` / `uninstall` / `doctor` find its `settings.json` |
| `CLAUDE_SESSION_ID` | `<editor>-<parent PID>` | Session identifier |
| `NO_COLOR` | unset | Disable colour output (also disables the `t` key) |
| `MINIMAL_BOOT` | unset | Start in minimal mode (same as `--minimal`) |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | unset | `1` enables agent-team orbitals |
| `CODE_CRUMB_RECORD` | unset | `1` records every payload the hooks and adapters receive, anonymised; `full` records them raw. See [Recording payloads for a bug report](#recording-payloads-for-a-bug-report) |
| `CODE_CRUMB_RECORD_FILE` | `~/.code-crumb-record/<date>.jsonl` | Where recordings go; a relative path is taken from your home folder |

Renderer flags: `--minimal` (face + status only), `--tmux` (write a status line for tmux instead of drawing), `--no-color`.

**The status line names the model when Code Crumb can find one** — `Opus is thinking`, `Sonnet is coding` — and the editor moves to a dim tag under the face. Subagent orbitals show their own model too, so a swarm of agents on different models is readable at a glance.

Claude Code supplies it through `SessionStart` and `PostModelSwitch` (re-run `npm run setup` to register the latter), and a subagent's comes from its own transcript. Codex picks it up from `-m`/`--model`. Where no model can be found nothing changes: the status line falls back to `claude is thinking`, `codex is coding`, etc. Each adapter sets a sensible default, and the display name can also be passed via the `model_name` field in event JSON.

### Manual Hook Setup

<details>
<summary>Claude Code — manual hook config</summary>

Add to `~/.claude/settings.json` (this shows four of the 23 events; repeat the block for the others, or let `node setup.js` write them all). `PreToolUse`, `PostToolUse` and `PostToolUseFailure` run with `"async": true` so they never block the editor; every other event is synchronous:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" PreToolUse", "async": true }]
    }],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "node \"/path/to/update-state.js\" PostToolUse", "async": true }]
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
</details>

<details>
<summary>Codex CLI — manual config</summary>

Add to `~/.codex/config.toml`:

```toml
notify = ["node", "/path/to/adapters/codex-notify.js"]
```
</details>

### Add to PATH (optional)

**Windows (PowerShell):**
```powershell
function code-crumb { node "C:\path\to\code-crumb\launch.js" @args }
```

**macOS / Linux:**
```bash
chmod +x ~/code-crumb/code-crumb.sh
ln -s ~/code-crumb/code-crumb.sh /usr/local/bin/code-crumb
```

Or: `cd code-crumb && npm link`

## Performance

- Zero dependencies — just Node.js
- The renderer uses about 1% of one CPU core at 15fps in a 160×50 terminal with orbitals showing, and ~41 MB of memory (RSS)
- A hook takes ~45–60 ms on Windows, most of it starting node (and the shell Claude Code runs it through). The per-tool hooks run async, so they don't hold the editor up
- State files are ~1 KB each, written atomically
- No network, no sockets — all file-based IPC

## Terminal Compatibility

| Terminal | Status |
|---|---|
| Windows Terminal | Full support |
| iTerm2 | Full support |
| VS Code terminal | Full support |
| tmux | Full support |
| macOS Terminal.app | Works (some Unicode may render oddly) |
| ConEmu / cmder | Should work |
| Legacy cmd.exe | No ANSI support — won't render |

> [!WARNING]
> Legacy `cmd.exe` does not support ANSI escape codes and will not render the face. Use Windows Terminal, VS Code terminal, or any modern terminal emulator instead.

## Troubleshooting

Start with `npm run doctor` (or `node setup.js doctor`, from wherever Code Crumb lives — see [Check it's working](#check-its-working)). It only reads, and it names the fix for each problem it finds.

**The face shows nothing.** Usually one of three things: the renderer is not running (start it, or turn on autolaunch), `node` is not on the `PATH` the hooks see (see the note under [Quick Start](#quick-start)), or no hooks are installed. `doctor` checks all three and also tells you when a hook last wrote anything — "no hook has written in 2h" while you are using your editor means the hooks are not firing. Inside Claude Code, `/hooks` lists what is registered and `claude --debug` shows hook errors.

**Every event happens twice and the counters double.** Both the plugin and the manual hooks are installed. Keep one: `node setup.js uninstall` removes the manual hooks, `claude plugin uninstall code-crumb@code-crumb` removes the plugin.

**Every hook errors after you moved or renamed the clone.** Manual hooks store the absolute path to `update-state.js`. Run `node setup.js` again from the new location (and `node setup.js codex` if you use Codex) — it rewrites the paths.

**Codex shows nothing.** Codex asks once to trust new hooks and runs none of them until you say yes. Start `codex` interactively and approve them, or pass `--dangerously-bypass-hook-trust` in automation.

**Autolaunch did not open the face.** After you quit the renderer it stays closed until your editor starts a new session (`claude`, `claude --continue`). `node setup.js --autolaunch` clears that straight away.

**The plugin is still on an old version.** Claude Code keeps a cached plugin until its version number changes. Run `claude plugin marketplace update code-crumb`, then `claude plugin update code-crumb@code-crumb`, and restart Claude Code.

**Ghost or stale orbitals.** Quit the renderer (`q`), delete the sessions folder, and start it again. That is safe while the renderer is stopped; the hooks recreate whatever they need.

```bash
rm -rf ~/.code-crumb-sessions
```

```powershell
Remove-Item -Recurse -Force "$HOME\.code-crumb-sessions"
```

## Recording payloads for a bug report

When the face does something odd, the quickest fix starts from exactly what your editor sent. Set `CODE_CRUMB_RECORD=1` in the environment your editor starts from:

- POSIX shells: `export CODE_CRUMB_RECORD=1`
- PowerShell: `$env:CODE_CRUMB_RECORD=1`
- cmd: `set CODE_CRUMB_RECORD=1`

Code Crumb then appends every payload its Claude Code and Codex hooks, its OpenCode and OpenClaw adapters and `codex-wrapper.js` receive to `~/.code-crumb-record/<YYYY-MM-DD>.jsonl`, one JSON line each. A day's file stops growing at 20 MB. `CODE_CRUMB_RECORD_FILE` chooses the file. Unset the variable to stop. With it unset, the hooks pay for one environment read and nothing else.

**What the default mode keeps.** Event names, sources, reasons, tool names, models, flags, statuses and exit codes stay, as does every key and every value's type. Session, agent and tool-call ids become stable pseudonyms (`s-3f9a…`), so you can still see which events belong together. Commands and paths keep their shape but lose their words: `git commit -m "fix acme login"` is recorded as `git commit -m "x x login"`, `/home/you/acme/src/app.ts` as `/home/x/x/src/app.ts`, and an IP address as `x.x.x.x`. Only common command names, subcommands, extensions, directory names and a few common words survive, even inside quotes, because a wrapped script (`bash -lc '…'`) is all quotes and its command words are the point.

**What it drops.** Prompts, tool output, file contents, descriptions and messages become `<text len~N lines=L>`: their size and line count are kept, their content is not. A payload over 1 MB is recorded as its ids only. The pseudonyms are keyed by `.code-crumb-record.key`, which sits beside the recording. **Never share that file**: it is what stops a recording being matched back to your real sessions. Read a recording before you attach it.

**`CODE_CRUMB_RECORD=full`** records payloads exactly as received, including prompts, file contents, paths, command lines and any secrets in them. It is for debugging on your own machine. Never attach a full recording to an issue; import it as a fixture instead, which anonymises it.

**Turning a recording into a test.** In a clone of this repo:

```
node tests/fixtures/replay/import-recording.js ~/.code-crumb-record/2026-10-18.jsonl my-bug [--session s-3f9a…] [--from N --to M]
CRUMB_UPDATE_GOLDEN=1 node tests/run.js replay
```

The first command writes `tests/fixtures/replay/my-bug.jsonl`, renumbering ids to `s1`, `a1`, `t1` (and anonymising a full recording). The second writes `my-bug.golden.json`, which records what the face does today. Edit the golden to say what it should do, and the test fails until the code agrees.

## Project Layout

The root holds only what gets run by path. Your installed hooks point at `update-state.js` here, and the shell wrappers point at `launch.js`.

<details>
<summary>Project files reference</summary>

| File | Purpose |
|---|---|
| `renderer.js` | Main renderer — face + orbital subagents |
| `update-state.js` | Hook script — maps tool events to face states |
| `launch.js` | Auto-starts renderer and launches editor |
| `setup.js` | Installs hooks for any supported editor; `setup.js doctor` checks an install |
| `code-crumb.sh` / `code-crumb.cmd` | Shell wrappers around `launch.js` |
| `lib/face.js` | ClaudeFace class — state machine and rendering |
| `lib/grid.js` | MiniFace + OrbitalSystem — subagent orbits |
| `lib/animations.js` | Eye/mouth animation functions |
| `lib/particles.js` | ParticleSystem — 16 visual effect styles |
| `lib/themes.js` | ANSI codes, palettes, color math, thought bubbles |
| `lib/state-machine.js` | Tool mapping, error detection, streaks |
| `lib/wait.js` | The permission-wait lifecycle, shared by the hook and every reader |
| `lib/carry.js` | What each hook write keeps from the session file before it |
| `lib/recorder.js` | Opt-in payload recorder and anonymiser (`CODE_CRUMB_RECORD`) |
| `lib/shared.js` | Shared constants, paths, utilities |
| `lib/transition.js` | SwapTransition — dissolve/swap/materialize animations |
| `lib/accessories.js` | Accessory definitions (hats, glasses, ears) and rendering |
| `adapters/base-adapter.js` | Base adapter class with shared functionality |
| `adapters/codex-wrapper.js` | Wraps `codex exec --json` for tool-level events |
| `adapters/codex-notify.js` | Handles Codex's legacy `notify` config events |
| `adapters/opencode-plugin.mjs` | The shipped OpenCode plugin (ESM) |
| `adapters/opencode-adapter.js` | OpenCode plugin event adapter |
| `adapters/openclaw-adapter.js` | OpenClaw/Pi event adapter |
| `adapters/engmux-adapter.js` | engmux agent dispatcher event adapter |
| `hooks/hooks.json` | Hook registrations used by the Claude Code plugin |
| `demo/single.js` | Cycles through all 23 states (`npm run demo`) |
| `demo/orbital.js` | Orbital subagent demo (`npm run demo:orbital`) |
| `tests/fixtures/replay/` | Recorded payloads replayed as golden tests; `import-recording.js` turns a recording into one |
| `tests/run.js`, `tests/` | Test runner and suite (`npm test`; files run in parallel, `--serial` for one process). Run the suite only through `tests/run.js` — a test file started directly refuses to run, because it would use your real `~/.code-crumb*` files |

</details>

## Uninstall

**Claude Code:** `node setup.js uninstall` removes the manual hooks (or `claude plugin uninstall code-crumb` for the plugin)

**Codex:** `node setup.js uninstall` removes the Codex hooks from `~/.codex/hooks.json` (or `$CODEX_HOME`) as well as the Claude Code ones, and the legacy mode's Code Crumb `notify` line from `config.toml`.

**OpenCode:** `node setup.js opencode --uninstall` removes the plugin entry from OpenCode's config (see [OpenCode](#opencode) for where that is).

**Clean up state files.** Quit the renderer first. Everything Code Crumb writes at run time sits in your home folder and starts with `.code-crumb`: `.code-crumb-state`, `.code-crumb-stats.json`, `.code-crumb-stats.lock`, `.code-crumb-prefs.json`, `.code-crumb.pid`, `.code-crumb-spawn.lock`, `.code-crumb-spawn.lock.claim`, `.code-crumb-quit`, `.code-crumb-tmux` and the `.code-crumb-sessions/` folder (plus the odd leftover `.tmp` from an interrupted write). These two patterns catch all of them:

```bash
rm -rf ~/.code-crumb-* ~/.code-crumb.pid*
```

```powershell
Remove-Item -Recurse -Force "$HOME\.code-crumb-*", "$HOME\.code-crumb.pid*"
```

If you pointed `CODE_CRUMB_STATE` somewhere else, delete that file too. Setup's backups (`~/.claude/settings.json.bak`, `~/.codex/hooks.json.bak`, or the same names under `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) are yours to keep or delete.

## License

MIT
