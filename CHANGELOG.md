# Changelog

Notable changes to Code Crumb. Dates are commit dates; issue and PR numbers refer to [Skelly0/code-crumb](https://github.com/Skelly0/code-crumb). The format is loosely [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Changed

- **Repository layout.** The internal modules moved into `lib/` (`accessories`, `animations`, `face`, `grid`, `particles`, `shared`, `state-machine`, `themes`, `transition`), the demos into `demo/` (`demo.js` → `demo/single.js`, `grid-demo.js` → `demo/orbital.js`), and the test runner into `tests/run.js`. The root keeps only what is run by path — `renderer.js`, `update-state.js`, `launch.js`, `setup.js` and the `code-crumb.sh`/`.cmd` wrappers — so installed hooks, PATH symlinks and `node setup.js` all keep working without re-running setup. `npm run demo`, `npm run demo:orbital` and `npm test` are unchanged.
- The review-pass history below moved here out of `CLAUDE.md`, and that file's per-file test coverage essay was condensed into a table.

### Added

- **Attention-following main face and a session-list tree** (#136). The center face follows the live top-level session the user last addressed (`lastPromptAt`, stamped by `SessionStart` and `UserPromptSubmit`) instead of whichever session owns the global state file. `Enter` in the session list pins a session, or pins and promotes it; a pin is released the moment its session stops. The list draws sessions as a tree with their children.
- **The real model name on the faces.** A new sticky `model` field (`Opus`, `Sonnet`, `Haiku`, `Fable`, or an unrecognised id verbatim) leads the status line, fills a child orbital's row 5 and joins the session list's info row. It is taken from `SessionStart`'s `model`, from `PostModelSwitch`'s `to_model` (registered as the 22nd hook event, so re-run `npm run setup`), from each subagent's own transcript, and from a bounded tail-read of the main transcript on `Stop`. codex-wrapper now honours `-m`/`--model`, and the OpenCode plugin records `message.updated`'s model without spawning anything.

### Fixed

- **Faces glitching at different window sizes.** A layout probe (~600 sizes × 3 face counts × 240 frames) found four causes: the key-hint bar wrapping the last row, the orbit being sized from the current accessory, the thought-bubble nudge teleporting orbitals, and faces spaced by angle rather than box size. After the fix the probe found 0 off-screen writes, 0 overlaps, 0 jumps and 0 layout flips, down from 73k, 4.9k, 8.5k and 1k frames.
- **First review pass** (ten bugs). A solo `TaskCompleted` no longer tags a session as a teammate. Adapters write `turnEnded` at a turn end and keep `stopped` for `session_end`, so an OpenCode/OpenClaw main no longer bounces away and back every turn. `<synthetic>` model ids are skipped. The swap seeds the write clock and clears git context. The status-line name yields to the room left on the line. `model` is carried forward by adapters and `SubagentStop`. `setup.js codex-notify` backs up and writes `config.toml` atomically.
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
- engmux registers its signal handlers before its first write, and a delete-pending stats lock on Windows (`EPERM` on create) is treated as held rather than free.
- **Third review pass** (~40 more bugs, each reproduced first by one of six parallel reviewers and re-verified before fixing). A `Third review pass` block was added to six test files, every new test checked to fail against the pre-fix sources:
  - **test-state-machine**: redirect-aware shell splitting and `cd`; one install table; anchored "0 errors" guards; kebab/camelCase MCP verbs; the real `PostToolUseFailure` payload (`error`, `is_interrupt`); NotebookEdit file counting; a fresh timestamp on synthetic retirement; teammate writes keeping `editor`/`modelName`/sticky fields; the shared counter helpers (now in state-machine.js as `freshCounter`/`normalizeCounter`/`parkAgents`/`unparkAgents`/`pruneCounters`); the quit flag cleared by a `startup` SessionStart.
  - **test-face**: a `waiting` behind a queued reward is remembered (it was dropped); a same-state work write drops any older queued state; a reward queues behind an on-screen error; the timeline's pass 2 is no longer cached (only pass 1 is — the cap froze and the live segment filled the bar); a streak break reacts only while fresh (`STREAK_BREAK_FRESH_MS`, 10s) and a break that lost nothing resets the last loss; the thought is re-picked when `setStats` brings a new diff or loss; the loss line and the milestone share row +12 without overdrawing; caffeine hands the detail back.
  - **test-grid**: a write without `parentSession` heals a falsely stamped window in `MiniFace` too; a stopped file is purged even while its editor pid lives (sync and async); `~` only on a path boundary; a child with no task is labelled by its `agentType`; non-text details are dropped (an object detail threw inside the ring render).
  - **test-platform**: setup strips our hook *commands*, never a user's co-located hook, and only matches our argv shape; backups keep the settings file's mode; `--help`, unknown flags and `--install`/`--uninstall` outside `opencode` no longer install anything; the plugin hint needs `.claude-plugin/marketplace.json`; `enableAutolaunch` clears the quit flag; `quoteArg` doubles backslashes before a `%`; a submodule's relative `gitdir` resolves from its own folder; a `null` prefs file; the exclusive spawn-lock takeover (including an 8-process race); launch.js exit codes for a signalled editor; `code-crumb.sh` through a symlink.
  - **test-adapters**: details are text on one line (`detailText` in shared.js, applied by base-adapter's writers, `readState` and `MiniFace`); oversized or unparseable stdin goes through the ownership guard with the session id; adapters keep per-session counters and park a conducting owner's agents like update-state.js does; multi-byte UTF-8 split across chunks; `exitWhenFlushed` (a passthrough used to be cut off by `process.exit`); the OpenCode plugin spawns one session's payloads in order; the OpenClaw snippets send a stable `session_id` through `execFileSync`; codex-wrapper's retry notices and late events.
  - **test-attention**: `needsRescue` exempts a conducting face while agents run (it looped responding → done! → conducting every ~12s); `readState` coerces details; a turn end no longer cuts a reward's window or an error's 4s; a recorded startup write hands over its counters; the session list's main row uses the real SessionEnd flag (it drew a grey ✕ between turns).
- **Two review rounds over the third pass** (four fresh reviewers over the whole diff, each finding reproduced): our hook command must end in a real hook event; backups are always 0600 and refreshed even when settings.json is read-only; an npm install is pointed at the GitHub marketplace; `detailText` also strips C1 controls; the install table was widened again (flags and workspace selectors between the manager and its verb, `npm ci`, a bare `yarn`); a failed `cd` still reads as an error; teammate writes do not carry subagent stamps; `resume` clears the quit flag; a newer same-state error drops the queue and restarts its 4s; a streak loss lasts for its own error episode (a burst keeps it, leaving `error` ends it); milestones are freshness-gated like breaks; the thought is re-picked only for the write on screen; a remembered prompt survives later rewards and repeated work states; the OpenCode plugin batches and drains its queue with the turn end; `buildExtra` subtracts time update-state.js already credited; sessions count once per id **per day** (`countedDay` replaced the `counted` boolean); and `pruneCounters` evicts throwaway entries first and never parked agents.

## 1.2.0 — 2026-09-07

Subagent attribution, Codex and OpenCode compatibility, and an audit pass (#135).

- **Every Claude Code subagent gets its own orbital.** Hooks fired inside a subagent carry the parent's `session_id` plus an `agent_id` the face never read, so an agent's whole turn used to land on the main face. Agents are now keyed by `agent_id`, retire individually instead of oldest-first, survive long model turns, and the main face reads "conducting" while they work.
- Long-running tools keep their work face for up to 10 minutes instead of degrading at 8s, with the detail counting up and sweat after 20s.
- A wait unanswered for 30s escalates: bigger question marks, a pulsing status line, a flashing terminal title — bounded by 30 minutes of write silence.
- The stats file's read-modify-write is serialized behind a lock (a six-worker contention test failed 10/10 before and 0/10 after, at ~0.3ms per hook).
- Edit diff counts come from `structuredPatch`, so a same-length replacement reports `+1 -1` rather than `+2 -2`.
- The dead incremental clear buffers were removed; a representative frame dropped from 4027.9 to 2326.5 bytes (−42.2%).
- Codex CLI uses its native hooks through the same handler, so it works in interactive sessions and not only `codex exec`; the wrapper was rewritten against codex-cli 0.146's real ThreadEvent schema.
- OpenCode gets a shipped plugin written against the 1.18 contract (fixes #120).
- Source-grep tests became behavioural, and the PID-liveness tests are deterministic across platforms.

After upgrading: re-run `node setup.js` so `UserPromptSubmit` registers, run `node setup.js codex` to regenerate the Codex hooks with the `--editor codex` tag, and replace a hand-written OpenCode plugin with the shipped one.

Also in 1.2.0, merged while `package.json` still read 1.1.0:

- Session identity overhaul: PID-recycling-proof liveness and editor provenance (#133); parallel sessions no longer misclassified as subagents of a conducting session (#134).
- Face reactions for nine newer hook events (#129); PostToolUse error detection reading the right field (#130); synthetic orbitals retired (#131); multiline commands no longer break the layout (#132).
- Subagent and orbital fixes: tool states on orbitals (#125), the main face staying while subagents run (#126), subagent sessions writing to orbitals instead of the main face (#128), orbitals disappearing or sticking on thinking (#106, #107, #109, #116), orbital cleanup deleting active sessions (#108).
- Orbital grouping with clustered positioning, tethers and group labels (#111, #117, #122); smooth orbital repositioning (#121); a timeline segment cap (#118).
- OpenCode no longer creates ~40 phantom orbitals (#120); the `ratelimited` state was removed (#119); keypresses no longer stop responding under load (#115); security hardening and performance work (#124); the suite grew from 1140 to 1386 tests (#123).
- The Claude Code plugin cache now holds the source (`plugin.json` at the root, marketplace `source: "."`).

## 1.1.0 — 2026-03-02

The earliest version in this repository's history.
