#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb -- A terminal tamagotchi for AI coding assistants  |
// |  Shows what your AI coding assistant is doing                  |
// |  Subagent mini-faces orbit the main face as satellites         |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR, TMUX_FILE, loadPrefs, savePrefs, getGitBranch, QUIT_FLAG_FILE, safeFilename } = require('./shared');

// -- Modules -------------------------------------------------------
const {
  ansi, lerpColor, dimColor, breathe, dimAnsiOutput,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES, normalizePaletteIndex,
  setNoColor, isNoColor,
} = require('./themes');
const { mouths, eyes, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { ClaudeFace } = require('./face');
const { MiniFace, OrbitalSystem, renderSessionList, orderSessionList, listNavigableIds, isProcessAlive, isOwnedByLiveProcess, requestPidStartTime, _pidStartStatus } = require('./grid');
const { SwapTransition } = require('./transition');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, '.code-crumb.pid');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const IDLE_TIMEOUT = 8000;
const THINKING_TIMEOUT = 45000; // 45s -- safety net if Stop event is missed
const SLEEP_TIMEOUT = 60000;
const LONG_TOOL_HOLD_MS = 600000; // 10 min: the longest a single tool call can run
// The `waiting` hold below is uncapped in display time, so it needs a bound of
// its own -- and it cannot borrow the crash machinery: on win32 update-state.js
// writes no `pid`, so `editorDead` never arms, and a hard-closed terminal never
// gets to write `stopped`. What is left is the editor's own write cadence: the
// hold ends once no NEW write has arrived for this long (see noteNewWrite --
// the age must not be measured from a read, because checkState re-reads the
// unchanged file every 2s).
//
// This is silence, not death. An editor blocked on a permission prompt emits no
// further hooks either, so a live-but-unanswered session looks exactly like a
// crashed one here and is dropped to idle identically -- a user who walks away
// for longer than this loses the flashing title until the next write. That is
// the accepted trade: the alternative is a face that shouts forever at a
// terminal that is already closed. 30 min is 3x LONG_TOOL_HOLD_MS -- far past
// any plausible "reading the permission prompt" pause, short of leaving the
// face shouting at an empty desk all night.
const WAIT_HOLD_STALE_MS = 1800000;

// -- Hoisted sets for checkState() hot path ---------------------------
const { ACTIVE_WORK_STATES, COMPLETION_STATES } = require('./shared');
const RESCUE_EXCLUDE = new Set(['idle', 'sleeping', 'responding', 'starting', 'happy', 'satisfied', 'proud', 'relieved']);
// States in which a missed Stop/start event is worth a fresh file read: every
// active work state, every completion, and thinking. Derived so a new work
// state can never be forgotten here (committing/reviewing/subagent/training were).
const FRESH_READ_STATES = new Set(['thinking', ...ACTIVE_WORK_STATES, ...COMPLETION_STATES]);

// -- Timeout cascade -------------------------------------------------
// Pure: decide the timeout-driven transition for the main face.
// Returns the next state, or null to hold the current one.
//   state         current face state
//   sinceChangeMs how long it has been showing (now - face.lastStateChange)
//   sessionActive Stop has not fired and the editor PID is not known dead
//   lingerMs      COMPLETION_LINGER for the current state (0 when it has none)
//   fileState     the state last applied from the state file
//   fileAgeMs     how long since the main session produced a NEW write
//                 (0 when unknown -- treated as fresh)
//   liveChildren  live subagent orbitals belonging to this session (0 = none)
function idleCascade({ state, sinceChangeMs, sessionActive, lingerMs, fileState, fileAgeMs, liveChildren = 0 }) {
  // Conducting hold. A Claude Code subagent's hooks write only that agent's
  // own orbital file, so between SubagentStart and SubagentStop nothing
  // refreshes global state and the face would fall idle -> sleeping while its
  // agents are visibly working around it. Hold it at 'subagent' (exactly what
  // SubagentStart itself writes) instead of letting it rest.
  //
  // `conducting()` is null once the face is already there, so a held face
  // never churns setState every frame. `hold()` substitutes it for a downward
  // transition only -- a reward, a real work state and a plain null all pass
  // through untouched, and so does the `waiting` hold below: "the editor needs
  // YOU" is actionable and outranks the ambient "your agents are busy".
  // Conducting only fills a vacuum the cascade would otherwise fill with idle.
  //
  // The bound is the caller's: liveChildren counts only non-stopped, non-stale
  // children, so a crashed parent's stale orbitals stop holding the face up.
  const conducting = () => (state === 'subagent' ? null : 'subagent');
  const hold = (next) => (liveChildren > 0 &&
    (next === 'idle' || next === 'sleeping' || next === 'thinking')) ? conducting() : next;

  if (state === 'starting') return hold(sinceChangeMs > 2500 ? 'idle' : null);
  if (state === 'responding' && !sessionActive) return 'happy';
  if (lingerMs && sinceChangeMs > lingerMs) return hold(sessionActive ? 'thinking' : 'idle');
  if (state === 'thinking') {
    return hold(sinceChangeMs > (sessionActive ? THINKING_TIMEOUT : IDLE_TIMEOUT) ? 'idle' : null);
  }
  // Resting: with agents still working, lift straight back to conducting
  // rather than wait out the 60s sleep timer with orbitals busy on screen.
  if (state === 'idle') {
    if (liveChildren > 0) return conducting();
    return sinceChangeMs > SLEEP_TIMEOUT ? 'sleeping' : null;
  }
  if (state === 'sleeping') return liveChildren > 0 ? conducting() : null;
  if (COMPLETION_STATES.has(state)) return null;
  // Waiting on the user is real whether or not the turn has ended -- an
  // idle_prompt notification arrives *after* Stop. So this hold ignores
  // sessionActive and never expires on display time: the face waits as long as
  // the user does. It ends only once the editor has stopped producing new
  // writes for WAIT_HOLD_STALE_MS -- the one crash signal that works on every
  // platform. Degrade to idle, not thinking: nothing was ever running.
  // This hold wins over the conducting hold while it lasts -- and once the
  // silence bound does expire, hold() turns that 'idle' into conducting if
  // agents are still writing, which is the honest reading: the global write
  // clock has gone quiet but the family demonstrably has not.
  if (state === 'waiting' && fileState === 'waiting') {
    return (fileAgeMs || 0) > WAIT_HOLD_STALE_MS ? hold('idle') : null;
  }
  // The state file still names this same unfinished tool: hold the work face.
  // ('responding' is in ACTIVE_WORK_STATES but is a post-turn state, never a tool.)
  if (ACTIVE_WORK_STATES.has(state) && state !== 'responding' && sessionActive
      && fileState === state && sinceChangeMs <= LONG_TOOL_HOLD_MS) return null;
  return hold(sinceChangeMs > IDLE_TIMEOUT ? (sessionActive ? 'thinking' : 'idle') : null);
}

