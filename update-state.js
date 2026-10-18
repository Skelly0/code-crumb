#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Hook -- writes state for the face renderer         |
// |  Called by editor hooks via stdin JSON                         |
// |  Usage: node update-state.js [--editor <name>] <event>         |
// |  Events: PreToolUse, PostToolUse, PostToolUseFailure, Stop,    |
// |          Notification, UserPromptSubmit, SubagentStart,        |
// |          SubagentStop, TeammateIdle, TaskCompleted,            |
// |          SessionStart, SessionEnd, PreCompact, PostCompact,    |
// |          PermissionRequest, Setup, Elicitation,                |
// |          ElicitationResult, ConfigChange, InstructionsLoaded,  |
// |          StopFailure, PostModelSwitch, PermissionDenied, and   |
// |          Codex's Interrupt                                     |
// |                                                                |
// |  Works with Claude Code, Codex CLI, and OpenCode               |
// +================================================================+

const fs = require('fs');
const path = require('path');
const {
  STATE_FILE, SESSIONS_DIR, STATS_FILE, PID_FILE, QUIT_FLAG_FILE, SPAWN_LOCK_FILE, STATS_LOCK_FILE,
  safeFilename, getGitBranch, getIsWorktree, loadPrefs,
  writeJsonAtomic, acquireSpawnLock, acquireFileLock, spawnRendererWindow, isRendererAlive,
} = require('./lib/shared');
// The permission-wait lifecycle: one module for the hook and every reader.
const {
  toolCallKey, notifyEnabled, askFields, deniedAnswers,
  agentWaitVerdict, notificationWait, releaseStandIn,
} = require('./lib/wait');
// What a write keeps from the session file before it (the tombstones, the
// open wait, the sticky fields), for both write paths.
const {
  TURN_CLOSING_EVENTS, STICKY_FIELDS, nextSessionFile, stopsGlobal,
} = require('./lib/carry');
const {
  toolToState, normalizeToolResponse, classifyToolResult, classifyTruncatedInput, rawToolInput, updateStreak, defaultStats, normalizeStats,
  EDIT_TOOLS, SUBAGENT_TOOLS, ASK_TOOLS, toText,
  pruneFrequentFiles, topFrequentFiles, buildSubagentSessionState,
  subagentSessionId, subagentLabel,
  classifyForeignSession, pruneTopLevelSessions,
  prettyModelName, agentTranscriptPath,
  COUNTER_MAX_FILES,
  freshCounter: _freshCounter, normalizeCounter: _normalizeCounter,
  parkAgents: _parkAgents, unparkAgents: _unparkAgents, pruneCounters: _pruneCounters,
  creditSession: _creditSession, creditEndFor, touchCounter, localDay, firstSeenFor,
} = require('./lib/state-machine');

// Safety net for a missed SubagentStop: an activeSubagents entry older than
// this is dropped. Not a lifetime -- an agent may legitimately run for hours,
// and the old 10-minute cut silently erased every long-running one.
const SUBAGENT_MAX_AGE_MS = 4 * 3600000;

// Bounds on transcript scanning. A main transcript reaches megabytes, so the
// model is read out of a fixed window at one end -- never readFileSync.
const TRANSCRIPT_READ_BYTES = 32768;
const TRANSCRIPT_MAX_LINES = 200;

// Events that carry agent_id but are NOT the subagent's own work: lifecycle
// and session-level hooks keep their existing handlers. `Stop` is deliberately
// absent -- a Stop with agent_id is the subagent's own turn ending.
const AGENT_EXCLUDED_EVENTS = new Set([
  'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'Setup', 'ConfigChange',
  'InstructionsLoaded', 'StopFailure', 'PostModelSwitch',
]);

// The turn-end contract -- which events open, close and echo a turn, and
// what a write carries on from the session file before it -- is
// lib/carry.js's, shared by the main path and the >1 MB fallback.

// SessionStart's `source`, checked against the 2.1.300 schema: startup |
// resume | clear | compact | fork. Each comparison below names the sources it
// means, so a new one is a decision rather than an accident:
// - EDITOR_START_SOURCES clear the quit flag: the user starting a session --
//   a new process, `--continue`/`--resume`, the resume picker, or `fork`
//   (2.1.300: the resumed transcript under a NEW session id, fired from the
//   same resume path). It was ignored, so a forked session never relaunched
//   a face the user had closed.
// - `clear` is a /clear inside a running editor: a fresh session (counters
//   reset, attention stamped) but not the editor starting again.
// - `compact` is the same live session restarting after a compaction; it is
//   the one source that keeps its session file, counters and running agents.
const EDITOR_START_SOURCES = new Set(['startup', 'resume', 'fork']);

// -- Async hook ordering ---------------------------------------------
// PreToolUse, PostToolUse and PostToolUseFailure are registered `"async":
// true` (hooks/hooks.json, setup.js): on Windows every hook is Git Bash plus
// node, ~55-85 ms, and a synchronous Pre + Post blocked the editor for ~170 ms
// on every tool call. Async hooks land in any order, so each session-file
// write records when its event fired and the async ones check it first --
// inside the stats lock, which already serialises the read-modify-write (a
// hook that misses the lock proceeds unlocked; that residual race is accepted).
const ASYNC_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
// When this hook process started -- within a spawn of when the editor fired
// the event, and the only clock a hook has (no payload carries a timestamp).
const EVENT_AT = performance.timeOrigin;
// The finished tool calls a session file remembers, newest last. A Pre that
// lands after its own Post is the commonest inversion (a fast Read or echo:
// both hooks start within milliseconds) and must not resurrect the work face,
// which the renderer would then hold as "still running" for ten minutes.
const DONE_TOOL_IDS_MAX = 16;
// Ids are kept short -- the session file is ~1 KB and this list is its
// largest optional field. The tail of a Claude Code id is its random part.
function shortToolId(id) {
  const s = toText(id);
  return s.length > 16 ? s.slice(-16) : s;
}

// The ordering fields of one session-file write: `eventAt` on every write;
// `syncAt`/`syncEvent` name the newest SYNCHRONOUS event the file has seen
// (an async write carries them forward); `doneToolIds` is the bounded list
// above, with `finishedId` appended by a tool end.
function orderingFields(prev, event, finishedId) {
  const out = { eventAt: EVENT_AT };
  const prevSyncAt = (prev && typeof prev.syncAt === 'number') ? prev.syncAt : 0;
  if (!ASYNC_EVENTS.has(event) && EVENT_AT >= prevSyncAt) {
    out.syncAt = EVENT_AT;
    out.syncEvent = event;
  } else if (prevSyncAt) {
    out.syncAt = prevSyncAt;
    if (typeof prev.syncEvent === 'string') out.syncEvent = prev.syncEvent;
  }
  let done = (prev && Array.isArray(prev.doneToolIds))
    ? prev.doneToolIds.filter(x => typeof x === 'string' && x) : [];
  if (finishedId) {
    done = done.filter(x => x !== finishedId);
    done.push(finishedId);
  }
  if (done.length > DONE_TOOL_IDS_MAX) done = done.slice(-DONE_TOOL_IDS_MAX);
  if (done.length) out.doneToolIds = done;
  return out;
}

// Whether an async event arrived too late to be drawn. Its stats still count;
// only the state-file writes are skipped.
// - A PreToolUse whose call already finished (its tool_use_id is in
//   doneToolIds), or whose call is the one the file's permission prompt is
//   waiting on: Claude Code asks only after the Pre hooks have fired, so that
//   Pre is older than the wait no matter how the two spawns raced -- the
//   exact guard for the race the clock below can lose by a few ms of jitter.
// - Any async event older than the file's newest synchronous write: a slow
//   PreToolUse must never replace the `waiting` a PermissionRequest wrote
//   after it, nor a previous turn's PostToolUse land on "reading your
//   message". A tool END older than a turn end is the exception: it keeps the
//   turn-end carry rules (a late PostToolUseFailure after Stop still shows
//   its error, with `turnEnded` carried), as it always did.
// A sync write further ahead than ORDER_SLACK_MS is a clock that stepped back
// (NTP, a resumed VM), not an inversion -- a real one is milliseconds, a slow
// spawn under load seconds -- and must not freeze every async write until the
// clock catches up (the renderer's FUTURE_SLACK_MS makes the same call).
const ORDER_SLACK_MS = 60000;
function asyncWriteIsStale(event, prev, toolUseId, callKey) {
  if (!ASYNC_EVENTS.has(event) || !prev || typeof prev !== 'object') return false;
  if (event === 'PreToolUse') {
    const id = shortToolId(toolUseId);
    if (id && Array.isArray(prev.doneToolIds) && prev.doneToolIds.includes(id)) return true;
    if (prev.waitingOn && prev.waitingOn === callKey) return true;
  }
  if (typeof prev.syncAt === 'number' && prev.syncAt > EVENT_AT
      && prev.syncAt - EVENT_AT < ORDER_SLACK_MS) {
    return event === 'PreToolUse' || !TURN_CLOSING_EVENTS.has(prev.syncEvent);
  }
  return false;
}

// -- Permission waits ------------------------------------------------
// Claude Code fires Notification(permission_prompt) 6000 ms after a
// permission dialog opens and cancels that timer if the dialog is answered
// first (2.1.300: one setTimeout per can_use_tool ask, cleared when the ask
// settles; CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS turns it off).
// So a PermissionRequest is an UNCONFIRMED wait, and the notification
// confirms it: a wait still unconfirmed well past 6 s was answered (allowed),
// and the tool is running -- its PostToolUse may be minutes away. The
// renderer reads these fields; they live exactly as long as `waitingOn`.
// The lifecycle and every rule about it are in lib/wait.js.
function permissionNotifyEnabled() {
  return notifyEnabled(process.env.CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS);
}

// Notification types that ask for nothing (2.1.300's set). They used to fall
// through to waiting / "needs attention": an elicitation_response arrives
// right after the user ANSWERED an MCP elicitation, and the face went
// straight back to waiting on them. Such a notification draws nothing.
const INFO_NOTIFICATIONS = new Set([
  'elicitation_response', 'elicitation_complete', 'agent_completed',
  'computer_use_exit', 'push_notification', 'plugin_notification',
]);


// firstSeenAt itself comes from state-machine.js's firstSeenFor, which the
// adapters share.

// Per-session counters, and the parking of a non-owner's agents, live in
// state-machine.js (see "Per-Session Counters") -- the adapters share them.

// Session time and records are credited by state-machine.js's creditSession
// (shared with the adapters) -- see creditEndFor for an outgoing owner.

// Read a session file, or null.
function _readSessionFile(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, safeFilename(id) + '.json'), 'utf8'));
  } catch { return null; }
}

