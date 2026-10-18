'use strict';

// +================================================================+
// |  The session file, one write at a time                         |
// |  Pure: what a hook write keeps from the file before it. The    |
// |  hook's main path and its >1 MB fallback both write through    |
// |  nextSessionFile; each used to keep its own copy, and drifted. |
// +================================================================+
//
// Two facts outlive the event that wrote them, and both are tombstones:
//
//   `stopped`    the SESSION ended. Only SessionEnd writes it, and every
//                write that merely lands beside the ended session -- a late
//                PostToolUse, a background agent's SubagentStop, a
//                TaskCompleted, a compaction -- keeps it (echoesTurnEnd).
//                A tombstone a late write could erase made the closed window
//                a candidate for the center again. Only the session starting
//                again clears it: a turn-opening event under the same id (a
//                resume), or SessionStart's unlink of its predecessor.
//   `turnEnded`  the TURN ended (Stop, StopFailure, Interrupt). Every echo of
//                the turn keeps it, as `turnEnded` or `turnOver` (see
//                inheritedTurnEnd); the next turn's opening event drops it.
//
// Around them, each write also carries on an open permission prompt
// (carryWait, lib/wait.js) and the sticky fields.

const { COMPLETION_STATES } = require('./shared');
const { carryWait } = require('./wait');

// -- The turn-end contract ------------------------------------------------

// Events that are live activity: they never inherit a finished turn, so a
// session file's `turnEnded` is dropped by them. Every OTHER event that lands
// after a Stop (a late PostToolUse, a background agent's SubagentStop, a
// TaskCompleted, a PostCompact...) is an echo of the turn that already ended
// and carries `turnEnded` forward -- otherwise it reopened the turn and the
// renderer sat on an active face for the 45s thinking timeout. Stop,
// StopFailure and SessionEnd decide their own flags.
const TURN_OPENING_EVENTS = new Set([
  'PreToolUse', 'UserPromptSubmit', 'SessionStart', 'SubagentStart',
  'PreCompact', 'Setup', 'PostModelSwitch',
]);
// Interrupt is Codex's: it runs no Stop hook when the user presses Esc (and
// none at all for a failed turn), only Interrupt. Without it the face held
// "running command · still running" for the whole 10-minute long-tool hold.
const TURN_CLOSING_EVENTS = new Set(['Stop', 'StopFailure', 'SessionEnd', 'Interrupt']);
// An agent's StopFailure is ITS turn failing. AGENT_EXCLUDED_EVENTS shows it
// on the parent's face, but it ends nothing there (see its handler), so to
// the parent's files it is an echo like any other. Taken as turn-closing, it
// dropped the parent's `turnEnded` and the global `stopped` after a Stop, and
// the finished turn sat on the 45s thinking timeout.
function closesTurn(event, agentId) {
  return TURN_CLOSING_EVENTS.has(event) && !(agentId && event === 'StopFailure');
}

// Session files that may inherit a finished turn from their predecessor.
// `waiting` is the exception: the renderer folds `turnEnded` into `stopped`
// and then force-rescues any non-reward face to "wrapping up", so a wait
// written with `turnEnded` would never be seen. It carries `turnOver`
// instead -- the same fact, invisible to the renderer -- so the NEXT echo
// (a background SubagentStop after an idle_prompt) still knows the turn is over.
function carriesTurnEnd(event, agentId) {
  return !TURN_OPENING_EVENTS.has(event) && !closesTurn(event, agentId);
}

// Turn-opening events that also happen BETWEEN turns: a /compact, a /model, a
// config reload, a subagent's own auto-compaction (Claude Code sends that one
// with the parent's session_id and no agent_id). After a finished turn they
// sit beside it rather than start a new one, so they keep its end (as
// `turnOver`, below). Dropping it left the renderer on the 45s thinking
// timeout with nothing left to close the turn.
const AMBIENT_EVENTS = new Set(['PreCompact', 'PostModelSwitch', 'SessionStart', 'Setup']);

// Every event that lands beside a finished turn and keeps its end: the echoes,
// and the ambient events but SessionStart (a resume is the session starting
// again). They re-stamp the global `stopped`, and they keep a session file's
// own `stopped` -- the session ENDED: a background agent's SubagentStop after
// SessionEnd rewrote the ended window live, a top-level candidate again.
function echoesTurnEnd(event, agentId) {
  return carriesTurnEnd(event, agentId) || (AMBIENT_EVENTS.has(event) && event !== 'SessionStart');
}

// The states a finished turn may be carried with as `turnEnded`. The renderer
// folds `turnEnded` into `stopped`, force-rescues every face outside its
// RESCUE_EXCLUDE to "wrapping up", and shows a new idle + stopped write as
// responding: a ConfigChange's `reading` after a Stop replayed the whole
// responding -> done! celebration. Everything else carries the same fact as
// `turnOver`, which the renderer reads as "not active" (the short idle
// timeout) but never rescues -- `waiting` was the first such case.
const TURN_END_SAFE_STATES = new Set([...COMPLETION_STATES, 'error']);

// What a write inherits from a session file that records a finished turn:
// null, 'turnEnded' or 'turnOver'.
function inheritedTurnEnd(event, state, agentId) {
  if (AMBIENT_EVENTS.has(event)) return 'turnOver';
  if (!carriesTurnEnd(event, agentId)) return null;
  return TURN_END_SAFE_STATES.has(state) ? 'turnEnded' : 'turnOver';
}

