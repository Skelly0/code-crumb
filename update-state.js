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
// |          StopFailure, PostModelSwitch                          |
// |                                                                |
// |  Works with Claude Code, Codex CLI, and OpenCode               |
// +================================================================+

const fs = require('fs');
const path = require('path');
const {
  STATE_FILE, SESSIONS_DIR, STATS_FILE, PID_FILE, QUIT_FLAG_FILE, SPAWN_LOCK_FILE, STATS_LOCK_FILE,
  safeFilename, getGitBranch, getIsWorktree, loadPrefs,
  writeJsonAtomic, acquireSpawnLock, acquireFileLock, buildRendererCommands,
} = require('./shared');
const {
  toolToState, normalizeToolResponse, classifyToolResult, classifyTruncatedInput, updateStreak, defaultStats, normalizeStats,
  EDIT_TOOLS, SUBAGENT_TOOLS, toText,
  pruneFrequentFiles, topFrequentFiles, buildSubagentSessionState,
  subagentSessionId, subagentLabel,
  classifyForeignSession, pruneTopLevelSessions,
  prettyModelName, agentTranscriptPath,
} = require('./state-machine');

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
const TURN_CLOSING_EVENTS = new Set(['Stop', 'StopFailure', 'SessionEnd']);

// Session files that may inherit a finished turn from their predecessor.
// `waiting` is the exception: the renderer folds `turnEnded` into `stopped`
// and then force-rescues any non-reward face to "wrapping up", so a wait
// written with `turnEnded` would never be seen. It carries `turnOver`
// instead -- the same fact, invisible to the renderer -- so the NEXT echo
// (a background SubagentStop after an idle_prompt) still knows the turn is over.
function carriesTurnEnd(event) {
  return !TURN_OPENING_EVENTS.has(event) && !TURN_CLOSING_EVENTS.has(event);
}

// Sticky session-file fields: set once, preserved across every later write.
const STICKY_FIELDS = ['taskDescription', 'parentSession', 'agentType', 'isTeammate', 'teamName', 'teammateName', 'editor', 'lastPromptAt', 'model'];

// Per-session counters. The shared stats file has ONE `session` owner, and two
// top-level windows alternating hooks used to reset it on every switch: each
// window's file reported the other's toolCalls, and daily.sessionCount grew by
// one per alternation. Each session now keeps its own counters, keyed by id,
// and the session file reports those. Bounded: idle entries age out after a
// day and the map keeps the 50 most recently seen.
const COUNTER_MAX_AGE_MS = 24 * 3600000;
const COUNTER_MAX_ENTRIES = 50;
const COUNTER_MAX_FILES = 200;

function _freshCounter(now) {
  return { toolCalls: 0, filesEdited: [], start: now, commitCount: 0, creditedMs: 0, lastSeen: now, counted: false };
}

// Repair one entry in place (a hand-edited or older stats file must never
// throw below). Returns null for anything that is not an entry at all.
function _normalizeCounter(c, now) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  c.toolCalls = num(c.toolCalls, 0);
  c.start = num(c.start, now) || now;
  c.commitCount = num(c.commitCount, 0);
  c.creditedMs = num(c.creditedMs, 0);
  c.lastSeen = num(c.lastSeen, now);
  c.counted = !!c.counted;
  c.filesEdited = Array.isArray(c.filesEdited)
    ? c.filesEdited.filter(f => typeof f === 'string').slice(0, COUNTER_MAX_FILES) : [];
  return c;
}

// While a session does not own stats.session, its running agents (and its
// subagent count) wait on its counter entry. Only stored when there is
// something to keep, so an idle window's entry stays small.
const COUNTER_MAX_AGENTS = 32;

function _parkAgents(c, session) {
  if (!c || !session) return;
  const active = Array.isArray(session.activeSubagents)
    ? session.activeSubagents.filter(s => s && typeof s === 'object').slice(0, COUNTER_MAX_AGENTS) : [];
  if (active.length) c.activeSubagents = active; else delete c.activeSubagents;
  if (session.subagentCount > 0) c.subagentCount = session.subagentCount; else delete c.subagentCount;
}