// -- Write clock -----------------------------------------------------
// Pure: when did the main session last produce a genuinely NEW write?
//
// This exists because "when did we last read the file" is a trap. checkState()
// re-reads the *unchanged* state file every 2s (the `forceRead` path, there to
// beat NTFS's 1-second mtime granularity), so any clock stamped on a read sits
// at ~2s forever, even for an editor that died an hour ago. Only the write's
// own JSON timestamp advancing proves the editor is alive.
//
//   ts      timestamp of the write just read
//   lastTs  the newest timestamp applied so far
//   now     current time
//   lastAt  the stamp to keep if this is not a new write
// Returns the stamp to keep. 0 means "no write seen yet" -- callers treat that
// as fresh rather than infinitely stale.
function noteNewWrite(ts, lastTs, now, lastAt) {
  return ts > lastTs ? now : lastAt;
}

// -- Main session policy ---------------------------------------------
// Pure: which session should the center face follow?
//
// The center follows the user's attention: the live top-level session with the
// newest `lastPromptAt` (stamped by SessionStart and UserPromptSubmit). A pin
// (manual promotion) wins while its session is live and is released the moment
// it is not, so a promoted agent hands the center back when it stops.
//
//   sessions   [{ id, parentSession, isTeammate, stopped, stale, attentionAt, lastUpdate }]
//   currentId  the session on screen now (null before the first pick)
//   pinnedId   the manual pin, or null
// Returns { mainId, pinnedId }. mainId is currentId when nothing live beats
// it -- the on-screen face then decays through its own cascade.
function pickMainSession({ sessions, currentId, pinnedId }) {
  const byId = new Map();
  for (const s of sessions) byId.set(s.id, s);
  const live = (s) => !!s && !s.stopped && !s.stale;
  const topLevel = (s) => live(s) && !s.parentSession && !s.isTeammate;

  if (pinnedId && live(byId.get(pinnedId))) return { mainId: pinnedId, pinnedId };

  let best = null;
  for (const s of sessions) {
    if (!topLevel(s)) continue;
    if (!best) { best = s; continue; }
    const a = s.attentionAt || 0;
    const b = best.attentionAt || 0;
    if (a > b) { best = s; continue; }
    if (a < b) continue;
    // Tie: the current main keeps its seat; with no current, the newest write.
    if (best.id === currentId) continue;
    if (s.id === currentId || (s.lastUpdate || 0) > (best.lastUpdate || 0)) best = s;
  }
  return { mainId: best ? best.id : (currentId || null), pinnedId: null };
}

// -- Terminal title -------------------------------------------------
// The tab/window title mirrors the face so a backgrounded terminal still
// says what is going on. While the face has been waiting on the user for a
// while, the caller alternates `flash` to make the title blink for attention.
function buildTitle(modelName, status, flash) {
  return flash
    ? `\x1b]0;\u2753 WAITING FOR YOU \u00b7 Code Crumb\x07`
    : `\x1b]0;Code Crumb \u00b7 ${modelName} is ${status}\x07`;
}

// -- Shared runtime -------------------------------------------------