// What a write itself ends: 'session' (SessionEnd), 'turn' (the session's
// own Stop -- an agent's Stop is the agent's turn, written to its orbital),
// 'failed' (StopFailure or Codex's Interrupt, not an agent's) or null.
// `isAgent`: the write goes to an agent's orbital (agent_id, and not one of
// the AGENT_EXCLUDED_EVENTS, which StopFailure is -- hence agentId too).
function writeEnds(event, agentId, isAgent) {
  if (event === 'SessionEnd') return 'session';
  if (event === 'Stop') return isAgent ? null : 'turn';
  if ((event === 'StopFailure' || event === 'Interrupt') && !agentId) return 'failed';
  return null;
}

// -- Sticky fields --------------------------------------------------------

// Sticky session-file fields: set once, preserved across every later write.
// `editor` is deliberately absent: every write stamps it fresh (EDITOR is
// never empty), so a copy-if-missing loop could never fire for it. The owner's
// provenance is kept by the global owner guard instead.
// `firstSeenAt` is when the file was first written. The legacy foreign-session
// classifier used the file's birthtime for that, but writeJsonAtomic renames
// a temp file over the old one, which REPLACES it -- birthtime is the last
// write (NTFS and POSIX alike), so an unregistered parallel window was
// classified parallel on its first event and the owner's subagent on its next.
// `model` is live here: a write sets it only when acquisition actually
// produced something, so the copy-if-missing guard both carries it forward and
// lets a real PostModelSwitch override it.
const STICKY_FIELDS = ['taskDescription', 'parentSession', 'agentType', 'isTeammate', 'teamName', 'teammateName', 'lastPromptAt', 'model', 'firstSeenAt'];

// -- The next session file ------------------------------------------------

function isToolEnd(event) {
  return event === 'PostToolUse' || event === 'PostToolUseFailure';
}

// The session file a write leaves behind. `prev` is the file as read before
// this write (null when there is none, or for a fresh SessionStart); `w`:
//   event, agentId   the hook event and its agent_id ('' for none)
//   isAgent          the write goes to an agent's orbital
//   state, detail    the face the write shows
//   fields           what the write already set (never overwritten)
//   callKey          the call a tool end finishes (toolCallKey, lib/wait.js)
//   dropOwnWait      a notification found the session's own wait allowed
// Returns { state, detail, stopped, fields } -- `fields.answered` is set when
// this write answers an open prompt, so the caller can release a parent
// standing in for the agent that asked.
function nextSessionFile(prev, w) {
  const ends = writeEnds(w.event, w.agentId, w.isAgent);
  const fields = { ...w.fields };
  let stopped = ends === 'session';
  if (prev) {
    // The session's tombstone survives every echo.
    if (!stopped && prev.stopped && echoesTurnEnd(w.event, w.agentId)) stopped = true;
    // The finished turn's: as turnEnded or turnOver (see inheritedTurnEnd).
    if (!stopped && (prev.turnEnded || prev.turnOver)) {
      const inherit = inheritedTurnEnd(w.event, w.state, w.agentId);
      if (inherit) fields[inherit] = true;
    }
    // An open permission prompt: carried on, or answered by its own call's end.
    Object.assign(fields, carryWait(prev, {
      toolEnd: isToolEnd(w.event), callKey: w.callKey,
      closes: closesTurn(w.event, w.agentId), answered: !!fields.answered,
      asks: w.event === 'PermissionRequest', dropOwn: !!w.dropOwnWait, fields,
    }));
    // The piggybacked work state is only worth injecting if the renderer
    // never saw the PreToolUse write. Name that write by its timestamp (when
    // the file still holds it) so the renderer can tell.
    if (fields.workState && prev.state === fields.workState && typeof prev.timestamp === 'number') {
      fields.workSince = prev.timestamp;
    }
    for (const field of STICKY_FIELDS) {
      if (prev[field] && !fields[field]) fields[field] = prev[field];
    }
  }
  let state = w.state;
  let detail = w.detail;
  if (ends === 'turn') {
    // Stop ends the turn, not the session: the window stays on, idle. (The
    // global file gets `stopped`, to release ownership: see stopsGlobal.)
    state = 'idle';
    detail = 'between turns';
  }
  if (ends === 'turn' || ends === 'failed') {
    fields.turnEnded = true;
    delete fields.turnOver;
  }
  // On a session file `stopped` is the tombstone, and nothing else.
  if (stopped) fields.stopped = true;
  else delete fields.stopped;
  return { state, detail, stopped, fields };
}

// Whether the GLOBAL write carries `stopped`: "this session's turn is over",
// so another window may take the file. A write that ends something says so.
// An echo says so again while the turn is still over -- known from the global
// file's own flag for this session (`globalOwnStop`), or from the session
// file's record (`prev`), since any wait clears the global one (an
// idle_prompt lands ~60 s after every Stop) and the next echo wrote the
// global file live: no other window could take it for two minutes. A wait
// never does: tmux mode would rescue it straight to "wrapping up".
//   w: { event, agentId, isAgent, state, globalOwnStop }
function stopsGlobal(prev, w) {
  if (writeEnds(w.event, w.agentId, w.isAgent)) return true;
  if (w.isAgent || w.state === 'waiting' || !echoesTurnEnd(w.event, w.agentId)) return false;
  return !!w.globalOwnStop || !!(prev && (prev.stopped || prev.turnEnded || prev.turnOver));
}

module.exports = {
  TURN_OPENING_EVENTS, TURN_CLOSING_EVENTS, AMBIENT_EVENTS, TURN_END_SAFE_STATES, STICKY_FIELDS,
  closesTurn, carriesTurnEnd, echoesTurnEnd, inheritedTurnEnd, writeEnds,
  nextSessionFile, stopsGlobal,
};
