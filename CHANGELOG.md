# Changelog

Notable changes to Code Crumb. Dates are commit dates; issue and PR numbers refer to [Skelly0/code-crumb](https://github.com/Skelly0/code-crumb). The format is loosely [Keep a Changelog](https://keepachangelog.com/).

## 1.3.0 — 2026-10-15

This release is review round 5 plus everything merged since 1.2.0 (listed under "Also in 1.3.0" below).

- **If you use the plugin, the version bump is what delivers this release.** Claude Code keeps a cached plugin until its version string changes, so plugin users stayed on 1.2.0 through all 34 commits after it shipped, and `claude plugin update` reported "already at the latest version". `package.json` and both plugin manifests now read 1.3.0.
- **After upgrading a manual install, re-run `npm run setup` (or `node setup.js`).** It makes the per-tool hooks async and registers `PermissionDenied` as the 23rd event. `npm run doctor` tells you whether your install needs it.

### Fixed

- **Successful commits and pushes no longer show an error face.** Claude Code 2.1.300 reports a failing Bash as `PostToolUseFailure`, so a Claude Code `PostToolUse` is now trusted as a success (`trustSuccess`). Its output is no longer searched for failure words, unless the command line could hide a failure (a pipe, `||`, `;` or `&` after the real command). Before, a commit echoing its subject, a push naming its branch, or a green test run listing its test names could each read as an error. The scan that remains for Codex and the adapters drops echoed content first (git summaries, ref updates, `remote:` lines, pass marks), and searches large output in a 16 KB head plus a 64 KB tail.
- **Empty searches are not errors.** Some commands use exit status 1 for a plain "no": `grep`/`rg`/`findstr`/`git grep` for no matches, `diff`/`cmp` for "the files differ", `test`/`[` for false, `which`/`where` for not found, and `pgrep` for no such process. Every empty search used to be an error face that broke the streak, and for Codex, whose searches all run through the shell, that was nearly every turn. When that status really is the command's own, it now reads as satisfied / `no matches` (or the matching answer) and leaves the streak alone. Exit 2 still means trouble. `git diff --quiet` counts even when git prints its CRLF line-ending warning (git for Windows' `core.autocrlf=true` default), and `which a b` counts when GNU which exits with the number of names it didn't find.
- **An approved permission prompt shows the running tool.** Allowing a prompt produces no event until the tool finishes, so the face used to stay on "allow?", with a flashing title, for the whole run. Claude Code sends its `permission_prompt` notification only for a dialog still open after 6 s, so a prompt that notification never confirmed was answered. After 8 s the face now shows the asking tool's own work face, held as a running tool. Allowing a **subagent's** prompt also takes the parent out of its wait.
- **Ctrl+C in the launcher goes to the editor.** `launch.js` used to die on the terminal's Ctrl+C and orphan the editor under the shell. While the editor runs, the launcher now ignores the signals the terminal sends to the whole group, forwards `SIGTERM`/`SIGHUP` on POSIX, and exits with the editor's own exit code.
- **A project's `claude.cmd`, `codex.cmd` or `codex.js` no longer runs instead of the editor.** The launcher spawns `node` as `process.execPath`, and a shell spawn sets `NoDefaultCurrentDirectoryInExePath`.
- **OpenCode: failed commands are errors.** OpenCode 1.18 reports a command's exit code only in the shell tool's `metadata.exit`. The plugin now forwards it, along with aborted or timed-out commands and both the head *and* the tail of long output. A failing `test -f x` used to read as success, and the "2 failing" at the end of a test run was cut off.
- **OpenCode: session errors, questions and Esc.**
  - A `session.error` that names no session is dropped. Plugin load failures used to mint a phantom session that broke the streak.
  - A context overflow shows compaction, and becomes a failed turn ("context too long") only when no compaction follows.
  - Esc is `error` / `interrupted` without a streak break.
  - Any other error ends the turn as a failure, counted once.
  - The `question` tool (and `plan_exit`) waits on you, and a reply or a dismissal answers it.
