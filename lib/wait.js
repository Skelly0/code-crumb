'use strict';

// +================================================================+
// |  Permission waits -- one lifecycle for every reader            |
// |  Pure: the hook writes a wait, the renderer, the orbitals and  |
// |  tmux read it. Each used to keep its own copy of the rules.    |
// +================================================================+
//
// A permission prompt, as the session files record it:
//
//                 PermissionRequest
//   none ───────────────────────────────► asked ──── Notification ────► confirmed
//                                          │       (permission_prompt,     │
//                                          │        6 s, still open)       │
//                     PERMISSION_CONFIRM_MS│ with nothing newer            │
//                     (Claude Code only)   ▼                               │
//                                       allowed  (its tool is running)     │
//                                          │                               │
//      the waited call's own tool end, a PermissionDenied, the user's     │
//      next prompt, or the turn's end  ────┴───────────────────────────────┘
//                                          ▼
//                                   answered: one write carries `answered`,
//                                   and every wait field is gone
//
//   open: a wait with no `waitKind` (Codex, or Claude Code with the
//   notification switched off). Nothing confirms it, so nothing may infer it
//   answered: it is open until it is answered.
//
// The fields live and die together (WAIT_FIELDS): every write in between
// carries them on, so a parallel tool's write or an agent's SubagentStop
// never closes a prompt the user has not answered. A parent whose agent is
// asking stands in for it (STAND_IN_FIELDS) and goes back when it is answered.

const { PERMISSION_CONFIRM_MS, PERMISSION_TOOL_STATES } = require('./shared');

// -- Fields --------------------------------------------------------------

// `waitAskedAt` is the request's own EVENT_AT, for the hook alone: syncAt
// cannot say how long a wait has been open, since a background agent's
// SubagentStart or InstructionsLoaded lands on the same file in between.
const WAIT_FIELDS = ['waitingOn', 'waitKind', 'waitConfirmed', 'permState', 'permDetail', 'waitAskedAt'];
// The parent's stand-in for its agents' prompts: which agents, and what the
// parent showed before it started waiting for them.
const STAND_IN_FIELDS = ['waitForAgents', 'waitPrev'];
const MAX_STAND_IN = 8;
// An agent's unconfirmed wait younger than this cannot be the one a
// notification is about (the timer is 6 s); if it was answered meanwhile,
// being confirmed early only means it waits for its PostToolUse.
const PERMISSION_CONFIRM_MIN_AGE_MS = 5000;

// Which tool call a permission prompt is waiting on. PermissionRequest
// carries no tool_use_id (checked against the 2.1.281 schema), only the
// tool's name and input -- and so does the PostToolUse that answers it when
// the user allows. A short digest keeps the session file small.
function toolCallKey(name, input) {
  let text = '';
  try { text = JSON.stringify(input) || ''; } catch {}
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  // As state-machine.js's toText: text, a number or a boolean; else nothing.
  const label = typeof name === 'string' ? name
    : (typeof name === 'number' || typeof name === 'boolean') ? String(name) : '';
  return `${label}:${h.toString(36)}:${text.length}`;
}

// Claude Code's own parse of CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS
// (2.1.300 reads it through its env table as D.bool()): 1/true/yes/on, any
// case, trimmed, switches the 6 s notification off. 0, false or empty leave
// it on.
function notifyEnabled(value) {
  return !(typeof value === 'string' && /^\s*(1|true|yes|on)\s*$/i.test(value));
}

// -- Asking: PermissionRequest ------------------------------------------

// The confirmation fields a PermissionRequest writes beside `waitingOn`, or
// null. Claude Code only, with its notification on: the notification is what
// confirms the wait. Codex has no Notification hook, so a Codex wait must
// never look unconfirmed -- it would be read as allowed while the prompt is
// still open. `work` is the asking tool's own face ({ state, detail }).
function askFields({ editor, notify, work, askedAt }) {
  if (editor !== 'claude' || !notify) return null;
  return {
    waitKind: 'permission', waitConfirmed: false,
    permState: work.state, permDetail: work.detail,
    waitAskedAt: askedAt,
  };
}

// -- Reading a write -----------------------------------------------------

// The confirmation fields of a Claude Code wait its notification has not
// confirmed. `waitConfirmed` must be an explicit false -- anything else is a
// wait this contract does not describe, and it keeps waiting as before.
function unconfirmedClaude(write, editor = write && write.editor) {
  return !!write && write.waitKind === 'permission' && write.waitConfirmed === false && editor === 'claude';
}

