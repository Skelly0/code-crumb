# Code Crumb — Full Code Review & Refactor Spec

**Date:** 2026-03-14
**Baseline:** 1386 tests passing, main branch clean (post-fix: ~1393 tests)
**Review method:** 6 parallel agents analyzing architecture, quality, errors, performance, tests, and security
**Status:** Phase 1 + partial Phase 2 completed in PR #124; follow-up fixes in current branch

---

## Executive Summary

The codebase is fundamentally sound — well-tested, zero-dependency, with consistent conventions. But it has grown organically and now has three god files (`grid.js` at 1564 lines, `face.js` at 1180, `renderer.js` at 740) that carry too many responsibilities. There's significant code duplication between `update-state.js` and `base-adapter.js`, hot-path allocations that create unnecessary GC pressure at 15 FPS, one actual crash bug (`eyes.star()` undefined), and a shell injection vulnerability in `launch.js`.

---

## Critical / Must-Fix

### ~~C1: `eyes.star()` called but not defined — runtime crash~~ (FALSE POSITIVE)
- **Status:** `eyes.star()` exists at `animations.js:160` and has test coverage. The reviewing agent missed it.
- ~~**Fix:** Add `eyes.star()` to `animations.js` or replace the call with an existing function like `eyes.wide()`.~~

### C2: `shell: true` with pass-through argv — command injection ✅ DONE (#124)
- **Fix:** Removed `shell: true` from both spawns.

### C3: `fs.watch` has no error listener — crash on directory deletion ✅ DONE (#124 + follow-up)
- **Fix:** Added `.on('error', ...)` with stderr logging to both watchers.

---

## High Priority — Architecture

### A1: Split `grid.js` (1564 lines → 3 files)
Currently holds `MiniFace`, `OrbitalSystem`, and `renderSessionList` — three distinct classes/concerns.

**Proposed split:**
- `mini-face.js` — MiniFace class
- `orbital-system.js` — OrbitalSystem class
- `session-list.js` — `renderSessionList` + helpers (`_truncatePath`, `_sessionDot`)

### A2: Extract rendering from `face.js` (1180 lines)
`ClaudeFace.render()` is 380 lines. The class mixes state machine, animation dispatch, stats ingestion, timeline compression, sparkline building, help overlay, and full rendering.

**Proposed extractions:**
- `_compressTimeline()` + `_buildSparkline()` → `timeline.js`
- `_updateThought()` → can stay but needs simplification
- `render()` stays but sub-sections become helper methods: `_renderStats()`, `_renderThoughtBubble()`, `_renderProjectCtx()`

### A3: Extract `checkState` and `_executeSwap` from `renderer.js`
`runUnifiedMode()` is a 504-line god function. `checkState` (170 lines) and `_executeSwap` (48 lines) should be extractable.

**Proposed approach:**
- Add `ClaudeFace.forceState(state, detail)` to bypass buffering while running all side effects (eliminates the two blocks where renderer directly mutates 9 face fields)
- Move `_executeSwap` into `OrbitalSystem.promoteSession(fromId, toId, faceState)`

### A4: Deduplicate `update-state.js` ↔ `base-adapter.js`
Near-identical implementations of: `writeState`, `writeSessionState`, `readStats`, `writeStats`, `guardedWriteState`, `buildExtra`, `initSession`.

**Fix:** Have `update-state.js` import helpers from `base-adapter.js` instead of reimplementing them.

### A5: Centralize duplicated constants
| Constant | Locations | Target |
|----------|-----------|--------|
| `ACTIVE_WORK_STATES` | face.js, grid.js | state-machine.js |
| `INTERRUPTIBLE_STATES` | face.js, grid.js | state-machine.js |
| `IDLE_TIMEOUT` / `SLEEP_TIMEOUT` / `THINKING_TIMEOUT` | renderer.js, grid.js | shared.js |
| `120000` session ownership timeout | renderer.js, update-state.js, base-adapter.js (5 places) | shared.js as `SESSION_OWNERSHIP_MS` |
| `completionStates` array | grid.js (3 places) | Import from themes.js `COMPLETION_LINGER` keys |

