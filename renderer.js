#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb -- A terminal tamagotchi for AI coding assistants  |
// |  Shows what your AI coding assistant is doing                  |
// |  Subagent mini-faces orbit the main face as satellites         |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR, TMUX_FILE, loadPrefs, savePrefs, getGitBranch, QUIT_FLAG_FILE, safeFilename, detailText, isRendererAlive, PID_HEARTBEAT_MS } = require('./lib/shared');

// -- Modules -------------------------------------------------------
const {
  ansi, lerpColor, dimColor, breathe, dimAnsiOutput,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES, normalizePaletteIndex,
  setNoColor, isNoColor, knownState,
} = require('./lib/themes');
const { mouths, eyes, gridMouths } = require('./lib/animations');
const { ParticleSystem } = require('./lib/particles');
// monoNow is the face's monotonic clock (see face.js, Clock). The renderer
// measures its own durations on it too -- the boot window, the forced-read
// interval, PID arming, the frame deadlines -- and keeps Date.now() for what is
// compared against a file's JSON timestamp or an mtime.
const { ClaudeFace, monoNow, cleanMilestone } = require('./lib/face');
const { MiniFace, OrbitalSystem, renderSessionList, orderSessionList, listNavigableIds, isProcessAlive, isOwnedByLiveProcess, requestPidStartTime, _pidStartStatus, sessionListFits } = require('./lib/grid');
const { SwapTransition } = require('./lib/transition');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, '.code-crumb.pid');
const FPS = 15;
// The exact step, 66.67ms, not a rounded timeout: frames are scheduled
// against deadlines (nextFrameDeadline). Re-arming setTimeout(66) after each
// frame's work ran at ~12.9 fps on Windows, whose timers tick every 15.6ms.
const FRAME_INTERVAL_MS = 1000 / FPS;
// A resting face with nothing else moving (canRestLowPower) draws at this
// rate instead: a sleeping face redrew ~99% of frames at 15 fps (the border
// breathes every frame) -- ~23 KB/s of terminal output, ~2 GB a day, while
// nobody was working. Any watcher event, key or resize wakes the loop at once.
const LOW_POWER_FPS = 4;
const LOW_POWER_FRAME_MS = 1000 / LOW_POWER_FPS;
// The loop's polls are timed, not counted in frames, so they keep their
// cadence at either rate: checkState every ~467ms (what `frame % 7` was at
// 15 fps), the session reload and the watcher's health check every 2s.
const STATE_POLL_MS = 1000 * Math.floor(FPS / 2) / FPS;
const SESSION_POLL_MS = 2000;
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
const { ACTIVE_WORK_STATES, COMPLETION_STATES } = require('./lib/shared');
// States the stopped/dead rescue must leave alone. `error` is here because it
// decays by itself (idleCascade takes a non-active error to idle after
// IDLE_TIMEOUT) and is the one face that must never be skipped: a late
// PostToolUseFailure arriving after Stop writes error + turnEnded, and without
// this the rescue replaced "hit a snag" with responding -> done! on the same
// tick, before its 4000ms minimum was ever drawn.
const RESCUE_EXCLUDE = new Set(['idle', 'sleeping', 'responding', 'starting', 'happy', 'satisfied', 'proud', 'relieved', 'error']);

// Pure: should the stopped/dead rescue force the face to responding now?
// Not while conducting (`liveChildren` agents still running): after the
// parent's Stop, idleCascade's conducting hold turns the resting face into
// `subagent` for as long as a background agent runs, and rescuing that sent it
// round responding -> done! -> conducting -> responding every ~12s for the
// agent's whole life. A dead editor is still rescued -- its agents are not
// really running.
function needsRescue(face, lastStopped, editorDead, liveChildren = 0) {
  if (face.state === 'subagent' && !editorDead && liveChildren > 0) return false;
  return !!((lastStopped || editorDead) && !RESCUE_EXCLUDE.has(face.state));
}

// -- Permission prompts ----------------------------------------------
// Allowing a permission prompt fires no hook: the tool simply starts, and its
// PostToolUse can be minutes away. So Pre(npm test) -> PermissionRequest ->
// "allow" -> a 2-minute test run showed the escalating wait and flashed
// "WAITING FOR YOU" in the title for the whole run. Claude Code does give one
// signal (checked in the 2.1.300 binary): it fires the `Notification` hook
// with notification_type `permission_prompt` 6000ms after a permission dialog
// appears, and cancels that timer when the user answers first (a denial fires
// its own PermissionDenied hook). So the hook marks a Claude Code permission
// wait `waitConfirmed: false`, and rewrites it `true` when that Notification
// lands; one still unconfirmed this long after its own write was answered --
// allowed -- and its tool (`permState` / `permDetail`) is running.
// Only for that contract: a confirmed wait, a wait without the fields (an
// older hook), and every other editor (Codex has no Notification hook at all)
// keep waiting exactly as before.
// PERMISSION_CONFIRM_MS: 8s, the 6s timer plus slack. PERMISSION_TOOL_STATES:
// what an answered prompt may turn into, the asking tool's own face -- one
// set with the orbitals (grid.js), in shared.js.
const { PERMISSION_CONFIRM_MS, PERMISSION_TOOL_STATES } = require('./lib/shared');

// Pure: a Claude Code permission wait its 6s Notification has not confirmed.
// `waitConfirmed` must be an explicit false -- anything else is a wait this
// contract does not describe, and it keeps today's behaviour.
function isUnconfirmedPermission(write) {
  return !!write && write.state === 'waiting' && write.waitKind === 'permission'
    && write.waitConfirmed === false && write.editor === 'claude'
    && PERMISSION_TOOL_STATES.has(write.permState);
}