// The teammate writes (TeammateIdle, a team TaskCompleted) build their file
// from scratch, but they are still this session's writes: keep its display
// name and provenance, and carry the sticky fields forward. They used to drop
// editor, modelName, model and lastPromptAt -- and since every later write
// carries sticky fields only from the previous file, those stayed lost.
// Not the subagent stamps, though: on a teammate's own file those only ever
// come from the legacy foreign-session misclassification, the main path's
// heal skips teammates, and this from-scratch write is what clears them.
// An agent-routed teammate file (see _writeTeammate) is a child orbital, so
// there the subagent stamps ARE right and every sticky field is carried.
const TEAMMATE_STICKY = STICKY_FIELDS.filter(f => !['parentSession', 'taskDescription', 'agentType'].includes(f));
function _teammateSessionExtra(sessionId, teamExtra, event, agentExtra) {
  const out = {
    modelName: process.env.CODE_CRUMB_MODEL || DEFAULT_MODEL_NAME,
    editor: EDITOR,
    ...teamExtra,
    ...(agentExtra || {}),
    sessionId,
  };
  const prev = _readSessionFile(sessionId);
  if (prev) {
    for (const field of (agentExtra ? STICKY_FIELDS : TEAMMATE_STICKY)) {
      if (prev[field] && !out[field]) out[field] = prev[field];
    }
  }
  out.firstSeenAt = firstSeenFor(prev, Date.now());
  Object.assign(out, orderingFields(prev, event));
  return out;
}

// A teammate's TeammateIdle / TaskCompleted. Claude Code 2.1.300 fires both
// from the teammate's own stop-hook path, with `session_id` = the session it
// runs in and `agent_id` = the teammate -- for an in-process teammate that
// session is the LEAD's. Writing to `session_id` stamped the lead's file
// `isTeammate` (sticky), so the main policy never picked the lead again, and
// the teammate's own orbital ({lead}-agent-{id}, where all its tool events
// go) never got its name and never went idle. With agent_id the write goes
// to that orbital, exactly like every other agent event; without one it is
// the session's own, as before.
function _writeTeammate(sessionId, agentId, agentType, event, state, detail, teamExtra) {
  if (!agentId) {
    writeSessionState(sessionId, state, detail, false, _teammateSessionExtra(sessionId, teamExtra, event));
    return;
  }
  const fileId = subagentSessionId(sessionId, agentId);
  const agentExtra = { parentSession: sessionId };
  if (agentType) { agentExtra.agentType = agentType; agentExtra.modelName = agentType; }
  writeSessionState(fileId, state, detail, false, _teammateSessionExtra(fileId, teamExtra, event, agentExtra));
  _healLeadFile(sessionId);
  // Family heartbeat, as for every agent event.
  _touchSessionFile(sessionId);
}

// A session whose agents are teammates is the team's lead (teams are one
// level deep: "Sessions have a single implicit team"), so a lead file that
// carries teammate fields was poisoned by the routing bug above. Heal it on
// disk without moving its timestamp: the renderer must not re-apply the
// lead's last state as a new write, and the lead's next hook carries the
// healed fields forward (the sticky loop copies only what the file has).
function _healLeadFile(leadId) {
  const prev = _readSessionFile(leadId);
  if (!prev || !prev.isTeammate || prev.parentSession) return;
  const { isTeammate: _i, teammateName: _n, teamName: _t, taskSubject: _s, ...healed } = prev;
  try {
    writeJsonAtomic(path.join(SESSIONS_DIR, safeFilename(leadId) + '.json'), healed, 0o600);
  } catch {}
}

// A subagent's permission prompt: its PermissionRequest carries agent_id and
// went to the agent's orbital, but the 6 s Notification is sent with the
// session's id alone (2.1.300 builds it without the tool's context). Confirm
// the agents' unconfirmed waits that are old enough to be the one this
// notification is about -- otherwise the renderer would resolve them while
// the dialog is still open (agentWaitVerdict, lib/wait.js).
// Returns the agent session-file names (no .json) whose prompt is open and
// confirmed once this returns -- just now, or by an earlier notification:
// the parent stands in for all of them (an agent's SubagentStart can have
// overwritten the parent's own list in between).
function _confirmAgentWaits(sessionId) {
  const confirmed = [];
  try {
    const prefix = safeFilename(sessionId) + '-agent-';
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      const fp = path.join(SESSIONS_DIR, name);
      let s = null;
      try { s = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      const verdict = agentWaitVerdict(s, EVENT_AT);
      if (!verdict) continue;
      // A fresh timestamp: the renderer skips a write whose timestamp it has seen.
      if (verdict === 'confirm') writeJsonAtomic(fp, { ...s, waitConfirmed: true, timestamp: Date.now() }, 0o600);
      confirmed.push(name.slice(0, -'.json'.length));
    }
  } catch {}
  return confirmed;
}

// The same notification also puts the PARENT on "allow?" -- the user is
// needed, and the main face should say so. But allowing the agent's prompt
// produces only the agent's own PostToolUse, and a parent waiting on its
// agent writes nothing, so that wait (and the flashing title) outlived the
// agent's tool by as long as the agent kept working. The parent's wait names
// the agents it stands for (`waitForAgents`) and what it showed before
// (`waitPrev`); when the last of them is answered, the parent goes back.
// The global file gets the same treatment when this session owns it (tmux).
// (releaseStandIn, lib/wait.js: still asking on another agent's behalf, it
// keeps waiting minus this one -- or the next answer still finds it and the
// parent never goes back.)
function _releaseParentWait(parentId, agentFile) {
  try {
    const next = releaseStandIn(_readSessionFile(parentId), agentFile, Date.now());
    if (next) writeJsonAtomic(path.join(SESSIONS_DIR, safeFilename(parentId) + '.json'), next, 0o600);
  } catch {}
  try {
    const g = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const next = g && g.sessionId === parentId ? releaseStandIn(g, agentFile, Date.now()) : null;
    if (next) writeJsonAtomic(STATE_FILE, next, 0o600);
  } catch {}
}

// Top-level string fields out of a payload too large to parse (>1 MB --
// nearly always a PostToolUse carrying a huge tool_response). Claude Code
// serializes the envelope fields before tool_input/tool_response, so the
// first match is the real one. Values with escapes are skipped rather than
// half-decoded; ids never contain any.
const RAW_FIELD_RES = {
  session_id: /"session_id"\s*:\s*"([^"\\]{1,256})"/,
  agent_id: /"agent_id"\s*:\s*"([^"\\]{1,256})"/,
  agent_type: /"agent_type"\s*:\s*"([^"\\]{1,256})"/,
  hook_event_name: /"hook_event_name"\s*:\s*"([^"\\]{1,64})"/,
  source: /"source"\s*:\s*"([^"\\]{1,64})"/,
  tool_name: /"tool_name"\s*:\s*"([^"\\]{1,256})"/,
  // Serialized AFTER tool_response, so it is read from the stream's tail
  // (see inputTail) -- never from the first megabyte.
  tool_use_id: /"tool_use_id"\s*:\s*"([^"\\]{1,256})"/,
};
function _rawField(raw, key) {
  const m = RAW_FIELD_RES[key].exec(raw);
  return m ? m[1] : '';
}

// The toolCallKey of a payload too large to parse, or '' -- what a permission
// prompt's wait is matched against when its allowed call returns >1 MB (an
// MCP screenshot, a huge build log). tool_input is serialized whole before
// tool_response, so it parses back to the value the PermissionRequest hashed
// (rawToolInput). The tool's name alone is not enough: a parallel call of the
// same tool would answer a dialog that is still open.
function _rawCallKey(raw, toolName) {
  const input = toolName ? rawToolInput(raw) : null;
  return input ? toolCallKey(toolName, input) : '';
}

// Argv: `[--editor <name>] <Event>` (cross-platform -- no env var tricks).
// Codex's native hooks and Claude Code's share this script, so the installer
// tags each command with the editor it serves. Unknown flags are ignored so a
// future `--flag` never gets mistaken for the event name.
function parseHookArgs(argv) {
  let editor = '';
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--editor') { editor = argv[i + 1] || ''; i++; continue; }
    if (arg.startsWith('--editor=')) { editor = arg.slice('--editor='.length); continue; }
    if (arg.startsWith('--')) continue;
    positionals.push(arg);
  }
  return { editor, event: positionals[0] || '' };
}

const HOOK_ARGS = parseHookArgs(process.argv.slice(2));

// Editor provenance — which agent CLI this hook serves (distinct from
// modelName). Must be resolved before FALLBACK_SESSION_ID, which embeds it.
const EDITOR = process.env.CODE_CRUMB_EDITOR || HOOK_ARGS.editor || 'claude';
// Display name default follows the editor: a codex hook says "codex is coding".
const DEFAULT_MODEL_NAME = EDITOR;
// Single shared fallback ID — the try and catch paths MUST mint the same
// ID or a session crossing the boundary splits into two orbitals.
const FALLBACK_SESSION_ID = `${EDITOR}-${process.ppid}`;

// Filled in from the payload's hook_event_name when no event positional was
// passed (some hosts pass the event only in the JSON).
let hookEvent = HOOK_ARGS.event;

// -- File I/O --------------------------------------------------------

// Write to the single state file (backward compat with renderer.js)
// pid is the hook's parent — the editor on Unix, where it enables liveness
// rescue. On Windows the ppid is a transient cmd.exe shim (dead within ms):
// useless for protection and a prime PID-recycling target, so it is omitted
// entirely and those sessions rely on staleness timeouts.
// All state writes are atomic (temp + rename): the renderer watches these
// files and must never read a half-written one.
function writeState(state, detail = '', extra = {}) {
  const data = { state, detail, timestamp: Date.now(),
    ...(process.platform !== 'win32' ? { pid: process.ppid } : {}), ...extra };
  try {
    writeJsonAtomic(STATE_FILE, data, 0o600);
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for orbital subagent rendering
function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const filename = safeFilename(sessionId) + '.json';
    const data = {
      session_id: sessionId, state, detail,
      timestamp: Date.now(), cwd: process.cwd(), stopped,
      // editor PID on Unix (hook runs as child of the long-lived editor);
      // omitted on Windows where ppid is a transient shim (recycling hazard)
      ...(process.platform !== 'win32' ? { pid: process.ppid } : {}),
      ...extra,
    };
    writeJsonAtomic(path.join(SESSIONS_DIR, filename), data, 0o600);
  } catch {
    // Silently fail
  }
}