// Read one state file into the shape the main face consumes. The unified
// renderer passes the main session's own file; tmux mode keeps the global
// file. A session file marks a finished turn with `turnEnded` (its `stopped`
// means the session ended, which the orbitals need to tell apart); for the
// main face both simply mean "the turn is over", so they fold into `stopped`.
function readState(filePath = STATE_FILE) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { state: 'idle', detail: '' };
    const data = JSON.parse(raw);
    return {
      state: data.state || 'idle',
      detail: data.detail || '',
      timestamp: data.timestamp || 0,
      sessionId: data.sessionId || data.session_id || '',
      modelName: data.modelName || '',
      model: data.model || '',
      toolCalls: data.toolCalls || 0,
      filesEdited: data.filesEdited || 0,
      sessionStart: data.sessionStart || 0,
      streak: data.streak || 0,
      bestStreak: data.bestStreak || 0,
      brokenStreak: data.brokenStreak || 0,
      brokenStreakAt: data.brokenStreakAt || 0,
      milestone: data.milestone || null,
      diffInfo: data.diffInfo || null,
      dailySessions: data.dailySessions || 0,
      dailyCumulativeMs: data.dailyCumulativeMs || 0,
      frequentFiles: data.frequentFiles || {},
      stopped: !!(data.stopped || data.turnEnded),
      cwd: data.cwd || null,
      isWorktree: data.isWorktree || false,
      gitBranch: data.gitBranch || null,
      commitCount: data.commitCount || 0,
      isSessionStart: data.isSessionStart || false,
      workState: data.workState || null,
      workDetail: data.workDetail || '',
      pid: data.pid || 0,
      editor: data.editor || '',
      lastPromptAt: data.lastPromptAt || 0,
    };
  } catch {
    return { state: 'idle', detail: '' };
  }
}

// -- PID guard -----------------------------------------------------
function isAlreadyRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function clearQuitFlag() {
  try { fs.unlinkSync(QUIT_FLAG_FILE); } catch {}
}

function writeQuitFlag() {
  try { fs.writeFileSync(QUIT_FLAG_FILE, String(Date.now()), 'utf8'); } catch {}
}