function _unparkAgents(c, session) {
  if (!c || !session) return;
  if (Array.isArray(c.activeSubagents)) {
    session.activeSubagents = c.activeSubagents.filter(s => s && typeof s === 'object');
  }
  if (typeof c.subagentCount === 'number' && Number.isFinite(c.subagentCount)) {
    session.subagentCount = c.subagentCount;
  }
  delete c.activeSubagents;
  delete c.subagentCount;
}

function _pruneCounters(map, keepId, now) {
  for (const id of Object.keys(map)) {
    const c = map[id];
    if (!c || typeof c !== 'object') { delete map[id]; continue; }
    if (id !== keepId && now - (c.lastSeen || 0) > COUNTER_MAX_AGE_MS) delete map[id];
  }
  const ids = Object.keys(map);
  if (ids.length <= COUNTER_MAX_ENTRIES) return;
  ids.sort((a, b) => (map[b].lastSeen || 0) - (map[a].lastSeen || 0));
  for (const id of ids.slice(COUNTER_MAX_ENTRIES)) {
    if (id !== keepId) delete map[id];
  }
}

// Fold a session's elapsed time into the records and today's cumulative
// total. `creditedMs` remembers how much was already added, so crediting the
// same session at every turn end and every ownership switch never counts a
// millisecond twice.
function _creditSession(stats, c, now) {
  if (!c || !c.start) return;
  const dur = now - c.start;
  if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
  if (c.filesEdited.length > (stats.records.mostFilesEdited || 0)) {
    stats.records.mostFilesEdited = c.filesEdited.length;
  }
  const delta = dur - (c.creditedMs || 0);
  if (delta > 0) {
    stats.daily.cumulativeMs += delta;
    c.creditedMs = dur;
  }
}

// Read a session file, or null.
function _readSessionFile(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, safeFilename(id) + '.json'), 'utf8'));
  } catch { return null; }
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
};
function _rawField(raw, key) {
  const m = RAW_FIELD_RES[key].exec(raw);
  return m ? m[1] : '';
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
function ensureRendererRunning() {
  try {
    // Check pref — fast sync read, bail early if disabled
    if (!loadPrefs().autolaunch) return;

    // Check quit flag — user intentionally quit, don't auto-relaunch
    try { fs.accessSync(QUIT_FLAG_FILE); return; } catch {}

    // Check if renderer alive via PID file
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(pid)) { process.kill(pid, 0); return; } // alive
    } catch {}

    // Renderer dead/missing — one hook spawns it, the rest back off.
    if (!acquireSpawnLock(SPAWN_LOCK_FILE, 5000)) return;

    const { spawn, execSync } = require('child_process');
    const rendererPath = path.resolve(__dirname, 'renderer.js');
    const cmds = buildRendererCommands(process.platform, [rendererPath], 'Code Crumb');

    let child;
    if (process.platform === 'win32') {
      // Probe for Windows Terminal before spawning (spawn doesn't throw synchronously)
      let hasWt = false;
      try { execSync('where wt', { stdio: 'ignore' }); hasWt = true; } catch {}
      const c = hasWt ? cmds.wt : cmds.cmd;
      child = spawn(c.cmd, c.args, c.opts);
    } else if (process.platform === 'darwin') {
      child = spawn(cmds.osascript.cmd, cmds.osascript.args, cmds.osascript.opts);
    } else {
      // Linux — try common terminal emulators in order
      for (const key of Object.keys(cmds)) {
        try {
          execSync(`command -v ${cmds[key].cmd}`, { stdio: 'ignore' });
          child = spawn(cmds[key].cmd, cmds[key].args, cmds[key].opts);
          break;
        } catch {}
      }
    }
    if (child) child.unref();
  } catch {} // Never throw from a hook
}

// -- Degraded path ---------------------------------------------------