- **Codex: the center face stays on a Codex window.** codex-notify rebuilt the session file from scratch at every turn end, erasing the native hooks' attention stamp. It now carries the sticky fields forward. `setup.js codex` and `uninstall` remove a leftover Code Crumb `notify` line, and setup honours `CODEX_HOME`.
- **Codex: a wrapped run counts once and exits cleanly.** A `codex exec` run through the wrapper with older, untagged hooks is no longer counted twice. Piping the wrapper into `head` now retires the session (`error` / `output closed`) and exits 141 instead of crashing with `EPIPE`.
- **OpenCode setup writes the config OpenCode reads.** That is `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (on Windows too), and an existing `opencode.jsonc` when there is no `opencode.json`. Comments and trailing commas no longer make setup refuse the file, and only the `plugin` entry is rewritten. A comment *inside* the plugin list makes setup stop and print the line to add by hand.
- **Agent teams: a lead stays in the center.** In 2.1.300, `TeammateIdle` and a team `TaskCompleted` fire from the teammate's stop path with the lead's session id. They used to stamp the lead `isTeammate`, which dropped it from the main policy for good. With `agent_id`, they now write the teammate's own orbital. A lead poisoned that way is healed on disk, and the renderer lets it back in without a restart.
- **Notifications that ask for nothing draw nothing.** An `elicitation_response` right after you answered an MCP elicitation used to put the face straight back to waiting.
- **A forked session** (`SessionStart` source `fork`) clears the quit flag like `startup` and `resume`, so autolaunch reopens a face you had closed.
- **Parallel windows are not misclassified as subagents.** The legacy classifier read the session file's birthtime, which `writeJsonAtomic`'s rename resets on every write, so an unregistered parallel window became the owner's subagent on its second event. It now reads a sticky `firstSeenAt`, which the adapters carry too.
- **A wall clock stepped back freezes nothing.** The face times itself on a monotonic clock, and the hooks' write ordering ignores a write more than 60 s ahead.
- **Docs-pass fixes.** Writing up round 5 turned up nine suspects. Eight were bugs, each fixed with a test that failed first:
  - `setup.js` follows `CLAUDE_CONFIG_DIR` (settings, `uninstall`, `.bak`) as Claude Code does. doctor already did, so it reported setup's hooks missing.
  - doctor reads OpenCode's config where setup writes it (`OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `opencode.jsonc`), as JSONC. Setup and doctor now share one resolver per editor config.
  - doctor sees a multi-line Code Crumb `notify = [` array, by the same scan setup removes it with. A foreign notify whose *comment* names codex-notify.js is no longer flagged, or removed.
  - An orbital settles an allowed `thinking` prompt (ExitPlanMode, TodoWrite) as `thinking`, not `executing`: one `PERMISSION_TOOL_STATES` for both faces.
  - `git diff --exit-code` finding differences reads `files differ`, its diff allowed, if it is the whole command. `which`/`where` count when they print only their own miss line (`which: no x in (…)`, `INFO: Could not find files…`).
  - A git `fatal:` line reads `push failed` for a push and `git failed` otherwise, not "something went wrong" (or "exit 128").
  - A codex-notify write no longer quiets the codex wrapper as if the hooks were live, so every turn after the first is reported again. Notify writes carry `writer: 'notify'`.
  - Checked, not changed: Claude Code 2.1.300 parses `CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS` as `1|true|yes|on` (any case, trimmed), exactly as the hooks already did; `0` leaves it on. A test pins it.
  - `.editorconfig` trims Markdown like the CI gate; a dead `rendererStartTime` and stale comments are gone.
- **Classification details:**
  - git's global options (`git -C x commit`) no longer hide a commit or push.
  - `cargo build` is a build, not an install.
  - `make lint`/`clean`/`format` are not builds, and `make test` and gradle/maven test tasks are test runs.
  - A run-in-background command shows `launched in background` and leaves the streak alone.
  - Heredoc bodies are treated as data.
  - git listings (`branch`, `reflog`, `stash list`…), `gh` listings and `docker`/`kubectl` logs count as read-only.
  - The install matcher is token-based and the training matcher linear (`pnpm -C -C…` was exponential).

### Added

- **Async per-tool hooks.** `PreToolUse`, `PostToolUse` and `PostToolUseFailure` are registered `"async": true`, so they no longer block the editor. On Windows every hook is Git Bash plus node (~55–85 ms), and a synchronous Pre + Post blocked the editor ~170 ms per tool call. update-state.js orders the async writes against the synchronous ones itself:
  - a Pre that lands after its own Post is dropped;
  - so is a Pre that lands after the permission prompt for its call;
  - so is any per-tool event older than the newest synchronous write.

  Re-running setup upgrades an existing install in place.
- **`PermissionDenied`**, the 23rd hook event. Claude Code 2.1.300 fires it when the auto-mode classifier refuses a tool call. It shows `thinking` / `<tool> denied`, answers the wait, and leaves the streak alone.
- **`npm run doctor`** (`node setup.js doctor`), a read-only health check. It checks node, the renderer, the Claude Code hooks (manual, plugin, or both), the Codex hooks, autolaunch, and when a hook last wrote. It prints a fix for each problem, and with the plugin installed it also prints the command that starts the plugin's renderer.
- **The renderer rests when nothing moves.** A face with nothing moving drops from 15 to 4 fps. On a 120×40 terminal with no sessions, output fell from ~5.0 KB/s to ~1.4 KB/s while idle, and from ~4.7 KB/s to ~1.7 KB/s while asleep. Any file event, key or resize wakes it at once. Frames now run on deadlines, so active animation is a true 15 fps.
- **README updates.** Plugin start-up commands that work in bash and PowerShell and skip orphaned plugin versions, a "Check it's working" section, Troubleshooting, and measured performance numbers.