// -- Unified mode (main face + orbital subagents) ------------------
function runUnifiedMode() {
  const minimal = (process.argv.includes('--minimal') || process.env.MINIMAL_BOOT === '1');
  const face = new ClaudeFace();
  const rendererStartTime = Date.now();
  face.setState('starting');
  const orbital = new OrbitalSystem();
  const swapTransition = new SwapTransition();

  // Minimal mode: strip all UI chrome, just face + status line
  if (minimal) {
    face.minimalMode = true;
    face.accessoriesEnabled = false;
    face.showStats = false;
    face.showOrbitals = false;
  }

  // Ensure sessions directory exists
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  // Load persisted preferences (skipped in minimal mode)
  if (!minimal) {
    const prefs = loadPrefs();
    face.paletteIndex = normalizePaletteIndex(prefs.paletteIndex, PALETTES.length);
    if (typeof prefs.accessoriesEnabled === 'boolean') face.accessoriesEnabled = prefs.accessoriesEnabled;
    if (typeof prefs.showStats === 'boolean') face.showStats = prefs.showStats;
    if (typeof prefs.showOrbitals === 'boolean') face.showOrbitals = prefs.showOrbitals;
  }

  // Main session: which session file the center face follows. Chosen by
  // pickMainSession over the orbital loader's faces (the main is loaded like
  // any other session and merely kept off the ring). Changing it always goes
  // through adoptMain so every per-session tracker below is reset together.
  let mainSessionId = null;
  let pinnedSessionId = null; // Set when user manually promotes — prevents auto-swap

  let lastMtime = 0;
  let lastStopped = false;    // Track if Stop hook has fired (turn ended)
  let lastForceReadTime = 0;  // Track periodic forced re-reads (bypasses mtime race)
  let lastEditorPid = 0;      // Validated (armed) PID of the editor process
  let candidatePid = 0;       // PID from the latest state write, pending validation
  let candidateSince = 0;     // When candidatePid was first seen
  let candidateTs = 0;        // JSON timestamp of the write that reported the candidate
  let editorDead = false;     // Armed PID found dead — session presumed crashed
  let lastAppliedTimestamp = 0; // Dedup: skip re-applying state with same timestamp
  let lastAppliedState = null;  // State named by that write -- "is this tool still running?"
  let lastNewWriteAt = 0;       // When a NEW write last arrived (not a re-read) -- see noteNewWrite

  function mainSessionFile() {
    return mainSessionId ? path.join(SESSIONS_DIR, safeFilename(mainSessionId) + '.json') : null;
  }

  // Every path that changes which session is main lands here: the trackers
  // above are all per-session, and a stale one (a held work state, an armed
  // PID, an old write clock) would otherwise leak onto the new face.
  function adoptMain(newId) {
    mainSessionId = newId;
    orbital.setMainSession(newId);
    lastAppliedState = null;
    lastAppliedTimestamp = 0;
    lastStopped = false;
    editorDead = false;
    lastEditorPid = 0;
    candidatePid = 0;
    lastNewWriteAt = 0;
    lastMtime = 0;
    lastForceReadTime = 0;
    // Cleared, not just overwritten: the incoming session may have no model at
    // all, and the outgoing one's must not linger on its face.
    face.model = '';
    // Same for the git context: setStats only assigns these when the incoming
    // value is truthy, so a session outside a repo would keep the old branch.
    face.cwd = null;
    face.gitBranch = null;
    face.frequentFiles = {};
    const mf = orbital.faces.get(newId);
    if (mf) {
      if (mf.modelName && !process.env.CODE_CRUMB_MODEL) face.modelName = mf.modelName;
      if (mf.model) face.model = mf.model;
      if (mf.editor && !process.env.CODE_CRUMB_EDITOR) face.editor = mf.editor;
      if (mf.cwd) face.cwd = mf.cwd;
      if (mf.gitBranch) face.gitBranch = mf.gitBranch;
    }
  }

  // Ask the policy which session the center should follow, and start the
  // swap if it is not the one on screen. The first pick is silent.
  function applyMainPolicy() {
    if (swapTransition.active) return;
    const sessions = [];
    for (const f of orbital.faces.values()) {
      sessions.push({
        id: f.sessionId, parentSession: f.parentSession, isTeammate: f.isTeammate,
        // The renderer knows one thing the file does not: the main's editor died.
        stopped: f.stopped || (f.sessionId === mainSessionId && editorDead),
        stale: f.isStale(), attentionAt: f.lastPromptAt || 0, lastUpdate: f.lastUpdate,
      });
    }
    const pick = pickMainSession({ sessions, currentId: mainSessionId, pinnedId: pinnedSessionId });
    pinnedSessionId = pick.pinnedId;
    if (!pick.mainId || pick.mainId === mainSessionId) return;
    if (!mainSessionId) adoptMain(pick.mainId);
    else swapTransition.start(mainSessionId, pick.mainId);
  }

  function checkState() {
    const now = Date.now();
    let cachedStateData = null; // Cache readState() to avoid duplicate fs.readFileSync
    // The policy runs above the main try, so an exception in it (or in
    // isStale's PID plumbing) would escape checkState and take the render loop
    // with it. A failed pick must cost one tick, not the face.
    try { applyMainPolicy(); } catch {}
    // Nothing may touch the face or the trackers while it dissolves. The old
    // guard sat inside the mtime branch, so on the ~3 ticks in 4 where the old
    // main's file is unchanged and this is not a forced read, execution fell
    // straight past it into the rescue block, the fresh-read block and
    // idleCascade -- all still acting on the session that is leaving. The
    // rescue's forceState('responding') then buffered the promoted face's own
    // state for up to 3s after it materialized. Returning here costs nothing:
    // adoptMain resets every tracker at the swap frame anyway.
    if (swapTransition.active) return;
    try {
      const fp = mainSessionFile();
      if (!fp) throw new Error('no main session yet');
      const stat = fs.statSync(fp);
      // Every 2s, bypass mtime check to eliminate NTFS 1-second mtime race
      const forceRead = (now - lastForceReadTime > 2000);
      if (forceRead) {
        // Arm a candidate PID only if it's still alive 2.5s after first
        // sighting. On Windows the hook's ppid is a transient cmd.exe shim
        // (dead within ms) — those never validate, so PID rescue silently
        // self-disables and the staleness timeouts below remain the fallback.
        // On Unix (sh -c execs) and for the codex adapters, the reported PID
        // is the long-lived editor/wrapper process and validates normally.
        if (candidatePid && candidatePid !== lastEditorPid
            && now - candidateSince > 2500) {
          // Arm only if the process is alive AND its start time predates the
          // write that reported it — a recycled PID must not arm and later
          // trigger a false editorDead. While start time is still resolving,
          // defer to the next forced read instead of arming blind.
          if (_pidStartStatus(candidatePid) === 'pending'
              && isProcessAlive(candidatePid)) {
            requestPidStartTime(candidatePid); // keep resolution warm; retry next cycle
          } else {
            if (isOwnedByLiveProcess(candidatePid, candidateTs)) {
              lastEditorPid = candidatePid;
              editorDead = false;
            }
            candidatePid = 0;
          }
        }
        // PID liveness check: an armed editor process that died without
        // writing a Stop event (crash, kill) triggers the rescue cascade.
        // Note `lastStopped` now also covers a plain turn end -- readState
        // folds the session file's `turnEnded` into `stopped` -- so an editor
        // that dies while sitting between turns is never seen as editorDead.
        // It is demoted by staleness instead (the policy drops a stale session
        // and picks another), which is the honest reading: a session waiting
        // for its next prompt looks exactly like one whose window was closed.
        if (lastEditorPid && !editorDead && !lastStopped && !RESCUE_EXCLUDE.has(face.state)) {
          if (!isProcessAlive(lastEditorPid)) {
            editorDead = true;
          }
        }
      }
      if (stat.mtimeMs > lastMtime || forceRead) {
        if (forceRead) lastForceReadTime = now;
        lastMtime = stat.mtimeMs;
        const stateData = readState(fp);
        cachedStateData = stateData;

        // Use JSON timestamp (ms precision) for staleness instead of
        // filesystem mtime (NTFS has 1-second granularity, and mtime
        // never updates if Claude is thinking with no tool calls).
        // Skip state older than 2 minutes pre-renderer-start — truly stale.
        const ts = stateData.timestamp || 0;
        const isStartup = (Date.now() - rendererStartTime < 5000);
        if (isStartup) {
          // Don't resurrect dead sessions on fresh renderer start
          if (stateData.stopped) {
            lastStopped = true;
            return;
          }
          // Tighter window: active sessions write every few seconds
          if (ts > 0 && ts < rendererStartTime - 15000) {
            return;
          }
        } else {
          // Normal runtime: 2-minute guard for live session tolerance
          if (ts > 0 && ts < rendererStartTime - 120000) {
            return;
          }
        }

        // The session file's picture of a finished turn is the orbital's
        // "idle / between turns". The main face's is responding -> happy ->
        // idle, so a NEW turn-end write is shown as responding first and the
        // existing cascade does the rest.
        if (stateData.state === 'idle' && stateData.stopped && ts > lastAppliedTimestamp) {
          stateData.state = 'responding';
          stateData.detail = 'wrapping up';
        }

        lastStopped = !!stateData.stopped;
        // Track the writer's PID as a validation candidate (same PID repeated
        // keeps its original sighting time so it can pass the 2.5s window).
        if (stateData.pid && stateData.pid !== lastEditorPid
            && stateData.pid !== candidatePid) {
          candidatePid = stateData.pid;
          candidateSince = Date.now();
          candidateTs = ts || Date.now();
        }
        // A write newer than anything we've applied proves the editor is
        // alive — overrides a false PID death (e.g. PID reuse).
        if (editorDead && ts > lastAppliedTimestamp) editorDead = false;
        // Same proof, kept as a clock: this is the ONLY place the write clock
        // moves forward. No read marker can serve -- lastForceReadTime and its
        // kind are refreshed by every forced re-read of the unchanged file.
        // (A write landing mid-transition is not seen at all: checkState now
        // returns at the top while a swap animates. Nothing is lost -- the
        // swap frame's adoptMain resets this clock for the new session.)
        lastNewWriteAt = noteNewWrite(ts, lastAppliedTimestamp, now, lastNewWriteAt);

        if (ts > lastAppliedTimestamp) {
          lastAppliedTimestamp = ts;
          lastAppliedState = stateData.state;
          // Force-apply stopped state (session ended) — bypass minimum display time
          // so the face doesn't get stuck on "thinking" when Claude is interrupted
          if (stateData.stopped && Date.now() < face.minDisplayUntil) {
            face.minDisplayUntil = Date.now();
          }

          // If PostToolUse includes a workState the renderer missed (PreToolUse
          // was overwritten before we read it), inject the work state first.
          // setState buffering queues the completion state behind it.
          if (ACTIVE_WORK_STATES.has(stateData.workState)
              && COMPLETION_STATES.has(stateData.state)
              && !ACTIVE_WORK_STATES.has(face.state)) {
            face.setState(stateData.workState, stateData.workDetail || '');
          }

          face.setState(stateData.state, stateData.detail);
          face.setStats(stateData);
        }
      }
    } catch {}

    // -- Stopped-flag rescue: runs BEFORE the minDisplayUntil early return --
    // If Stop hook fired (lastStopped=true) but the face is still showing an
    // active/thinking state (either because the file read was missed due to mtime
    // granularity, or because setState buffered 'responding' as pendingState
    // while minDisplayUntil was active), force-transition to 'responding' now.
    // We bypass setState() here to avoid it re-buffering the state.
    // Completion states (happy/satisfied/proud/relieved) are excluded — they
    // already transition to idle via the linger path with sessionActive=false.
    if ((lastStopped || editorDead) && !RESCUE_EXCLUDE.has(face.state)) {
      face.forceState('responding', 'wrapping up', 3000); // respect responding's 3s min display time
    }

    // If we're past minDisplayUntil and in an active state,
    // do a fresh file read to catch any stop/start event missed by fs.watch mtime
    // granularity (common on Windows FAT/NTFS with 1-second mtime resolution).
    if (now >= face.minDisplayUntil &&
        FRESH_READ_STATES.has(face.state) &&
        (face.state === 'thinking' || now - lastForceReadTime > 2000)) {
      try {
        // Explicit, not accidental: with no main session there is no file to
        // re-read. (readState(null) would throw into its own catch and hand
        // back a default idle state, which reads like data but is not.)
        const freshFp = mainSessionFile();
        if (!cachedStateData && !freshFp) throw new Error('no main session yet');
        const freshData = cachedStateData || readState(freshFp);
        const freshTs = freshData.timestamp || 0;
        // Detect stopped transition: false->true only (the primary reset is in the apply block above, plus session adoption)
        const stoppedNow = freshData.stopped || false;
        if (stoppedNow && !lastStopped && freshTs > lastAppliedTimestamp) {
          lastAppliedTimestamp = freshTs;
          lastAppliedState = freshData.state;
          lastStopped = stoppedNow;
          // If the file says responding, apply it; otherwise
          // we just set lastStopped so the rescue block above fires next frame.
          if (freshData.state === 'responding') {
            face.forceState('responding', freshData.detail || 'wrapping up', 3000);
          }
        }
      } catch {}
    }

    // Don't apply timeouts if minimum display time hasn't passed
    if (now < face.minDisplayUntil) return;

    // Session is active until Stop hook fires (writes stopped: true)
    // or the armed editor PID is found dead
    const sessionActive = !lastStopped && !editorDead;

    // Timeout-driven transitions: starting → idle, responding → happy once the
    // session ended, a completion's linger, thinking/idle timeouts, and the
    // degrade-to-thinking fallback — except while the state file still names
    // the same unfinished tool, which holds the work face (face.js escalates
    // its detail line instead).
    // Live subagent orbitals hold the main face at "conducting N" instead of
    // letting it fall idle while agent hooks write only their own files.
    const liveChildren = minimal ? 0 : orbital.liveChildCount();
    const next = idleCascade({
      state: face.state,
      sinceChangeMs: now - face.lastStateChange,
      sessionActive,
      lingerMs: COMPLETION_LINGER[face.state] || 0,
      fileState: lastAppliedState,
      fileAgeMs: lastNewWriteAt ? now - lastNewWriteAt : 0,
      liveChildren,
    });
    if (next === 'subagent' && liveChildren > 0) face.setState(next, `conducting ${liveChildren}`);
    else if (next) face.setState(next);
  }

  let stateWatchThrottled = false;
  let stateWatcher = null;
  let sessionWatcher = null;
  let sessionWatchTimer = null;
  // The main face follows its session file: a change to that file re-reads
  // it at once (leading-edge throttle: first event fires immediately,
  // duplicates within 50ms are suppressed — Windows fs.watch fires multiple
  // events per write). Any other file in the directory reloads the ring below.
  try {
    stateWatcher = fs.watch(SESSIONS_DIR, (eventType, filename) => {
      const mainName = mainSessionId ? safeFilename(mainSessionId) + '.json' : null;
      if (!filename || filename === mainName) {
        if (!stateWatchThrottled) {
          stateWatchThrottled = true;
          checkState();
          setTimeout(() => { stateWatchThrottled = false; }, 50);
        }
      }
    });
    stateWatcher.on('error', (err) => {
      try { process.stderr.write(`[code-crumb] state watcher error: ${err.code || err.message}\n`); } catch {}
    });
  } catch {}

  // Watch sessions directory for session changes. Minimal mode needs the
  // loader too -- it just never draws the ring.
  try {
    sessionWatcher = fs.watch(SESSIONS_DIR, () => {
      if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
      sessionWatchTimer = setTimeout(() => {
        orbital.loadSessionsAsync(mainSessionId);
      }, 80);
    });
    sessionWatcher.on('error', (err) => {
      try { process.stderr.write(`[code-crumb] session watcher error: ${err.code || err.message}\n`); } catch {}
    });
  } catch {}

  // Boot: load every session file, let the policy pick the main, read it.
  orbital.loadSessions(null);
  applyMainPolicy();
  checkState();

  // -- Cleanup (accessible to keypress handler + signal handlers) ----
  function cleanup() {
    writeQuitFlag();
    removePid();
    try { if (stateWatcher) stateWatcher.close(); } catch {}
    try { if (sessionWatcher) sessionWatcher.close(); } catch {}
    if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    process.stdout.write(ansi.syncEnd + ansi.show + ansi.clear + ansi.reset);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}

  // Raw stdin keypress handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function persistPrefs() {
      savePrefs({
        paletteIndex: face.paletteIndex,
        accessoriesEnabled: face.accessoriesEnabled,
        showStats: face.showStats,
        showOrbitals: face.showOrbitals,
      });
    }

    process.stdin.on('data', (key) => {
      if (key === 'q' || key === '\x03') { cleanup(); return; } // q or Ctrl+C
      if (minimal) {
        // Minimal mode: only pet and quit
        if (key === ' ') face.pet();
        return;
      }
      // Help dismiss: any key while help is showing closes it
      if (face.showHelp) { face.showHelp = false; return; }
      // Session list navigation: arrows/j/k move through the rendered order,
      // Enter pins/unpins the main row or pins+promotes any other, anything
      // else dismisses.
      if (face.showSessionList) {
        const ids = face.sessionListIds;
        let idx = ids.indexOf(face.sessionListSelectedId);
        if (idx < 0) idx = 0;
        if (key === '\x1b[A' || key === 'k') {
          face.sessionListSelectedId = ids[Math.max(0, idx - 1)] || null;
        } else if (key === '\x1b[B' || key === 'j') {
          face.sessionListSelectedId = ids[Math.min(ids.length - 1, idx + 1)] || null;
        } else if (key === '\r' || key === '\n') {
          const sel = face.sessionListSelectedId;
          if (sel && sel === mainSessionId) {
            pinnedSessionId = pinnedSessionId === mainSessionId ? null : mainSessionId;
          } else if (sel) {
            face.sessionListPromote = sel;
          }
          face.showSessionList = false;
          face.sessionListSelectedId = null;
        } else {
          face.showSessionList = false;
          face.sessionListSelectedId = null;
        }
        return;
      }
      if (key === ' ') face.pet();
      else if (key === 't' && !isNoColor()) { face.cycleTheme(); persistPrefs(); }
      else if (key === 's') { face.toggleStats(); persistPrefs(); }
      else if (key === 'a') { face.toggleAccessories(); persistPrefs(); }
      else if (key === 'o') { face.toggleOrbitals(); persistPrefs(); }
      else if (key === 'l') face.toggleSessionList();
      else if (key === 'h' || key === '?') face.toggleHelp();
    });
  }

  let prevFrame = null;  // last frame written; loop() skips identical frames
  process.stdout.on('resize', () => {
    // Force-complete swap on resize to avoid ghost artifacts
    if (swapTransition.active) {
      _executeSwap();
      swapTransition.cancel();
    }
    face.particles.fadeAll(5);
    prevFrame = null;  // the screen is about to be cleared -- force the next frame out even if identical
    process.stdout.write(ansi.syncEnd + ansi.clear);
  });

  // Execute the actual main↔orbital swap (called on 'swap' frame or forced by resize)
  function _executeSwap() {
    const newId = swapTransition.toId;
    if (!newId) return;

    // Both sessions already own their files: the old main reappears on the
    // ring at the next load, the new main is read from its file right here.
    adoptMain(newId);
    try {
      const newData = readState(mainSessionFile());
      const ts = newData.timestamp || 0;
      if (ts > 0) {
        lastAppliedTimestamp = ts;
        // Seed the write clock from the write itself. adoptMain zeroed it, and
        // later reads of this same write are not "new", so without this the
        // WAIT_HOLD_STALE_MS bound could never fire on a face swapped in while
        // already waiting.
        lastNewWriteAt = ts;
        lastAppliedState = newData.state;
        lastStopped = !!newData.stopped;
        // forceState, not setState: a materialized face must show its own
        // session at once. Any leftover minDisplayUntil belongs to the session
        // that just left, and setState would buffer this behind it. No third
        // argument, so the new state's own table minimum applies from here.
        face.forceState(newData.state || 'idle', newData.detail || '');
        face.setStats(newData);
      }
    } catch {
      // No readable file yet: the id is adopted and checkState reads it next cycle
    }

    // Spawn celebration particles
    face.particles.spawn(8, 'sparkle');
    face.particles.spawn(4, 'push');

    // Reload orbital sessions
    orbital.loadSessions(mainSessionId);
  }

  let lastTime = Date.now();
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    face.update(dt);
    orbital.update(dt);

    // -- Transition tick --
    if (swapTransition.active) {
      const result = swapTransition.tick();
      if (result.phase === 'dissolve') {
        // Spawn glitch particles during dissolve
        if (swapTransition.frame === 1) face.particles.fadeAll();
        if (swapTransition.frame % 2 === 0) face.particles.spawn(2, 'glitch');
      } else if (result.phase === 'swap') {
        _executeSwap();
      } else if (result.phase === 'materialize') {
        if (swapTransition.frame % 3 === 0) face.particles.spawn(1, 'stream');
      }
    }

    // -- Manual promotion from session list: pin it; the policy swaps. --
    if (face.sessionListPromote !== null) {
      if (face.sessionListPromote !== mainSessionId && orbital.faces.has(face.sessionListPromote)) {
        pinnedSessionId = face.sessionListPromote;
      }
      face.sessionListPromote = null;
    }

    // Periodically reload sessions
    if (orbital.frame % (FPS * 2) === 0) orbital.loadSessionsAsync(mainSessionId);

    // Periodically rescan team configs (~every 10s)

    if (face.frame % Math.floor(FPS / 2) === 0) checkState();

    // Tell face how many subagents are active (for status line)
    face.subagentCount = orbital.getSortedFaces().length;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    // The ring is drawn first so the main face layers over it: an orbital
    // drifting behind a thought bubble is occluded instead of being shoved
    // out of the way (that shove was a visible teleport every time).
    let faceOut = '';
    try {
      faceOut = face.render();
    } catch {}
    let out = '';
    if (!minimal && face.showOrbitals && face.lastPos) {
      const paletteThemes = (PALETTES[face.paletteIndex] || PALETTES[0]).themes;
      try {
        out += orbital.render(cols, rows, face.lastPos, paletteThemes);
      } catch {}
    }
    out += faceOut;

    // Apply transition dim to face output
    if (swapTransition.active) {
      out = dimAnsiOutput(out, swapTransition.dimFactor());
    }

    // Session list overlay (drawn on top of orbital, not dimmed)
    if (!minimal && face.showSessionList) {
      const paletteThemes = (PALETTES[face.paletteIndex] || PALETTES[0]).themes;
      const mainFace = mainSessionId ? orbital.faces.get(mainSessionId) : null;
      const mainInfo = mainSessionId ? {
        sessionId: mainSessionId,
        state: face.state,
        detail: face.stateDetail,
        cwd: face.cwd,
        gitBranch: face.gitBranch,
        label: face.modelName || 'claude',
        editor: face.editor || '',
        // Without this the main row is the one row in the list with no model
        // segment, while every orbital below it has one.
        model: face.model || '',
        stopped: lastStopped,
        isMain: true,
        isPinned: pinnedSessionId === mainSessionId,
        toolCalls: face.toolCallCount,
        filesEdited: face.filesEditedCount,
        lastUpdate: lastNewWriteAt,
        taskDescription: mainFace ? mainFace.taskDescription : '',
        agentType: mainFace ? mainFace.agentType : '',
        parentSession: mainFace ? mainFace.parentSession : null,
        isTeammate: mainFace ? mainFace.isTeammate : false,
        teamName: mainFace ? mainFace.teamName : '',
      } : null;
      const entries = orderSessionList(mainInfo, orbital.getSortedFaces());
      // Every entry is drawn; only the live ones can be selected.
      face.sessionListIds = listNavigableIds(entries);
      if (!face.sessionListIds.includes(face.sessionListSelectedId)) {
        face.sessionListSelectedId = face.sessionListIds[0] || null;
      }
      try { out += renderSessionList(cols, rows, entries, paletteThemes, mainInfo, face.sessionListSelectedId); } catch {}
    }

    // Update terminal title bar to reflect current state. A wait the user has
    // not answered for a while blinks the title (~0.5s each way at 15 FPS) so a
    // backgrounded terminal still asks for attention.
    const _pal = PALETTES[face.paletteIndex] || PALETTES[0];
    const _status = (_pal.themes[face.state] || _pal.themes.idle).status;
    const flash = face.waitEscalated() && Math.floor(face.frame / 8) % 2 === 0;
    const _title = buildTitle(face.model || face.modelName, _status, flash);

    // The title is part of the frame: a blink with identical body still needs
    // writing, so dedupe on both.
    const frameKey = _title + out;
    if (frameKey === prevFrame) {
      setTimeout(loop, FRAME_MS);
      return;
    }
    prevFrame = frameKey;
    process.stdout.write(ansi.syncStart + _title + ansi.home + ansi.clearBelow + out + ansi.syncEnd);
    setTimeout(loop, FRAME_MS);
  }

  loop();
}