---

## High Priority — Performance

### P1: `dimAnsiOutput` regex on full output during transitions
- **File:** `themes.js:60-69`, called from `renderer.js:589`
- Runs regex replace on the entire rendered output string (3,000-10,000+ chars) every frame during transitions.
- **Fix:** Pass `dimFactor` into `face.render()` and multiply colors before ANSI encoding, eliminating the regex entirely.

### P2: O(n²) dot loops in connection/tether rendering
- **File:** `grid.js:922-984` (`_renderConnections`), `grid.js:987-1061` (`_renderGroupTethers`)
- For each dot on each line, iterates all orbital positions for bounding-box exclusion. 8 orbitals × 60 steps = 3,840 checks per connection pass per frame.
- **Fix:** Pre-compute AABB skip set. Quick min/max rejection eliminates ~90% of inner iterations.

### P3: Double `readState()` per `checkState()` invocation
- **File:** `renderer.js:181, 287`
- When in active states past `minDisplayUntil`, reads the state file twice per call.
- **Fix:** Cache first read result in a local variable.

### P4: Hot-path allocations (per-frame garbage)
| What | File | Fix |
|------|------|-----|
| `rescueExclude = new Set(...)` | renderer.js:264 | Hoist to module constant |
| `freshReadStates = [...]` | renderer.js:282 | Hoist to module `Set` |
| `completionStates = [...]` (×3) | grid.js:188,260,494 | Hoist to module constant |
| `_compressTimeline` arrays | face.js:675 | Cache, recompute only when timeline changes |
| `_buildGroups` Map + arrays | grid.js:761 | Cache when faces unchanged |
| `connDots = []` rebuilt | grid.js:1325 | Reuse preallocated array |
| `stateChangeTimes.filter()` | face.js:619 | Count with loop instead |
| `ansi.reset/bold/dim` getters | themes.js:16-20 | Cache after `setNoColor()` |

### P5: `Array.shift()` on 200-element timeline
- **File:** `face.js:232`
- O(n) shift on bounded queue. Replace with ring buffer for O(1) push/pop.

---

## Medium Priority — Code Quality

### Q1: Dead code cleanup ✅ DONE (#124)
- ~~Remove `eyes.echo()`, `mouths.ooh()`, `mouths.calm()` from animations.js~~ ✅
- ~~Remove unused `roomLeft`/`roomRight` in `grid.js:_resolveOverlaps`~~ ✅
- ~~Differentiate `eyes.wide()` from `eyes.open()` or alias them~~ ✅ (aliased with comment)

### Q2: `spawn()` in particles.js — 180-line else-if chain
- Replace with a `PARTICLE_CONFIGS` lookup table keyed by style.

### Q3: `classifyToolResult()` complexity
- Extract `_classifyBashResult(cmd, stdout, stderr)` as a helper.

### Q4: `_updateThought()` — 14-branch if/else chain
- Replace with a dispatch table `STATE_THOUGHT_BUILDERS`.

### Q5: `guardedWriteState` mutates caller's `extra` object
- Return modified `extra` instead of mutating in-place.

### Q6: Fallback catch block in `update-state.js` duplicates event→state logic
- Extract `eventToState(hookEvent, data)` pure function, call from both branches.

---

## Medium Priority — Security & Robustness

### S1: State files world-readable (no explicit `mode`)
- All `writeFileSync` calls use default umask. On multi-user systems, state files expose working patterns.
- **Fix:** `{ mode: 0o600 }` for files, `{ mode: 0o700 }` for directories.

### S2: Unbounded stdin accumulation
- `update-state.js:162`, `base-adapter.js:167` — no size cap on `input += chunk`.
- **Fix:** Cap at 1MB, truncate and write fallback state.