// Pure: has that wait gone unconfirmed long enough to have been answered?
// Measured from the write's own timestamp, so a renderer that only sees the
// wait late (a boot, a swap) does not make the user wait again.
function permissionAnswered(write, now) {
  if (!isUnconfirmedPermission(write)) return false;
  const ts = write.timestamp || 0;
  return ts > 0 && now - ts >= PERMISSION_CONFIRM_MS;
}

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
function idleCascade({ state, sinceChangeMs, sessionActive, lingerMs, fileState, fileAgeMs, liveChildren = 0, fileWaiting = false }) {
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
  // (`fileWaiting`: the file's last write still names a permission prompt
  // not yet answered -- a wait kept through a later error is still owed.)
  if (state === 'waiting' && (fileState === 'waiting' || fileWaiting)) {
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
  return isNewerWrite(ts, lastTs, now) ? now : lastAt;
}

// Whether a write is newer than the last one applied. Normally its timestamp
// must be greater -- parallel hooks can land out of order, and the older one
// must not overwrite the newer. But a timestamp from the future (a clock that
// stepped back: NTP, a resumed VM) froze the face: nothing written afterwards
// was "newer" until the wall clock caught up, possibly hours. Once the last
// applied write is from the future, any write with a different stamp is new.
const FUTURE_SLACK_MS = 60000;
function isNewerWrite(ts, lastTs, now = Date.now()) {
  return ts > lastTs || (lastTs > now + FUTURE_SLACK_MS && ts !== lastTs && ts > 0);
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

// What the title was before the renderer touched it is pushed on start-up
// (XTPUSHTITLE) and popped on exit (XTPOPTITLE). A terminal without a title
// stack ignores both, so an empty OSC 0 goes first: Windows Terminal then
// shows the profile's own title again. Quitting used to leave the last frame's
// title on the tab -- mid-flash, "WAITING FOR YOU" for good.
const TITLE_PUSH = '\x1b[22;0t';
const TITLE_RESET = '\x1b]0;\x07\x1b[23;0t';
// Everything the renderer changed about the terminal, undone: synchronized
// output ended, the cursor shown again, the screen cleared, attributes and
// the title reset. (Raw mode is the caller's: it belongs to stdin.)
const TERMINAL_RESTORE = ansi.syncEnd + ansi.show + ansi.clear + ansi.reset + TITLE_RESET;

// -- Policy input ------------------------------------------------------
// Pure (apart from pruning `deadSessions`, which it owns): project the orbital
// loader's faces into pickMainSession's input.
//
// The renderer knows one thing no file says: that a session's armed editor PID
// died. While that session is main, `editorDead` carries it -- but adoptMain
// clears editorDead the moment the center moves away, and a crashed session's
// MiniFace is neither stopped (no Stop was written) nor stale for another ~90s.
// It then looked live again and won the center straight back on attention,
// showing its last, frozen "writing code". `deadSessions` (id -> the JSON
// timestamp of the newest write seen when it died) remembers the death after
// the swap: the session is projected as stopped until it writes something
// newer (a resumed editor), and the entry is dropped once the session's file
// is gone.
//
//   faces        iterable of MiniFace-like objects
//   mainId       the session on screen now
//   editorDead   the main's armed PID is known dead
//   deadSessions Map<id, deathTimestamp>, pruned in place
function policySessions(faces, { mainId, editorDead, deadSessions }) {
  const sessions = [];
  const seen = new Set();
  for (const f of faces) {
    seen.add(f.sessionId);
    let dead = f.sessionId === mainId && !!editorDead;
    if (deadSessions && deadSessions.has(f.sessionId)) {
      if ((f._lastDataTimestamp || 0) > deadSessions.get(f.sessionId)) deadSessions.delete(f.sessionId);
      else dead = true;
    }
    sessions.push({
      id: f.sessionId, parentSession: f.parentSession, isTeammate: f.isTeammate,
      stopped: !!f.stopped || dead,
      stale: f.isStale(), attentionAt: f.lastPromptAt || 0, lastUpdate: f.lastUpdate,
    });
  }
  if (deadSessions) {
    for (const id of [...deadSessions.keys()]) if (!seen.has(id)) deadSessions.delete(id);
  }
  return sessions;
}

// -- Keypress tokenizer ---------------------------------------------------
// Pure: split one stdin chunk into individual keys. A terminal delivers
// several keys in one chunk whenever they arrive faster than the event loop
// drains them -- a held arrow key ('\x1b[B\x1b[B'), a fast double tap ('qq'),
// a paste -- and comparing the whole chunk to a single key matched none of
// them (a held arrow in the session list fell through to "any other key" and
// closed the list). CSI sequences (ESC [ params final) and SS3 sequences
// (ESC O x) stay whole; everything else is one code point per token.
function splitKeys(chunk) {
  const chars = Array.from(String(chunk == null ? '' : chunk));
  const keys = [];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\x1b' && chars[i + 1] === '[') {
      let j = i + 2;
      // Parameter (0x30-0x3F) and intermediate (0x20-0x2F) bytes, then one
      // final byte (0x40-0x7E). A sequence cut off mid-chunk keeps what it has.
      while (j < chars.length) {
        const code = chars[j].charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) { j++; break; }
        if (code < 0x20 || code > 0x3f) break;
        j++;
      }
      keys.push(chars.slice(i, j).join(''));
      i = j;
    } else if (c === '\x1b' && chars[i + 1] === 'O' && i + 2 < chars.length) {
      keys.push(chars.slice(i, i + 3).join(''));
      i += 3;
    } else {
      keys.push(c);
      i++;
    }
  }
  return keys;
}

// -- tmux decay -------------------------------------------------------------
// Pure: which state should the tmux status line show for a global-file read?
// The full renderer runs idleCascade; tmux mode used to print whatever the file
// last said, forever -- a crashed or finished session read "writing code" in
// the status bar all night. The same bounds, simplified for a 2s poll:
//   - waiting is held (an idle_prompt arrives after Stop) until the write is
//     WAIT_HOLD_STALE_MS old
//   - a finished turn keeps its last face for IDLE_TIMEOUT, then rests
//   - a tool call is held for LONG_TOOL_HOLD_MS, anything else for
//     THINKING_TIMEOUT, then idle
// A missing timestamp is treated as fresh, like noteNewWrite's 0. A Claude
// Code permission wait left unconfirmed was allowed (permissionAnswered), so
// it reads as the asking tool, held like any other.
function tmuxDisplayState(data, now) {
  let state = (data && data.state) || 'idle';
  const ts = (data && data.timestamp) || 0;
  const age = ts ? now - ts : 0;
  if (state === 'waiting' && permissionAnswered(data, now)) state = data.permState;
  else if (state === 'waiting') return age > WAIT_HOLD_STALE_MS ? 'idle' : 'waiting';
  if (data && data.stopped) return age > IDLE_TIMEOUT ? 'idle' : state;
  const limit = (ACTIVE_WORK_STATES.has(state) && state !== 'responding') ? LONG_TOOL_HOLD_MS : THINKING_TIMEOUT;
  return age > limit ? 'idle' : state;
}

// Pure: the one line tmux mode writes for a global-file read. The branch is
// the session's own: `getGitBranch()` with no argument walks up from
// process.cwd(), so a write without a gitBranch showed the branch of
// whichever repo the tmux renderer happened to be started in. No cwd, no
// branch. `branchOf` is getGitBranch, injectable for tests.
function tmuxStatusLine(data, now, branchOf = getGitBranch) {
  const defaultThemes = PALETTES[0].themes;
  const state = tmuxDisplayState(data, now);
  const theme = defaultThemes[state] || defaultThemes.idle;
  const emoji = theme.emoji || '';
  const status = theme.status || state;
  const model = data.model || data.modelName || process.env.CODE_CRUMB_MODEL || 'claude';
  let branch = data.gitBranch || '';
  if (!branch && data.cwd) {
    try { branch = detailText(branchOf(data.cwd) || ''); } catch { branch = ''; }
  }
  const streak = data.streak || 0;

  let line = `${emoji} ${status} [${model}]`;
  if (branch) line += ` [${branch}]`;
  if (streak > 0) line += ` \uD83D\uDD25${streak}`;
  return line;
}

// -- Startup gate -----------------------------------------------------------
// Pure: what the main face does with a write read at time `now`, given when
// the renderer started. Returns 'apply', 'skip' (ignore, look again next read)
// or 'record' (never show it, but mark it applied so it cannot come back).
//   - During the first STARTUP_WINDOW_MS a turn that finished BEFORE the
//     renderer started, or a live write more than STARTUP_STALE_MS older than
//     the renderer, is 'record': a fresh renderer must not resurrect a session
//     that went quiet before it started. It used to be a plain skip, so the
//     same old write read as "new" the moment the window closed and was
//     applied after all (a finished turn as responding -> done!, a stale one
//     as whatever tool it last named). A turn that ends after the start is
//     news, though: a StopFailure or an Interrupt at t+2s used to be recorded
//     and never shown, and its error was rescued into "done!".
//   - After that window only writes from more than RUNTIME_STALE_MS before
//     the renderer started are skipped.
// `uptimeMs` is how long the renderer has run, on the monotonic clock. The
// window used to be `now - rendererStartTime`, so after the wall clock stepped
// back the renderer was "booting" for as long as the step, and recorded every
// live write instead of showing it. The renderer also passes the start
// re-expressed on the current wall clock (`now - uptimeMs`), so a step cannot
// make every fresh write look older than the renderer either. Omitted, it is
// derived from the wall clock as before.
const STARTUP_WINDOW_MS = 5000;
const STARTUP_STALE_MS = 15000;
const RUNTIME_STALE_MS = 120000;