// -- tmux status line mode -----------------------------------------
// Lightweight poll loop that writes a compact one-line status to a file
// readable via #(cat ~/.code-crumb-tmux) in tmux status-line config.
//
// Usage in .tmux.conf:
//   set -g status-right "#(cat ~/.code-crumb-tmux)"
//
// Start with: node renderer.js --tmux  (or: npm run tmux)
// No PID guard — can run alongside the full-face renderer.

const TMUX_POLL_MS = 2000;

function runTmuxMode() {
  const defaultThemes = PALETTES[0].themes;

  function writeTmuxStatus() {
    try {
      const data = readState();
      const state = data.state || 'idle';
      const theme = defaultThemes[state] || defaultThemes.idle;
      const emoji = theme.emoji || '';
      const status = theme.status || state;
      const model = data.model || data.modelName || process.env.CODE_CRUMB_MODEL || 'claude';
      const branch = data.gitBranch || getGitBranch() || '';
      const streak = data.streak || 0;

      let line = `${emoji} ${status} [${model}]`;
      if (branch) line += ` [${branch}]`;
      if (streak > 0) line += ` \uD83D\uDD25${streak}`;

      fs.writeFileSync(TMUX_FILE, line, 'utf8');
    } catch {}
  }

  // Write initial status immediately
  writeTmuxStatus();

  // Poll on interval
  const timer = setInterval(writeTmuxStatus, TMUX_POLL_MS);

  function cleanup() {
    clearInterval(timer);
    try { fs.unlinkSync(TMUX_FILE); } catch {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(TMUX_FILE); } catch {} });
}