### Changed

- **One self-healing watcher.** The renderer watches the sessions folder with one `fs.watch` handle, fanned out to the main-file read and the ring reload. It closes and re-opens with a backoff on an error, on the folder vanishing, or on the win32 event storm that pegged a core after the folder was deleted.
- **A crash puts the terminal back.** An uncaught exception or rejection restores the terminal, removes the PID file and exits 1, leaving autolaunch free to reopen the face. The terminal title is pushed at start and popped on exit.
- **tmux mode** names the branch of the session's own `cwd`, and keeps its last line through a failed read.
- **Orbitals join smoothly.** A face joining a ring already on screen starts at its predecessor's position and eases forward. A demoted main face rejoins the same way; the overlap resolver used to fire on 13–54 frames of every swap.
- **PID liveness.**
  - On win32, a pid that is not a multiple of 4 is never alive.
  - A pid the resolver cannot find is now `dead` until the cache TTL. It used to be deleted, which read as pending and re-ran PowerShell forever.
  - A pending start time protects a session for 30 s at most.
- **Session loading.** The sync and async session loaders are one code path, reading and stat-ing each file once. Junk files (empty, unparseable, or not an object) older than two minutes are purged.

### Internals and tests

- **Parallel test runner.** `node tests/run.js` runs the 17 test files in parallel child processes (`--jobs=N`, default min(4, cpus), slowest first), each with its own throwaway home. Output prints in list order, and a file that crashes or times out (5 min) counts as failed. A full run fell from ~31 s to ~15 s on win32. `--serial` keeps the one-process mode, and a single selected file runs in-process. The runner also clears `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG`.
- **A test file run directly refuses to start.** `node tests/test-adapters.js` used to run against the real home, writing the live state files under a running renderer. `createSuite()` now exits 1 unless `CRUMB_TEST_HOME` names the HOME in use, and the test files lost their shebangs.
- **`tests/test-release.js`** (50 tests) covers packaging (the require graph from every entry point, against `package.json` `"files"`), the plugin manifests (identical copies, agreeing versions, `hooks.json` registering exactly `HOOK_EVENTS`), the npm scripts, the runner, and `doctor`.
- **`readState`** returns `failed: true` for a read that is not data, so the renderer changes nothing on one. It also sanitises counters, `frequentFiles`, milestones and diff info.
- **The fresh-read block and `FRESH_READ_STATES` are gone.** The 2 s forced read catches a missed Stop.
- **Smaller changes:**
  - `startupGate` takes the monotonic uptime.
  - A repeated reward drops the finished tool queued behind it.
  - `writeFallback` takes the stats lock.
  - `PERMISSION_CONFIRM_MS` lives in `shared.js`.
  - `runUnifiedMode(opts)` takes test seams.
- **Local-day tests.** Eight test sites compared against the UTC day and failed between local and UTC midnight; they now use `localDay()`.
- **Smoke runs.** Before the merge, a live run with Claude Code 2.1.300 (`-p`, async hooks included) and a fake 120×40 renderer both passed.
- **Test count.** The suite is 2713 tests in 17 files on win32, up from 2454 in 16 files before the round.

### Also in 1.3.0 (merged before review round 5)

#### Changed

- **Repository layout.** The internal modules moved into `lib/` (`accessories`, `animations`, `face`, `grid`, `particles`, `shared`, `state-machine`, `themes`, `transition`). The demos moved into `demo/` (`demo.js` → `demo/single.js`, `grid-demo.js` → `demo/orbital.js`), and the test runner into `tests/run.js`. The root keeps only what is run by path — `renderer.js`, `update-state.js`, `launch.js`, `setup.js` and the `code-crumb.sh`/`.cmd` wrappers — so installed hooks, PATH symlinks and `node setup.js` all keep working without re-running setup. `npm run demo`, `npm run demo:orbital` and `npm test` are unchanged.
- **Documentation.** The review-pass history below moved here out of `CLAUDE.md`, and that file's per-file test coverage essay was condensed into a table.

#### Added