function startupGate(ts, stopped, now, rendererStartTime, uptimeMs = now - rendererStartTime) {
  if (uptimeMs < STARTUP_WINDOW_MS) {
    if (stopped && !(ts >= rendererStartTime)) return 'record';
    if (ts > 0 && ts < rendererStartTime - STARTUP_STALE_MS) return 'record';
    return 'apply';
  }
  if (ts > 0 && ts < rendererStartTime - RUNTIME_STALE_MS) return 'skip';
  return 'apply';
}

// -- Shared runtime -------------------------------------------------

// Read one state file into the shape the main face consumes. The unified
// renderer passes the main session's own file; tmux mode keeps the global
// file. A session file marks a finished turn with `turnEnded` (its `stopped`
// means the session ended, which the orbitals need to tell apart); for the
// main face both simply mean "the turn is over", so they fold into `stopped`.
//
// A read that yields no data -- a missing or unreadable file (EPERM while a
// writer holds it on Windows), an empty or torn one, JSON that is not an
// object -- returns `failed: true` (with an idle state, for callers that only
// look at that). It is not a picture of the session: checkState used to apply
// it, and a torn read between turns set lastStopped false and made the
// session "active" again -- with the armed editor dead by then, the death
// check replayed responding -> done!.
function readFailed() {
  return { state: 'idle', detail: '', failed: true };
}

// Counters are numbers or nothing: a string reached the stats rows and the
// session list as written, escape sequences and all.
function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// The keys are real Edit basenames (update-state.js counts path.basename of
// every edit), and a file name may hold anything the filesystem allows -- ESC,
// an OSC title sequence, a newline. The idle thought "back to <name>
// again..." printed the key raw, straight into the frame. Keys are cut to one
// printable line, a key with nothing printable left is dropped, and the map
// has no prototype, so a file called `__proto__` is just a file.
function cleanFrequentFiles(ff) {
  const out = Object.create(null);
  if (!ff || typeof ff !== 'object' || Array.isArray(ff)) return out;
  let kept = 0;
  for (const [k, v] of Object.entries(ff)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const key = detailText(k).trim();
    if (!key) continue;
    out[key] = Math.max(out[key] || 0, v);
    if (++kept >= 200) break;
  }
  return out;
}

// `{added, removed}` line counts, or nothing.
function cleanDiff(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { added: n(d.added), removed: n(d.removed) };
}

function readState(filePath = STATE_FILE) {
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return readFailed();
    data = JSON.parse(raw);
  } catch {
    return readFailed();
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return readFailed();
  try {
    // Text fields are one-line strings, whatever the file holds (see
    // MiniFace.updateFromFile); a state outside the table is idle.
    const text = (v) => detailText(typeof v === 'string' ? v : '');
    return {
      state: knownState(data.state),
      detail: detailText(data.detail),
      timestamp: finiteNum(data.timestamp),
      sessionId: text(data.sessionId) || text(data.session_id),
      modelName: text(data.modelName),
      model: text(data.model),
      toolCalls: finiteNum(data.toolCalls),
      filesEdited: finiteNum(data.filesEdited),
      sessionStart: finiteNum(data.sessionStart),
      streak: finiteNum(data.streak),
      bestStreak: finiteNum(data.bestStreak),
      brokenStreak: finiteNum(data.brokenStreak),
      brokenStreakAt: finiteNum(data.brokenStreakAt),
      milestone: cleanMilestone(data.milestone),
      diffInfo: cleanDiff(data.diffInfo),
      dailySessions: finiteNum(data.dailySessions),
      dailyCumulativeMs: finiteNum(data.dailyCumulativeMs),
      frequentFiles: cleanFrequentFiles(data.frequentFiles),
      stopped: !!(data.stopped || data.turnEnded),
      // The session itself is over (SessionEnd), not just its turn.
      sessionEnded: !!data.stopped,
      // The turn is over but the face is one the rescue would replace (a
      // wait, a /compact between turns): not active, never rescued.
      turnOver: !!data.turnOver && !(data.stopped || data.turnEnded),
      cwd: text(data.cwd) || null,
      isWorktree: !!data.isWorktree,
      gitBranch: text(data.gitBranch) || null,
      commitCount: finiteNum(data.commitCount),
      isSessionStart: !!data.isSessionStart,
      workState: data.workState ? knownState(data.workState, null) : null,
      workDetail: detailText(data.workDetail),
      workSince: finiteNum(data.workSince),
      answered: !!data.answered,
      waitingOn: !!data.waitingOn,
      compacting: !!data.compacting,
      // A permission wait (see Permission prompts): which kind of wait, whether
      // the 6s Notification has confirmed it (a strict boolean, or null when
      // the write does not say), and the asking tool's own face.
      waitKind: text(data.waitKind),
      waitConfirmed: typeof data.waitConfirmed === 'boolean' ? data.waitConfirmed : null,
      permState: data.permState ? knownState(data.permState, null) : null,
      permDetail: detailText(data.permDetail),
      pid: Number.isInteger(data.pid) && data.pid > 0 ? data.pid : 0,
      editor: text(data.editor),
      lastPromptAt: finiteNum(data.lastPromptAt),
    };
  } catch {
    return readFailed();
  }
}

// -- PID guard -----------------------------------------------------
// The shared rule (shared.js isRendererAlive): a PID file without a fresh
// heartbeat is a dead renderer's, whatever process now has that PID.
function isAlreadyRunning() {
  return isRendererAlive(PID_FILE);
}

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
}

// The heartbeat refreshes the PID file's mtime -- it never rewrites it: a
// hook reading the file mid-rewrite saw it empty, took the renderer for
// dead, and opened a window that said "already running". A file naming some
// other renderer is left alone; a missing one is written again.
let lastBeat = 0;
function heartbeat(now = Date.now()) {
  lastBeat = now;
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() !== String(process.pid)) return;
    const t = new Date(now);
    fs.utimesSync(PID_FILE, t, t);
  } catch (e) {
    if (e && e.code === 'ENOENT') writePid();
  }
}

let heartbeatFromLoop = false;  // set once this renderer owns the PID file

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function clearQuitFlag() {
  try { fs.unlinkSync(QUIT_FLAG_FILE); } catch {}
}

function writeQuitFlag() {
  try { fs.writeFileSync(QUIT_FLAG_FILE, String(Date.now()), 'utf8'); } catch {}
}