// Writes for a hook whose payload could not be used whole: empty or
// non-JSON stdin, a payload too large to parse (ids regex-extracted), or one
// that parsed and then threw. `ids` holds whatever envelope ids survived
// ({ sessionId, agentId, agentType }, any of them empty); `override` is a
// { state, detail } classification that replaces the event map below.
function writeFallback(ids, override) {
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
  } else if (hookEvent === 'Setup') {
    fallbackState = 'starting';
    fallbackDetail = 'setting up';
  } else if (hookEvent === 'Elicitation') {
    fallbackState = 'waiting';
    fallbackDetail = 'needs input';
  } else if (hookEvent === 'ElicitationResult') {
    fallbackState = 'satisfied';
    fallbackDetail = 'input received';
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
  } else if (hookEvent === 'StopFailure') {
    fallbackState = 'error';
    fallbackDetail = 'API error';
    // The failed turn is over: global `stopped`, session-file `turnEnded`.
    if (!isAgent) fallbackExtra.stopped = true;
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
  // Keep the session file's sticky fields -- above all lastPromptAt, whose
  // loss drops the window to attention 0 and moves the center away -- and
  // honour the same turn-boundary carry as the main path. A fresh
  // SessionStart reads nothing (its predecessor was just unlinked).
  let prevSession = null;
  if (hookEvent !== 'SessionStart') prevSession = _readSessionFile(sessionFileId);
  if (prevSession) {
    for (const field of STICKY_FIELDS) {
      if (prevSession[field] && !sessionExtra[field]) sessionExtra[field] = prevSession[field];
    }
    if ((prevSession.turnEnded || prevSession.turnOver) && carriesTurnEnd(hookEvent)) {
      if (fallbackState === 'waiting') sessionExtra.turnOver = true;
      else sessionExtra.turnEnded = true;
    }
  }
  const globalExtra = (!fallbackExtra.stopped && globalWasOurStop
    && carriesTurnEnd(hookEvent) && fallbackState !== 'waiting')
    ? { ...fallbackExtra, stopped: true } : fallbackExtra;
  if (shouldWriteGlobal) writeState(fallbackState, fallbackDetail, globalExtra);

  if (hookEvent === 'Stop' && !isAgent) {
    const idleFallbackExtra = { ...sessionExtra, turnEnded: true };
    delete idleFallbackExtra.stopped;
    delete idleFallbackExtra.turnOver;
    writeSessionState(sessionFileId, 'idle', 'between turns', false, idleFallbackExtra);
  } else {
    if (hookEvent === 'StopFailure' && !isAgent) {
      sessionExtra.turnEnded = true;
      delete sessionExtra.turnOver;
    }
    // On a session file `stopped` is reserved for SessionEnd.
    if (hookEvent !== 'SessionEnd') delete sessionExtra.stopped;
    writeSessionState(sessionFileId, fallbackState, fallbackDetail,
      hookEvent === 'SessionEnd', sessionExtra);
  }
  // Family heartbeat, as on the main path.
  if (isAgent) _touchSessionFile(originalFallbackId);
}

// -- Main handler ----------------------------------------------------