// Write tool state to an active subagent's session file, preserving sticky fields.
// Pure logic lives in state-machine.js (buildSubagentSessionState); this is the I/O wrapper.
function _writeSubagentToolState(sub, state, detail, parentSessionId) {
  try {
    const fp = path.join(SESSIONS_DIR, safeFilename(sub.id) + '.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
    const built = buildSubagentSessionState(existing, sub, parentSessionId, process.cwd());
    if (!built) return;
    writeSessionState(sub.id, state, detail, false, built);
  } catch {}
}

// Retire a tracked agent (an activeSubagents entry): SubagentStop for one,
// SessionEnd for all that are left. The write is rebuilt from the entry, so
// what only the file knows (the resolved model, the other sticky fields)
// comes from the file itself. And the retirement is the agent's newest
// synchronous word: an async PreToolUse of its own that lands after it must
// not revive it. SessionEnd's sweep built its own write without either, and a
// late Pre brought the agent back as a live `testing` orbital.
function _retireSubagent(sub, parentSessionId, event, agentType) {
  const prev = _readSessionFile(sub.id);
  const extra = {
    sessionId: sub.id, stopped: true, cwd: process.cwd(),
    gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
    parentSession: parentSessionId, taskDescription: sub.taskDescription || sub.description,
    modelName: sub.model || 'haiku', editor: sub.editor || EDITOR,
    ...((sub.agentType || agentType) ? { agentType: sub.agentType || agentType } : {}),
  };
  if (prev) {
    for (const field of STICKY_FIELDS) {
      if (prev[field] && !extra[field]) extra[field] = prev[field];
    }
  }
  writeSessionState(sub.id, 'happy', 'done', true, { ...extra, ...orderingFields(prev, event) });
}

// Touch (refresh mtime on) the active subagent files that have no writer of
// their own -- the legacy synthetics, created by a SubagentStart that carried
// no agent_id. The parent is their only voice: it writes their state through
// _writeSubagentToolState, so it must also keep their mtime alive.
//
// Entries WITH an agentId are deliberately skipped. A real per-agent orbital
// keeps itself fresh by writing, and a child must never be kept alive solely
// by its parent's activity: that composes with the renderer accepting a newer
// mtime on unchanged content (grid.js updateFromFile) into a ghost, where a
// missed SubagentStop leaves an orbital that the parent's own tool calls
// revive for the whole SUBAGENT_MAX_AGE_MS window -- pinning the main face at
// "conducting N" for four hours. The child -> parent heartbeat below is the
// sound direction: an agent writing proves its parent's family is alive.
function _touchActiveSubagents(activeSubagents) {
  for (let i = 0; i < activeSubagents.length; i++) {
    if (activeSubagents[i].agentId) continue;
    _touchSessionFile(activeSubagents[i].id);
  }
}

// Refresh one session file's mtime without rewriting it.
// Used as the family heartbeat: a parent waiting on its agents fires no hooks
// of its own, so its session file would go stale and the renderer could not
// tell a live conductor from a crashed one. Every agent event stamps the
// parent's file here, so "parent file fresh" means the family is alive -- and
// a crashed parent goes stale on the normal schedule, taking its ghost
// orbitals with it instead of letting them animate for CHILD_ORPHAN_TIMEOUT.
function _touchSessionFile(sessionId) {
  try {
    const fp = path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');
    const now = new Date();
    fs.utimesSync(fp, now, now);
  } catch {}
}

// Raw model id out of a transcript JSONL, or '' for anything unreadable.
//
// Always scans the TAIL, newest line first. That is obviously right for a main
// session (the newest line reflects a mid-session /model switch) and turns out
// to be the only thing that works for a subagent too: an agent's transcript
// opens with attachment and context entries that ran to 26-64 KB per line on
// every real sample, so the first `message.model` sits far past any sane head
// window -- while the model cannot change within an agent's run, so the newest
// line is just as true as the first. Reading the head found nothing on all
// five real agent transcripts; the tail found the model on all five.
//
// Only TRANSCRIPT_READ_BYTES are read -- a transcript reaches megabytes and
// readFileSync would blow the ~50ms hook budget on its own.
//
// The transcript's shape is NOT a documented interface, so this is
// best-effort by construction: every failure returns '' and the caller simply
// carries on without a model.
function _readTranscriptModel(filePath) {
  if (!filePath) return '';
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (!size) return '';
    const want = Math.min(size, TRANSCRIPT_READ_BYTES);
    const pos = size - want;
    const buf = Buffer.alloc(want);
    const read = fs.readSync(fd, buf, 0, want, pos);
    const lines = buf.toString('utf8', 0, read).split('\n');
    // Drop the line the window cut in half.
    if (pos > 0) lines.shift();
    lines.reverse();
    let scanned = 0;
    for (const line of lines) {
      if (scanned++ >= TRANSCRIPT_MAX_LINES) break;
      if (line.length < 16 || line.indexOf('"model"') === -1) continue;
      try {
        const entry = JSON.parse(line);
        // `message.model` specifically: a bare "model" also appears inside
        // attachment entries, which are not what we are after.
        const m = entry && entry.message && entry.message.model;
        // `<synthetic>` marks an entry no model produced (a usage-limit
        // notice, "No response requested.") -- keep looking past it.
        if (typeof m === 'string' && m && m[0] !== '<') return m;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  return '';
}

// Persistent stats (streaks, records, session counters). normalizeStats
// repairs a {} / old-schema file so nothing below can throw on a missing key.
function readStats() {
  try {
    return normalizeStats(JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')));
  } catch {
    return defaultStats();
  }
}

function writeStats(stats) {
  try { writeJsonAtomic(STATS_FILE, stats, 0o600); } catch {}
}

// -- Autolaunch ------------------------------------------------------

// If the renderer isn't running and the user has opted in, spawn it in
// a new terminal window. Runs on every hook call — the fast path (PID
// alive) costs ~1-2ms, well within the 50ms hook budget. When the renderer
// is down, parallel tool calls fire several hooks at once; the spawn lock
// lets exactly one of them open a window per 5s.
function ensureRendererRunning(editorStarting = false) {
  try {
    // Check pref — fast sync read, bail early if disabled
    if (!loadPrefs().autolaunch) return;

    // Check quit flag — user intentionally quit, don't auto-relaunch. The
    // renderer writes it on every exit and nothing else removed it, so one
    // closed window disabled autolaunch for good. It now lasts until the
    // editor starts again -- a `startup` SessionStart, or `resume` (how
    // `claude --continue` / `--resume` and `codex resume` start) -- which is
    // exactly the moment the setup prompt promises a launch.
    if (editorStarting) {
      try { fs.unlinkSync(QUIT_FLAG_FILE); } catch {}
    }
    try { fs.accessSync(QUIT_FLAG_FILE); return; } catch {}

    // Renderer alive (PID file with a fresh heartbeat)? Nothing to do.
    if (isRendererAlive(PID_FILE)) return;

    // Renderer dead/missing — one hook spawns it, the rest back off.
    if (!acquireSpawnLock(SPAWN_LOCK_FILE, 5000)) return;

    spawnRendererWindow(path.resolve(__dirname, 'renderer.js'), 'Code Crumb');
  } catch {} // Never throw from a hook
}

// -- Degraded path ---------------------------------------------------

// Writes for a hook whose payload could not be used whole: empty or
// non-JSON stdin, a payload too large to parse (ids regex-extracted), or one
// that parsed and then threw. `ids` holds whatever envelope ids survived
// ({ sessionId, agentId, agentType }, any of them empty); `override` is a
// { state, detail } classification that replaces the event map below.
// Serialised behind the stats lock like the main path: a payload over 1 MB is
// nearly always a PostToolUse, which now races its own (async) PreToolUse.
function writeFallback(ids, override) {
  const release = acquireFileLock(STATS_LOCK_FILE);
  try { _writeFallback(ids, override); } finally { if (release) release(); }
}

function _writeFallback(ids, override) {
  // JSON parse may fail for events with empty or non-JSON stdin
  // (e.g., Stop, Notification, lifecycle events) -- still write the
  // correct state for the hook event.
  // When the payload named its session, that id is the truth. Otherwise try
  // to reuse the session ID from the global state file so we don't create an
  // orphan session file that appears as a phantom orbital.
  const knownSid = (ids && ids.sessionId) || '';
  const agentId = (ids && ids.agentId) || '';
  const agentType = (ids && ids.agentType) || '';
  // Same routing as the main path: an agent's event is its own orbital's.
  const isAgent = !!agentId && !AGENT_EXCLUDED_EVENTS.has(hookEvent);
  const originalFallbackId = knownSid || process.env.CLAUDE_SESSION_ID || FALLBACK_SESSION_ID;
  let fallbackSessionId = originalFallbackId;
  let shouldWriteGlobal = true;
  let globalWasOurStop = false;
  try {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (existing.sessionId && !knownSid) {
      fallbackSessionId = existing.sessionId;
    }
    if (existing.sessionId && existing.sessionId !== originalFallbackId &&
        !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
      shouldWriteGlobal = false;
    }
    globalWasOurStop = !!existing.stopped && existing.sessionId === fallbackSessionId;
  } catch {}

  // Same parentSession guard as the try block above — subagents must not write global state.
  // Uses originalFallbackId (the caller's identity), not fallbackSessionId
  // (which may be the adopted main session's ID from the state file).
  if (shouldWriteGlobal) {
    try {
      const mySession = JSON.parse(fs.readFileSync(
        path.join(SESSIONS_DIR, safeFilename(originalFallbackId) + '.json'), 'utf8'));
      if (mySession.parentSession) shouldWriteGlobal = false;
    } catch {}
  }

  // SessionStart always takes over global state — explicit new-session signal
  if (hookEvent === 'SessionStart') shouldWriteGlobal = true;
  // An agent event is an orbital by definition, never the global owner.
  if (isAgent) shouldWriteGlobal = false;

  const fallbackExtra = { sessionId: fallbackSessionId, modelName: process.env.CODE_CRUMB_MODEL || DEFAULT_MODEL_NAME, editor: EDITOR };

  let fallbackState = 'thinking';
  let fallbackDetail = '';
  if (hookEvent === 'SessionEnd') {
    fallbackState = 'responding';
    fallbackDetail = 'session ending';
    fallbackExtra.stopped = true;
  } else if (hookEvent === 'Stop') {
    fallbackState = 'responding';
    fallbackDetail = 'wrapping up';
    fallbackExtra.stopped = true; // for global state only
  } else if (hookEvent === 'Notification') {
    fallbackState = 'waiting';
    fallbackDetail = 'needs attention';
  } else if (hookEvent === 'UserPromptSubmit') {
    fallbackState = 'thinking';
    fallbackDetail = 'reading your message';
    fallbackExtra.lastPromptAt = Date.now();
    fallbackExtra.answered = true;   // the user spoke (a big paste lands here)
  } else if (hookEvent === 'TeammateIdle') {
    fallbackState = 'waiting';
    fallbackDetail = 'teammate idle';
  } else if (hookEvent === 'TaskCompleted') {
    fallbackState = 'happy';
    fallbackDetail = 'task done';
  } else if (hookEvent === 'SessionStart') {
    fallbackState = 'idle';
    fallbackDetail = 'session starting';
    fallbackExtra.isSessionStart = true;
    // No payload here, so no `source` to check: a fallback SessionStart
    // always counts as attention (see the main path's compaction guard).
    fallbackExtra.lastPromptAt = Date.now();
    // Clean up any stale session file from previous session with same ID
    const staleSessionFile = path.join(SESSIONS_DIR, safeFilename(fallbackSessionId) + '.json');
    try { fs.unlinkSync(staleSessionFile); } catch {}
  } else if (hookEvent === 'SubagentStart') {
    fallbackState = 'subagent';
    fallbackDetail = 'spawning subagent';
    // Create subagent orbital file even in fallback path
    const subId = `${fallbackSessionId}-sub-${Date.now()}`;
    writeSessionState(subId, 'spawning', 'subagent', false, {
      sessionId: subId, parentSession: fallbackSessionId,
      modelName: 'haiku', editor: EDITOR, taskDescription: 'subagent',
      synthetic: true,   // no writer of its own (see the main path's SubagentStart)
    });
  } else if (hookEvent === 'SubagentStop') {
    fallbackState = 'happy';
    fallbackDetail = 'subagent done';
  } else if (hookEvent === 'PostToolUseFailure') {
    fallbackState = 'error';
    fallbackDetail = 'tool failed';
  } else if (hookEvent === 'PreCompact') {
    fallbackState = 'thinking';
    fallbackDetail = 'compacting memory';
  } else if (hookEvent === 'PostCompact') {
    fallbackState = 'satisfied';
    fallbackDetail = 'memory compacted';
  } else if (hookEvent === 'PermissionRequest') {
    fallbackState = 'waiting';
    fallbackDetail = 'needs permission';
  } else if (hookEvent === 'PermissionDenied') {
    // No payload, so no tool to match against a pending wait: a denial is
    // still an answer -- the tool will not run, and nothing else says so.
    fallbackState = 'thinking';
    fallbackDetail = 'permission denied';
    fallbackExtra.answered = true;
  } else if (hookEvent === 'Setup') {
    fallbackState = 'starting';
    fallbackDetail = 'setting up';
  } else if (hookEvent === 'Elicitation') {
    fallbackState = 'waiting';
    fallbackDetail = 'needs input';
  } else if (hookEvent === 'ElicitationResult') {
    fallbackState = 'satisfied';
    fallbackDetail = 'input received';
    fallbackExtra.answered = true;
  } else if (hookEvent === 'ConfigChange') {
    fallbackState = 'reading';
    fallbackDetail = 'config updated';
  } else if (hookEvent === 'InstructionsLoaded') {
    fallbackState = 'reading';
    fallbackDetail = 'loading instructions';
  } else if (hookEvent === 'PostModelSwitch') {
    // No payload here, so no to_model to name.
    fallbackState = 'thinking';
    fallbackDetail = 'model switched';
  } else if (hookEvent === 'StopFailure' || hookEvent === 'Interrupt') {
    fallbackState = 'error';
    fallbackDetail = hookEvent === 'Interrupt' ? 'interrupted' : 'API error';
    // The failed turn is over: global `stopped`, session-file `turnEnded`.
    // Not an agent's: its StopFailure lands here (AGENT_EXCLUDED_EVENTS) but
    // is its own turn failing, as on the main path (see closesTurn).
    if (!agentId) fallbackExtra.stopped = true;
  }
  // A classification from the raw (truncated) payload beats the event map.
  if (override && override.state) {
    fallbackState = override.state;
    fallbackDetail = override.detail || '';
  }
  // An agent's Stop is its own turn ending -- not the parent's, not the session's.
  if (isAgent) delete fallbackExtra.stopped;

  // Always write per-session file so parallel sessions appear as orbitals.
  // The adopted owner id is only right when we ARE the owner (shouldWriteGlobal);
  // otherwise this hook belongs to some other session and must write its own
  // orbital file, not overwrite the owner's.
  const sessionFileId = isAgent
    ? subagentSessionId(originalFallbackId, agentId)
    : (shouldWriteGlobal ? fallbackSessionId : originalFallbackId);
  const sessionExtra = { ...fallbackExtra, sessionId: sessionFileId };
  if (isAgent) {
    sessionExtra.parentSession = originalFallbackId;
    if (agentType) { sessionExtra.agentType = agentType; sessionExtra.modelName = agentType; }
  }
  // The file this write carries on from (see nextSessionFile below). A fresh
  // SessionStart reads nothing: its predecessor was just unlinked.
  let prevSession = null;
  if (hookEvent !== 'SessionStart') prevSession = _readSessionFile(sessionFileId);
  // The async ordering rules hold here too (see asyncWriteIsStale). There is
  // no call to match a wait against, but the tail of a truncated stream still
  // names the tool_use_id.
  const toolUseId = (ids && ids.toolUseId) || '';
  if (asyncWriteIsStale(hookEvent, prevSession, toolUseId, '')) return;
  // The same carry as the main path, through the same function: the
  // tombstones (an ended session stays ended through every echo), an open
  // permission prompt -- answered by the waited call's own huge result,
  // matched by the call key from the raw payload, and kept through any other
  // -- and the sticky fields, above all lastPromptAt, whose loss dropped the
  // window to attention 0 and moved the center away. Each path once kept its
  // own copy of these rules, and they drifted apart.
  const next = nextSessionFile(prevSession, {
    event: hookEvent, agentId, isAgent, state: fallbackState, detail: fallbackDetail,
    fields: sessionExtra, callKey: (ids && ids.callKey) || '',
  });
  next.fields.firstSeenAt = firstSeenFor(prevSession, Date.now());
  Object.assign(next.fields, orderingFields(prevSession, hookEvent,
    (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') ? shortToolId(toolUseId) : ''));
  const globalExtra = stopsGlobal(prevSession, {
    event: hookEvent, agentId, isAgent, state: fallbackState, globalOwnStop: globalWasOurStop,
  }) ? { ...fallbackExtra, stopped: true } : fallbackExtra;
  if (shouldWriteGlobal) writeState(fallbackState, fallbackDetail, globalExtra);
  writeSessionState(sessionFileId, next.state, next.detail, next.stopped, next.fields);
  // An agent's prompt was answered: a parent standing in for it goes back.
  if (isAgent && next.fields.answered) _releaseParentWait(originalFallbackId, safeFilename(sessionFileId));
  // Family heartbeat, as on the main path.
  if (isAgent) _touchSessionFile(originalFallbackId);
}

// -- Main handler ----------------------------------------------------

// Read stdin
let input = '';
const MAX_INPUT = 1048576;
let inputTruncated = false;
// The last few KB of a stream too large to keep: the envelope fields that
// Claude Code serializes after tool_response (tool_use_id) live there.
let inputTail = '';
const INPUT_TAIL = 4096;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (input.length < MAX_INPUT) input += chunk;
  else inputTruncated = true;
  inputTail = (inputTail + chunk).slice(-INPUT_TAIL);
});
// The LAST match in the tail: a tool_response can quote the key itself, but
// the real envelope field is serialized after it.
function _tailField(key) {
  const re = new RegExp(RAW_FIELD_RES[key].source, 'g');
  let m, last = '';
  while ((m = re.exec(inputTail))) last = m[1];
  return last;
}
process.stdin.on('end', () => {
  // Payload recorder (lib/recorder.js): stdin exactly as received, before any
  // state logic. The env check first, so a disabled recorder is never loaded.
  if (process.env.CODE_CRUMB_RECORD) {
    try {
      require('./lib/recorder').record({ source: `${EDITOR}-hook`, editor: EDITOR, event: hookEvent,
        argv: process.argv.slice(2), raw: input, tail: inputTail, truncated: inputTruncated });
    } catch {}
  }
  ensureRendererRunning(
    (hookEvent || _rawField(input, 'hook_event_name')) === 'SessionStart'
    && EDITOR_START_SOURCES.has(_rawField(input, 'source')));
  if (inputTruncated) {
    // Too large to parse. The envelope ids are still recoverable from the raw
    // text, and they must be: this used to write ONLY the global file, with
    // no sessionId, ignoring ownership and agent_id -- so the unified renderer
    // (which follows session files) never saw the event, and a foreign
    // session clobbered the global owner's state.
    try {
      if (!hookEvent) hookEvent = _rawField(input, 'hook_event_name');
      const truncResult = classifyTruncatedInput(hookEvent, input,
        { trustSuccess: EDITOR === 'claude' && hookEvent === 'PostToolUse' });
      // Only a tool end can answer a wait, so only it pays for the scan.
      const callKey = (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure')
        ? _rawCallKey(input, _rawField(input, 'tool_name')) : '';
      writeFallback({
        sessionId: _rawField(input, 'session_id'),
        agentId: _rawField(input, 'agent_id'),
        agentType: _rawField(input, 'agent_type'),
        toolUseId: _tailField('tool_use_id'),
        callKey,
      }, truncResult);
    } catch {}
    process.exit(0);
  }
  let state = 'thinking';
  let detail = '';
  let stopped = false;
  let diffInfo = null;
  let workState = null;
  let workDetail = null;
  let waitingOn = null; // set by a PermissionRequest (see toolCallKey)
  // A permission wait's confirmation fields (see WAIT_FIELDS), or null.
  let waitFields = null;
  // Set by a PermissionDenied that answers the pending wait.
  let permissionAnswered = false;
  // Set by a permission Notification that finds the session's own prompt
  // long answered: that prompt's wait fields are not carried forward.
  let ownWaitAnswered = false;
  let compacting = false; // a PreCompact that is real work on this session
  // A compaction restart normally carries lastPromptAt forward off its own
  // session file. Set when that file is gone, so there is nothing to carry.
  let compactWithoutPredecessor = false;
  // Set by a StopFailure: the failed turn is over (see its handler).
  let failureEndsTurn = false;
  // The ids of a payload that parsed but then threw further down. The catch
  // path reuses them instead of minting `<editor>-<ppid>` -- a fresh phantom
  // orbital per hook on win32, with the real event lost.
  let parsedIds = null;

  try {
    const data = JSON.parse(input);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      parsedIds = {
        sessionId: toText(data.session_id),
        agentId: toText(data.agent_id),
        agentType: toText(data.agent_type),
      };
    }
    // Codex (and any host that omits the argv event) names it in the payload
    if (!hookEvent) hookEvent = toText(data.hook_event_name);
    const toolName = toText(data.tool_name);
    const toolInput = (data.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
    const toolResponse = normalizeToolResponse(data);

    // Extract session ID: try hook data, env, then fall back to editor-prefixed PPID
    const sessionId = toText(data.session_id)
      || process.env.CLAUDE_SESSION_ID
      || FALLBACK_SESSION_ID;

    // Claude Code subagent attribution. Every hook fired inside a subagent
    // call carries the PARENT's session_id plus agent_id / agent_type, so
    // without reading agent_id the agent's whole turn lands on the main face.
    // An agent event is routed to its own orbital file (parent + agent id)
    // and never writes the global state file or the parent's session file.
    const agentId = toText(data.agent_id);
    const agentType = toText(data.agent_type);
    const isAgentEvent = !!agentId && !AGENT_EXCLUDED_EVENTS.has(hookEvent);
    const agentSessionId = isAgentEvent ? subagentSessionId(sessionId, agentId) : '';
    // The session file this hook owns: the agent's orbital, or our own.
    const writeSessionId = isAgentEvent ? agentSessionId : sessionId;

    // Load persistent stats. Everything from here to the final writeStats()
    // is one read-modify-write: parallel tool calls fire parallel hooks, and
    // without the lock the last writer would silently drop the others'
    // counter increments. A failed acquire proceeds unlocked -- the hook
    // must never stall the editor waiting on a courtesy lock.
    const releaseStats = acquireFileLock(STATS_LOCK_FILE);
    try {
    const stats = readStats();

    // The file this hook will write, as it stands before the write -- read
    // inside the lock, so the ordering decision and the write are one step.
    const prevSessionFile = _readSessionFile(writeSessionId);
    const toolUseId = toText(data.tool_use_id);
    const callKey = toolCallKey(toolName, toolInput);
    // An async event that lost the race to a newer write: it still counts
    // (tool calls, streak, commits), but it writes no state. See
    // asyncWriteIsStale.
    const staleWrite = asyncWriteIsStale(hookEvent, prevSessionFile, toolUseId, callKey);

    // Daily tracking -- reset counters on new day
    const today = localDay();
    if (!stats.daily || stats.daily.date !== today) {
      stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
    }
    if (!stats.frequentFiles) stats.frequentFiles = Object.create(null);
    // Registry of known top-level sessions (#134) — populated at SessionStart,
    // which real subagents never fire. Used to tell parallel editor windows
    // apart from subagents when their hooks interleave.
    if (!stats.topLevelSessions) stats.topLevelSessions = Object.create(null);
    // A user prompt is proof of a top-level session, and so is a Stop that
    // carries no agent_id (a subagent's turn ends in SubagentStop, or in a
    // Stop WITH agent_id). Registering here, before classification, rescues a
    // window that never fired SessionStart through these hooks -- opened
    // before they were installed -- from being filed as the conducting
    // owner's subagent: its prompt stamped parentSession, so the main policy
    // could never pick it, and its first tool call retired a live agent orbital.
    if (!agentId && (hookEvent === 'UserPromptSubmit' || hookEvent === 'Stop')) {
      stats.topLevelSessions[sessionId] = Date.now();
      pruneTopLevelSessions(stats.topLevelSessions, Date.now());
    }

    // Detect subagent sessions: different session_id while parent has active subagents.
    // Subagent hooks fire with their own session_id, not the parent's.
    // Without this, subagent hooks would trigger session reset (wiping parent stats)
    // and write tool state to the global file instead of their own orbital file.
    // Lifecycle events have dedicated handlers and must not be rerouted to subagent files.
    // Per-session interactive events (PermissionRequest, Elicitation, ElicitationResult)
    // stay OUT of this set so they correctly route to orbital files in subagent context.
    // `PostModelSwitch` is deliberately NOT here, unlike in
    // AGENT_EXCLUDED_EVENTS -- the two sets answer different questions. This
    // one only decides whether the foreign-session heuristic runs, and
    // skipping it lets the session-reset below fire: a `/model` in a parallel
    // window would wipe a conducting owner's activeSubagents (orphaning its
    // orbitals and breaking SubagentStop matching). A `/model` is frequent and
    // user-triggered, and a subagent never fires one, so it must classify.
    const LIFECYCLE_EVENTS = new Set([
      'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
      'PreCompact', 'PostCompact', 'Setup', 'ConfigChange',
      'InstructionsLoaded', 'StopFailure',
    ]);

    let isKnownSubagent = false;
    let isParallelSession = false;
    // agent_id is authoritative -- when it is present the foreign-session
    // heuristic below is not consulted at all (it exists for hosts whose
    // subagents report under their own session id).
    if (!isAgentEvent
        && stats.session.id && stats.session.id !== sessionId
        && stats.session.activeSubagents && stats.session.activeSubagents.length > 0
        && !LIFECYCLE_EVENTS.has(hookEvent)) {
      // Foreign session while the owner is conducting: real subagent, or an
      // unrelated parallel top-level window? (#134) Without this distinction,
      // every parallel session gets stamped as a subagent of the conductor.
      const registryHit = !!stats.topLevelSessions[sessionId];
      // When this session's file was first written (see firstSeenAt in
      // STICKY_FIELDS). Birthtime only for a file that predates the field --
      // it is the time of the LAST write, since every write replaces the file.
      // (Not an agent event here, so prevSessionFile is this session's own.)
      let fileBornAt = null;
      if (prevSessionFile && typeof prevSessionFile.firstSeenAt === 'number'
          && prevSessionFile.firstSeenAt > 0) {
        fileBornAt = prevSessionFile.firstSeenAt;
      } else {
        try {
          const st = fs.statSync(path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'));
          if (st.birthtimeMs > 0) fileBornAt = st.birthtimeMs;
        } catch {}
      }
      const earliestSubagentStart = Math.min(
        ...stats.session.activeSubagents.map(s => s.startedAt || 0));
      if (classifyForeignSession({ registryHit, fileBornAt, earliestSubagentStart }) === 'parallel') {
        isParallelSession = true;
      } else {
        isKnownSubagent = true;
      }
    }
    // Keep registry entries fresh for active windows so the TTL prune
    // only drops sessions that are actually gone.
    if (stats.topLevelSessions[sessionId] && !isKnownSubagent) {
      stats.topLevelSessions[sessionId] = Date.now();
    }

    // Initialize session if new (skip for known subagents to preserve parent
    // stats, and for parallel sessions so they don't wipe the conducting
    // owner's activeSubagents tracking mid-dispatch).
    // Agent events are excluded outright: they carry their PARENT's session_id,
    // and when that parent is not the stats owner this reset would adopt it and
    // wipe the owner's activeSubagents -- orphaning the owner's live orbitals
    // and losing its session records, once per ping-pong between the two.
    // A subagent's tool call is never a top-level turn boundary.
    // Per-session counters (see COUNTER_MAX_AGE_MS). An agent event counts
    // toward its parent (sessionId IS the parent there); a legacy subagent
    // reporting under its own id counts toward its own entry, never the owner's.
    const now = Date.now();
    if (!stats.sessionCounters || typeof stats.sessionCounters !== 'object'
        || Array.isArray(stats.sessionCounters)) {
      stats.sessionCounters = Object.create(null);
    }
    const counters = stats.sessionCounters;
    // Seed the owner's entry from stats.session when it has none (a stats
    // file from before this map, or an owner adopted by an adapter). It was
    // already counted as a session when it was adopted.
    if (stats.session.id && !_normalizeCounter(counters[stats.session.id], now)) {
      counters[stats.session.id] = {
        toolCalls: stats.session.toolCalls || 0,
        filesEdited: (stats.session.filesEdited || []).filter(f => typeof f === 'string').slice(0, COUNTER_MAX_FILES),
        start: stats.session.start || now, commitCount: stats.session.commitCount || 0,
        creditedMs: 0, lastSeen: now, countedDay: stats.daily.date,
      };
    }
    let counter = _normalizeCounter(counters[sessionId], now);
    if (!counter) counter = counters[sessionId] = _freshCounter(now);
    touchCounter(counter, now);
    // daily.sessionCount counts sessions, once per id -- not once per switch
    // of stats.session ownership, which two alternating windows did on every
    // hook. An agent event does not count its parent (the parent's own events
    // will), nor does a legacy subagent count itself.
    if (counter.countedDay !== stats.daily.date && !isAgentEvent && !isKnownSubagent) {
      stats.daily.sessionCount++;
      counter.countedDay = stats.daily.date;
    }

    if (stats.session.id !== sessionId && !isAgentEvent && !isKnownSubagent && !isParallelSession) {
      // Credit the outgoing owner's records, then adopt this session with its
      // OWN counters -- a switch is not a new session.
      const outgoing = stats.session.id ? counters[stats.session.id] : null;
      if (outgoing) _creditSession(stats, outgoing, creditEndFor(outgoing, now));
      if ((stats.session.subagentCount || 0) > (stats.records.mostSubagents || 0)) {
        stats.records.mostSubagents = stats.session.subagentCount;
      }
      // Park the outgoing owner's agent bookkeeping on its own counter entry
      // and restore this session's. A lifecycle event from a parallel window
      // (SessionStart, PreCompact...) skips the foreign-session classifier and
      // takes ownership, and that used to wipe a conducting owner's
      // activeSubagents -- orphaning its synthetic orbitals and leaving its
      // SubagentStops nothing to match once it took ownership back.
      _parkAgents(outgoing, stats.session);
      stats.session = {
        id: sessionId, start: counter.start,
        toolCalls: counter.toolCalls, filesEdited: counter.filesEdited.slice(),
        subagentCount: 0, commitCount: counter.commitCount,
      };
      _unparkAgents(counter, stats.session);
    }

    // Initialize subagent tracking for synthetic orbital sessions
    if (!stats.session.activeSubagents) stats.session.activeSubagents = [];
    // Safety net for a missed SubagentStop. Agents legitimately run for hours,
    // so this is deliberately generous -- the old 10-minute cut dropped every
    // long-running agent from the orbital display while it was still working.
    stats.session.activeSubagents = stats.session.activeSubagents.filter(
      sub => Date.now() - sub.startedAt < SUBAGENT_MAX_AGE_MS
    );

    // Clear old milestones (older than 8 seconds)
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    // Real model identity. Claude Code carries it only on SessionStart
    // (`model`) and PostModelSwitch (`to_model`), so everything else is either
    // carried forward by STICKY_FIELDS or read out of a transcript once.
    // Codex puts a required `model` on EVERY hook payload -- and has no
    // PostModelSwitch, and its rollout JSONL has no message.model -- so a
    // payload model is taken whenever one is present: it is free, and the
    // only way a Codex session ever follows a /model. (PostModelSwitch also
    // fires with source 'resume', so a restored session re-stamps itself.)
    // Every transcript-backed path needs one, and only Claude Code sends it:
    // checking first keeps Codex and the adapters at zero extra reads.
    const transcriptPath = toText(data.transcript_path);
    // Not from a lifecycle event an agent fires into its PARENT's records:
    // Codex runs SubagentStart/Stop (and an agent's compaction) inside the
    // child, so their `model` is the child's, and it replaced the parent's on
    // the status line for as long as the child ran.
    const payloadModel = (agentId && !isAgentEvent)
      ? '' : toText(hookEvent === 'PostModelSwitch' ? data.to_model : data.model);
    let rawModel = '';
    if (payloadModel) {
      rawModel = payloadModel;
    } else if (isAgentEvent && transcriptPath) {
      // SubagentStart carries no model at all, so an agent's own transcript is
      // the only source. The agent's session file is the memory: once stamped,
      // this never reads again -- hence one bounded read per agent, not per
      // hook. (The file does not exist yet at SubagentStart, which is excluded
      // from isAgentEvent anyway; the first real tool event resolves it, and
      // an event before the agent's first model reply simply retries later.)
      let known = '';
      try {
        known = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(agentSessionId) + '.json'), 'utf8')).model || '';
      } catch {}
      if (!known) {
        rawModel = _readTranscriptModel(agentTranscriptPath(transcriptPath, agentId));
      }
    } else if (hookEvent === 'Stop' && transcriptPath) {
      // Covers the hole in the free path: SessionStart's `model` is optional
      // and Claude Code does not always send it. The tail at a turn end (after
      // the assistant has written) is the model that was actually just used.
      //
      // Deliberately NOT gated on "no model known yet". An install predating
      // the PostModelSwitch hook never gets the switch event, so a gate would
      // pin the first model it ever saw and show it confidently forever after
      // a /model. A stale label is worse than none; re-reading once per turn
      // self-heals, and costs one bounded 32 KB read against a hook whose cost
      // is dominated by starting node itself (getGitBranch reads .git/HEAD
      // directly -- no child process is spawned anywhere on this path).
      rawModel = _readTranscriptModel(transcriptPath);
    }
    const model = prettyModelName(rawModel);

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));

      // Every session counts its own tool calls (see COUNTER_MAX_AGE_MS in
      // state-machine.js); the lifetime totals are handled below.
      counter.toolCalls++;
      const fp = EDIT_TOOLS.test(toolName)
        ? toText(toolInput.file_path || toolInput.notebook_path || toolInput.path || toolInput.target_file) : '';
      const base = fp ? path.basename(fp) : '';
      if (base && !counter.filesEdited.includes(base) && counter.filesEdited.length < COUNTER_MAX_FILES) {
        counter.filesEdited.push(base);
      }
      // Lifetime totals: every top-level window counts once. A parallel
      // window used to be left out only while the owner was conducting (the
      // one time it is classified), though its calls are counted nowhere
      // else. A legacy subagent's calls are its parent's work, not a window's.
      if (!isKnownSubagent) {
        stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;
        if (base) {
          stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
          pruneFrequentFiles(stats.frequentFiles, base);
        }
      }

      // Propagate tool state to the most recently started LEGACY subagent
      // orbital (an entry with no agentId: it has no writer of its own, so
      // the parent's sequential tool calls are the best picture of its work).
      // Only then does the parent show "conducting" -- the tool state went to
      // the orbital. An agent-owned entry writes its own orbital, so the
      // parent's real work passes straight through: overriding it hid every
      // parent Edit/Bash behind "conducting N" for as long as an agent ran.
      // The renderer's liveChildren conducting hold covers the idle gaps.
      // Skip entirely for known subagents (they write their own session
      // files), parallel windows (their tools belong to no subagent here),
      // agent events (already routed to their own orbital), and a stale Pre
      // (its call already finished: see asyncWriteIsStale).
      if (stats.session.activeSubagents.length > 0 && !SUBAGENT_TOOLS.test(toolName)
          && !isKnownSubagent && !isParallelSession && !isAgentEvent && !staleWrite) {
        const latest = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
        _touchActiveSubagents(stats.session.activeSubagents);
        if (!latest.agentId) {
          _writeSubagentToolState(latest, state, detail, sessionId);
          state = 'subagent';
          detail = `conducting ${stats.session.activeSubagents.length}`;
        }
      }
    }
    else if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {
      // PostToolUseFailure is the same as PostToolUse but the tool execution
      // itself failed -- force the error flag so we always show error state.
      const isErrorFlag = hookEvent === 'PostToolUseFailure'
        || toolResponse?.isError || data?.isError || false;
      // Claude Code sends a failing tool as PostToolUseFailure, never as
      // PostToolUse (checked against 2.1.300), so its PostToolUse is a
      // success the host vouches for and its output is not searched for
      // failure words (trustSuccess, in classifyToolResult). Codex has no
      // PostToolUseFailure -- its PostToolUse fires for failures too -- so
      // its output is still read.
      const result = classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag,
        { trustSuccess: EDITOR === 'claude' && hookEvent === 'PostToolUse' });
      state = result.state;
      detail = result.detail;
      diffInfo = result.diffInfo;

      // Piggyback the PreToolUse work state onto the PostToolUse write so the
      // renderer can inject it if it missed the PreToolUse file write (race condition
      // on fast commands where PostToolUse overwrites before the renderer reads).
      const preToolResult = toolToState(toolName, toolInput);
      if (preToolResult.state !== 'idle' && preToolResult.state !== 'thinking') {
        workState = preToolResult.state;
        workDetail = preToolResult.detail;
      }

      // Track git commits and streaks (skip for known subagents -- their
      // results should not affect the parent session's counters or streak).
      // A background launch (result.neutral) has no verdict yet: it used to
      // add to the streak before its job had run.
      if (!isKnownSubagent && !result.neutral) {
        // commitCount is per session (each window's own counter). The streak
        // is global gamification, so parallel windows still contribute.
        if (result.committed) {
          counter.commitCount++;
        }
        updateStreak(stats, state === 'error');
      }

      // Propagate tool result state to the most recently started legacy
      // subagent (see PreToolUse). An error is never masked: the parent's
      // streak just broke, and "conducting" would hide why.
      if (stats.session.activeSubagents.length > 0 && !SUBAGENT_TOOLS.test(toolName)
          && !isKnownSubagent && !isParallelSession && !isAgentEvent) {
        const latest = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
        _touchActiveSubagents(stats.session.activeSubagents);
        if (!latest.agentId) {
          _writeSubagentToolState(latest, state, detail, sessionId);
          if (state !== 'error') {
            state = 'subagent';
            detail = `conducting ${stats.session.activeSubagents.length}`;
            workState = null;  // conducting state is not a completion -- no piggyback needed
            workDetail = null;
          }
        }
      }
    }
    else if (hookEvent === 'Stop') {
      state = 'responding';
      detail = 'wrapping up';
      // A Stop carrying agent_id is the subagent's own turn ending, not the
      // parent's: it must not release global ownership, retire the orbital
      // (SubagentStop does that), or close the parent's session records.
      stopped = !isAgentEvent;

      // Update session records from THIS session's own counter (a parallel
      // window credits its own, never the owner's). creditedMs keeps a second
      // Stop, or a later ownership switch, from counting the time again.
      if (stopped && !isKnownSubagent) _creditSession(stats, counter, now);

      // Don't clean up synthetic subagent sessions here — background subagents
      // may still be running after the parent's turn ends. SessionEnd handles
      // final cleanup; SubagentStop handles individual foreground agents.
    }
    else if (hookEvent === 'Notification') {
      // notification_type: permission_prompt | idle_prompt | elicitation_dialog | auth_success
      // (plus the informational ones in INFO_NOTIFICATIONS, which draw nothing)
      const kind = toText(data.notification_type);
      if (INFO_NOTIFICATIONS.has(kind)) {
        writeStats(stats);
        // process.exit skips finally -- release the stats lock by hand.
        if (releaseStats) releaseStats();
        process.exit(0);
      }
      if (kind === 'auth_success') {
        state = 'satisfied';
        detail = 'signed in';
      } else {
        state = 'waiting';
        detail = kind === 'permission_prompt' ? 'allow?'
          : kind === 'idle_prompt' ? 'waiting for you'
          : kind === 'elicitation_dialog' ? 'needs input'
          : 'needs attention';
      }
      if (kind === 'permission_prompt') {
        // The dialog is still open 6 s on: the wait is confirmed. Keep the
        // PermissionRequest's own details (which tool, the tool's work face)
        // rather than the generic "allow?" -- they name what is being asked.
        // It carries the session id alone, so it may be about the agents'
        // prompts too: the parent then stands in for them (notificationWait,
        // lib/wait.js, which also knows the session's own prompt allowed long
        // ago when an agent is the one asking). An agent's own notification
        // stands in for nobody.
        const agents = agentId ? [] : _confirmAgentWaits(sessionId);
        const asked = notificationWait(prevSessionFile, agents, EVENT_AT, { standIn: !agentId });
        if (asked.waitingOn) waitingOn = asked.waitingOn;
        if (asked.detail) detail = asked.detail;
        waitFields = asked.fields;
        ownWaitAnswered = asked.dropOwn;
      }
    }
    else if (hookEvent === 'UserPromptSubmit') {
      // The user just sent a message: Claude is thinking before its first tool
      // call. Without this the face sits on happy/idle from the last Stop.
      state = 'thinking';
      detail = 'reading your message';
    }
    else if (hookEvent === 'TeammateIdle') {
      state = 'waiting';
      const mate = toText(data.teammate_name);
      detail = mate ? `${mate} idle` : 'idle';
      const teamExtra = {
        teamName: toText(data.team_name),
        teammateName: mate,
        isTeammate: true,
      };
      _writeTeammate(sessionId, agentId, agentType, hookEvent, state, detail, teamExtra);
      writeStats(stats);
      // process.exit skips finally -- release the stats lock by hand.
      if (releaseStats) releaseStats();
      process.exit(0);
    }
    else if (hookEvent === 'TaskCompleted') {
      const taskSubject = toText(data.task_subject);
      state = stats.streak >= 10 ? 'proud' : stats.streak >= 3 ? 'satisfied' : 'happy';
      detail = taskSubject ? taskSubject.slice(0, 40) : 'task done';
      // TaskCompleted is NOT team-only: Claude Code's TaskUpdate fires it for
      // any task marked completed, solo sessions included (teammate_name is
      // empty there). Only a real teammate takes the from-scratch write below;
      // anyone else falls through to the normal path, which routes agent
      // events to their own orbital and carries the sticky fields. Tagging a
      // solo session isTeammate made the main policy skip it for good.
      if (toText(data.team_name) || toText(data.teammate_name)) {
        const teamExtra = {
          teamName: toText(data.team_name),
          teammateName: toText(data.teammate_name),
          taskSubject,
          isTeammate: true,
        };
        _writeTeammate(sessionId, agentId, agentType, hookEvent, state, detail, teamExtra);
        writeStats(stats);
        // process.exit skips finally -- release the stats lock by hand.
        if (releaseStats) releaseStats();
        process.exit(0);
      }
    }
    else if (hookEvent === 'SubagentStart') {
      // Native subagent lifecycle event -- create the agent's orbital session.
      // Claude Code names the agent with agent_id/agent_type and describes the
      // work in invocation_prompt; other hosts may send subagent_id/description.
      state = 'subagent';
      const desc = subagentLabel(data);
      detail = desc;
      const subModel = agentType || toText(data.model) || 'haiku';
      const subId = agentId
        ? subagentSessionId(sessionId, agentId)
        : (toText(data.subagent_id) || `${sessionId}-sub-${Date.now()}`);
      stats.session.subagentCount = (stats.session.subagentCount || 0) + 1;
      if (stats.session.subagentCount > (stats.records.mostSubagents || 0)) {
        stats.records.mostSubagents = stats.session.subagentCount;
      }
      stats.session.activeSubagents.push({
        id: subId, agentId, agentType, description: desc, taskDescription: desc,
        model: subModel, editor: EDITOR, startedAt: Date.now(),
      });
      writeSessionState(subId, 'spawning', desc, false, {
        sessionId: subId, modelName: subModel, editor: EDITOR, cwd: process.cwd(),
        gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
        parentSession: sessionId, taskDescription: desc,
        ...(agentType ? { agentType } : {}),
        // Without agent_id the orbital has no writer of its own -- the parent
        // writes its state (_writeSubagentToolState) -- so the renderer may
        // cycle activity on it. A real agent reports its own tools.
        ...(agentId ? {} : { synthetic: true }),
      });
      detail = `conducting ${stats.session.activeSubagents.length}`;
    }
    else if (hookEvent === 'SubagentStop') {
      // Native subagent lifecycle event -- mark the subagent session as done.
      // Agents finish out of order, so identity comes first: agent_id (Claude
      // Code), then the legacy subagent_id. Only when the payload names nobody
      // do we fall back to retiring the oldest entry (FIFO).
      const subs = stats.session.activeSubagents;
      const legacyId = toText(data.subagent_id);
      let idx = -1;
      if (agentId) {
        const wantId = subagentSessionId(sessionId, agentId);
        idx = subs.findIndex(s => s.agentId === agentId || s.id === wantId);
      } else if (legacyId) {
        idx = subs.findIndex(s => s.id === legacyId);
      } else if (subs.length > 0) {
        idx = 0;
      }
      // An id we don't know may belong to another session -- retire nothing.
      if (idx >= 0) {
        _retireSubagent(subs.splice(idx, 1)[0], sessionId, hookEvent, agentType);
      } else if (agentId) {
        // The agent's file name is deterministic, so it can be retired even
        // when activeSubagents lost track of it -- a lifecycle event from a
        // parallel window resets stats.session and empties that list. Without
        // this, an agent last seen at error/waiting stayed "live" for the
        // whole CHILD_ORPHAN_TIMEOUT and held its parent at "conducting".
        const orphanId = subagentSessionId(sessionId, agentId);
        const prev = _readSessionFile(orphanId);
        if (prev && !prev.stopped) {
          // Keep the sticky fields, never the old state/detail/timestamp: a
          // stale timestamp would make the renderer ignore the retirement.
          const { state: _s, detail: _d, timestamp: _t, ...keep } = prev;
          writeSessionState(orphanId, 'happy', 'done', true, {
            ...keep, sessionId: orphanId, stopped: true, ...orderingFields(prev, hookEvent),
          });
        }
      }
      if (stats.session.activeSubagents.length > 0) {
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
      } else {
        state = 'happy';
        detail = 'subagent done';
      }
    }
    else if (hookEvent === 'SessionStart') {
      state = 'idle';
      detail = 'session starting';
      // Register as a known top-level session (#134) — subagents never fire
      // SessionStart, so registry members are immune to subagent classification.
      stats.topLevelSessions[sessionId] = Date.now();
      pruneTopLevelSessions(stats.topLevelSessions, Date.now());
      // sessionCount already incremented in new-session block above
      // Clean up any stale session file left by a PREVIOUS session with the
      // same id (resume/startup). A compaction restart is that same live
      // session, so its file stays put and the sticky read below carries
      // lastPromptAt forward -- otherwise compacting would demote the window
      // the user is actively working in from "addressed at T" to never.
      if (data.source !== 'compact') {
        const staleSessionFile = path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');
        try { fs.unlinkSync(staleSessionFile); } catch {}
      } else {
        // ...unless there is no file left to carry from. The renderer's stale
        // purge can remove a live window's session file (a long think on win32
        // writes nothing for two minutes), and a compact SessionStart is the
        // one event that recreates it without stamping. An unstamped file is
        // attention 0, i.e. never the center again, so a fresh stamp is the
        // least-wrong value here.
        try {
          fs.accessSync(path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'));
        } catch { compactWithoutPredecessor = true; }
      }
      // A compaction is the same live session: its tool calls, files, clock
      // and -- above all -- its running agents survive. Resetting here wiped
      // activeSubagents mid-dispatch, so every SubagentStop after an
      // auto-compact matched nothing. Any other source is a fresh session.
      if (data.source !== 'compact') {
        counter = counters[sessionId] = { ..._freshCounter(now), countedDay: counter.countedDay };
        stats.session = {
          id: sessionId, start: now,
          toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0,
          activeSubagents: [],
        };
      }
    }
    else if (hookEvent === 'SessionEnd') {
      state = 'responding';
      detail = 'session ending';
      stopped = true;
      // Finalize session records
      _creditSession(stats, counter, now);
      // Retire every agent still running, exactly as SubagentStop would.
      for (const sub of stats.session.activeSubagents) _retireSubagent(sub, sessionId, hookEvent);
      stats.session.activeSubagents = [];
    }
    else if (hookEvent === 'PreCompact') {
      state = 'thinking';
      const trigger = toText(data.trigger) || 'auto';
      detail = trigger === 'manual' ? 'compacting memory' : 'auto-compacting';
      // Between turns a PreCompact keeps the turn's end (turnOver, see
      // AMBIENT_EVENTS) so PostCompact can close it again -- but when the
      // compaction is this session's own work the face stays active while
      // it runs: a manual /compact, and Codex, which compacts at the START of
      // a turn, before UserPromptSubmit. An auto one after a Claude Code Stop
      // is a background agent's, sent with the parent's id and no agent_id.
      compacting = !agentId && (trigger !== 'auto' || EDITOR !== 'claude');
    }
    else if (hookEvent === 'PostCompact') {
      state = 'satisfied';
      detail = 'memory compacted';
    }
    else if (hookEvent === 'PermissionRequest') {
      state = 'waiting';
      detail = toolName ? `allow ${toolName}?` : 'needs permission';
      waitingOn = callKey;
      // Claude Code only: the 6 s Notification is what confirms this wait
      // (see WAIT_FIELDS). Codex has no Notification hook, so a Codex wait
      // must never look unconfirmed -- the renderer would resolve it while
      // the prompt is still open. Same when the user turned the
      // notification off.
      waitFields = askFields({
        editor: EDITOR, notify: permissionNotifyEnabled(),
        work: toolToState(toolName, toolInput), askedAt: EVENT_AT,
      });
    }
    else if (hookEvent === 'PermissionDenied') {
      // 2.1.300 fires it when the auto-mode classifier refuses a tool call --
      // only then: a user's "no" in the dialog fires nothing. The call never
      // runs, so no PostToolUse or PostToolUseFailure follows it (the denial
      // returns before the tool is called), and nothing else would close a
      // wait on it. Not an error and not a reward: Claude reads the denial
      // and carries on, so the face thinks. The streak is left alone.
      state = 'thinking';
      const label = /^mcp__/.test(toolName) ? (toolName.split('__')[1] || 'tool') : (toolName || 'tool');
      detail = `${label.slice(0, 24)} denied`;
      // It answers the wait on this call, or nothing at all if none is
      // pending; a wait on some OTHER call is still open and stays.
      if (deniedAnswers(prevSessionFile, callKey)) permissionAnswered = true;
    }
    else if (hookEvent === 'Setup') {
      state = 'starting';
      const trigger = toText(data.trigger) || 'init';
      detail = trigger === 'maintenance' ? 'maintenance' : 'setting up';
    }
    else if (hookEvent === 'Elicitation') {
      state = 'waiting';
      const server = (toText(data.mcp_server_name) || 'MCP').slice(0, 20);
      detail = `${server}: needs input`;
    }
    else if (hookEvent === 'ElicitationResult') {
      const action = toText(data.action) || 'accept';
      if (action === 'accept') {
        state = 'satisfied';
        detail = 'input received';
      } else {
        state = 'relieved';
        detail = action === 'decline' ? 'input declined' : 'input cancelled';
      }
    }
    else if (hookEvent === 'ConfigChange') {
      state = 'reading';
      const fp = toText(data.file_path);
      const base = fp ? path.basename(fp) : '';
      detail = base ? `config: ${base}` : 'config updated';
    }
    else if (hookEvent === 'InstructionsLoaded') {
      state = 'reading';
      const fp = toText(data.file_path);
      detail = fp ? path.basename(fp) : 'loading instructions';
    }
    else if (hookEvent === 'PostModelSwitch') {
      // The model just changed under the face -- say so, then let the normal
      // cascade take over. `model` was resolved from to_model above.
      state = 'thinking';
      detail = model ? `now ${model}` : 'model switched';
    }
    else if (hookEvent === 'StopFailure') {
      state = 'error';
      const errorType = toText(data.error) || toText(data.error_type);
      if (errorType === 'rate_limit') detail = 'rate limited!';
      else if (errorType === 'server_error') detail = 'server error';
      else if (errorType === 'max_output_tokens') detail = 'output too long';
      else if (errorType === 'authentication_failed') detail = 'auth failed';
      else if (errorType === 'billing_error') detail = 'billing error';
      else detail = errorType || 'API error';
      // Track in stats -- API failures break the streak
      if (!isKnownSubagent) {
        updateStreak(stats, true);
      }
      // StopFailure fires INSTEAD of Stop, so it is the turn's end too: the
      // session file gets `turnEnded` (never `stopped` -- that is SessionEnd)
      // and the global file `stopped`, exactly like Stop. Without it the
      // renderer treated the session as mid-turn and sat on thinking for 45s.
      if (!agentId) {
        failureEndsTurn = true;
        if (!isKnownSubagent) _creditSession(stats, counter, now);
      }
    }
    else if (hookEvent === 'Interrupt') {
      // Codex's Esc: the turn is over, cut short by the user. Shown like
      // Claude Code's interrupted tool call, but it is the user's choice, so
      // the streak is left alone. It ends the turn exactly as StopFailure does.
      state = 'error';
      detail = 'interrupted';
      if (!agentId) {
        failureEndsTurn = true;
        if (!isKnownSubagent) _creditSession(stats, counter, now);
      }
    }
    else {
      if (toolName) {
        ({ state, detail } = toolToState(toolName, toolInput));
      }
    }

    // Model name: from event data, env var, or the editor this hook serves.
    // Despite the name this is the EDITOR tag in every production path
    // (DEFAULT_MODEL_NAME = EDITOR) -- real model identity is `model`, below.
    const modelName = toText(data.model_name) || process.env.CODE_CRUMB_MODEL || DEFAULT_MODEL_NAME;

    // stats.session mirrors its owner's own counter, so every reader of the
    // stats file (the adapters included) sees the same numbers.
    if (stats.session.id === sessionId) {
      stats.session.start = counter.start;
      stats.session.toolCalls = counter.toolCalls;
      stats.session.filesEdited = counter.filesEdited.slice();
      stats.session.commitCount = counter.commitCount;
    }

    // Build extra data for state files -- this session's OWN counters.
    const currentSessionMs = Math.max(0, now - counter.start - (counter.idleMs || 0) - counter.creditedMs);
    const extra = {
      sessionId,
      modelName,
      ...(model ? { model } : {}),
      editor: EDITOR,
      toolCalls: counter.toolCalls,
      filesEdited: counter.filesEdited.length,
      sessionStart: counter.start,
      streak: stats.streak,
      cwd: process.cwd(),
      isWorktree: getIsWorktree(process.cwd()),
      gitBranch: getGitBranch(process.cwd()),
      commitCount: counter.commitCount,
      bestStreak: stats.bestStreak,
      brokenStreak: stats.brokenStreak,
      brokenStreakAt: stats.brokenStreakAt,
      milestone: stats.recentMilestone,
      diffInfo,
      dailySessions: stats.daily.sessionCount,
      dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
      frequentFiles: topFrequentFiles(stats.frequentFiles),
    };

    if (stopped) extra.stopped = true;
    if (workState) { extra.workState = workState; extra.workDetail = workDetail; }
    if (waitingOn) extra.waitingOn = waitingOn;
    if (waitFields) Object.assign(extra, waitFields);
    if (compacting) extra.compacting = true;
    // This write answers whatever the face was asked to wait on: the user
    // spoke (UserPromptSubmit), an elicitation came back, an AskUserQuestion
    // returned, a denial closed the prompt. The renderer drops a wait still
    // queued behind a reward, which otherwise reappeared after the answer.
    // Not sticky -- one write only.
    if (hookEvent === 'UserPromptSubmit' || hookEvent === 'ElicitationResult' || permissionAnswered
        || ((hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') && ASK_TOOLS.test(toolName))) {
      extra.answered = true;
    }
    if (hookEvent === 'SessionStart') extra.isSessionStart = true;

    // Attention stamp: the user just addressed THIS session. The renderer's
    // main-face policy follows the newest one. A SessionStart from compaction
    // is not the user's attention and must not pull the center away from the
    // window they are typing in -- unless its own session file is gone, in
    // which case there is no earlier stamp to carry and 0 would exile the
    // window from the center for good (see compactWithoutPredecessor).
    if (hookEvent === 'UserPromptSubmit'
        || (hookEvent === 'SessionStart'
            && (data.source !== 'compact' || compactWithoutPredecessor))) {
      extra.lastPromptAt = Date.now();
    }

    // Claude Code subagent event: everything below writes the agent's own
    // orbital, never the parent's records. There is no separate synthetic to
    // retire -- the SubagentStart file IS this orbital.
    if (isAgentEvent) {
      extra.sessionId = agentSessionId;
      extra.parentSession = sessionId;
      if (agentType) {
        extra.agentType = agentType;
        // The agent type is a better display name than the parent's editor.
        extra.modelName = agentType;
      }
    }
    // Stamp parentSession on subagent writes so the parentSession guard
    // blocks them from writing global state, and the renderer treats them as orbitals.
    else if (isKnownSubagent) {
      extra.parentSession = stats.session.id;
      // Retire synthetic orbital: SubagentStart created a synthetic file for the subagent.
      // Now that the real subagent is sending its own hooks, mark the synthetic as done
      // so it is pruned after STOPPED_LINGER_MS (10s) instead of lingering for STALE_MS (120s).
      // PreToolUse is the first tool event a real subagent sends -- retire on first contact.
      if (hookEvent === 'PreToolUse') {
        const subs = stats.session.activeSubagents;
        // Iterate forward: oldest non-stopped synthetic is most likely to match
        // the first real subagent hook when multiple subagents are concurrent.
        for (let i = 0; i < subs.length; i++) {
          // An agent-owned entry is not a synthetic: it writes its own orbital
          // and retires through its own SubagentStop. Retiring it here -- on
          // the word of a foreign session that may be an unregistered
          // parallel window -- stamped a LIVE agent `stopped` for good.
          if (subs[i].agentId) continue;
          try {
            const synthFp = path.join(SESSIONS_DIR, safeFilename(subs[i].id) + '.json');
            const synthData = JSON.parse(fs.readFileSync(synthFp, 'utf8'));
            if (!synthData.stopped) {
              if (synthData.taskDescription) extra.taskDescription = synthData.taskDescription;
              // A fresh timestamp, as in the orphan SubagentStop path: the
              // renderer skips a write whose timestamp it has already seen,
              // so keeping the old one left the retired orbital live.
              writeJsonAtomic(synthFp, { ...synthData, stopped: true, state: 'happy', detail: 'done', timestamp: Date.now() }, 0o600);
              break;
            }
          } catch {}
        }
      }
    }

    // Only write to global state file if this session "owns" it.
    // Subagents should only write to their per-session file so they
    // don't overwrite the main session's state in the renderer.
    let shouldWriteGlobal = true;
    // Scoped to the GLOBAL write only -- see the owner guard below.
    let globalStopped = false;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId && existing.sessionId !== sessionId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
      // These three guards are all parent-scoped: they compare the global
      // file's session id against ours. An agent event shares the parent's
      // session id but writes the agent's own file, so none of them apply --
      // without the !isAgentEvent guard a stopped parent would retire a live
      // agent orbital, and the parent's modelName would erase the agent type.
      // Preserve the GLOBAL file's stopped flag — an echo of a finished turn
      // (a late PostToolUse, a background agent's SubagentStop, anything but
      // a turn-opening event: see carriesTurnEnd) must not resurrect
      // ownership. PreToolUse (a new turn) does clear the flag, and so does a
      // wait, which tmux mode would otherwise rescue straight to "wrapping up".
      // This re-stamp is deliberately scoped to the global write: on a session
      // file `stopped` means SESSION ENDED (SessionEnd), and leaking it here
      // used to make the orbital loader retire a live window -- the policy then
      // dropped the attended session and the center bounced away and back with
      // two swap animations. The session-file block below decides for itself
      // from the session file's own fields (`stopped`, else `turnEnded`).
      // The global flag is not the only record of the finished turn: any wait
      // clears it (an idle_prompt lands ~60 s after every Stop), and the next
      // echo wrote the global file live -- no other window could take it for
      // two minutes. The session file still knows, so it counts too.
      // (stopsGlobal, lib/carry.js: an echo re-stamps it while the turn is
      // over -- by the global file's own flag, or the session file's record.)
      globalStopped = stopsGlobal(prevSessionFile, {
        event: hookEvent, agentId, isAgent: isAgentEvent, state,
        globalOwnStop: !!existing.stopped && existing.sessionId === sessionId,
      });
      // Preserve model name — subagents sharing session ID must not overwrite the owner's name.
      // See also: base-adapter.js guardedWriteState (adapters) and face.js setStats (env var).
      if (!isAgentEvent && existing.sessionId === sessionId && existing.modelName &&
          extra.modelName !== existing.modelName) {
        extra.modelName = existing.modelName;
      }
      // Same guard for editor provenance — the owner's editor must not be overwritten.
      if (!isAgentEvent && existing.sessionId === sessionId && existing.editor &&
          extra.editor !== existing.editor) {
        extra.editor = existing.editor;
      }
      // The global write happens BEFORE the session file's STICKY_FIELDS loop,
      // so without this the global file would carry `model` only on the two
      // acquisition events and blank in between -- a flicker for tmux mode and
      // any external reader.
      if (!isAgentEvent && existing.sessionId === sessionId && existing.model && !extra.model) {
        extra.model = existing.model;
      }
    } catch {}

    // Subagents should never take over the global state file —
    // they appear as orbitals via their per-session files.
    if (shouldWriteGlobal) {
      try {
        const mySession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(writeSessionId) + '.json'), 'utf8'));
        if (mySession.parentSession) shouldWriteGlobal = false;
        // The model is carried above only while the global file already
        // names this session. Taking it back from another window found the
        // other's file there, so tmux mode lost the model for good; the
        // session's own file still has it.
        if (!isAgentEvent && !extra.model && typeof mySession.model === 'string' && mySession.model) {
          extra.model = mySession.model;
        }
      } catch {}
    }

    // A Claude Code subagent event carries the parent's session_id, so the
    // ownership checks above cannot catch it — it is an orbital by definition.
    if (isAgentEvent) shouldWriteGlobal = false;
    // So is a legacy subagent, by classification. Its file is stamped with
    // parentSession only by this very write, so on its first event the guard
    // above found nothing and it took the global file from its stopped parent.
    if (isKnownSubagent) shouldWriteGlobal = false;

    // SessionStart always takes over global state — explicit new-session signal
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    // A stale async event writes neither file (see asyncWriteIsStale): its
    // stats above are already counted, and the newer state stays drawn.
    if (shouldWriteGlobal && !staleWrite) {
      writeState(state, detail, (globalStopped || failureEndsTurn) ? { ...extra, stopped: true } : extra);
    }
    // Always write the per-session file: it is what the renderer's main face
    // follows and what parallel sessions appear as. SessionStart writes one
    // too (the unlink above is skipped for `source === 'compact'`, which is
    // the same live session restarting), so a fresh session is a candidate for
    // the center before its first tool call.
    // What the session file ends up holding (see below); the write's own
    // fields when nothing is written.
    let written = extra;
    if (!staleWrite) {
      let existingSession = null;
      // A fresh session starts with fresh fields, so it reads nothing: the
      // unlink above normally leaves no file, but a failed unlink (a locked
      // file on Windows) would otherwise resurrect a dead session's agentType
      // and team fields onto a brand-new one. A compaction is the same live
      // session and does read -- that is how it keeps its own sticky fields.
      if (hookEvent !== 'SessionStart' || data.source === 'compact') {
        try {
          existingSession = JSON.parse(fs.readFileSync(
            path.join(SESSIONS_DIR, safeFilename(writeSessionId) + '.json'), 'utf8'));
        } catch {}
      }
      // What this write keeps from the file before it -- the session's and
      // the turn's tombstones, an open permission prompt (or its answer),
      // the sticky fields -- and what it ends itself: lib/carry.js, the one
      // copy of these rules the >1 MB fallback writes through too.
      const next = nextSessionFile(existingSession, {
        event: hookEvent, agentId, isAgent: isAgentEvent, state, detail,
        fields: extra, callKey, dropOwnWait: ownWaitAnswered,
      });
      written = next.fields;
      // Heal sessions falsely stamped as subagents (#134): the stats owner
      // and classified parallel windows are top-level by definition — drop a
      // stale parentSession/taskDescription stamp instead of preserving it.
      // (Teammates keep theirs; their fields are legitimately set. An agent
      // event writes the agent's file under the parent's session_id, so it
      // is exempt too -- its parentSession stamp is the correct one.)
      if (existingSession && !isAgentEvent && (isParallelSession || stats.session.id === sessionId)
          && !written.isTeammate) {
        delete written.parentSession;
        delete written.taskDescription;
      }
      // Session-file only, after the global write: the ordering fields
      // (asyncWriteIsStale reads them back) and when the file was born.
      written.firstSeenAt = firstSeenFor(existingSession, Date.now());
      Object.assign(written, orderingFields(existingSession, hookEvent,
        (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') ? shortToolId(toolUseId) : ''));
      writeSessionState(writeSessionId, next.state, next.detail, next.stopped, written);
    }
    // An agent's prompt was answered: a parent standing in for it goes back.
    if (isAgentEvent && written.answered) _releaseParentWait(sessionId, safeFilename(writeSessionId));
    // Family heartbeat: an agent working proves its parent is alive, and the
    // parent itself writes nothing while it waits. See _touchSessionFile.
    // (A stale event is still the agent working.)
    if (isAgentEvent) _touchSessionFile(sessionId);
    pruneFrequentFiles(stats.frequentFiles);
    _pruneCounters(counters, [stats.session.id, sessionId], now);
    writeStats(stats);
    } finally { if (releaseStats) releaseStats(); }
  } catch {
    // Parsing failed (empty or non-JSON stdin), or a parsed payload threw
    // further down -- then parsedIds still names the real session.
    try { writeFallback(parsedIds, null); } catch {}
  }

  process.exit(0);
});