// -- Sessions-directory watcher ----------------------------------------
// One fs.watch handle on the sessions folder, fanned out by the caller, and
// self-healing. Deleting the folder under a live watcher on win32 (Node 22)
// does not raise `error`: it fires an endless stream of `rename` events whose
// filename is the folder's own full path (`\\?\C:\...\.code-crumb-sessions`)
// -- 450,000 events in 2s, a whole core, until restart -- and the handle keeps
// streaming even after a hook has recreated the folder, so nothing in it is
// ever seen again. Each of the two handles the renderer used to keep did that.
// So an event whose filename is not a plain basename, a `rename` after which
// the folder is gone, or an `error` closes the handle, and it is re-opened
// with a backoff once the folder exists again (creating it if need be -- the
// hooks create it anyway). `check()` is the periodic health check, for a
// platform that reports a vanished folder by saying nothing at all.
//   onEvent(eventType, filename)  a change in the folder (filename may be null)
//   onReopen()                    a handle came back: events were missed
// fs.watch, fs.existsSync, mkdir and the timers are injectable for tests.
const WATCH_RETRY_MS = 500;
const WATCH_RETRY_MAX_MS = 8000;

function isPlainBasename(name) {
  return typeof name === 'string' && name.length > 0
    && !/[\\/]/.test(name) && name !== '.' && name !== '..';
}

function createDirWatcher({
  dir, onEvent, onReopen,
  watch = fs.watch, exists = fs.existsSync,
  mkdir = (d) => fs.mkdirSync(d, { recursive: true }),
  schedule = setTimeout, cancel = clearTimeout,
  retryMs = WATCH_RETRY_MS, maxRetryMs = WATCH_RETRY_MAX_MS,
}) {
  let handle = null;
  let retryTimer = null;
  let delay = retryMs;
  let opened = 0;
  let closed = false;

  function open() {
    retryTimer = null;
    if (closed) return;
    let h = null;
    try {
      if (!exists(dir)) mkdir(dir);
      h = watch(dir, (eventType, filename) => onRaw(h, eventType, filename));
      if (h && typeof h.on === 'function') h.on('error', () => broken(h));
    } catch {
      if (h) { try { h.close(); } catch {} }
      retry();
      return;
    }
    handle = h;
    if (++opened > 1 && onReopen) { try { onReopen(); } catch {} }
  }

  function retry() {
    if (closed || retryTimer) return;
    retryTimer = schedule(open, delay);
    delay = Math.min(maxRetryMs, delay * 2);
  }

  function broken(h) {
    if (!h || h !== handle) return;   // a late event from a handle already closed
    handle = null;
    try { h.close(); } catch {}
    retry();
  }

  function onRaw(h, eventType, filename) {
    if (closed || !h || h !== handle) return;
    const name = filename == null ? null : String(filename);
    if (name !== null && !isPlainBasename(name)) { broken(h); return; }
    if (eventType === 'rename' && !exists(dir)) { broken(h); return; }
    delay = retryMs;   // healthy again: the next break starts the backoff afresh
    try { onEvent(eventType, name); } catch {}
  }

  function check() {
    if (closed) return;
    if (handle && !exists(dir)) broken(handle);
    else if (!handle) retry();
  }

  function close() {
    closed = true;
    if (retryTimer) { try { cancel(retryTimer); } catch {} retryTimer = null; }
    if (handle) {
      const h = handle;
      handle = null;
      try { h.close(); } catch {}
    }
  }

  open();
  return { check, close, isOpen: () => !!handle };
}

// -- Frame pacing -----------------------------------------------------
// Pure: the deadline of the next frame, given the last one's. Frames run on
// deadlines a fixed interval apart, so a late timer (Windows ticks every
// 15.6ms) is made up on the next frame instead of being added to every frame.
// Fallen behind by more than a whole frame -- a long GC, a suspended laptop, a
// slow terminal -- the schedule restarts from `now` rather than bursting
// through every frame it missed.
function nextFrameDeadline(prevDeadline, now, interval) {
  const next = prevDeadline + interval;
  return next < now - interval ? now : next;
}

// Pure: may the next frame wait LOW_POWER_FRAME_MS? Only while the main face
// rests (idle or sleeping, nothing queued) and nothing else on screen moves:
// no transition, no open overlay, no busy orbital, no pet reaction, no blink
// or glitch under way, and no particles beyond the resting face's own slow
// drift (idle's float, sleeping's zzz -- both spawn every 30-40 frames and
// live for up to 180, so "no particles at all" would never once be true; at
// 4 fps they drift just as slowly, and as seldom).
const RESTING_STATES = new Set(['idle', 'sleeping']);
const AMBIENT_PARTICLES = new Set(['float', 'zzz']);
function canRestLowPower(face, { transitionActive = false, orbitalsBusy = false } = {}) {
  if (!face || !RESTING_STATES.has(face.state) || face.pendingState) return false;
  if (transitionActive || orbitalsBusy) return false;
  if (face.showHelp || face.showSessionList) return false;
  if (face.petTimer > 0 || face.petSpamActive || face.petAfterglowTimer > 0) return false;
  if (face.blinkFrame >= 0 || face.glitchIntensity > 0 || face.milestoneShowTime > 0) return false;
  const ps = (face.particles && face.particles.particles) || [];
  return ps.every((p) => AMBIENT_PARTICLES.has(p.style));
}