- **Attention-following main face and a session-list tree** (#136).
  - The center face follows the live top-level session the user last addressed (`lastPromptAt`, stamped by `SessionStart` and `UserPromptSubmit`), instead of whichever session owns the global state file.
  - `Enter` in the session list pins a session, or pins and promotes it; a pin is released the moment its session stops.
  - The list draws sessions as a tree with their children.
- **The real model name on the faces.** A new sticky `model` field (`Opus`, `Sonnet`, `Haiku`, `Fable`, or an unrecognised id verbatim) leads the status line, fills a child orbital's row 5, and joins the session list's info row.
  - It comes from `SessionStart`'s `model`, from `PostModelSwitch`'s `to_model`, from each subagent's own transcript, and from a bounded tail-read of the main transcript on `Stop`. `PostModelSwitch` is registered as the 22nd hook event, so re-run `npm run setup`.
  - codex-wrapper now honours `-m`/`--model`, and the OpenCode plugin records `message.updated`'s model without spawning anything.

#### Fixed

- **Faces glitching at different window sizes.** A layout probe (~600 sizes × 3 face counts × 240 frames) found four causes:
  - the key-hint bar wrapped the last row;
  - the orbit was sized from the current accessory;
  - the thought-bubble nudge teleported orbitals;
  - faces were spaced by angle rather than box size.

  After the fix the probe found 0 off-screen writes, 0 overlaps, 0 jumps and 0 layout flips, down from 73k, 4.9k, 8.5k and 1k frames.
- **First review pass** (ten bugs):
  - A solo `TaskCompleted` no longer tags a session as a teammate.
  - Adapters write `turnEnded` at a turn end and keep `stopped` for `session_end`, so an OpenCode/OpenClaw main no longer bounces away and back every turn.
  - `<synthetic>` model ids are skipped.
  - The swap seeds the write clock and clears git context.
  - The status-line name yields to the room left on the line.
  - `model` is carried forward by adapters and `SubagentStop`.
  - `setup.js codex-notify` backs up and writes `config.toml` atomically.
- **Second review pass** (~40 bugs across the renderer, face, orbitals, hooks, adapters and launch/setup, plus three leftovers: startup replay, `wt` semicolons and parked agents). Regression tests were added across the suite, every one checked to fail against the pre-fix sources:
  - **test-face**: caffeine never replacing a queued state; same-state work dropping a stale queued completion.
  - **test-grid**: the same rule in `MiniFace`; cycling protection and the real-agent exclusion; the boot-time live-family child; the PID `refreshing` marker; the documented label order.
  - **test-state-machine**: `shellIntent` pre/post classification (commit messages, `cat foo.test.js`, an end-to-end `commitCount`); exit-code forms; per-line guards; read-only commands.
  - **test-platform**: `quoteArg` cmd metacharacters (plus a win32 `shell:true` round-trip); the `wt` `\;` escape; `%`/`&` in `buildRendererCommands`; the staged stale-lock race; an `EPERM` create waiting as held.
  - **test-adapters**: late tool ends; codex-notify's turn end; codex-wrapper turn end vs session end and `closeOutcome`; `signalExitCode`; the setup demo hint; the POSIX signal tests.
  - **test-transition**: `swapPending()`.
  - **test-emotions**: the `startupGate` table; `needsRescue`/`RESCUE_EXCLUDE`; `policySessions` dead-session projection; `splitKeys`; the `tmuxDisplayState` table; source checks for the startup record, new-pid reset, resize guard, subagent count and stdin split.
  - **test-subagents**: the parent's own work and errors passing through while an agent runs; unregistered windows; late `SubagentStop`; `turnOver`.
  - **test-attention**: `/compact` keeping counters; a parallel SessionStart parking the owner's agents; alternating windows; `StopFailure`; payloads over 1 MB; non-string fields.
- **Two smaller fixes.** engmux registers its signal handlers before its first write, and a delete-pending stats lock on Windows (`EPERM` on create) is treated as held rather than free.
- **Third review pass** (~40 more bugs, each reproduced first by one of six parallel reviewers and re-verified before fixing). A `Third review pass` block was added to six test files, every new test checked to fail against the pre-fix sources:
  - **test-state-machine**: redirect-aware shell splitting and `cd`; one install table; anchored "0 errors" guards; kebab/camelCase MCP verbs; the real `PostToolUseFailure` payload (`error`, `is_interrupt`); NotebookEdit file counting; a fresh timestamp on synthetic retirement; teammate writes keeping `editor`/`modelName`/sticky fields; the shared counter helpers (now in state-machine.js as `freshCounter`/`normalizeCounter`/`parkAgents`/`unparkAgents`/`pruneCounters`); the quit flag cleared by a `startup` SessionStart.
  - **test-face**: a `waiting` behind a queued reward is remembered (it was dropped); a same-state work write drops any older queued state; a reward queues behind an on-screen error; the timeline's pass 2 is no longer cached (only pass 1 is — the cap froze and the live segment filled the bar); a streak break reacts only while fresh (`STREAK_BREAK_FRESH_MS`, 10s) and a break that lost nothing resets the last loss; the thought is re-picked when `setStats` brings a new diff or loss; the loss line and the milestone share row +12 without overdrawing; caffeine hands the detail back.
  - **test-grid**: a write without `parentSession` heals a falsely stamped window in `MiniFace` too; a stopped file is purged even while its editor pid lives (sync and async); `~` only on a path boundary; a child with no task is labelled by its `agentType`; non-text details are dropped (an object detail threw inside the ring render).
  - **test-platform**: setup strips our hook *commands*, never a user's co-located hook, and only matches our argv shape; backups keep the settings file's mode; `--help`, unknown flags and `--install`/`--uninstall` outside `opencode` no longer install anything; the plugin hint needs `.claude-plugin/marketplace.json`; `enableAutolaunch` clears the quit flag; `quoteArg` doubles backslashes before a `%`; a submodule's relative `gitdir` resolves from its own folder; a `null` prefs file; the exclusive spawn-lock takeover (including an 8-process race); launch.js exit codes for a signalled editor; `code-crumb.sh` through a symlink.
  - **test-adapters**: details are text on one line (`detailText` in shared.js, applied by base-adapter's writers, `readState` and `MiniFace`); oversized or unparseable stdin goes through the ownership guard with the session id; adapters keep per-session counters and park a conducting owner's agents like update-state.js does; multi-byte UTF-8 split across chunks; `exitWhenFlushed` (a passthrough used to be cut off by `process.exit`); the OpenCode plugin spawns one session's payloads in order; the OpenClaw snippets send a stable `session_id` through `execFileSync`; codex-wrapper's retry notices and late events.
  - **test-attention**: `needsRescue` exempts a conducting face while agents run (it looped responding → done! → conducting every ~12s); `readState` coerces details; a turn end no longer cuts a reward's window or an error's 4s; a recorded startup write hands over its counters; the session list's main row uses the real SessionEnd flag (it drew a grey ✕ between turns).
- **Two review rounds over the third pass** (four fresh reviewers over the whole diff, each finding reproduced):
  - Our hook command must end in a real hook event.
  - Backups are always 0600, and refreshed even when settings.json is read-only.
  - An npm install is pointed at the GitHub marketplace.
  - `detailText` also strips C1 controls.
  - The install table was widened again: flags and workspace selectors between the manager and its verb, `npm ci`, and a bare `yarn`.
  - A failed `cd` still reads as an error.
  - Teammate writes do not carry subagent stamps.
  - `resume` clears the quit flag.
  - A newer same-state error drops the queue and restarts its 4s.
  - A streak loss lasts for its own error episode: a burst keeps it, and leaving `error` ends it.
  - Milestones are freshness-gated like breaks.
  - The thought is re-picked only for the write on screen.
  - A remembered prompt survives later rewards and repeated work states.
  - The OpenCode plugin batches and drains its queue with the turn end.
  - `buildExtra` subtracts time update-state.js already credited.
  - Sessions count once per id **per day** (`countedDay` replaced the `counted` boolean).
  - `pruneCounters` evicts throwaway entries first, and never parked agents.
- **Fourth review pass** (Sep 2026). It ran five reviewer lanes — stats lifecycle, Windows, the cross-writer file contract (real editor schemas: Claude Code 2.1.281, codex-cli 0.156.1, OpenCode source), the live renderer in a pty (`pyte`), and a fuzzer (25,000 hook cases, 26,000 adapter cases, hostile session files) — plus a regression review of the previous round. It added `round 3` blocks to eight test files, every new test checked to fail against the pre-fix sources:
  - **test-state-machine**: session time credited to an owner's own last activity; the local day; frequent-file ageing; wrapped and Windows shells (`unwrapShell`, PowerShell reads); read-only exit trailers, conflicts and `cd` failures; linear-time patterns and OSC 8; background agents (`async_launched`); a stats file that lies (typed repair, `__proto__`, `toString`); builds judged by command position.
  - **test-platform**: `writeJsonAtomic`'s rename retry; `isRendererAlive` (staleness, pid 0, heartbeat); `buildRendererCommands`' `nodeBin`/`cwd`/`cmdExe`; `code-crumb.cmd` runs `node.exe`; codex's `Interrupt`/`PostCompact` in `CODEX_HOOK_EVENTS`.
  - **test-adapters**: codex-wrapper's exit grace, bare thread id and hooks-live quiet mode; OpenCode child sessions; identity coercion; oversized payloads reaching the session file; the plugin's field and batch caps, numbering and straggler rule; monotonic timestamps; engmux's `CLAUDE_CODE_SESSION_ID`.
  - **test-attention**: codex's per-payload model and `Interrupt`; the ambient/echo `turnOver` contract (`/compact`, `/model`, an agent's auto-compaction, `ConfigChange`, a late PostToolUse); `isNewerWrite`; `workSince`; `answered` (including an allowed permission prompt); the global file's model on ownership return.
  - **test-grid**: `~` case folding on win32; hostile session files (non-string fields, `null` files sync and async, object ids, unknown states); the child PID cap; `sessionListFits`; the swap's caffeine reset and tool age; a dead editor's children.
  - **test-face**: an error keeps a queued prompt; `dropWait`; wide characters (the detail, status, project and indicators rows and the thought bubble stay inside the window at 38x20 and 44x30).
  - **test-shared**: the display-width helpers (ASCII, CJK, emoji, combining marks, surrogate pairs, a wide character straddling the limit, every app glyph at width 1). **test-grid** also renders CJK and emoji through `MiniFace` rows and the session list at 50 and 120 columns, asserting exact widths.
- **A round-4 review** of the fourth pass (three fresh reviewers over the whole diff) found 16 more, all fixed with `round 4` test blocks that fail against the pre-fix sources:
  - The adapter now reads the session file **under** the stats lock. Read before it, a process waiting on the lock acted on a file older than the turn end written meanwhile, and re-opened the turn.
  - The oversized-payload fallback names the event through the adapter's own `normaliseEvent` (OpenClaw's names were missing). It writes a session file only under an id the payload named (no `<editor>-<ppid>` phantom) and carries its counters.
  - A nested OpenCode child counts toward the root.
  - An agent's lifecycle event never sets its parent's model.
  - A compaction the session runs itself (a manual `/compact`, Codex's pre-turn one) carries `compacting` and stays active while it runs.
  - `isRendererAlive` trusts a signalable pid on POSIX: the heartbeat's monotonic timer stops during a suspend, and a stale-looking file started a second renderer. The heartbeat now touches the file rather than rewriting it.
  - A dead editor's wait is rescued again.
  - A turn end drops a queued wait.
  - A wait is held while the file still names its prompt (`waitingOn` → `fileWaiting`).
  - A non-numeric `pid` cannot crash the loader.
  - A session's idle gaps over `IDLE_GAP_MS` (2h, `touchCounter`/`idleMs`) are not session time.
  - `unwrapShell` strips only a whole-script quote pair.
  - Builds run through `exec`/`dlx`/`compose` or a runner's `-p` are builds.

### Why the rules are what they are (moved from CLAUDE.md)

`CLAUDE.md` is loaded into every coding-agent session in this repository, so in 1.3.0 it was cut down to the rules themselves. The stories behind them, meaning how each bug showed itself before its rule existed, moved here, grouped by the part of the code they explain.

**State files and the turn-end contract**

- **`turnOver` after `Stop`.** A non-reward face after `Stop` carries `turnOver`, not `turnEnded`, because the renderer folds `turnEnded` into `stopped` and rescues the face. A `ConfigChange`'s `reading` after a Stop used to replay the whole responding → done! celebration.
- **Ambient events.** `/compact`, `/model` and a subagent's auto-compaction used to clear the turn end, which left the face on the 45s thinking timeout with nothing to close the turn.
- **`stopped` on a session file.** A turn-end `stopped` leaked onto a session file retired a live window in the orbital loader. The policy dropped the attended session (auto-releasing any pin), and the center bounced away and back with two swap animations. Adapters did the same at every turn end until they moved to `turnEnded`.
- **`normalizeStats`.** It exists because a string `"streak":"5"` concatenated to `"51"`, and `activeSubagents: [null]` threw in every hook. That hook then fell back and never rewrote the file, so it was never repaired.
- **Parking agents.** Agents are parked on an ownership switch because a parallel window's lifecycle event, which takes `stats.session`, used to wipe a conducting owner's agents; its `SubagentStop`s then matched nothing.
- **Crediting session time.** An outgoing owner is credited only up to its own last activity. Crediting up to the takeover added a session that ended at 18:00 to the next morning's total ("62h 59m today" after a weekend).
- **`pruneFrequentFiles`.** It never cuts the file just touched, because a full map used to reject every newcomer in the same write that added it.
- **One liveness check.** `isRendererAlive` is the only check because the hook, `launch.js` and the renderer used to disagree about `EPERM`. A stale PID file on Windows, where a logoff delivers no signal, made every hook open a window that printed "already running" and closed.
- **The spawn lock.** The stale takeover is exclusive (`<lock>.claim`) because a plain overwrite let up to 3 of 8 racing hooks each open a window.
- **The quit flag.** It is cleared when the editor starts again. Before that, one closed window disabled autolaunch for good.
- **The stats lock.** A create failing `EPERM` counts as held. On Windows a lock being unlinked sits delete-pending in about 0.2% of attempts under contention, and treating that as "proceed" ran the read-modify-write unlocked. That is why the 6-worker contention test used to fail intermittently on Windows CI.

**Liveness and hostile files**

- **The `refreshing` marker.** Without it, a TTL-expired PID-cache entry was re-queued during the in-flight exec and triggered a redundant second batch.
- **Child PID protection.** A child keeps PID protection only for `CHILD_ORPHAN_TIMEOUT`. A missed `SubagentStop` (an Esc) used to leave a ghost orbital for the editor's whole lifetime on Unix, holding the main face at "conducting 1" with it.
- **Hostile session files.**
  - An object `model_name` crashed the renderer at `.slice` in `_assignLabels`, at every boot, until the file went stale.
  - A newline or ESC in a folder or branch name reached the terminal raw.
  - A `null` file threw inside the async pass's fs callback 2s after boot.
- **`deadSessions`.** It exists because `adoptMain` must clear `editorDead` on a swap. Without the record, a crashed session looked live again, won the center straight back on attention, and showed its last work state for ~90s.

**Main session policy**

- **The main file is never purged.** On win32 its `MiniFace` goes stale 30s before the `STALE_MS` purge. Deleting the file the renderer reads dropped the attended window to attention 0 as soon as any non-`UserPromptSubmit` hook recreated it.
- **`STOPPED_LINGER_MS` is limited** to a child whose parent is no longer fresh.
  - Applied to a top-level window, it declared a live window dead at a cold boot for having last written `proud`.
  - Applied to a child of a live family, it dropped every agent whose last write was a reward at renderer boot: created and deleted every pass, `liveChildCount()` 0, conducting hold lost.
- **`_executeSwap`'s seeding.**
  - Without the adopted write's timestamp, a face swapped in while `waiting` escaped `WAIT_HOLD_STALE_MS` forever.
  - Without `lastStateChange`, a swap restarted "still running … Ns" at 0.
  - Without clearing `stateChangeTimes`, a face that had done nothing went "hyperdrive!" 67ms after arriving.
- **A dead editor's children do not count.** Counting them lifted the rescued face straight back to conducting, looping responding → done! → conducting every ~12s until they went stale.
- **`checkState()` is guarded whole during a swap.** The guard used to sit inside the mtime branch, so on the ~3 ticks in 4 where the file was unchanged, the rescue block, the (since removed) fresh-read block and `idleCascade` still acted on the session that was leaving.
- **`startupGate` records rather than skips.** A plain skip let the same old write read as new once the window closed, so a finished turn replayed as responding → done! and a stale one as whatever tool it last named.

**Subagents and classification**

- **Masked parent work.** Before agent-owned entries, a parent tool call wrote `subagent` / `conducting N`, which masked the parent's own work, errors included, for the whole life of any agent.
- **Touching only synthetic entries.** Only legacy synthetic entries are touched by the parent. A bare touch made `isStale()` false, so a missed `SubagentStop` left a ghost orbital that the parent's own tool calls revived for the full `SUBAGENT_MAX_AGE_MS` window, pinning the main face at `conducting N` for four hours.
- **Parallel-session classification (#134).** A foreign session arriving while the owner had `activeSubagents` was classified as its subagent unconditionally. That gave unrelated windows a sticky wrong `parentSession`, a stolen `taskDescription`, frozen stats and blocked main-face ownership, and it falsely retired the real subagent's synthetic orbital.
- **Reading the tail of agent transcripts.** An agent transcript's head is attachment and context entries of 26–64 KB per line. Reading the head found the model in none of five real agent transcripts sampled; the tail found it in all five.
- **The status-line name.** It yields to the room left on the line, because the fixed 16-column cap alone still wrapped `gpt-5.1-codex-ma is running command` at 38 columns.

**Face timing**

- **Same-state work drops a queued completion.** Otherwise a fast Bash → `relieved` queued → a second Bash showed the stale reward over the running tool and broke the long-tool hold.
- **Caffeine never fires while a state is queued.** A buffered `caffeinated` used to overwrite a queued `waiting`, so the permission prompt never showed.
- **`subagent` does not escalate.** Re-asserted by the conducting hold, a multi-agent session rendered `conducting 3 · still running … 240s` and sweated permanently.
- **`isNewerWrite`'s future escape.** A single future-stamped write froze the face until the wall clock caught up.
- **`answered` drops a spent wait.** The wait used to reappear the moment the reward in front of it ran out, drawing "allow?" again right after "got your answer".
- **`workSince`.** A Pre the renderer had already shown was replayed after its reward; for example, a Task's PostToolUse after its SubagentStop re-showed "spawning" for 8s over "agent done".
- **Solo `TaskCompleted`.** A solo `TaskCompleted` tagged its session `isTeammate`, which excluded it from the main policy for good.

**Orbitals and the session list**

- **Orbital labels.** The label put `modelName` first, so parallel windows in different folders all read `claude`.
- **Gating on `sessionListFits`.** The session list and its `l` key are gated on it because an invisible list swallowed the next key, and an Enter silently pinned.
- **The ended marker.** The main row's ended marker reads the main file's own SessionEnd flag, because the stopped `MiniFace` is purged after its 10s linger and the ended row then came back as live, offering a pin.

**Tool classification**

- **Linear-time patterns.** `\d+\s+fail(ed|ing)` against 60,000 digits cost ~1.4s of backtracking.
- **Builds by command position.** `rm -rf build` and `mkdir -p build` used to finish as "build succeeded".
- **Redirect `&`.** Segments never split on a redirect's `&`. Splitting `grep x 2>&1` left a segment `1` that is not read-only, so an ordinary grep had its matches read as a failure.
- **`unwrapShell`.** It exists because Codex runs every command through a shell wrapper, so the wrapper used to be the only word ever seen.

**Adapters**

- **codex-wrapper goes quiet when the hooks are live.** `setup.js codex` also suggests the wrapper for `codex exec`, and each run used to be two sessions, with every tool call, the daily session count and the streak counted twice.
- **`EXIT_GRACE_MS`.** A process codex (or a shell shim in front of it) left in the background used to block the user's terminal, with the session unretired, for its whole life.
- **One child at a time per session.** The OpenCode plugin does this because two detached children raced for the stats lock, and a fast tool's `after` could land before its `before`, leaving the face on "still running".
- **Payload numbering (`seq`/`endSeq`).** A child spawned just before a synchronous turn end could not write before it, so its batch landed after the turn end and re-opened the turn.
- **OpenCode child sessions never stamp attention.** Every delegated task used to take the center from the session that launched it.
- **Adapter identity coercion.**
  - An object `session_id` keyed the renderer's faces by a fresh object on every load.
  - A number read as a legacy row index in the session list.
  - An object `model_name` crashed the renderer.
- **Oversized payloads are judged by their own event.** A huge Write whose content said "exit code 2" put a false error on the global file.

**Tests**

- **`_harness.js` owns the subprocess runners** because four local copies had drifted apart.
- **The PID resolver became a seam** because seven tests once passed only where the start time was never resolved: in-tick `/proc` on Linux, `'pending'` `execFile` on win32 and darwin.

## 1.2.0 — 2026-09-07

Subagent attribution, Codex and OpenCode compatibility, and an audit pass (#135).

- **Every Claude Code subagent gets its own orbital.** Hooks fired inside a subagent carry the parent's `session_id` plus an `agent_id` the face never read, so an agent's whole turn used to land on the main face. Agents are now keyed by `agent_id`, retire individually instead of oldest-first, survive long model turns, and the main face reads "conducting" while they work.
- **Long-running tools** keep their work face for up to 10 minutes instead of degrading at 8s, with the detail counting up and sweat after 20s.
- **Waits escalate.** A wait unanswered for 30s gets bigger question marks, a pulsing status line and a flashing terminal title, bounded by 30 minutes of write silence.
- **The stats lock.** The stats file's read-modify-write is serialized behind a lock. A six-worker contention test failed 10/10 before and 0/10 after, at ~0.3ms per hook.
- **Diff counts.** Edit diff counts come from `structuredPatch`, so a same-length replacement reports `+1 -1` rather than `+2 -2`.
- **Frame size.** The dead incremental clear buffers were removed; a representative frame dropped from 4027.9 to 2326.5 bytes (−42.2%).
- **Codex CLI** uses its native hooks through the same handler, so it works in interactive sessions and not only `codex exec`. The wrapper was rewritten against codex-cli 0.146's real ThreadEvent schema.
- **OpenCode** gets a shipped plugin written against the 1.18 contract (fixes #120). The phantom orbitals of #120 came from the old documented snippet: it registered bus events as top-level hooks and captured an always-empty `session_id`, so every event fell back to `opencode-<ppid>`, and that ppid was a fresh `cmd.exe` shim per event.
- **Tests.** Source-grep tests became behavioural, and the PID-liveness tests are deterministic across platforms.

After upgrading:

- re-run `node setup.js` so `UserPromptSubmit` registers;
- run `node setup.js codex` to regenerate the Codex hooks with the `--editor codex` tag;
- replace a hand-written OpenCode plugin with the shipped one.

Also in 1.2.0, merged while `package.json` still read 1.1.0:

- **Session identity.** PID-recycling-proof liveness and editor provenance (#133). Parallel sessions are no longer misclassified as subagents of a conducting session (#134).
- **Hook events and error detection.** Face reactions for nine newer hook events (#129); PostToolUse error detection reading the right field (#130); synthetic orbitals retired (#131); multiline commands no longer break the layout (#132).
- **Subagents and orbitals.**
  - Tool states on orbitals (#125).
  - The main face stays while subagents run (#126).
  - Subagent sessions write to orbitals instead of the main face (#128).
  - Orbitals no longer disappear or stick on thinking (#106, #107, #109, #116).
  - Orbital cleanup no longer deletes active sessions (#108).
- **Orbital layout.** Orbital grouping with clustered positioning, tethers and group labels (#111, #117, #122); smooth orbital repositioning (#121); a timeline segment cap (#118).
- **Other fixes.**
  - OpenCode no longer creates ~40 phantom orbitals (#120).
  - The `ratelimited` state was removed (#119).
  - Keypresses no longer stop responding under load (#115).
  - Security hardening and performance work (#124).
  - The suite grew from 1140 to 1386 tests (#123).
- **The plugin cache.** The Claude Code plugin cache now holds the source (`plugin.json` at the root, marketplace `source: "."`).

## 1.1.0 — 2026-03-02

The earliest version in this repository's history.