// Read stdin
let input = '';
const MAX_INPUT = 1048576;
let inputTruncated = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (input.length < MAX_INPUT) input += chunk;
  else inputTruncated = true;
});
process.stdin.on('end', () => {
  ensureRendererRunning();
  if (inputTruncated) {
    // Too large to parse. The envelope ids are still recoverable from the raw
    // text, and they must be: this used to write ONLY the global file, with
    // no sessionId, ignoring ownership and agent_id -- so the unified renderer
    // (which follows session files) never saw the event, and a foreign
    // session clobbered the global owner's state.
    try {
      if (!hookEvent) hookEvent = _rawField(input, 'hook_event_name');
      const truncResult = classifyTruncatedInput(hookEvent, input);
      writeFallback({
        sessionId: _rawField(input, 'session_id'),
        agentId: _rawField(input, 'agent_id'),
        agentType: _rawField(input, 'agent_type'),
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

    // Daily tracking -- reset counters on new day
    const today = new Date().toISOString().slice(0, 10);
    if (!stats.daily || stats.daily.date !== today) {
      stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
    }
    if (!stats.frequentFiles) stats.frequentFiles = {};
    // Registry of known top-level sessions (#134) — populated at SessionStart,
    // which real subagents never fire. Used to tell parallel editor windows
    // apart from subagents when their hooks interleave.
    if (!stats.topLevelSessions) stats.topLevelSessions = {};
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
      let fileBornAt = null;
      try {
        const st = fs.statSync(path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'));
        if (st.birthtimeMs > 0) fileBornAt = st.birthtimeMs;
      } catch {}
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
      stats.sessionCounters = {};
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
        creditedMs: 0, lastSeen: now, counted: true,
      };
    }
    let counter = _normalizeCounter(counters[sessionId], now);
    if (!counter) counter = counters[sessionId] = _freshCounter(now);
    counter.lastSeen = now;
    // daily.sessionCount counts sessions, once per id -- not once per switch
    // of stats.session ownership, which two alternating windows did on every
    // hook. An agent event does not count its parent (the parent's own events
    // will), nor does a legacy subagent count itself.
    if (!counter.counted && !isAgentEvent && !isKnownSubagent) {
      stats.daily.sessionCount++;
      counter.counted = true;
    }

    if (stats.session.id !== sessionId && !isAgentEvent && !isKnownSubagent && !isParallelSession) {
      // Credit the outgoing owner's records, then adopt this session with its
      // OWN counters -- a switch is not a new session.
      const outgoing = stats.session.id ? counters[stats.session.id] : null;
      if (outgoing) _creditSession(stats, outgoing, now);
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

    // Real model identity. No hook payload carries it except SessionStart
    // (`model`) and PostModelSwitch (`to_model`), so everything else is either
    // carried forward by STICKY_FIELDS or read out of a transcript once.
    // Every transcript-backed path needs one, and only Claude Code sends it:
    // checking first keeps Codex and the adapters at zero extra reads.
    const transcriptPath = toText(data.transcript_path);
    let rawModel = '';
    if (isAgentEvent && transcriptPath) {
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
    } else if (hookEvent === 'SessionStart' || hookEvent === 'PostModelSwitch') {
      // Both are free -- a payload field, no file touched. PostModelSwitch also
      // fires with source 'resume', so a restored session re-stamps itself.
      rawModel = toText(hookEvent === 'PostModelSwitch' ? data.to_model : data.model);
    } else if (hookEvent === 'Stop' && transcriptPath) {
      // Covers the hole in the free path: SessionStart's `model` is optional
      // and Claude Code does not always send it. The tail at a turn end (after
      // the assistant has written) is the model that was actually just used.
      //
      // Deliberately NOT gated on "no model known yet". An install predating
      // the PostModelSwitch hook never gets the switch event, so a gate would
      // pin the first model it ever saw and show it confidently forever after
      // a /model. A stale label is worse than none; re-reading once per turn
      // self-heals, and costs one bounded read against a hook whose cost is
      // already dominated by getGitBranch's child process.
      rawModel = _readTranscriptModel(transcriptPath);
    }
    const model = prettyModelName(rawModel);

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));

      // Every session counts its own tool calls (see COUNTER_MAX_AGE_MS). The
      // global lifetime totals stay owner-only, as before: subagent and
      // parallel-window calls must not inflate them twice over.
      counter.toolCalls++;
      const fp = EDIT_TOOLS.test(toolName)
        ? toText(toolInput.file_path || toolInput.path || toolInput.target_file) : '';
      const base = fp ? path.basename(fp) : '';
      if (base && !counter.filesEdited.includes(base) && counter.filesEdited.length < COUNTER_MAX_FILES) {
        counter.filesEdited.push(base);
      }
      if (!isKnownSubagent && !isParallelSession) {
        stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;
        if (base) stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
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
      // and agent events (already routed to their own orbital).
      if (stats.session.activeSubagents.length > 0 && !SUBAGENT_TOOLS.test(toolName)
          && !isKnownSubagent && !isParallelSession && !isAgentEvent) {
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
      const result = classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag);
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
      if (!isKnownSubagent) {
        // commitCount is per session (each window's own counter). The streak
        // is global gamification, so parallel windows still contribute.
        if (result.state === 'proud' && result.detail === 'committed') {
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
      const kind = toText(data.notification_type);
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
      writeSessionState(sessionId, state, detail, false, { ...teamExtra, sessionId });
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
        writeSessionState(sessionId, state, detail, false, { ...teamExtra, sessionId });
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
      // The retirement write rebuilds the file, so the one sticky field it
      // cannot rebuild from the stats entry -- the resolved model -- comes
      // from the file itself.
      const readSub = (id) => {
        try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, safeFilename(id) + '.json'), 'utf8')); }
        catch { return null; }
      };
      // An id we don't know may belong to another session -- retire nothing.
      if (idx >= 0) {
        const finished = subs.splice(idx, 1)[0];
        const prev = readSub(finished.id);
        writeSessionState(finished.id, 'happy', 'done', true, {
          sessionId: finished.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, taskDescription: finished.taskDescription || finished.description,
          modelName: finished.model || 'haiku', editor: finished.editor || EDITOR,
          ...((finished.agentType || agentType) ? { agentType: finished.agentType || agentType } : {}),
          ...(prev && prev.model ? { model: prev.model } : {}),
        });
      } else if (agentId) {
        // The agent's file name is deterministic, so it can be retired even
        // when activeSubagents lost track of it -- a lifecycle event from a
        // parallel window resets stats.session and empties that list. Without
        // this, an agent last seen at error/waiting stayed "live" for the
        // whole CHILD_ORPHAN_TIMEOUT and held its parent at "conducting".
        const orphanId = subagentSessionId(sessionId, agentId);
        const prev = readSub(orphanId);
        if (prev && !prev.stopped) {
          // Keep the sticky fields, never the old state/detail/timestamp: a
          // stale timestamp would make the renderer ignore the retirement.
          const { state: _s, detail: _d, timestamp: _t, ...keep } = prev;
          writeSessionState(orphanId, 'happy', 'done', true, { ...keep, sessionId: orphanId, stopped: true });
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
        counter = counters[sessionId] = { ..._freshCounter(now), counted: counter.counted };
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
      // Clean up any remaining synthetic subagent sessions
      for (const sub of stats.session.activeSubagents) {
        writeSessionState(sub.id, 'happy', 'done', true, {
          sessionId: sub.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, modelName: sub.model || 'haiku', editor: sub.editor || EDITOR,
        });
      }
      stats.session.activeSubagents = [];
    }
    else if (hookEvent === 'PreCompact') {
      state = 'thinking';
      const trigger = toText(data.trigger) || 'auto';
      detail = trigger === 'manual' ? 'compacting memory' : 'auto-compacting';
    }
    else if (hookEvent === 'PostCompact') {
      state = 'satisfied';
      detail = 'memory compacted';
    }
    else if (hookEvent === 'PermissionRequest') {
      state = 'waiting';
      detail = toolName ? `allow ${toolName}?` : 'needs permission';
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
    const currentSessionMs = Math.max(0, now - counter.start - counter.creditedMs);
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
              writeJsonAtomic(synthFp, { ...synthData, stopped: true, state: 'happy', detail: 'done' }, 0o600);
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
      if (!isAgentEvent && existing.stopped && existing.sessionId === sessionId && !stopped &&
          carriesTurnEnd(hookEvent) && state !== 'waiting') {
        globalStopped = true;
      }
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
      } catch {}
    }

    // A Claude Code subagent event carries the parent's session_id, so the
    // ownership checks above cannot catch it — it is an orbital by definition.
    if (isAgentEvent) shouldWriteGlobal = false;

    // SessionStart always takes over global state — explicit new-session signal
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    if (shouldWriteGlobal) {
      writeState(state, detail, (globalStopped || failureEndsTurn) ? { ...extra, stopped: true } : extra);
    }
    // Always write the per-session file: it is what the renderer's main face
    // follows and what parallel sessions appear as. SessionStart writes one
    // too (the unlink above is skipped for `source === 'compact'`, which is
    // the same live session restarting), so a fresh session is a candidate for
    // the center before its first tool call.
    {
      // Preserve stopped flag and sticky fields from existing session file
      // (set once at SubagentStart/TeammateIdle, must survive subsequent hook updates)
      // `model` is live here (unlike the dead 'editor' entry): extra.model is
      // set only when acquisition actually produced something, so the
      // `!extra[field]` guard both carries it forward and lets a real
      // PostModelSwitch override it. (STICKY_FIELDS is defined at the top.)
      // A fresh session starts with fresh fields, so it reads nothing: the
      // unlink above normally leaves no file, but a failed unlink (a locked
      // file on Windows) would otherwise resurrect a dead session's agentType
      // and team fields onto a brand-new one. A compaction is the same live
      // session and does read -- that is how it keeps its own sticky fields.
      if (hookEvent !== 'SessionStart' || data.source === 'compact') {
        try {
          const existingSession = JSON.parse(fs.readFileSync(
            path.join(SESSIONS_DIR, safeFilename(writeSessionId) + '.json'), 'utf8'));
          if (!stopped && existingSession.stopped &&
              (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure')) {
            stopped = true;
            extra.stopped = true;
          }
          // Same rule for the turn boundary: an echo of a finished turn (a late
          // PostToolUse, a background agent's SubagentStop -- see
          // carriesTurnEnd) must not erase a Stop; a turn-opening event
          // (PreToolUse/UserPromptSubmit...) drops it. A finished turn reads as
          // `stopped || turnEnded` on a session file and the renderer folds
          // both -- but only SessionEnd sets `stopped` here, so the global
          // owner and a parallel window take the same path: `turnEnded`
          // carried forward. A wait carries it as `turnOver` instead (see
          // carriesTurnEnd), and the next echo turns that back into turnEnded.
          if (!stopped && (existingSession.turnEnded || existingSession.turnOver)
              && carriesTurnEnd(hookEvent)) {
            if (state === 'waiting') extra.turnOver = true;
            else extra.turnEnded = true;
          }
          for (const field of STICKY_FIELDS) {
            if (existingSession[field] && !extra[field]) {
              extra[field] = existingSession[field];
            }
          }
          // Heal sessions falsely stamped as subagents (#134): the stats owner
          // and classified parallel windows are top-level by definition — drop a
          // stale parentSession/taskDescription stamp instead of preserving it.
          // (Teammates keep theirs; their fields are legitimately set. An agent
          // event writes the agent's file under the parent's session_id, so it
          // is exempt too -- its parentSession stamp is the correct one.)
          if (!isAgentEvent && (isParallelSession || stats.session.id === sessionId) && !extra.isTeammate) {
            delete extra.parentSession;
            delete extra.taskDescription;
          }
        } catch {}
      }
      if (hookEvent === 'Stop' && !isAgentEvent) {
        // Stop = end of turn, not end of session. Keep orbital visible as idle.
        // Global state file already has stopped=true for ownership release.
        const idleExtra = { ...extra, turnEnded: true };
        delete idleExtra.stopped;
        writeSessionState(sessionId, 'idle', 'between turns', false, idleExtra);
      } else {
        if (failureEndsTurn) { extra.turnEnded = true; delete extra.turnOver; }
        writeSessionState(writeSessionId, state, detail, stopped, extra);
      }
      // Family heartbeat: an agent working proves its parent is alive, and the
      // parent itself writes nothing while it waits. See _touchSessionFile.
      if (isAgentEvent) _touchSessionFile(sessionId);
    }
    pruneFrequentFiles(stats.frequentFiles);
    _pruneCounters(counters, stats.session.id, now);
    writeStats(stats);
    } finally { if (releaseStats) releaseStats(); }
  } catch {
    // Parsing failed (empty or non-JSON stdin), or a parsed payload threw
    // further down -- then parsedIds still names the real session.
    try { writeFallback(parsedIds, null); } catch {}
  }

  process.exit(0);
});