// -- Unified mode (main face + orbital subagents) ------------------
// `opts` are seams for the test suite; the renderer itself passes none.
//   sessionsDir      the folder the main face and the ring follow
//   watch            fs.watch, handed to createDirWatcher
//   schedule/cancel  setTimeout/clearTimeout, for every timer the runtime owns
//   write            where frames and the terminal restore go
//   exit             process.exit
//   installHandlers  false: no signal, crash, stdin or resize listeners
//   start            false: build everything, boot the face, run no frame
// It returns a handle on the running closure for the same tests.
function runUnifiedMode(opts = {}) {
  const {
    sessionsDir = SESSIONS_DIR,
    watch = fs.watch,
    schedule = setTimeout,
    cancel = clearTimeout,
    write = (s) => process.stdout.write(s),
    exit = (code) => process.exit(code),
    installHandlers = true,
    start = true,
  } = opts;

  // -- Crash handling: first, so a throw anywhere below is covered -----
  // An uncaught exception used to kill the renderer with the cursor hidden,
  // stdin in raw mode, the title mid-flash and the PID file left behind (a
  // live-looking renderer until the heartbeat went stale). Undo what can be
  // undone, report, exit non-zero -- but never write the quit flag: that
  // means "the user closed the face", and a crash must leave autolaunch free
  // to bring it back on the next hook.
  let crashed = false;
  function crash(err) {
    if (!crashed) {
      crashed = true;
      try { stopRuntime(); } catch {}
      removePid();
      restoreTerminal();
      try { process.stderr.write(`[code-crumb] renderer crashed: ${(err && err.stack) || err}\n`); } catch {}
    }
    exit(1);
  }
  if (installHandlers) {
    process.on('uncaughtException', crash);
    process.on('unhandledRejection', crash);
  }

  const minimal = (process.argv.includes('--minimal') || process.env.MINIMAL_BOOT === '1');
  const face = new ClaudeFace();
  // Monotonic, for how long the renderer has actually run. Its start on the
  // wall clock is re-expressed at each read as `now - uptime` (see
  // startupGate), so no wall-clock start is kept.
  const rendererStartMono = monoNow();
  face.setState('starting');
  const orbital = new OrbitalSystem();
  if (sessionsDir !== SESSIONS_DIR) orbital._sessionsDir = sessionsDir;
  const swapTransition = new SwapTransition();

  // Minimal mode: strip all UI chrome, just face + status line
  if (minimal) {
    face.minimalMode = true;
    face.accessoriesEnabled = false;
    face.showStats = false;
    face.showOrbitals = false;
  }

  // Ensure sessions directory exists
  try { fs.mkdirSync(sessionsDir, { recursive: true }); } catch {}

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
  let lastTurnOver = false;   // Turn over, but on a face that is not rescued (see readState)
  let lastSessionEnded = false; // The main's file says SessionEnd (the list's ended marker)
  let lastCompacting = false;   // The main's file is a compaction this session is running
  let lastWaitingOn = false;    // The main's last applied write still names an unanswered prompt
  // Periodic forced re-reads (bypass the mtime race), on the monotonic clock.
  // -Infinity, not 0: that clock starts near zero, and 0 put the first forced
  // read up to 2s after boot.
  let lastForceReadTime = -Infinity;
  let lastEditorPid = 0;      // Validated (armed) PID of the editor process
  let candidatePid = 0;       // PID from the latest state write, pending validation
  let candidateSince = 0;     // When candidatePid was first seen (monotonic)
  let candidateTs = 0;        // JSON timestamp of the write that reported the candidate
  let editorDead = false;     // Armed PID found dead — session presumed crashed
  let lastAppliedTimestamp = 0; // Dedup: skip re-applying state with same timestamp
  let lastAppliedState = null;  // State named by that write -- "is this tool still running?"
  let lastNewWriteAt = 0;       // When a NEW write last arrived (not a re-read) -- see noteNewWrite
  // The applied write is an unconfirmed Claude Code permission wait (see
  // Permission prompts): its JSON timestamp and when it was first seen.
  let pendingPermission = null;
  // Sessions whose armed editor PID died: id -> the write timestamp at death.
  // Outlives adoptMain (which must clear editorDead) -- see policySessions.
  const deadSessions = new Map();

  // Frame scheduling (see loop): the pending timer, the deadline it is set
  // for, and the interval it was chosen with (full rate or low power).
  let frameTimer = null;
  let frameDeadline = monoNow();
  let frameInterval = FRAME_INTERVAL_MS;
  let runtimeStopped = false;

  // The main's armed editor is dead: flag it and remember it past a swap.
  function markMainDead() {
    editorDead = true;
    if (mainSessionId) deadSessions.set(mainSessionId, lastAppliedTimestamp);
  }

  function mainSessionFile() {
    return mainSessionId ? path.join(sessionsDir, safeFilename(mainSessionId) + '.json') : null;
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
    lastTurnOver = false;
    lastSessionEnded = false;
    lastCompacting = false;
    lastWaitingOn = false;
    pendingPermission = null;
    editorDead = false;
    lastEditorPid = 0;
    candidatePid = 0;
    lastNewWriteAt = 0;
    lastMtime = 0;
    lastForceReadTime = -Infinity;
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
    // The renderer knows one thing the files do not: which editors died.
    const sessions = policySessions(orbital.faces.values(),
      { mainId: mainSessionId, editorDead, deadSessions });
    const pick = pickMainSession({ sessions, currentId: mainSessionId, pinnedId: pinnedSessionId });
    pinnedSessionId = pick.pinnedId;
    if (!pick.mainId || pick.mainId === mainSessionId) return;
    if (!mainSessionId) adoptMain(pick.mainId);
    else swapTransition.start(mainSessionId, pick.mainId);
  }

  function checkState() {
    // Two clocks. `now` is the wall clock, for what is compared with a file's
    // JSON timestamp; `mono` is the face's monotonic one, for every duration
    // that is the renderer's own (forced reads, PID arming, the boot window),
    // so a wall clock stepped back can freeze none of them.
    const now = Date.now();
    const mono = monoNow();
    // The policy runs above the main try, so an exception in it (or in
    // isStale's PID plumbing) would escape checkState and take the render loop
    // with it. A failed pick must cost one tick, not the face.
    try { applyMainPolicy(); } catch {}
    // Nothing may touch the face or the trackers while it dissolves. The old
    // guard sat inside the mtime branch, so on the ~3 ticks in 4 where the old
    // main's file is unchanged and this is not a forced read, execution fell
    // straight past it into the rescue block and idleCascade -- both still
    // acting on the session that is leaving. The rescue's
    // forceState('responding') then buffered the promoted face's own state for
    // up to 3s after it materialized. Returning here costs nothing: adoptMain
    // resets every tracker at the swap frame anyway.
    if (swapTransition.active) return;
    try {
      const fp = mainSessionFile();
      if (!fp) throw new Error('no main session yet');
      const stat = fs.statSync(fp);
      // Every 2s, bypass mtime check to eliminate NTFS 1-second mtime race
      const forceRead = (mono - lastForceReadTime > 2000);
      if (forceRead) {
        // Arm a candidate PID only if it's still alive 2.5s after first
        // sighting. On Windows the hook's ppid is a transient cmd.exe shim
        // (dead within ms) — those never validate, so PID rescue silently
        // self-disables and the staleness timeouts below remain the fallback.
        // On Unix (sh -c execs) and for the codex adapters, the reported PID
        // is the long-lived editor/wrapper process and validates normally.
        if (candidatePid && candidatePid !== lastEditorPid
            && mono - candidateSince > 2500) {
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
          if (!isProcessAlive(lastEditorPid)) markMainDead();
        }
      }
      // Any change of mtime, not only a later one: after the wall clock
      // stepped back every new write has an OLDER mtime, and `>` passed over
      // all of them until the clock caught up.
      if (stat.mtimeMs !== lastMtime || forceRead) {
        if (forceRead) lastForceReadTime = mono;
        const stateData = readState(fp);
        // A failed read is not data (see readState): every tracker stays as it
        // was -- lastMtime too, so the next tick reads the file again -- and
        // the rescue and the cascade below carry on from what was last known.
        if (stateData.failed) throw new Error('unreadable state file');
        lastMtime = stat.mtimeMs;

        // Use JSON timestamp (ms precision) for staleness instead of
        // filesystem mtime (NTFS has 1-second granularity, and mtime
        // never updates if Claude is thinking with no tool calls).
        // Skip state older than 2 minutes pre-renderer-start — truly stale.
        // The boot window is measured on the monotonic clock, and the start
        // is handed over re-expressed on today's wall clock (see startupGate).
        const ts = stateData.timestamp || 0;
        const uptime = mono - rendererStartMono;
        const gate = startupGate(ts, !!stateData.stopped, now, now - uptime, uptime);
        if (gate === 'skip') return;
        if (gate === 'record') {
          // Don't resurrect dead sessions on fresh renderer start -- and
          // record the write as applied, or it reads as "new" (ts > 0) once
          // the startup window closes and is shown after all.
          lastStopped = !!stateData.stopped;
          lastTurnOver = !!stateData.turnOver;
          lastSessionEnded = !!stateData.sessionEnded;
          lastCompacting = !!stateData.compacting;
          if (isNewerWrite(ts, lastAppliedTimestamp, now)) {
            lastAppliedTimestamp = ts;
            lastAppliedState = stateData.state;
            // The counters are not the state: take them, or the stats rows
            // and the session list's main row read "0 tools · 0 files" until
            // the session happens to write again.
            face.setStats(stateData);
          }
          return;
        }

        // The session file's picture of a finished turn is the orbital's
        // "idle / between turns". The main face's is responding -> happy ->
        // idle, so a NEW turn-end write is shown as responding first and the
        // existing cascade does the rest.
        if (stateData.state === 'idle' && stateData.stopped && isNewerWrite(ts, lastAppliedTimestamp, now)) {
          stateData.state = 'responding';
          stateData.detail = 'wrapping up';
        }

        lastStopped = !!stateData.stopped;
        lastTurnOver = !!stateData.turnOver;
        lastSessionEnded = !!stateData.sessionEnded;
        lastCompacting = !!stateData.compacting;
        // Same session id, new editor process (e.g. `claude --resume` after a
        // crash): a NEWER write reporting a different PID retires the armed
        // one at once. Otherwise the death check kept testing the old, dead
        // PID until the new one armed (>= 2.5s), and every forced re-read of
        // an already-applied write set editorDead again -- a false responding
        // flash, and possibly a swap away from a perfectly live session.
        if (stateData.pid && lastEditorPid && stateData.pid !== lastEditorPid
            && isNewerWrite(ts, lastAppliedTimestamp, now)) {
          lastEditorPid = 0;
          editorDead = false;
          if (mainSessionId) deadSessions.delete(mainSessionId);
        }
        // Track the writer's PID as a validation candidate (same PID repeated
        // keeps its original sighting time so it can pass the 2.5s window).
        if (stateData.pid && stateData.pid !== lastEditorPid
            && stateData.pid !== candidatePid) {
          candidatePid = stateData.pid;
          candidateSince = mono;
          candidateTs = ts || Date.now();
        }
        // A write newer than anything we've applied proves the editor is
        // alive — overrides a false PID death (e.g. PID reuse).
        // (The main's deadSessions record exists only while editorDead is set,
        // so it is dropped here too.)
        if (editorDead && isNewerWrite(ts, lastAppliedTimestamp, now)) {
          editorDead = false;
          if (mainSessionId) deadSessions.delete(mainSessionId);
        }
        // Same proof, kept as a clock: this is the ONLY place the write clock
        // moves forward. No read marker can serve -- lastForceReadTime and its
        // kind are refreshed by every forced re-read of the unchanged file.
        // (A write landing mid-transition is not seen at all: checkState now
        // returns at the top while a swap animates. Nothing is lost -- the
        // swap frame's adoptMain resets this clock for the new session.)
        lastNewWriteAt = noteNewWrite(ts, lastAppliedTimestamp, now, lastNewWriteAt);

        if (isNewerWrite(ts, lastAppliedTimestamp, now)) {
          const prevAppliedTs = lastAppliedTimestamp;
          lastAppliedTimestamp = ts;
          lastAppliedState = stateData.state;
          // Force-apply stopped state (session ended) — bypass minimum display time
          // so the face doesn't get stuck on "thinking" when Claude is interrupted.
          // Never for a reward or an error: a reward owns its guaranteed window
          // and an error its 4s, and a turn end used to cut either short (a
          // `relieved` shown for a quarter of a second). They queue instead.
          if (stateData.stopped && face.now() < face.minDisplayUntil
              && !COMPLETION_STATES.has(face.state) && face.state !== 'error') {
            face.minDisplayUntil = face.now();
          }

          // If PostToolUse includes a workState the renderer missed (PreToolUse
          // was overwritten before we read it), inject the work state first.
          // setState buffering queues the completion state behind it. Never
          // for a finished turn: a late PostToolUse after Stop then showed its
          // tool, the rescue saw a work face on a stopped turn, and forceState
          // replaced the queued reward with a second "wrapping up" -> done!.
          // And only when it WAS missed: `workSince` is the PreToolUse write's
          // own timestamp, so a Pre this renderer already applied is never
          // replayed -- a Task's PostToolUse after its SubagentStop re-showed
          // "spawning" for 8s over the "agent done" reward.
          if (ACTIVE_WORK_STATES.has(stateData.workState)
              && COMPLETION_STATES.has(stateData.state)
              && !stateData.stopped
              && stateData.workSince > prevAppliedTs
              && !ACTIVE_WORK_STATES.has(face.state)) {
            face.setState(stateData.workState, stateData.workDetail || '');
          }

          // A write that answers a prompt spends any wait still queued -- and
          // so does a turn end: a prompt cannot outlive its turn, and one kept
          // through an Interrupt or a StopFailure flushed after the error and
          // was rescued straight into "wrapping up" -> done!.
          if (stateData.answered || stateData.stopped) face.dropWait();
          lastWaitingOn = !!stateData.waitingOn;
          face.setState(stateData.state, stateData.detail);
          face.setStats(stateData);
          // An unconfirmed Claude Code permission wait starts the answer clock
          // below; any other newer write stops it.
          pendingPermission = isUnconfirmedPermission(stateData) ? { ts, seenAt: mono } : null;
        }
      }

      // A permission prompt whose 6s Notification never came was answered
      // (see Permission prompts): the face shows its tool, running. Judged
      // against the file as it is NOW, so a confirmation (or anything else)
      // that landed since the last read is never overruled -- only the same
      // unconfirmed write, still the newest, turns into its tool. Due once
      // the window has passed since the write was made or since it was first
      // seen, whichever comes first: the second keeps it working after the
      // wall clock steps back.
      if (pendingPermission && (now - pendingPermission.ts >= PERMISSION_CONFIRM_MS
          || mono - pendingPermission.seenAt >= PERMISSION_CONFIRM_MS)) {
        const cur = readState(fp);
        if (!cur.failed) {
          if (cur.timestamp === pendingPermission.ts && isUnconfirmedPermission(cur)) {
            face.dropWait();
            lastWaitingOn = false;
            // The long-tool hold compares the face with the file's state. The
            // file still says "waiting"; what that write means now is this
            // tool, running -- so the hold keeps it, up to LONG_TOOL_HOLD_MS,
            // until the tool's own PostToolUse lands as the next write.
            lastAppliedState = cur.permState;
            face.setState(cur.permState, cur.permDetail || '');
          }
          pendingPermission = null;
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
    // (A Stop the mtime check missed is picked up by the forced read every 2s.
    // The separate "fresh read" that used to follow here acted only between
    // forced reads, on a thinking face, and stamped a turn end as applied
    // without showing it: a StopFailure right after thinking never drew its
    // error, and this rescue turned the turn into "done!" instead.)
    if (needsRescue(face, lastStopped, editorDead, minimal ? 0 : orbital.liveChildCount())) {
      face.forceState('responding', 'wrapping up', 3000); // respect responding's 3s min display time
    }

    // Don't apply timeouts if minimum display time hasn't passed
    if (face.now() < face.minDisplayUntil) return;

    // Session is active until Stop hook fires (writes stopped: true)
    // or the armed editor PID is found dead
    // A compaction this session is running (a manual /compact, Codex's own
    // pre-turn one) is active even between turns: it held thinking for its
    // whole run before, and dropped to idle after 8s once it carried turnOver.
    const sessionActive = !lastStopped && (!lastTurnOver || lastCompacting) && !editorDead;

    // Timeout-driven transitions: starting → idle, responding → happy once the
    // session ended, a completion's linger, thinking/idle timeouts, and the
    // degrade-to-thinking fallback — except while the state file still names
    // the same unfinished tool, which holds the work face (face.js escalates
    // its detail line instead).
    // Live subagent orbitals hold the main face at "conducting N" instead of
    // letting it fall idle while agent hooks write only their own files.
    // A dead editor's agents are not running either (needsRescue says so):
    // counting them here lifted the rescued face straight back to conducting,
    // and it went round responding -> done! -> conducting every ~12s until
    // the children went stale.
    const liveChildren = (minimal || editorDead) ? 0 : orbital.liveChildCount();
    const next = idleCascade({
      state: face.state,
      sinceChangeMs: face.now() - face.lastStateChange,
      sessionActive,
      lingerMs: COMPLETION_LINGER[face.state] || 0,
      fileState: lastAppliedState,
      fileAgeMs: lastNewWriteAt ? now - lastNewWriteAt : 0,
      liveChildren,
      fileWaiting: lastWaitingOn,
    });
    if (next === 'subagent' && liveChildren > 0) face.setState(next, `conducting ${liveChildren}`);
    else if (next) face.setState(next);
  }

  // -- Watching the sessions folder ---------------------------------
  // One handle (createDirWatcher), two consumers. The main face follows its
  // session file: a change to that file re-reads it at once (leading-edge
  // throttle: the first event fires immediately, duplicates within 50ms are
  // folded -- Windows fs.watch fires several per write -- and one more read
  // runs at the end if any were, so the last write of a burst is never left
  // for the 467ms poll). Any change at all reloads the ring, 80ms after the
  // first event of a burst. That timer is not pushed back by later events:
  // a trailing debounce that every event reset never fired at all under a
  // steady stream. Every event also wakes a resting loop.
  let stateWatchTimer = null;   // the 50ms throttle window; null when open
  let stateWatchMissed = false;
  let sessionWatchTimer = null;
  function onMainFileEvent() {
    if (runtimeStopped) return;
    if (stateWatchTimer) { stateWatchMissed = true; return; }
    try { checkState(); } catch {}
    stateWatchTimer = schedule(() => {
      stateWatchTimer = null;
      if (stateWatchMissed) { stateWatchMissed = false; onMainFileEvent(); }
    }, 50);
  }
  function reloadRingSoon() {
    if (runtimeStopped || sessionWatchTimer) return;
    sessionWatchTimer = schedule(() => {
      sessionWatchTimer = null;
      try { orbital.loadSessionsAsync(mainSessionId); } catch {}
    }, 80);
  }
  function onSessionsEvent(eventType, filename) {
    const mainName = mainSessionId ? safeFilename(mainSessionId) + '.json' : null;
    if (!filename || filename === mainName) onMainFileEvent();
    reloadRingSoon();
    wake();
  }
  // Minimal mode needs the loader too -- it just never draws the ring.
  const sessionsWatcher = createDirWatcher({
    dir: sessionsDir, watch, schedule, cancel,
    onEvent: onSessionsEvent,
    // Back after a break: whatever happened meanwhile was never reported.
    onReopen: () => { reloadRingSoon(); onMainFileEvent(); wake(); },
  });

  // Boot: load every session file, let the policy pick the main, read it.
  // Guarded like every other call into the loader: one bad file crashing
  // here would crash every boot until it went stale, cursor left hidden.
  try { orbital.loadSessions(null); } catch {}
  applyMainPolicy();
  checkState();

  // -- Cleanup (accessible to keypress handler + signal handlers) ----
  // Stop everything the runtime owns: the watcher and every pending timer.
  function stopRuntime() {
    runtimeStopped = true;
    try { sessionsWatcher.close(); } catch {}
    if (sessionWatchTimer) { try { cancel(sessionWatchTimer); } catch {} sessionWatchTimer = null; }
    if (stateWatchTimer) { try { cancel(stateWatchTimer); } catch {} stateWatchTimer = null; }
    if (frameTimer) { try { cancel(frameTimer); } catch {} frameTimer = null; }
  }
  function restoreTerminal() {
    try { if (installHandlers && process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    try { write(TERMINAL_RESTORE); } catch {}
  }
  function cleanup() {
    writeQuitFlag();
    removePid();
    stopRuntime();
    restoreTerminal();
    exit(0);
  }
  if (installHandlers) {
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    try { process.on('SIGHUP', cleanup); } catch {}
    // Ctrl+Break on Windows; without a handler it killed the renderer with the
    // PID file left behind.
    if (process.platform === 'win32') { try { process.on('SIGBREAK', cleanup); } catch {} }
  }

  // -- Keys ------------------------------------------------------------
  function persistPrefs() {
    savePrefs({
      paletteIndex: face.paletteIndex,
      accessoriesEnabled: face.accessoriesEnabled,
      showStats: face.showStats,
      showOrbitals: face.showOrbitals,
    });
  }

  function handleKey(key) {
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
    else if (key === 'l') {
      // Too small to draw it: an invisible list would eat the next key.
      if (sessionListFits(process.stdout.columns || 80, process.stdout.rows || 24)) face.toggleSessionList();
    }
    else if (key === 'h' || key === '?') face.toggleHelp();
  }

  // One chunk can carry several keys (a held arrow, a fast double tap):
  // dispatch each one on its own -- and draw the answer now, not at the next
  // low-power frame.
  function onKeys(chunk) {
    for (const key of splitKeys(chunk)) handleKey(key);
    wake();
  }

  // Raw stdin keypress handling
  if (installHandlers && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onKeys);
  }

  let prevFrame = null;  // last frame written; loop() skips identical frames
  if (installHandlers) process.stdout.on('resize', onResize);
  function onResize() {
    // Force-complete swap on resize to avoid ghost artifacts. The swap itself
    // runs only if its frame has not fired yet -- during materialize it has,
    // and a second _executeSwap re-ran adoptMain, forceState, the particles
    // and a synchronous session reload.
    if (swapTransition.active) {
      if (swapTransition.swapPending()) _executeSwap();
      swapTransition.cancel();
    }
    face.particles.fadeAll(5);
    // Shrunk below the list's minimum while it was open: close it rather than
    // leave an invisible list waiting to swallow a key.
    if (face.showSessionList && !sessionListFits(process.stdout.columns || 80, process.stdout.rows || 24)) {
      face.showSessionList = false;
      face.sessionListSelectedId = null;
    }
    prevFrame = null;  // the screen is about to be cleared -- force the next frame out even if identical
    try { write(ansi.syncEnd + ansi.clear); } catch {}
    wake();
  }

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
      if (!newData.failed && ts > 0) {
        // A permission prompt already past its confirmation window was
        // allowed: the face arrives showing the tool, not a wait it would
        // flash for a frame before checkState turned it. One still inside
        // the window gets the answer clock, as if it had just been applied.
        if (permissionAnswered(newData, Date.now())) {
          newData.state = newData.permState;
          newData.detail = newData.permDetail;
          newData.waitingOn = false;
        } else if (isUnconfirmedPermission(newData)) {
          pendingPermission = { ts, seenAt: monoNow() };
        }
        lastAppliedTimestamp = ts;
        // Seed the write clock from the write itself. adoptMain zeroed it, and
        // later reads of this same write are not "new", so without this the
        // WAIT_HOLD_STALE_MS bound could never fire on a face swapped in while
        // already waiting.
        lastNewWriteAt = ts;
        lastAppliedState = newData.state;
        lastStopped = !!newData.stopped;
        lastTurnOver = !!newData.turnOver;
        lastSessionEnded = !!newData.sessionEnded;
        lastCompacting = !!newData.compacting;
        lastWaitingOn = !!newData.waitingOn;
        // forceState, not setState: a materialized face must show its own
        // session at once. Any leftover minDisplayUntil belongs to the session
        // that just left, and setState would buffer this behind it. No third
        // argument, so the new state's own table minimum applies from here.
        face.forceState(newData.state || 'idle', newData.detail || '');
        // A tool (or a wait) that was already running before the swap keeps
        // its age: "still running … Ns" restarted at 0 on the incoming face,
        // and so did the 10-minute long-tool hold. The write's own timestamp
        // is when the tool started, as far as this session's file can say --
        // carried over onto the face's clock as an age.
        if ((ACTIVE_WORK_STATES.has(newData.state) || newData.state === 'waiting')
            && newData.state !== 'responding' && ts <= Date.now()) {
          face.lastStateChange = face.now() - (Date.now() - ts);
        }
        face.setStats(newData);
      }
    } catch {
      // No readable file yet: the id is adopted and checkState reads it next cycle
    }
    // Caffeine counts state changes in the last 10s, and those belonged to
    // the session that just left -- with the swap's own forceState on top,
    // a face that had done nothing went "hyperdrive!" 67ms after arriving.
    face.stateChangeTimes = [];

    // Spawn celebration particles
    face.particles.spawn(8, 'sparkle');
    face.particles.spawn(4, 'push');

    // Reload orbital sessions (guarded like every loader call)
    try { orbital.loadSessions(mainSessionId); } catch {}
  }

  // -- Frame loop ------------------------------------------------------
  // Frames run on deadlines (nextFrameDeadline) at FRAME_INTERVAL_MS, or at
  // LOW_POWER_FRAME_MS while the face rests with nothing else moving
  // (canRestLowPower). wake() cuts a low-power wait short, so a hook write, a
  // key or a resize is drawn at once rather than up to 250ms later.
  function orbitalsBusy() {
    if (minimal || !face.showOrbitals) return false;
    for (const f of orbital.getSortedFaces()) {
      if (f.spawning || !RESTING_STATES.has(f.state)) return true;
    }
    return false;
  }

  function scheduleFrame() {
    if (runtimeStopped) return;
    let resting = false;
    try {
      resting = canRestLowPower(face, { transitionActive: swapTransition.active, orbitalsBusy: orbitalsBusy() });
    } catch {}
    frameInterval = resting ? LOW_POWER_FRAME_MS : FRAME_INTERVAL_MS;
    const t = monoNow();
    frameDeadline = nextFrameDeadline(frameDeadline, t, frameInterval);
    frameTimer = schedule(loop, Math.max(0, frameDeadline - t));
  }

  function wake() {
    if (runtimeStopped || !frameTimer || frameInterval <= FRAME_INTERVAL_MS) return;
    try { cancel(frameTimer); } catch {}
    frameDeadline = monoNow();
    frameTimer = schedule(loop, 0);
  }

  let lastTime = monoNow();
  let lastStatePollAt = lastTime;
  let lastSessionPollAt = lastTime;
  function loop() {
    frameTimer = null;
    if (runtimeStopped) return;
    // Wall clock for the heartbeat, on purpose: after a system suspend the
    // interval's monotonic timer is up to PID_HEARTBEAT_MS late, and the PID
    // file's age is judged on the wall clock. Everything else is monotonic.
    const now = Date.now();
    const t = monoNow();
    const dt = t - lastTime;
    lastTime = t;
    if (heartbeatFromLoop && now - lastBeat > PID_HEARTBEAT_MS) heartbeat(now);

    try { face.update(dt); } catch {}
    try { orbital.update(dt); } catch {}

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

    // Periodically reload sessions, and make sure the folder is still watched
    if (t - lastSessionPollAt >= SESSION_POLL_MS) {
      lastSessionPollAt = t;
      try { orbital.loadSessionsAsync(mainSessionId); } catch {}
      try { sessionsWatcher.check(); } catch {}
    }

    if (t - lastStatePollAt >= STATE_POLL_MS) {
      lastStatePollAt = t;
      try { checkState(); } catch {}
    }

    // Tell face how many subagents are active (for status line). Only the
    // main session's own live children: the ring also holds parallel windows,
    // other sessions' children and lingering stopped faces.
    try { face.subagentCount = (minimal || editorDead) ? 0 : orbital.liveChildCount(); } catch {}

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
        // The real SessionEnd flag, not lastStopped: that one folds a plain
        // turn end in, and drew the live main row as an ended session (a grey
        // cross) every time the list was opened between turns. Read from the
        // main's own file too: the stopped MiniFace is purged after its 10s
        // linger, and the ended row then came back as live, offering a pin.
        stopped: lastSessionEnded || !!(mainFace && mainFace.stopped),
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
      // Guarded like the loader calls: a throw here skipped scheduling the
      // next frame, and the face froze on screen for good.
      let entries = [];
      try { entries = orderSessionList(mainInfo, orbital.getSortedFaces()); } catch {}
      // Every entry is drawn; only the live ones can be selected.
      try { face.sessionListIds = listNavigableIds(entries); } catch { face.sessionListIds = []; }
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
    if (frameKey !== prevFrame) {
      prevFrame = frameKey;
      try { write(ansi.syncStart + _title + ansi.home + ansi.clearBelow + out + ansi.syncEnd); } catch {}
    }
    scheduleFrame();
  }

  if (start) loop();

  return {
    face, orbital, swapTransition,
    checkState, loop, wake, onKeys, onResize, cleanup, crash,
    dispose: stopRuntime,
    mainSession: () => mainSessionId,
    trackers: () => ({
      lastStopped, lastTurnOver, lastSessionEnded, lastCompacting, lastWaitingOn,
      lastAppliedState, lastAppliedTimestamp, editorDead, pendingPermission,
      frameInterval, frameDeadline, watching: sessionsWatcher.isOpen(),
    }),
  };
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
  let wrote = false;
  function writeTmuxStatus() {
    try {
      const data = readState();
      // A torn or unreadable read says nothing new: keep the last line (an
      // idle one only if nothing was ever written).
      if (data.failed && wrote) return;
      fs.writeFileSync(TMUX_FILE, tmuxStatusLine(data, Date.now()), 'utf8');
      wrote = true;
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
    // Heartbeat, so a stale PID file (a renderer that died without cleanup)
    // can be told from a live one -- see isRendererAlive. The render loop
    // beats too, as soon as the wall clock says one is due: after a system
    // suspend the interval's monotonic timer is up to PID_HEARTBEAT_MS late.
    lastBeat = Date.now();
    setInterval(heartbeat, PID_HEARTBEAT_MS).unref();
    heartbeatFromLoop = true;
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

  // The terminal's own title goes on its title stack first, so the exit
  // restore (TERMINAL_RESTORE) can pop it back.
  process.stdout.write(ansi.hide + ansi.clear + TITLE_PUSH);
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
    readState, ACTIVE_WORK_STATES, COMPLETION_STATES,
    idleCascade, buildTitle, noteNewWrite, pickMainSession,
    RESCUE_EXCLUDE, needsRescue, policySessions, splitKeys, tmuxDisplayState, isNewerWrite,
    startupGate, tmuxStatusLine,
    PERMISSION_CONFIRM_MS, isUnconfirmedPermission, permissionAnswered,
    createDirWatcher, isPlainBasename, nextFrameDeadline, canRestLowPower,
    runUnifiedMode, TITLE_RESET, TERMINAL_RESTORE,
    FPS, FRAME_INTERVAL_MS, LOW_POWER_FPS, LOW_POWER_FRAME_MS,
    IDLE_TIMEOUT, THINKING_TIMEOUT, SLEEP_TIMEOUT,
    LONG_TOOL_HOLD_MS, WAIT_HOLD_STALE_MS,
  };
}