// The write that ASKS such a wait, for the orbitals: `editor` is passed in
// because a MiniFace infers it for a legacy file. Any asking tool face is
// allowed here -- the orbital shows an unknown one as a generic running tool.
function isUnconfirmedAsk(write, editor) {
  return !!write && write.state === 'waiting' && unconfirmedClaude(write, editor);
}

// The same, for the main face: the asking tool's face must be one it may
// turn into (PERMISSION_TOOL_STATES); with any other it stays waiting.
function isUnconfirmedPermission(write) {
  return isUnconfirmedAsk(write) && PERMISSION_TOOL_STATES.has(write.permState);
}

// A later write that still carries such a wait. Every write keeps the wait
// fields until the prompt is answered, so a parallel tool's write (or a
// SubagentStop) can land on top of it: the prompt is still unconfirmed,
// whatever that write's own state says.
function carriesUnconfirmedPermission(write) {
  return !!write && !!write.waitingOn && unconfirmedClaude(write)
    && PERMISSION_TOOL_STATES.has(write.permState);
}

// Has that wait gone unconfirmed long enough to have been answered (allowed)?
// Measured from the write's own timestamp, so a reader that only sees the
// wait late (a boot, a swap) does not make the user wait again.
function permissionAnswered(write, now) {
  if (!isUnconfirmedPermission(write)) return false;
  const ts = write.timestamp || 0;
  return ts > 0 && now - ts >= PERMISSION_CONFIRM_MS;
}

// Where a write stands in the lifecycle above: 'none', 'open', 'asked',
// 'confirmed' or 'allowed'. A write that asks counts with or without its
// `waitingOn` (a sanitised or legacy read may have lost it).
function waitPhase(write, now) {
  if (!write || typeof write !== 'object') return 'none';
  if (!write.waitingOn && !isUnconfirmedAsk(write)) return 'none';
  if (write.waitKind === 'permission' && write.waitConfirmed === true) return 'confirmed';
  if (!(unconfirmedClaude(write) && PERMISSION_TOOL_STATES.has(write.permState))) return 'open';
  const ts = write.timestamp || 0;
  return ts > 0 && now - ts >= PERMISSION_CONFIRM_MS ? 'allowed' : 'asked';
}

// -- Carrying: every write in between ------------------------------------

// What a write takes over from the file before it (prev) about an open
// wait. `w` describes the write:
//   toolEnd   it is a PostToolUse/PostToolUseFailure, of the call `callKey`
//   closes    it closes the turn (Stop, StopFailure, SessionEnd, Interrupt)
//   answered  it answers whatever is asked (the user spoke, a denial...)
//   asks      it asks a wait of its own (PermissionRequest)
//   dropOwn   a notification found the session's own wait long allowed
//   fields    what the write already set, never overwritten
// Returns { answered: true } when this write is the waited call's own end --
// allowing a prompt produces nothing else -- or the fields to carry on.
function carryWait(prev, w) {
  if (!prev || !prev.waitingOn || w.asks || (w.fields && w.fields.waitingOn)) return {};
  if (w.toolEnd && w.callKey && prev.waitingOn === w.callKey) return { answered: true };
  if (w.answered || w.closes || w.dropOwn) return {};
  const out = {};
  for (const field of WAIT_FIELDS) {
    if (prev[field] !== undefined && (!w.fields || w.fields[field] === undefined)) out[field] = prev[field];
  }
  return out;
}

// A PermissionDenied answers the wait on its own call -- or, with none
// pending, nothing at all: a wait on some OTHER call is still open.
function deniedAnswers(prev, callKey) {
  const pending = prev && prev.waitingOn;
  return !pending || pending === callKey;
}

// -- Confirming: Notification(permission_prompt) --------------------------

// The verdict on one agent's file for a notification that carries only the
// session id: 'confirmed' (already), 'confirm' (write waitConfirmed: true
// now) or null (not an open permission prompt, or too young to be the one
// this notification is about). The request's own time is syncAt: an async
// write since (a parallel tool of the agent's) moves eventAt but carries it.
function agentWaitVerdict(s, now) {
  if (!s || typeof s !== 'object' || s.stopped || s.state !== 'waiting') return null;
  if (s.waitKind !== 'permission') return null;
  if (s.waitConfirmed === true) return 'confirmed';
  if (s.waitConfirmed !== false) return null;
  const askedAt = typeof s.syncAt === 'number' ? s.syncAt : s.eventAt;
  if (typeof askedAt === 'number' && now - askedAt < PERMISSION_CONFIRM_MIN_AGE_MS) return null;
  return 'confirm';
}

