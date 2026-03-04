# PR Reviews — 2026-03-04

## PR #114: Fix subagent orbitals failing to show up

**Branch:** `worktree-fix-orbital-bugs` -> `main` | **Author:** Skelly0 | **Tests:** All 1053 pass

### Bug A: Face removal PID liveness check (grid.js:509)
**Verdict: Correct and important fix.**

When a session file disappears temporarily during a race (`unlink` + `writeFileSync`), the face gets pruned even though the process is alive. The PID liveness guard is well-structured and consistent with `isStale()` logic. Good test coverage with live/dead PID and stopped-face cases.

### Bug B: Parse error protection in purge loop (grid.js:464)
**Verdict: Correct, obvious fix.**

Previously `JSON.parse` failure fell through to `fs.unlinkSync`, deleting files mid-write. The `continue` in the catch block correctly protects files during race conditions.

### Bug C: Completion-state faces with live PIDs protected (grid.js:451)
**Verdict: Correct, improves consistency.**

Separates active non-completion (always protect) from completion with live PID (protect) vs completion with dead PID (allow deletion). Consistent with `isStale()`.

### Bug D: Subagent cleanup timeout 3min -> 10min (update-state.js:203)
**Verdict: Reasonable.**

Dead subagents without `SubagentStop` will linger longer, but PID-based staleness handles this.

### Bug E: Fallback SubagentStart writes session file (update-state.js:549)
**Verdict: Works but has a known limitation.**

The subagent is not added to `stats.session.activeSubagents`, so it won't get live tool state updates. The orbital stays frozen in `spawning`. Missing `subagentCount` increment. Hardcoded `modelName: 'haiku'` and `taskDescription: 'subagent'`. This is best-effort for malformed stdin, so acceptable — but a comment noting the limitation would help future maintainers.

### Overall: Approve with minor nit on Bug E.

---

## PR #112: Fix test suite polluting state file with stale modelName

**Branch:** `claude/unruffled-spence` -> `main` | **Author:** Skelly0 | **Tests:** All 1083 pass

3 unique commits (the ANSI-stripping commit `1a34043` is already in `main` via PR #113):

1. `f66b330` Add 'training' face state — The Furnace
2. `6502142` Fix training regex false positives and add missing tests
3. `28cedb2` Fix test suite polluting ~/.code-crumb-state with stale modelName

### 1. Bug Fix: Test pollution save/restore (test-adapters.js)
**Verdict: Correct.**

The save/restore pattern handles both cases (file existed -> restore, file didn't exist -> delete). Matches existing patterns in the codebase. Minor note: cleanup is a `test()` block, so early abort leaves artifacts — but consistent with project conventions.

### 2. New "training" face state feature
**Verdict: Well-implemented.**

Clean integration across all layers:
- **state-machine.js**: Regex detection for `python train.py`, `torchrun`, `deepspeed`, `accelerate launch`, `unsloth`, `--epochs`/`--lr` flags. Placed after install detection (correct ordering).
- **themes.js**: Warm amber/gold colors, 8 thought bubbles, all 6 palettes updated.
- **animations.js**: Furnace eyes (flickering ember glyphs with 4-phase pulse) and mouth. Grid mouth entry added.
- **particles.js**: New "fire" particle style — embers rising from below with negative `vy`. Correct physics.
- **face.js / grid.js**: Training in `ACTIVE_WORK_STATES`, 5000ms min display, fire particle spawn on state entry, eye/mouth dispatch.

### 3. Training regex false positive guards
**Verdict: Good coverage.**

Tests verify these do NOT trigger training:
- `python train_test_split.py` — `\btrain\b` word boundary correctly excludes `train_test_split`
- `torchrun --version` — no `\btrain\b` present
- `accelerate config` — no `\btrain\b` present
- `python eval.py --batch-size` — `--batch-size` alone doesn't trigger (requires `--epochs` or `--lr`)

**Potential gap:** `python train_utils.py` would match `\btrain\b` (the underscore is a word boundary). Not a major concern since it's unlikely to be a standalone command, but worth noting.

### 4. Scope concern
This PR bundles a feature (training state) with a test bug fix. Ideally separate PRs, but since both are clean and tests pass, this is acceptable.

### Overall: Approve.