### S3: ANSI escape sequences in detail strings reach terminal
- Tool commands like `\x1b[2J` pass through to terminal output unsanitized.
- **Fix:** Strip ANSI from `detail` before writing state files.

### S4: Symlink check before session file writes
- Symlinks in `~/.code-crumb-sessions/` redirect writes to arbitrary paths.
- **Fix:** `fs.lstatSync` check or restrict directory permissions.

### S5: `CODE_CRUMB_STATE` env var — unvalidated path override
- **Fix:** Validate resolved path stays within HOME.

### S6: Stats read-modify-write race (concurrent sessions)
- Known limitation of file-based IPC. Document explicitly.

### S7: Non-atomic writes (write-then-read race)
- **Fix:** Write to `.tmp` file, then `fs.renameSync` for atomic replacement.

---

## Medium Priority — Test Coverage Gaps

### T1: Zero-coverage high-value functions
- `buildSubagentSessionState` — 3 branches, used in hot hook path
- `guardedWriteState` ownership/conflict logic
- `_updateThought` — 10+ untested branches
- `isProcessAlive` — no unit tests
- `processJsonlStream` — never tested

### T2: `update-state.js` entirely untested as integration
- SubagentStart/Stop/TeammateIdle handlers have no test coverage.
- **Fix:** Spawn-based integration tests (same pattern as `test-adapters.js`).

### T3: Test infrastructure issues
- `test-shared.js` and `test-grid.js` use real filesystem paths instead of temp dirs.
- `test-adapters.js` tests codex-wrapper by source inspection instead of behavior.

---

## Low Priority (deferred)

- `_drawDottedLine` helper to deduplicate connection/tether inner loops
- `face.js` layout values as named top-level constants
- `renderer.js` re-exports for tests → direct imports instead
- `process.stdout` injection into `ClaudeFace.render(cols, rows)`
- `orbital._prevClearBuf` → `orbital.clearCache()` method
- ~~`getAccessory` called 3x per frame → cache in local var~~ ✅ DONE
- `scanTeams` synchronous in render loop → async
- PID guard TOCTOU → exclusive file lock
- EPERM false positive on PID check → secondary liveness signal
- Orphaned session file cleanup on disk

---

## Proposed Refactor Phases

### Phase 1: Critical fixes (no architecture changes) ✅ DONE
- ~~C1: Fix `eyes.star()` crash~~ — false positive, already exists
- C2: Remove `shell: true` from spawns ✅
- C3: Add `fs.watch` error handlers ✅
- S1: File permission modes ✅
- S2: Stdin truncation cap ✅
- S3: ANSI stripping on detail strings ✅

### Phase 2: Performance wins (low-risk, high-impact) — partially done
- P3: Cache `readState()` result ✅
- P4: Hoist all hot-path allocations to module constants ✅ (incl. renderer.js COMPLETION_STATES)
- P4: `_compressTimeline` caching ✅
- P4: `_buildGroups` caching ✅ (with proper dirty-flag invalidation)
- P1: Pass `dimFactor` into render instead of post-processing — remaining

### Phase 3: Code deduplication
- A4: `update-state.js` imports from `base-adapter.js`
- A5: Centralize shared constants
- Q6: Extract `eventToState()` pure function

### Phase 4: File splits (biggest structural change)
- A1: Split `grid.js` → `mini-face.js` + `orbital-system.js` + `session-list.js`
- A2: Extract timeline/sparkline from `face.js`
- A3: Extract `checkState`/`_executeSwap` (note: `forceState()` was prototyped but removed as dead code — renderer rescue blocks work correctly with direct field mutation + `_timelineDirty` flag)

### Phase 5: Test coverage & quality
- T1: Add tests for zero-coverage functions
- T2: Integration tests for `update-state.js`
- T3: Fix test infrastructure (temp dirs, behavior tests)

### Phase 6: Remaining medium items
- Q1-Q5: Dead code, particle configs, complexity reduction
- S2-S7: Security hardening
- P2: O(n²) dot loop optimization
- P5: Ring buffer for timeline