// What the session's own permission_prompt notification writes, from its
// file before (prev), the agents whose prompts are open and confirmed now
// (`agents`, newest last) and the hook's own time. Returns
//   waitingOn  the session's own prompt, when this is about it (else null)
//   detail     that prompt's own detail to keep (else null: "allow?")
//   fields     the wait fields to write
//   dropOwn    the session's own wait was allowed long ago: do not carry it
// The parent stands in for its agents: agents asking seconds apart each get
// a notification, so the list merges with the one already held (one that
// confirms nothing new must not forget the first agent). `standIn: false`
// (an agent's own file) stands in for nobody.
function notificationWait(prev, agents, now, { standIn = true } = {}) {
  const standingIn = standIn && prev && prev.state === 'waiting' && Array.isArray(prev.waitForAgents)
    ? prev.waitForAgents.filter(a => typeof a === 'string') : [];
  const all = [...new Set([...standingIn, ...agents])].slice(0, MAX_STAND_IN);
  let asking = !!(prev && prev.waitingOn && prev.waitKind === 'permission');
  let dropOwn = false;
  // The session's OWN prompt, still unconfirmed PERMISSION_CONFIRM_MS after
  // it was asked, was answered -- allowed, its tool is running -- and an
  // agent's notification is not about it. Re-confirming it put the parent
  // back on "allow Bash?" over its own running call, and, "asking", it never
  // stood in for the agent. Only while an agent is asking: a notification
  // nobody else claims is still the session's own, however late its hook ran.
  if (asking && all.length && prev.waitConfirmed === false && typeof prev.waitAskedAt === 'number'
      && now - prev.waitAskedAt >= PERMISSION_CONFIRM_MS) {
    asking = false;
    dropOwn = true;
  }
  const fields = {
    waitKind: 'permission', waitConfirmed: true,
    ...(asking && typeof prev.permState === 'string' ? { permState: prev.permState } : {}),
    ...(asking && typeof prev.permDetail === 'string' ? { permDetail: prev.permDetail } : {}),
  };
  if (!asking && all.length) {
    fields.waitForAgents = all;
    if (standingIn.length && prev.waitPrev && typeof prev.waitPrev.state === 'string') {
      fields.waitPrev = prev.waitPrev;
    } else if (dropOwn && prev.state === 'waiting') {
      // Still the allowed prompt's own write: what the face shows now is
      // that tool, running -- and what it goes back to.
      if (PERMISSION_TOOL_STATES.has(prev.permState)) {
        fields.waitPrev = { state: prev.permState, detail: typeof prev.permDetail === 'string' ? prev.permDetail : '' };
      }
    } else if (prev && typeof prev.state === 'string' && prev.state !== 'waiting') {
      fields.waitPrev = { state: prev.state, detail: typeof prev.detail === 'string' ? prev.detail : '' };
    }
  }
  return {
    waitingOn: asking ? prev.waitingOn : null,
    detail: asking && prev.state === 'waiting' && typeof prev.detail === 'string' && prev.detail ? prev.detail : null,
    fields,
    dropOwn,
  };
}

// -- Releasing a stand-in ------------------------------------------------

// A file standing in for `agentFile`'s prompt once that agent is answered:
// still waiting, minus that agent, while others are asking (same timestamp:
// nothing to redraw); otherwise back to what it showed before (`waitPrev`,
// else conducting), with `answered`, a fresh timestamp and no wait fields.
// null when the file does not stand in for that agent.
function releaseStandIn(s, agentFile, now) {
  if (!s || typeof s !== 'object' || s.state !== 'waiting'
      || !Array.isArray(s.waitForAgents) || !s.waitForAgents.includes(agentFile)) return null;
  const rest = s.waitForAgents.filter(id => id !== agentFile);
  if (rest.length) return { ...s, waitForAgents: rest };
  const next = { ...s, timestamp: now, answered: true };
  for (const field of [...WAIT_FIELDS, ...STAND_IN_FIELDS]) delete next[field];
  const back = s.waitPrev && typeof s.waitPrev.state === 'string' ? s.waitPrev : null;
  next.state = back ? back.state : 'subagent';
  next.detail = back && typeof back.detail === 'string' ? back.detail : 'conducting';
  return next;
}

module.exports = {
  PERMISSION_CONFIRM_MS, PERMISSION_TOOL_STATES, PERMISSION_CONFIRM_MIN_AGE_MS, MAX_STAND_IN,
  WAIT_FIELDS, STAND_IN_FIELDS,
  toolCallKey, notifyEnabled, askFields,
  isUnconfirmedAsk, isUnconfirmedPermission, carriesUnconfirmedPermission, permissionAnswered, waitPhase,
  carryWait, deniedAnswers,
  agentWaitVerdict, notificationWait, releaseStandIn,
};