// -- Entry ---------------------------------------------------------
function main() {
  const tmuxMode = process.argv.includes('--tmux');

  // Skip PID guard for tmux mode — can run alongside full renderer
  if (!tmuxMode) {
    // Clear quit flag on normal startup so autolaunch works for new sessions
    clearQuitFlag();
    if (isAlreadyRunning()) {
      console.log('Code Crumb is already running in another window.');
      process.exit(0);
    }
    writePid();
  }

  // NO_COLOR compliance (https://no-color.org)
  if (process.env.NO_COLOR !== undefined || process.argv.includes('--no-color')) {
    setNoColor(true);
  }

  if (tmuxMode) {
    runTmuxMode();
    return;
  }

  // Signal handlers are registered inside runUnifiedMode() — just
  // ensure PID cleanup on early exit before we reach that point.
  process.on('exit', removePid);

  process.stdout.write(ansi.hide + ansi.clear);
  process.stdout.write(`\x1b]0;Code Crumb\x07`);

  runUnifiedMode();
}

// -- Module exports (for testing) / Entry ----------------------------
if (require.main === module) {
  main();
} else {
  module.exports = {
    ClaudeFace, MiniFace, OrbitalSystem, ParticleSystem,
    lerpColor, dimColor, breathe,
    themes, mouths, eyes, gridMouths,
    COMPLETION_LINGER, TIMELINE_COLORS, SPARKLINE_BLOCKS,
    IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
    PALETTES, PALETTE_NAMES,
    readState, ACTIVE_WORK_STATES, COMPLETION_STATES, FRESH_READ_STATES,
    idleCascade, buildTitle, noteNewWrite, pickMainSession,
    IDLE_TIMEOUT, THINKING_TIMEOUT, SLEEP_TIMEOUT,
    LONG_TOOL_HOLD_MS, WAIT_HOLD_STALE_MS,
  };
}
