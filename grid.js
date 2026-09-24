'use strict';

// +================================================================+
// |  Orbital mode -- MiniFace and OrbitalSystem classes            |
// |  MiniFace renders compact subagent faces                       |
// |  OrbitalSystem orbits them around the main ClaudeFace          |
// +================================================================+

const fs = require('fs');
const path = require('path');
const {
  HOME, SESSIONS_DIR, safeFilename, detailText, strWidth, sliceToWidth, sliceFromEndToWidth,
  ACTIVE_WORK_STATES, INTERRUPTIBLE_STATES, COMPLETION_STATES,
} = require('./shared');
const { ansi, breathe, dimColor, themes, COMPLETION_LINGER, knownState } = require('./themes');
const { gridMouths } = require('./animations');

// -- Config --------------------------------------------------------

// ACTIVE_WORK_STATES / INTERRUPTIBLE_STATES / COMPLETION_STATES are shared
// with face.js and renderer.js via shared.js.
const HOME_FWD = HOME.replace(/\\/g, '/');  // Forward-slash-normalized HOME for path display

// Editors whose names may appear in legacy modelName fields / ID prefixes
const KNOWN_EDITORS = new Set(['claude', 'codex', 'opencode', 'openclaw', 'engmux']);

// Predefined team accent colors — assigned consistently by hashing the team name
const TEAM_COLORS = [
  [255, 120, 120],  // red
  [100, 200, 255],  // cyan
  [140, 255, 120],  // green
  [255, 210,  60],  // yellow
  [200, 120, 255],  // purple
  [255, 160,  60],  // orange
  [100, 255, 210],  // teal
  [255, 120, 210],  // pink
];

function hashTeamColor(teamName) {
  if (!teamName) return TEAM_COLORS[0];
  let h = 0;
  for (let i = 0; i < teamName.length; i++) {
    h = (h * 31 + teamName.charCodeAt(i)) >>> 0;
  }
  return TEAM_COLORS[h % TEAM_COLORS.length];
}

const CELL_H = 7;
const BOX_W = 8;
const BOX_INNER = 6;
const STALE_MS = 120000;
const STOPPED_LINGER_MS = 10000;
const IDLE_TIMEOUT = 8000;
const SLEEP_TIMEOUT = 60000;
const THINKING_TIMEOUT = 45000;
const ORPHAN_TIMEOUT = 90000;  // 90s fallback for sessions without pid or whose process has exited
// Subagent orbitals (parentSession set) go quiet for a whole model turn --
// they emit no hooks between tool calls, so 90s/120s retired them mid-work.
const CHILD_ORPHAN_TIMEOUT = 900000;  // 15 min for a live child orbital
const BREATHE_STEP = 200;  // Quantize breathe/pulse time to reduce frame-unique output

// -- Orbital Grouping Constants ------------------------------------
const INTER_GROUP_GAP = 0.15;      // Radians of spacing between group sectors (~8.5 deg)
const INTRA_GROUP_GAP = 0.35;      // Radians between faces within a group (~20 deg)
const TETHER_BRIGHTNESS = 0.15;    // Dim factor for sibling tether dots
const GROUP_LABEL_BRIGHTNESS = 0.45; // Dim factor for floating group label
const REPOSITION_MS = 4000;        // Duration of orbital reposition animation in ms

// -- Activity Cycling Constants (for synthetic subagent faces) --------
const CYCLE_WORK_STATES = ['thinking', 'reading', 'searching', 'coding', 'executing'];
const CYCLE_INTERVAL = 2500;       // ms between state changes
const CYCLE_STALE_MS = 3000;       // start cycling after 3s of no real data
// Real states cycling must never paint over: an actionable wait, an error, a
// reward (COMPLETION_LINGER retires it to thinking, and cycling resumes from
// there) and the post-turn responding.
const CYCLE_PROTECTED_STATES = new Set([
  'waiting', 'error', 'responding', ...COMPLETION_STATES,
]);

// Signal 0 tests process existence without killing it (works cross-platform in Node.js)
function isProcessAlive(pid) {
  if (!pid || pid <= 1) return false; // reject 0, negative, and PID 1 (init — always alive)
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // EPERM = process exists, different owner
}

// -- PID identity (start-time) tracking ------------------------------
// isProcessAlive proves *a* process exists, not *the* process — recycled
// PIDs falsely protect dead sessions. A PID owns a session only if its
// process started before the session's last write (+ slack).
const SLACK_MS = 1000;                 // NTFS 1s mtime granularity + minor skew
const PID_PROTECT_CAP_MS = 3600000;    // 1h cap when start time is unobtainable
const PID_CACHE_TTL_MS = 60000;        // re-resolve to close live->live recycle gap

// pid -> { value: epochMs | 'pending' | 'unknown-alive' | 'unknown-nodata', resolvedAt }
const _pidStartCache = new Map();
const _pidResolveQueue = new Set();
let _pidExecInFlight = false;

function _pidStartStatus(pid) {
  const e = _pidStartCache.get(pid);
  if (!e) return 'none';
  return typeof e.value === 'number' ? 'known' : e.value;
}

// Memoized PowerShell path — static for the process lifetime, so resolve once.
let _psExeCached = null;
function _winPsExe() {
  if (_psExeCached) return _psExeCached;
  _psExeCached = 'powershell';
  try {
    const psPath = path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(psPath)) _psExeCached = psPath;
  } catch {}
  return _psExeCached;
}

// Evict resolved entries nobody has asked about for 3x the TTL, so PIDs from
// sessions that vanished do not accumulate over a long renderer lifetime.
// Pending entries are left alone: a resolver may still be about to fill them.
function _sweepPidCache(now = Date.now()) {
  for (const [pid, e] of _pidStartCache) {
    if (e.value !== 'pending' && now - e.resolvedAt > 3 * PID_CACHE_TTL_MS) _pidStartCache.delete(pid);
  }
}

// Enqueue a PID for background start-time resolution. Fresh entries are
// left alone; TTL-expired entries keep their old value (still used by the
// gate) while a refresh rides the next batch. The `refreshing` marker says
// that refresh is already queued or in flight: without it every caller
// during the exec saw the same expired entry, re-queued the pid, and a
// redundant second batch ran as soon as the first returned. `done` replaces
// or deletes the entry, which clears the marker.
function requestPidStartTime(pid, aliveFn = isProcessAlive) {
  if (!pid || pid <= 1) return;
  const now = Date.now();
  _sweepPidCache(now);
  const e = _pidStartCache.get(pid);
  if (e && (e.value === 'pending' || e.refreshing || now - e.resolvedAt < PID_CACHE_TTL_MS)) return;
  if (!aliveFn(pid)) { _pidStartCache.delete(pid); return; }
  if (!e) _pidStartCache.set(pid, { value: 'pending', resolvedAt: now });
  else e.refreshing = true;
  _pidResolveQueue.add(pid);
  _kickPidResolve();
}

// Test seam: swap the platform start-time resolver. The Linux resolver reads
// /proc synchronously and calls back in the same tick, while win32/darwin go
// through execFile and cannot call back until the caller yields -- so the same
// test observes 'known' on Linux and 'pending' everywhere else. Tests inject a
// resolver with deterministic timing instead. Resetting also clears the
// in-flight latch and the queue, because _pidExecInFlight is only lowered
// inside `done` and test.js runs every test file in one process: a fake
// resolver that never calls back would otherwise freeze every later PID at
// 'pending' for the rest of the run.
let _pidResolver = _resolvePidStartTimes;
function _setPidResolver(fn) {
  _pidResolver = fn || _resolvePidStartTimes;
  _pidExecInFlight = false;
  _pidResolveQueue.clear();
  // A refresh that was queued or in flight will never report back now, so
  // its marker would otherwise block that pid from ever refreshing again.
  for (const e of _pidStartCache.values()) delete e.refreshing;
}

// One outstanding exec at a time; queued PIDs ride the next batch.
function _kickPidResolve() {
  if (_pidExecInFlight || _pidResolveQueue.size === 0) return;
  const pids = [..._pidResolveQueue];
  _pidResolveQueue.clear();
  _pidExecInFlight = true;
  let settled = false;
  const done = (results) => {
    if (settled) return;
    settled = true;
    const now = Date.now();
    for (const pid of pids) {
      if (!results) { _pidStartCache.set(pid, { value: 'unknown-nodata', resolvedAt: now }); continue; }
      const v = results.get(pid);
      if (v === undefined) _pidStartCache.delete(pid);        // absent from output = dead
      else _pidStartCache.set(pid, { value: v, resolvedAt: now }); // epochMs or 'unknown-alive'
    }
    _pidExecInFlight = false;
    if (_pidResolveQueue.size > 0) _kickPidResolve();
  };
  // A synchronous throw in a resolver must never latch _pidExecInFlight —
  // that would freeze every PID at 'pending' (protected) forever.
  try { _pidResolver(pids, done); } catch { done(null); }
}

// Platform resolvers. callback(Map<pid, epochMs|'unknown-alive'> | null on exec failure).
function _resolvePidStartTimes(pids, callback) {
  if (process.platform === 'linux') {
    const out = new Map();
    try {
      const uptimeSec = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
      const bootEpochMs = Date.now() - uptimeSec * 1000;
      const hz = 100; // USER_HZ is 100 on all mainstream kernels
      for (const pid of pids) {
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          // comm (field 2) may contain spaces/parens — split after the last ')'
          const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const startJiffies = parseInt(after[19], 10); // stat field 22
          if (!isNaN(startJiffies)) out.set(pid, bootEpochMs + (startJiffies / hz) * 1000);
        } catch {} // ENOENT = dead (absent from results)
      }
      callback(out);
    } catch { callback(null); }
    return;
  }
  const { execFile } = require('child_process');
  if (process.platform === 'win32') {
    // Per-PID error isolation: one dead PID must not poison the batch.
    // Emits "<pid> <epochMs>" for readable processes, "<pid> EPERM" when
    // StartTime is unreadable (elevated process), nothing when dead. The
    // trailing EOB sentinel distinguishes "all queried PIDs are dead"
    // (empty-but-complete output) from a silently broken powershell.
    const script = `$ErrorActionPreference='SilentlyContinue';` +
      `foreach($i in @(${pids.join(',')})){` +
      `$p=Get-Process -Id $i -ErrorAction SilentlyContinue;` +
      `if($p){ try { '{0} {1}' -f $i,[int64]($p.StartTime.ToUniversalTime() - [datetime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)).TotalMilliseconds } catch { '{0} EPERM' -f $i } } };'EOB'`;
    execFile(_winPsExe(), ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', script],
      { windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const s = String(stdout || '');
        if (!s.includes('EOB')) { callback(null); return; } // exec failed/blocked — no verdicts
        callback(_parsePidLines(s));
      });
    return;
  }
  // darwin: ps lstart with C locale for stable English date parsing
  execFile('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')],
    { env: { ...process.env, LC_ALL: 'C' }, timeout: 15000 }, (err, stdout) => {
      if (err && !stdout) { callback(null); return; }
      const out = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!m) continue;
        const t = Date.parse(m[2]);
        out.set(parseInt(m[1], 10), isNaN(t) ? 'unknown-alive' : t);
      }
      callback(out);
    });
}

function _parsePidLines(stdout) {
  const out = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(EPERM|-?\d+)\s*$/.exec(line);
    if (!m) continue;
    out.set(parseInt(m[1], 10), m[2] === 'EPERM' ? 'unknown-alive' : parseInt(m[2], 10));
  }
  return out;
}

// The gate. Synchronous: start-time cache + a kill(0) probe — no exec,
// never blocks. aliveFn is injectable for tests.
// Unknown start times ('unknown-alive': process present but StartTime is
// Access-Denied, e.g. crashpad_handler holding a recycled PID; or
// 'unknown-nodata': no exec capability) protect only up to the 1h cap.
// A real elevated editor refreshes lastWriteMs with every hook and its
// orbital reappears on the next write after an idle gap; an uncapped
// protect-while-alive would instead immortalize ghosts whose PIDs were
// recycled onto protected system processes (observed live: ghost 44240).
function isOwnedByLiveProcess(pid, lastWriteMs, aliveFn = isProcessAlive) {
  if (!pid || pid <= 1) return false;
  if (!aliveFn(pid)) return false;
  requestPidStartTime(pid, aliveFn);
  const e = _pidStartCache.get(pid);
  const value = e ? e.value : 'pending';
  if (typeof value === 'number') return value <= (lastWriteMs || 0) + SLACK_MS;
  if (value === 'pending') return true;
  return Date.now() - (lastWriteMs || 0) < PID_PROTECT_CAP_MS; // both unknowns
}

// A pid from a file is only a pid if it is a positive integer: an object
// `pid` threw inside the async loader's fs callback -- an uncaught exception
// that took the renderer down 2s after every boot.
function validPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

// PID protection for one session. A child's pid is its PARENT's editor, so
// that process living proves nothing about the agent: an agent whose
// SubagentStop was missed (an Esc) stood on the ring for as long as the
// editor ran -- and held the main face at "conducting 1" with it. A child
// keeps the protection only for CHILD_ORPHAN_TIMEOUT past its last write,
// the same window a silent agent in a live family gets anyway.
function pidProtects(pid, lastWriteMs, isChild, now = Date.now()) {
  if (!validPid(pid) || !isOwnedByLiveProcess(pid, lastWriteMs)) return false;
  return !isChild || now - lastWriteMs <= CHILD_ORPHAN_TIMEOUT;
}

// -- MiniFace (compact, for grid) ----------------------------------
// A session file's id: its own session_id when that is text, else the file
// name. An object id keyed the faces map by a fresh object on every load --
// the face respawned, and the center swap-animated, every 2s.
function sessionIdOf(data, file) {
  const v = data && data.session_id;
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return path.basename(file, '.json');
}

class MiniFace {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.state = 'idle';
    this.detail = '';
    this.label = '';
    this.cwd = '';
    this._cwdBasename = '';
    this.modelName = '';
    this.model = '';           // real model identity (Opus/Sonnet/...), when known
    this.editor = '';          // editor provenance (claude/codex/opencode/...)
    this.lastUpdate = Date.now();
    this.firstSeen = Date.now();
    this.stopped = false;
    this.stoppedAt = 0;
    this.frame = 0;
    this.time = 0;
    this.blinkTimer = 2500 + Math.random() * 3500;
    this.blinkFrame = -1;
    this.lookDir = 0;
    this.lookTimer = 0;
    this.parentSession = null; // set if this is a subagent orbital
    this.agentType = '';       // Claude Code agent_type (Explore, Plan, ...)
    // Whether the conducting parent still shows a sign of life. Only the long
    // CHILD_ORPHAN_TIMEOUT depends on it, and it starts true so a face nobody
    // has classified yet is protected -- the same "unresolved means protect"
    // convention isOwnedByLiveProcess uses for a pending PID.
    this.parentAlive = true;
    this.teamName = '';        // agent teams: team name
    this.teammateName = '';    // agent teams: teammate role/name
    this.isTeammate = false;   // true if part of an agent team
    this.teamColor = null;     // RGB color derived from teamName
    this.isMainSession = false; // true if independent (no parentSession, not teammate)
    this.gitBranch = null;     // current git branch (if known)
    this.taskDescription = ''; // sticky task description from SubagentStart
    this.pid = 0;              // owning process PID for liveness detection
    this.lastPromptAt = 0;     // when the user last prompted this session (attention)
    this.toolCalls = 0;        // session tool-call counter, for the list's info row
    this.filesEdited = 0;
    this._lastDataTimestamp = 0; // Track JSON timestamp to skip redundant updates (ms precision)
    this.minDisplayUntil = 0;  // Minimum display time to prevent flashing
    this.pendingState = null;  // Buffered state when minDisplayUntil blocks
    this.pendingDetail = null;
    // Startup/spawn animation state for orbitals
    this.spawning = false;      // true while this mini-face is entering the orbit
    this.spawnProgress = 0;       // ms elapsed since spawn began
    this.SPAWN_MS = 800;          // duration of the spawn animation in ms
    // Smooth orbital repositioning state
    this.orbitalOffset = null;      // Current rendered offset from rotationAngle (null = uninitialized)
    this.targetOffset = null;       // Target offset from _calculateGroupedAngles
    this._lerpStartOffset = 0;     // Offset when lerp began
    this._lerpElapsed = 0;         // ms elapsed in current lerp
    this.REPOSITION_MS = REPOSITION_MS;
    this._cwdForBasename = '';  // tracks which cwd value _cwdBasename was computed from
  }

  get cwdBasename() {
    if (this.cwd !== this._cwdForBasename) {
      this._cwdBasename = this.cwd ? path.basename(this.cwd) : '';
      this._cwdForBasename = this.cwd;
    }
    return this._cwdBasename;
  }

  updateFromFile(data, fileMtimeMs) {
    // Stopped faces don't need state updates — they're lingering until pruned
    if (this.stopped) return;
    // Skip if data hasn't changed since last read (prevents tick() oscillation).
    // Uses JSON timestamp (ms precision) instead of file mtime — immune to NTFS 1s granularity.
    const dataTs = data.timestamp || 0;
    if (dataTs && dataTs === this._lastDataTimestamp) {
      // Same content, newer mtime: the file was touched, not rewritten (the
      // parent heartbeat and _touchActiveSubagents both do this). Take the
      // mtime so the face doesn't go stale under a demonstrably fresh file.
      // Only the file's own mtime is used, never Date.now() -- polling must
      // not be able to keep a dead session alive.
      if (fileMtimeMs && fileMtimeMs > this.lastUpdate) this.lastUpdate = fileMtimeMs;
      return;
    }
    this._lastDataTimestamp = dataTs;

    const newState = knownState(data.state);
    const now = Date.now();
    if (newState !== this.state) {
      // Minimum display time: don't flicker between states too rapidly
      // Errors always bypass (important feedback), stopped sessions always bypass
      // Spawning always bypasses so the initial state is applied immediately
      // Active work states (reading, searching, coding, etc.) can interrupt
      // interruptible states (satisfied, happy, thinking, idle, etc.) to show
      // real-time activity without delay
      const canInterrupt = ACTIVE_WORK_STATES.has(newState) && INTERRUPTIBLE_STATES.has(this.state);
      if (now >= this.minDisplayUntil || newState === 'error' || newState === 'spawning' || data.stopped || canInterrupt) {
        this.state = newState;
        this.detail = detailText(data.detail);
        // Work states get shorter display (800ms) so tool activity is visible
        this.minDisplayUntil = now + (ACTIVE_WORK_STATES.has(newState) ? 800 : 1500);
        this.pendingState = null;
        this.pendingDetail = null;
      } else {
        // Buffer as pending instead of dropping — will flush when minDisplayUntil expires
        this.pendingState = newState;
        this.pendingDetail = detailText(data.detail);
      }
    } else {
      // Same state — refresh the timer and update detail
      this.minDisplayUntil = now + 1500;
      this.detail = detailText(data.detail);
      // A fresh write of the same WORK state is a new tool call; a completion
      // still queued from the previous one would otherwise flush over it.
      if (ACTIVE_WORK_STATES.has(newState) && COMPLETION_STATES.has(this.pendingState)) {
        this.pendingState = null;
        this.pendingDetail = null;
      }
    }
    // Use file mtime (when available) so lastUpdate reflects when the hook
    // handler actually wrote the file, not when the renderer polled it.
    // This breaks the deadlock where polling refreshed lastUpdate and
    // prevented isStale() from ever firing on orphaned sessions.
    this.lastUpdate = fileMtimeMs || Date.now();
    // Every text field is a string on one line, whatever the file says: a
    // model_name object (a documented adapter input) crashed the renderer at
    // `.slice` in _assignLabels -- at boot, every boot, until the file went
    // stale -- and a newline or ESC in a folder or branch name reached the
    // terminal raw. (detailText strips control characters, C1 included.)
    const text = (v) => detailText(typeof v === 'string' ? v : '');
    if (text(data.cwd)) this.cwd = text(data.cwd);
    if (text(data.modelName)) this.modelName = text(data.modelName);
    if (text(data.model)) this.model = text(data.model);
    if (text(data.editor)) this.editor = text(data.editor);
    else if (!this.editor) {
      // Best-effort legacy derivation: modelName-as-editor, then ID prefix
      if (KNOWN_EDITORS.has(data.modelName)) this.editor = data.modelName;
      else {
        const m = /^([a-z]+)-/.exec(String(this.sessionId));
        if (m && KNOWN_EDITORS.has(m[1])) this.editor = m[1];
      }
    }
    if (text(data.parentSession)) this.parentSession = text(data.parentSession);
    else if (this.parentSession && !data.isTeammate && !this.isTeammate) {
      // update-state.js heals a window falsely stamped as a subagent (#134)
      // by dropping parentSession/taskDescription from its file. Every child
      // write carries parentSession, so its absence IS the heal: without this
      // the face stayed a "child" -- never the center, counted as a live
      // child of its old parent -- for as long as the renderer ran.
      this.parentSession = null;
      this.taskDescription = text(data.taskDescription);
    }
    if (text(data.agentType)) this.agentType = text(data.agentType);
    if (text(data.teamName)) {
      this.teamName = text(data.teamName);
      this.teamColor = hashTeamColor(this.teamName);
    }
    if (text(data.teammateName)) this.teammateName = text(data.teammateName);
    if (data.isTeammate) this.isTeammate = true;
    if (text(data.gitBranch)) this.gitBranch = text(data.gitBranch);
    if (text(data.taskDescription)) this.taskDescription = text(data.taskDescription);
    if (Number.isInteger(data.pid) && data.pid > 0) this.pid = data.pid;
    if (typeof data.lastPromptAt === 'number') this.lastPromptAt = data.lastPromptAt;
    if (typeof data.toolCalls === 'number') this.toolCalls = data.toolCalls;
    if (typeof data.filesEdited === 'number') this.filesEdited = data.filesEdited;
    // Classify: independent session = no parentSession and not a teammate
    this.isMainSession = !this.parentSession && !this.isTeammate;

    if (data.stopped && !this.stopped) {
      this.stopped = true;
      this.stoppedAt = Date.now();
    }
  }

  isStale() {
    // Stopped faces: use stoppedAt timer regardless of PID
    if (this.stopped) {
      return Date.now() - this.stoppedAt > STOPPED_LINGER_MS;
    }
    // Non-stopped: if the owning process is alive AND actually ours
    // (start time predates our last write — recycled PIDs fail), never stale
    if (pidProtects(this.pid, this.lastUpdate, !!this.parentSession)) return false;
    // No pid or dead process: a completion state on an ORPHANED child gets the
    // short timeout -- an agent that reported `happy` and went quiet while its
    // parent shows no sign of life is finished.
    // A face is built from its file and judged in the same loadSessions pass,
    // before any tick() has moved the reward state on (steady-state ticks
    // retire a reward within its COMPLETION_LINGER, all under 10s), so this
    // rule effectively only ever judges a freshly built face. Applied to a
    // top-level window at a cold boot it declared a live session dead for
    // having last written `proud` (on win32 it never became a center
    // candidate). Applied to a child of a LIVE family it did the same to every
    // agent whose last write was a reward: created and deleted on every pass,
    // liveChildCount() 0, and the main face lost its conducting hold. So it
    // needs both: a child, and a parent whose file is no longer fresh.
    if (this.parentSession && !this.parentAlive && COMPLETION_STATES.has(this.state)) {
      return Date.now() - this.lastUpdate > STOPPED_LINGER_MS;
    }
    // Everything else: orphan timeout. A child orbital gets the longer window
    // -- a subagent in a long model turn writes nothing until its next tool
    // call, and dropping it there is exactly the "subagents don't all show up"
    // symptom. The extension is conditional on the parent still showing a sign
    // of life, so a crashed parent's ghosts degrade on the normal schedule
    // instead of animating fake work for a quarter of an hour.
    const orphanMs = (this.parentSession && this.parentAlive)
      ? CHILD_ORPHAN_TIMEOUT : ORPHAN_TIMEOUT;
    return Date.now() - this.lastUpdate > orphanMs;
  }

  tick(dt) {
    this.time += dt;
    this.frame++;

    // Blink logic (always runs)
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkFrame = 0;
      this.blinkTimer = 2500 + Math.random() * 3500;
    }
    if (this.blinkFrame >= 0) {
      this.blinkFrame++;
      if (this.blinkFrame >= 3) this.blinkFrame = -1;
    }

    // Search look direction (always runs)
    if (this.state === 'searching') {
      this.lookTimer += dt;
      if (this.lookTimer > 600) {
        this.lookDir = [-1, 0, 1, 0][Math.floor(Math.random() * 4)];
        this.lookTimer = 0;
      }
    }

    // Update startup spawn progress for orbitals (always runs)
    if (this.spawning) {
      this.spawnProgress += dt;
      if (this.spawnProgress >= this.SPAWN_MS) {
        this.spawning = false;
        this.spawnProgress = this.SPAWN_MS;
      }
    }

    // Advance orbital offset lerp
    if (this._lerpElapsed < this.REPOSITION_MS && this.targetOffset !== null && this.orbitalOffset !== null) {
      this._lerpElapsed += dt;
      const rawT = Math.min(1, this._lerpElapsed / this.REPOSITION_MS);
      const t = 1 - (1 - rawT) * (1 - rawT) * (1 - rawT); // cubic ease-out
      const dist = this._shortestAngleDist(this._lerpStartOffset, this.targetOffset);
      this.orbitalOffset = this._lerpStartOffset + dist * t;
      if (rawT >= 1) this.orbitalOffset = this.targetOffset; // snap at completion
    }

    // --- Flush pending state when minDisplayUntil expires ---
    const now = Date.now();
    if (this.pendingState && now >= this.minDisplayUntil) {
      this.state = this.pendingState;
      this.detail = this.pendingDetail || '';
      this.pendingState = null;
      this.pendingDetail = null;
      this.minDisplayUntil = now + 1500;
    }

    // --- Timeout-based state transitions (guarded by minDisplayUntil) ---
    if (now < this.minDisplayUntil) return;

    const elapsed = now - this.lastUpdate;

    // Spawning is a transient boot state — auto-transition to thinking after 2s
    if (this.state === 'spawning' && now - this.firstSeen > 2000) {
      this.state = 'thinking';
      this.minDisplayUntil = now + 1500;
    }

    // Activity cycling for synthetic subagent faces — while a subagent tool
    // is running, the parent emits no further hook events. Cycle through work
    // states to show the face is alive and working.
    //
    // Only synthetic faces cycle (see _cyclesActivity): a real agent orbital
    // reports its own tools, so cycling would paint invented work over real
    // state. And a face whose real state is actionable or meaningful --
    // waiting on a permission prompt, an error, a reward, responding -- is
    // never overwritten by fake reading/searching after CYCLE_STALE_MS.
    if (this.parentSession && !this.stopped && !this.spawning && this._cyclesActivity()) {
      const sinceUpdate = now - this.lastUpdate;
      if (sinceUpdate > CYCLE_STALE_MS) {
        const cycleTime = now - this.firstSeen;
        const idx = Math.floor(cycleTime / CYCLE_INTERVAL) % CYCLE_WORK_STATES.length;
        const cycleState = CYCLE_WORK_STATES[idx];
        if (this.state !== cycleState) {
          this.state = cycleState;
          this.detail = this._cycleDetail();
        }
        this.minDisplayUntil = now + 800;
        return; // Cycling owns state — skip timeout logic below
      }
    }

    const completionLinger = COMPLETION_LINGER[this.state];
    const sessionActive = !this.stopped;

    if (completionLinger && elapsed > completionLinger) {
      this.state = sessionActive ? 'thinking' : 'idle';
      this.minDisplayUntil = now + 1500;
    } else if (this.state === 'thinking' &&
               elapsed > (sessionActive ? THINKING_TIMEOUT : IDLE_TIMEOUT)) {
      this.state = 'idle';
      this.minDisplayUntil = now + 1500;
    } else if (!COMPLETION_STATES.has(this.state) &&
               this.state !== 'idle' && this.state !== 'sleeping' &&
               this.state !== 'waiting' && this.state !== 'thinking' &&
               elapsed > IDLE_TIMEOUT) {
      this.state = sessionActive ? 'thinking' : 'idle';
      this.minDisplayUntil = now + 1500;
    }
    if (this.state === 'idle' && elapsed > SLEEP_TIMEOUT) {
      this.state = 'sleeping';
      this.minDisplayUntil = now + 1500;
    }
  }

  // Whether activity cycling may drive this face. A Claude Code agent orbital
  // is named `{parent}-agent-{agentId}` (subagentSessionId) and writes its own
  // hooks, so it is never synthetic. For the rest, cycling may only replace a
  // neutral state or its own previous cycle state.
  _cyclesActivity() {
    if (/-agent-/.test(String(this.sessionId))) return false;
    return !CYCLE_PROTECTED_STATES.has(this.state);
  }

  _cycleDetail() {
    if (this.taskDescription) return sliceToWidth(this.taskDescription, 8);
    switch (this.state) {
      case 'reading':   return 'reading';
      case 'searching': return 'looking';
      case 'coding':    return 'writing';
      case 'executing': return 'running';
      default:          return 'working';
    }
  }

  _shortestAngleDist(from, to) {
    let d = to - from;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  setTargetOffset(offset) {
    // First assignment or spawning: snap immediately
    if (this.orbitalOffset === null || this.spawning) {
      this.orbitalOffset = offset;
      this.targetOffset = offset;
      this._lerpElapsed = this.REPOSITION_MS;
      return;
    }
    // Dead zone: ignore sub-pixel changes (0.005 rad ~ 0.15px at typical radius)
    if (Math.abs(this._shortestAngleDist(this.targetOffset, offset)) < 0.005) return;
    // Start lerp from current position
    this._lerpStartOffset = this.orbitalOffset;
    this.targetOffset = offset;
    this._lerpElapsed = 0;
  }

  getEyes() {
    if (this.blinkFrame >= 0) return ' \u2584\u2584 \u2584\u2584';

    switch (this.state) {
      case 'idle':        return ' \u2588\u2588 \u2588\u2588';
      case 'thinking': {
        const p = Math.floor(this.frame / 4) % 4;
        return [' \u25cf\u00b7 \u00b7\u25cf', ' \u00b7\u25cf \u25cf\u00b7', ' \u25cf\u00b7 \u25cf\u00b7', ' \u00b7\u25cf \u00b7\u25cf'][p];
      }
      case 'responding': {
        const r = Math.floor(this.frame / 30) % 2;
        return r ? ' \u2584\u2584 \u2588 ' : ' \u2584\u2584 \u2588\u2588';
      }
      case 'reading':     return ' \u2500\u2500 \u2500\u2500';
      case 'searching':
        if (this.lookDir < 0) return ' \u2588\u2588 \u2588\u00b7';
        if (this.lookDir > 0) return ' \u00b7\u2588 \u2588\u2588';
        return ' \u2588\u2588 \u2588\u2588';
      case 'coding':      return ' \u2580\u2580 \u2580\u2580';
      case 'executing':   return ' \u2588\u2588 \u2588\u2588';
      case 'happy': {
        const h = Math.floor(this.frame / 3) % 2;
        return [' \u2726\u2727 \u2727\u2726', ' \u2727\u2726 \u2726\u2727'][h];
      }
      case 'error': {
        const r1 = (this.frame * 2654435761) >>> 0;
        if ((r1 % 100) < 12) {
          const g = ['\u2593\u2591', '\u2591\u2592', '\u2592\u2593', '\u2588\u2591'];
          const i = (r1 >>> 8) % g.length;
          const j = (i + 2) % g.length;
          return ` ${g[i]} ${g[j]}`;
        }
        return ' \u2572\u2571 \u2572\u2571';
      }
      case 'sleeping': {
        if (this.frame % 150 > 145) return ' \u2584\u2584 \u2584\u2584';
        return ' \u2500\u2500 \u2500\u2500';
      }
      case 'waiting': {
        const drift = Math.floor(this.frame / 40) % 3;
        if (drift === 1) return ' \u2584\u2588 \u2584\u2588';
        return ' \u2584\u2584 \u2584\u2584';
      }
      case 'testing': {
        if (this.frame % 25 < 2) return ' \u2580\u2588 \u2588\u2580';
        return ' \u2588\u2588 \u2588\u2588';
      }
      case 'installing':  return ' \u2584\u2584 \u2584\u2584';
      case 'caffeinated': {
        const j = this.frame % 3;
        if (j === 1) return '  \u2588\u2588\u2588 ';
        if (j === 2) return ' \u2588 \u2588 \u2588';
        return ' \u2588\u2588 \u2588\u2588';
      }
      case 'subagent':    return ' \u2588\u2588 \u2588\u2588';
      case 'satisfied':   return ' \u2580\u2580 \u2580\u2580';
      case 'proud':       return ' \u2584\u2584 \u2584\u2584';
      case 'relieved':    return ' \u2588\u2588 \u2588\u2588';
      case 'committing': {
        // Focused eyes that pulse — data streaming out
        const cp = Math.floor(this.frame / 8) % 2;
        return cp ? ' \u2580\u2580 \u2580\u2580' : ' \u2588\u2588 \u2588\u2588';
      }
      case 'reviewing': {
        // Scanning along a line -- reading with intent
        const rv = Math.floor(this.frame / 6) % 3;
        return [' \u2500\u2588 \u2500\u2588', ' \u2588\u2500 \u2588\u2500', ' \u2500\u2500 \u2500\u2500'][rv];
      }
      case 'training': {
        // Furnace eyes -- embers flicker
        const tf = Math.floor(this.frame / 5) % 2;
        return tf ? ' \u2593\u2593 \u2593\u2593' : ' \u2592\u2592 \u2592\u2592';
      }
      case 'starting':
      case 'spawning': {
        // Booting up -- dots resolve into open eyes
        const sp = Math.floor(this.frame / 4) % 3;
        return [' \u00b7\u00b7 \u00b7\u00b7', ' \u2584\u2584 \u2584\u2584', ' \u2588\u2588 \u2588\u2588'][sp];
      }
      default:            return ' \u2588\u2588 \u2588\u2588';
    }
  }

  getMouth() {
    if (this.state === 'error') {
      const r1 = (this.frame * 2246822519) >>> 0;
      if ((r1 % 100) < 8) {
        return ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2500\u25e1\u2500'][(r1 >>> 8) % 3];
      }
    }
    return gridMouths[this.state] || '\u25e1\u25e1\u25e1';
  }

  render(startRow, startCol, globalTime, paletteThemes) {
    const themeMap = paletteThemes || themes;
    const theme = themeMap[this.state] || themeMap.idle;
    const breathSpeed = this.state === 'sleeping' ? 0.5
      : this.state === 'caffeinated' ? 2.5
      : this.state === 'committing' ? 1.8 : 1;
    const quantizedTime = Math.floor(globalTime / BREATHE_STEP) * BREATHE_STEP;
    const bc = breathe(theme.border, (quantizedTime + this.firstSeen % 2000) * breathSpeed);
    const fc = ansi.fg(...bc);
    const ec = ansi.fg(...theme.eye);
    const mc = ansi.fg(...theme.mouth);
    const lc = ansi.fg(...theme.label);
    const dc = ansi.fg(...dimColor(theme.label, 0.55));
    const r = ansi.reset;

    const eyeStr = this.getEyes();
    const mouthStr = this.getMouth();
    const mPad = Math.max(0, Math.floor((BOX_INNER - mouthStr.length) / 2));
    const mRight = BOX_INNER - mPad - mouthStr.length;

    let buf = '';

    buf += ansi.to(startRow, startCol);
    buf += `${fc}\u256d${'\u2500'.repeat(BOX_INNER)}\u256e${r}`;

    buf += ansi.to(startRow + 1, startCol);
    buf += `${fc}\u2502${ec}${eyeStr}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 2, startCol);
    buf += `${fc}\u2502${' '.repeat(mPad)}${mc}${mouthStr}${r}${' '.repeat(Math.max(0, mRight))}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 3, startCol);
    buf += `${fc}\u2570${'\u2500'.repeat(BOX_INNER)}\u256f${r}`;

    // Rows 4-6 hold file text (label, branch, cwd, model, detail): measured
    // in columns, not code units, or a CJK name draws 16 wide in the 8 box.
    const lbl = sliceToWidth(this.label || '?', BOX_W);
    const lW = strWidth(lbl);
    const lPad = Math.max(0, Math.floor((BOX_W - lW) / 2));
    buf += ansi.to(startRow + 4, startCol);
    buf += `${lc}${' '.repeat(lPad)}${lbl}${' '.repeat(BOX_W - lPad - lW)}${r}`;

    const cwdBase = this.cwdBasename;
    // A child shares its parent's repo and folder, so branch/cwd on this row
    // is pure redundancy -- the model is the one thing you cannot read
    // anywhere else. A TOP-LEVEL orbital keeps the branch: a parallel editor
    // window may genuinely be somewhere else.
    const modelRow = (this.parentSession && this.model) ? sliceToWidth(this.model, BOX_W) : '';
    const statusStr = modelRow || (this.gitBranch
      ? sliceToWidth('\u2387 ' + this.gitBranch, BOX_W)   // ⎇ branchname
      : cwdBase
        ? sliceToWidth(cwdBase, BOX_W)
        : (theme.status || '').slice(0, BOX_W));
    const sW = strWidth(statusStr);
    const sPad = Math.max(0, Math.floor((BOX_W - sW) / 2));
    buf += ansi.to(startRow + 5, startCol);
    buf += `${dc}${' '.repeat(sPad)}${statusStr}${' '.repeat(BOX_W - sPad - sW)}${r}`;

    const detailStr = sliceToWidth(this.detail || '', BOX_W);
    const dW = strWidth(detailStr);
    const dPad = Math.max(0, Math.floor((BOX_W - dW) / 2));
    buf += ansi.to(startRow + 6, startCol);
    buf += `${dc}${' '.repeat(dPad)}${detailStr}${' '.repeat(BOX_W - dPad - dW)}${r}`;

    return buf;
  }
}

// -- OrbitalSystem -------------------------------------------------
// Orbits subagent MiniFaces around the main ClaudeFace
const MINI_W = BOX_W;       // 8 cols visible width of mini face
const MINI_H = CELL_H;      // 7 rows (box + label + status)
const MAX_ORBITALS = 8;      // Beyond this, labels become unreadable
const ORBIT_SPACING = 1.2;   // neighbour gap in box-lengths (margin for chord < arc)
const ORBIT_LUT_STEPS = 720;
const TAU = Math.PI * 2;

// The rectangle the ring must stay clear of. ClaudeFace publishes a worst-case
// `keepOut`; a bare mainPos (older callers, tests) gets one derived from the box.
function keepOutOf(mainPos) {
  if (mainPos.keepOut) return mainPos.keepOut;
  const above = mainPos.accessoriesActive ? (mainPos.accessoryHeight || 0) : 0;
  return {
    top: mainPos.row - Math.max(4, above),
    bottom: mainPos.row + mainPos.h + 4,
    left: mainPos.col - 1,
    right: mainPos.col + mainPos.w,
  };
}

// Pure: the orbit ellipse for a terminal and a keep-out rectangle.
//
// The ellipse is centred on the keep-out and sized so that a mini-face's box
// can sit anywhere on it without touching the keep-out: every box centre must
// satisfy |dx| >= ex or |dy| >= ey, which holds on the whole ellipse exactly
// when the expanded rectangle's corner lies inside it. The bottom row is left
// to the key-hint bar.
//
// Faces are spaced along the ellipse by BOX length, not by angle: an 8x7 box
// needs 9 columns of travel along the top but only 8 rows along the sides, so
// even angular spacing let neighbours collide near 0 and PI, and the overlap
// resolver then shoved them around frame to frame. `thetaAt(u)` maps a
// uniform "box-arc angle" u onto the ellipse's own angle; rotation and every
// offset live in u, so a gap of `minGap` in u is a real gap on screen at any
// rotation.
function computeOrbit(cols, rows, ko) {
  const none = { a: 0, b: 0, maxSlots: 0, cx: 0, cy: 0, minGap: 0, perimeter: 0, thetaAt: u => u };
  const cx = (ko.left + ko.right) / 2;
  const cy = (ko.top + ko.bottom) / 2;
  const ex = (ko.right - ko.left) / 2 + MINI_W / 2 + 1;
  const ey = (ko.bottom - ko.top) / 2 + MINI_H / 2 + 1;
  const maxA = Math.floor(Math.min(cx - MINI_W / 2 - 1, cols - cx - MINI_W / 2));
  const maxB = Math.floor(Math.min(cy - MINI_H / 2 - 1, rows - 1 - cy - MINI_H / 2));
  if (maxA <= ex || maxB <= ey) return none;

  let a = 0, b = 0;
  const prefA = Math.max(Math.ceil(ex) + 1, Math.floor(cols * 0.35));
  for (let tryA = Math.min(maxA, prefA); tryA <= maxA; tryA++) {
    if (tryA <= ex) continue;
    const needB = ey / Math.sqrt(1 - (ex / tryA) ** 2);
    if (needB <= maxB) {
      a = tryA;
      b = Math.min(maxB, Math.max(Math.ceil(needB), Math.floor(rows * 0.3)));
      break;
    }
  }
  if (!a) return none;

  // Cumulative box-arc length: a step's cost is how far it moves in box
  // widths or box heights, whichever is larger (boxes clear on either axis).
  const cum = new Float64Array(ORBIT_LUT_STEPS + 1);
  const dt = TAU / ORBIT_LUT_STEPS;
  for (let i = 0; i < ORBIT_LUT_STEPS; i++) {
    const t = (i + 0.5) * dt;
    cum[i + 1] = cum[i] + Math.max(
      Math.abs(a * Math.sin(t)) / (MINI_W + 1),
      Math.abs(b * Math.cos(t)) / (MINI_H + 1)) * dt;
  }
  const perimeter = cum[ORBIT_LUT_STEPS];
  const maxSlots = Math.min(MAX_ORBITALS, Math.floor(perimeter / ORBIT_SPACING));
  if (maxSlots < 1) return none;

  const thetaAt = (u) => {
    const s = ((u % TAU) + TAU) % TAU / TAU * perimeter;
    let lo = 0, hi = ORBIT_LUT_STEPS;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid; else hi = mid;
    }
    const span = cum[lo + 1] - cum[lo];
    return (lo + (span > 0 ? (s - cum[lo]) / span : 0)) * dt;
  };
  return { a, b, maxSlots, cx, cy, minGap: TAU * ORBIT_SPACING / perimeter, perimeter, thetaAt };
}

class OrbitalSystem {
  constructor() {
    this.faces = new Map();        // sessionId → MiniFace
    this.rotationAngle = 0;        // Current global rotation (radians)
    this.rotationSpeed = 0.007;    // ~1 full rotation per 60s at 15fps
    this.frame = 0;
    this.time = 0;
    this._sortedCache = [];        // Cached sorted faces array
    this._sortedDirty = true;      // Rebuild cache on next getSortedFaces()
    this._loadingInProgress = false; // Re-entrancy guard for loadSessionsAsync
    this._groupsCache = null;        // Cached _buildGroups result
    this._groupsDirty = true;        // Flag to invalidate groups cache
    this.mainSessionId = null;       // Session drawn as the big face, kept off the ring
    this._sessionsDir = null;        // test seam; production reads SESSIONS_DIR
  }

  // The main session is loaded like any other file (the renderer's face
  // follows its file through the same reads) but never drawn on the ring.
  setMainSession(id) {
    const next = id || null;
    if (next !== this.mainSessionId) {
      this.mainSessionId = next;
      this._sortedDirty = true;
      this._groupsDirty = true;
    }
  }

  getSortedFaces() {
    if (this._sortedDirty) {
      this._sortedCache = [...this.faces.values()]
        .filter(f => f.sessionId !== this.mainSessionId)
        .sort((a, b) => a.firstSeen - b.firstSeen);
      this._sortedDirty = false;
    }
    return this._sortedCache;
  }

  loadSessions(excludeId) {
    const dir = this._sessionsDir || SESSIONS_DIR;
    this.setMainSession(excludeId);
    const prevSize = this.faces.size;
    const prevKeys = new Set(this.faces.keys());
    let files;
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }

    // Build reverse map: safeFilename(faceId)+'.json' → faceId
    // Needed BEFORE file deletion so the deletion loop can correctly find
    // in-memory faces regardless of safeFilename() transformations.
    const fileToFaceId = new Map();
    for (const id of this.faces.keys()) {
      fileToFaceId.set(safeFilename(id) + '.json', id);
    }

    // Purge orphaned/finished session files — but protect active thinking faces
    const now = Date.now();
    // One stat per file, reused by the purge below and by the parent-freshness
    // rule: a child orbital only earns CHILD_ORPHAN_TIMEOUT while its parent's
    // file is fresh. Every agent write heartbeats that file, so a silent parent
    // really is a gone parent and its ghosts degrade on the normal schedule.
    const mtimes = new Map();
    for (const f of files) {
      try { mtimes.set(f, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
    }
    const parentIsFresh = (parentSession) => {
      const m = mtimes.get(safeFilename(parentSession) + '.json');
      return m !== undefined && now - m <= STALE_MS;
    };
    // The center's own file is never purged. On win32 there is no pid, so the
    // main's face goes stale at ORPHAN_TIMEOUT and stops protecting its file
    // 30s before the purge fires -- deleting the very file the renderer reads.
    // The next non-UserPromptSubmit hook recreates it with no lastPromptAt and
    // the attended window drops to attention 0.
    const mainFile = this.mainSessionId ? safeFilename(this.mainSessionId) + '.json' : null;
    for (const f of files) {
      try {
        const fp = path.join(dir, f);
        const fileMtimeMs = mtimes.get(f);
        if (fileMtimeMs === undefined) continue;
        if (now - fileMtimeMs > STALE_MS) {
          if (f === mainFile) continue;  // protected exactly like a knownFace
          // Use reverse map for correct face lookup (safeFilename may transform the ID)
          const faceId = fileToFaceId.get(f) || path.basename(f, '.json');
          const knownFace = this.faces.get(faceId);
          if (knownFace && !knownFace.stopped) {
            if (!COMPLETION_STATES.has(knownFace.state)) continue;  // Active non-completion: always protect
            if (pidProtects(knownFace.pid, knownFace.lastUpdate, !!knownFace.parentSession)) continue;  // Completion with owning PID: protect
          }
          // No protecting face — check file PID identity before deleting
          // (mtime fallback matches the async purge path for legacy files
          // whose JSON lacks a timestamp field)
          try {
            const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
            // A live subagent orbital emits no hooks during a model turn —
            // give child files the longer window before they are purged, but
            // only while the conducting parent still shows a sign of life.
            if (data.parentSession && !data.stopped &&
                parentIsFresh(data.parentSession) &&
                now - fileMtimeMs <= CHILD_ORPHAN_TIMEOUT) continue;
            // A stopped file is finished (SessionEnd, a retired agent): its
            // editor living on must not keep it on disk, or every retired
            // agent piled up -- read and parsed on each load -- for the
            // editor's whole lifetime (Unix only; win32 writes no pid).
            if (!data.stopped && pidProtects(data.pid, data.timestamp || fileMtimeMs, !!data.parentSession)) continue;
          } catch {
            continue; // Parse failure = mid-write race — protect the file
          }
          fs.unlinkSync(fp);
        }
      } catch {}
    }
    files = files.filter(f => {
      try { return fs.existsSync(path.join(dir, f)); } catch { return false; }
    });

    const seenIds = new Set();

    for (const file of files) {
      try {
        const fp = path.join(dir, file);
        const mtimeMs = fs.statSync(fp).mtimeMs;
        const raw = fs.readFileSync(fp, 'utf8').trim();
        if (!raw) {
          // Empty file (mid-write) — protect existing face from deletion
          const existingId = fileToFaceId.get(file);
          if (existingId) seenIds.add(existingId);
          continue;
        }
        const data = JSON.parse(raw);
        // `null`, a number or an array parses fine and is not a session.
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const id = sessionIdOf(data, file);

        // Keep start-time resolution warm for every session PID — on the
        // renderer's synchronous boot scan this enqueues all PIDs at once,
        // so one batched exec resolves them before the next purge cycle.
        if (validPid(data.pid)) requestPidStartTime(data.pid);

        seenIds.add(id);

        if (!this.faces.has(id)) {
          if (data.stopped) continue; // Don't resurrect stopped sessions — prevents linger/respawn cycle
          // New orbital session detected on startup; mark it to spawn with a startup animation
          const mf = new MiniFace(id);
          mf.spawning = true;
          mf.spawnProgress = 0;
          this.faces.set(id, mf);
        }
        const mf = this.faces.get(id);
        mf.updateFromFile(data, mtimeMs);
        // Only children gate on this; a top-level session is always "alive".
        mf.parentAlive = !data.parentSession || parentIsFresh(data.parentSession);
      } catch {
        // Parse failure (partial write) — protect existing face from deletion
        const existingId = fileToFaceId.get(file);
        if (existingId) seenIds.add(existingId);
        continue;
      }
    }

    for (const [id, face] of this.faces) {
      if (!seenIds.has(id) || face.isStale()) {
        // File gone but process alive? Keep face — file may reappear on next hook write.
        if (!seenIds.has(id) && !face.stopped && pidProtects(face.pid, face.lastUpdate, !!face.parentSession)) continue;
        this.faces.delete(id);
        // Don't delete session files here — the dedicated file stale purge above
        // handles cleanup with proper PID and face-state protection.
      }
    }

    this._assignLabels();

    // Always invalidate groups (face properties like teamName may change via updateFromFile)
    this._groupsDirty = true;
    // Only invalidate sorted cache if faces actually changed
    if (this.faces.size !== prevSize) {
      this._sortedDirty = true;
    } else {
      for (const key of this.faces.keys()) {
        if (!prevKeys.has(key)) { this._sortedDirty = true; break; }
      }
    }
  }

  // -- Async session loading (non-blocking event loop) ----------------
  // Reads session files using callback-based fs APIs so stdin events
  // (keypresses) can be processed between I/O operations.

  loadSessionsAsync(excludeId) {
    if (this._loadingInProgress) return; // Re-entrancy guard
    const dir = this._sessionsDir || SESSIONS_DIR;
    this._loadingInProgress = true;
    this.setMainSession(excludeId);

    fs.readdir(dir, (err, allFiles) => {
      if (err) { this._loadingInProgress = false; return; }
      const files = allFiles.filter(f => f.endsWith('.json'));
      if (files.length === 0) {
        try { this._applySessionResults(excludeId, []); } catch {}
        finally { this._loadingInProgress = false; }
        return;
      }

      // Read all files concurrently (non-blocking)
      const results = [];    // { file, data, mtimeMs } or { file, empty: true } or { file, error: true }
      let pending = files.length;

      const onComplete = () => {
        if (--pending > 0) return;
        // In an fs callback a throw is uncaught: it would end the renderer.
        try { this._applySessionResults(excludeId, results); } catch {}
        finally { this._loadingInProgress = false; }
      };

      for (const file of files) {
        const fp = path.join(dir, file);
        fs.stat(fp, (statErr, stats) => {
          if (statErr) { results.push({ file, error: true }); onComplete(); return; }
          fs.readFile(fp, 'utf8', (readErr, raw) => {
            if (readErr) { results.push({ file, error: true }); onComplete(); return; }
            const trimmed = (raw || '').trim();
            if (!trimmed) {
              results.push({ file, empty: true });
              onComplete();
              return;
            }
            try {
              const data = JSON.parse(trimmed);
              // A file holding `null` crashed the renderer 2s after boot.
              if (!data || typeof data !== 'object' || Array.isArray(data)) results.push({ file, error: true });
              else results.push({ file, data, mtimeMs: stats.mtimeMs });
            } catch {
              results.push({ file, error: true });
            }
            onComplete();
          });
        });
      }
    });
  }

  // How many of the main session's subagent orbitals are still live.
  // The renderer feeds this to idleCascade so the main face reads as
  // "conducting N" instead of cascading to idle/sleeping while its agents
  // work -- agent hooks write only their own orbital files, so nothing
  // refreshes global state between SubagentStart and SubagentStop.
  // Staleness is whatever isStale() already says, so a crashed parent whose
  // child files have gone stale stops holding the face up.
  liveChildCount() {
    if (!this.mainSessionId) return 0;
    let n = 0;
    for (const face of this.faces.values()) {
      if (face.parentSession === this.mainSessionId && !face.stopped && !face.isStale()) n++;
    }
    return n;
  }

  // excludeId is kept in the signature (loadSessionsAsync's call shape) but no
  // longer filters: the main session is loaded like every other file and is
  // only kept off the ring by getSortedFaces.
  _applySessionResults(excludeId, results) {
    const dir = this._sessionsDir || SESSIONS_DIR;
    const prevSize = this.faces.size;
    const prevKeys = new Set(this.faces.keys());

    // Build reverse map: safeFilename(faceId)+'.json' → faceId
    const fileToFaceId = new Map();
    for (const id of this.faces.keys()) {
      fileToFaceId.set(safeFilename(id) + '.json', id);
    }

    // Purge stale session files (async unlink — fire and forget)
    const now = Date.now();
    const survivingResults = [];

    // Sessions that still show a sign of life. A child orbital only earns the
    // long CHILD_ORPHAN_TIMEOUT while its parent is in here: every agent write
    // heartbeats the parent's file, so a parent silent for STALE_MS has really
    // gone and its ghost children must not keep animating fake work.
    const freshIds = new Set();
    for (const r of results) {
      if (r.error || r.empty || !r.data) continue;
      if (now - r.mtimeMs <= STALE_MS) {
        freshIds.add(sessionIdOf(r.data, r.file));
      }
    }

    // The center's own file is never purged -- see the sync purge above.
    const mainFile = this.mainSessionId ? safeFilename(this.mainSessionId) + '.json' : null;

    for (const r of results) {
      if (r.error || r.empty) { survivingResults.push(r); continue; }

      if (now - r.mtimeMs > STALE_MS) {
        if (r.file === mainFile) { survivingResults.push(r); continue; }
        const faceId = fileToFaceId.get(r.file) || path.basename(r.file, '.json');
        const knownFace = this.faces.get(faceId);
        if (knownFace && !knownFace.stopped) {
          if (!COMPLETION_STATES.has(knownFace.state)) {
            survivingResults.push(r); // Protected — active non-completion face
            continue;
          }
          if (pidProtects(knownFace.pid, knownFace.lastUpdate, !!knownFace.parentSession)) {
            survivingResults.push(r); // Protected — completion with owning PID
            continue;
          }
        }
        // A live subagent orbital emits no hooks during a model turn — give
        // child files the longer window before they are purged, but only while
        // the conducting parent still shows a sign of life.
        if (r.data && r.data.parentSession && !r.data.stopped &&
            freshIds.has(r.data.parentSession) &&
            now - r.mtimeMs <= CHILD_ORPHAN_TIMEOUT) {
          survivingResults.push(r); // Protected — subagent in a long model turn
          continue;
        }
        if (r.data && !r.data.stopped &&
            pidProtects(r.data.pid, r.data.timestamp || r.mtimeMs, !!r.data.parentSession)) {
          survivingResults.push(r); // Protected — owning process alive
          continue;
        }
        // Stale and unprotected — delete asynchronously
        fs.unlink(path.join(dir, r.file), () => {});
        continue;
      }
      survivingResults.push(r);
    }

    // Apply session data to faces map
    const seenIds = new Set();

    for (const r of survivingResults) {
      if (r.empty || r.error) {
        const existingId = fileToFaceId.get(r.file);
        if (existingId) seenIds.add(existingId);
        continue;
      }

      const id = sessionIdOf(r.data, r.file);
      if (validPid(r.data.pid)) requestPidStartTime(r.data.pid); // keep start-time cache warm
      seenIds.add(id);

      if (!this.faces.has(id)) {
        if (r.data.stopped) continue; // Don't resurrect stopped sessions — prevents linger/respawn cycle
        const mf = new MiniFace(id);
        mf.spawning = true;
        mf.spawnProgress = 0;
        this.faces.set(id, mf);
      }
      const mf = this.faces.get(id);
      mf.updateFromFile(r.data, r.mtimeMs);
      // Only children gate on this; a top-level session is always "alive".
      mf.parentAlive = !r.data.parentSession || freshIds.has(r.data.parentSession);
    }

    // Remove faces not seen in files or stale in memory
    for (const [id, face] of this.faces) {
      if (!seenIds.has(id) || face.isStale()) {
        // File gone but process alive? Keep face — file may reappear on next hook write.
        if (!seenIds.has(id) && !face.stopped && pidProtects(face.pid, face.lastUpdate, !!face.parentSession)) continue;
        this.faces.delete(id);
        // Don't delete session files here — the dedicated file stale purge above
        // handles cleanup with proper PID and face-state protection.
      }
    }

    this._assignLabels();

    // Always invalidate groups (face properties like teamName may change via updateFromFile)
    this._groupsDirty = true;
    if (this.faces.size !== prevSize) {
      this._sortedDirty = true;
    } else {
      for (const key of this.faces.keys()) {
        if (!prevKeys.has(key)) { this._sortedDirty = true; break; }
      }
    }
  }

  _assignLabels() {
    const sorted = [...this.faces.values()]
      .filter(f => f.sessionId !== this.mainSessionId)
      .sort((a, b) => a.firstSeen - b.firstSeen);
    if (sorted.length === 0) return;

    const cwdCounts = {};
    for (const face of sorted) {
      const base = face.cwdBasename;
      cwdCounts[base] = (cwdCounts[base] || 0) + 1;
    }

    const cwdIndex = {};
    for (let i = 0; i < sorted.length; i++) {
      const face = sorted[i];

      // Team members use their designated teammate name
      if (face.teammateName) {
        face.label = sliceToWidth(face.teammateName, 8);
        continue;
      }

      const base = face.cwdBasename;

      // Documented order: teammateName > taskDescription > cwd basename >
      // modelName > sub-N. A top-level face's modelName used to win before
      // its cwd, so two parallel windows in different folders both read
      // `claude`. It is now only the fallback when the folder cannot tell
      // this face apart (no cwd, or a basename shared with another face).
      if (face.taskDescription) {
        face.label = sliceToWidth(face.taskDescription, 8);
      } else if (sorted.length === 1) {
        face.label = sliceToWidth(base || face.modelName || 'sub', 8);
      } else if (base && cwdCounts[base] === 1) {
        face.label = sliceToWidth(base, 8);
      } else if (face.isMainSession && face.modelName) {
        face.label = sliceToWidth(face.modelName, 8);
      } else if (face.parentSession && face.agentType) {
        // A child's modelName is its agent type only when one is known (a
        // legacy child carries the editor name), so read agentType directly.
        face.label = sliceToWidth(face.agentType, 8);
      } else {
        cwdIndex[base] = (cwdIndex[base] || 0) + 1;
        face.label = 'sub-' + (i + 1);
      }
    }
  }

  // -- Orbital Grouping ---------------------------------------------
  // Groups visible orbitals by team/parent for clustered positioning

  _buildGroups(visible) {
    // The cache is keyed on the visible set as well as on session reloads:
    // maxSlots changes with the terminal size, so after a resize the visible
    // subset can differ without any session file having changed.
    const sig = visible.map(f => f.sessionId).join('\u0000');
    if (!this._groupsDirty && this._groupsCache && this._groupsSig === sig) return this._groupsCache;
    this._groupsSig = sig;
    const map = new Map();
    for (const face of visible) {
      const key = face.teamName || face.parentSession || face.sessionId;
      if (!map.has(key)) map.set(key, { key, color: null, members: [] });
      map.get(key).members.push(face);
    }
    const groups = [...map.values()].sort((a, b) =>
      Math.min(...a.members.map(m => m.firstSeen)) - Math.min(...b.members.map(m => m.firstSeen))
    );
    for (const g of groups) {
      const teamFace = g.members.find(m => m.teamColor);
      g.color = teamFace ? teamFace.teamColor : null;
    }
    this._groupsCache = groups;
    this._groupsDirty = false;
    return groups;
  }

  // Offsets in the orbit's box-arc angle (see computeOrbit). `minGap` is the
  // smallest separation that keeps two neighbouring boxes apart; members of a
  // group sit INTRA_GROUP_GAP apart (never closer than minGap) and the groups
  // share what is left of the circle evenly, so all-singletons is exactly even.
  _calculateGroupedAngles(visible, minGap = INTER_GROUP_GAP) {
    const n = visible.length;
    if (n === 0) return new Map();
    if (n === 1) return new Map([[visible[0], this.rotationAngle]]);

    const groups = this._buildGroups(visible);
    const k = groups.length;
    const inner = n - k; // neighbour pairs inside a group
    let intra = Math.max(minGap, INTRA_GROUP_GAP);
    let inter;
    if (n * minGap >= TAU) {
      intra = inter = TAU / n; // cannot honour minGap: best effort is even
    } else {
      // Squeeze clusters first; never below minGap, never starving the gaps.
      if (inner > 0 && inner * intra + k * minGap > TAU) {
        intra = Math.max(minGap, (TAU - k * minGap) / inner);
      }
      inter = (TAU - inner * intra) / k;
    }

    const angles = new Map();
    let cur = this.rotationAngle;
    for (const g of groups) {
      for (let i = 0; i < g.members.length; i++) angles.set(g.members[i], cur + i * intra);
      cur += (g.members.length - 1) * intra + inter;
    }
    return angles;
  }

  _resolveOverlaps(positions, cols, rows) {
    const maxIter = 3;
    for (let iter = 0; iter < maxIter; iter++) {
      let moved = false;
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const a = positions[i];
          const b = positions[j];
          // Check bounding box overlap (MINI_W x MINI_H)
          const overlapX = Math.min(a.col + MINI_W, b.col + MINI_W) - Math.max(a.col, b.col);
          const overlapY = Math.min(a.row + MINI_H, b.row + MINI_H) - Math.max(a.row, b.row);
          if (overlapX <= 0 || overlapY <= 0) continue;

          moved = true;
          // Push apart along axis with less overlap
          if (overlapX <= overlapY) {
            // Horizontal push
            const nudge = Math.ceil(overlapX / 2);
            if (a.col <= b.col) {
              a.col = Math.max(1, a.col - nudge);
              b.col = Math.min(cols - MINI_W, b.col + nudge);
            } else {
              b.col = Math.max(1, b.col - nudge);
              a.col = Math.min(cols - MINI_W, a.col + nudge);
            }
          } else {
            // Vertical push
            const nudge = Math.ceil(overlapY / 2);
            if (a.row <= b.row) {
              a.row = Math.max(1, a.row - nudge);
              b.row = Math.min(rows - MINI_H, b.row + nudge);
            } else {
              b.row = Math.max(1, b.row - nudge);
              a.row = Math.min(rows - MINI_H, a.row + nudge);
            }
          }
        }
      }
      if (!moved) break;
    }
  }

  // Cached per (terminal size, keep-out): the keep-out only moves on a resize
  // or a toggle, so this is computed a handful of times per session.
  calculateOrbit(cols, rows, mainPos) {
    const ko = keepOutOf(mainPos);
    const key = `${cols},${rows},${ko.top},${ko.bottom},${ko.left},${ko.right}`;
    if (this._orbitCache && this._orbitCache.key === key) return this._orbitCache.orbit;
    const orbit = computeOrbit(cols, rows, ko);
    this._orbitCache = { key, orbit };
    return orbit;
  }

  // Is (row, col) inside the main face's footprint (or its current bubble)?
  // Connection dots, tethers and group labels all skip it.
  _inMainZone(mainPos, row, col) {
    const ko = keepOutOf(mainPos);
    if (col >= ko.left - 1 && col <= ko.right + 1 && row >= ko.top - 1 && row <= ko.bottom + 1) return true;
    const bub = mainPos.bubble;
    return !!bub && col >= bub.col - 1 && col <= bub.col + bub.w + 1 && row >= bub.row - 1 && row <= bub.row + bub.h;
  }

  _renderConnections(mainPos, positions, accentColor) {
    let out = '';
    const r = ansi.reset;

    for (const pos of positions) {
      // Draw connection lines only to direct children (parentSession matches main) and team members
      const isChild = pos.face && pos.face.parentSession && pos.face.parentSession === this.mainSessionId;
      if (pos.face && !isChild && !pos.face.isTeammate) continue;

      // Team members use their team color; synthetic subagents use the default accent
      const lineColor = (pos.face && pos.face.isTeammate && pos.face.teamColor)
        ? pos.face.teamColor
        : accentColor;

      const dx = pos.col - mainPos.centerX;
      const dy = pos.row - mainPos.centerY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps < 4) continue;

      for (let s = 1; s < steps - 1; s++) {
        const t = s / steps;
        const col = Math.round(mainPos.centerX + dx * t);
        const row = Math.round(mainPos.centerY + dy * t);

        // Skip the main face's footprint (accessories, bubble, stats rows)
        if (this._inMainZone(mainPos, row, col)) continue;

        // Skip if inside ANY orbital face box
        let hitFace = false;
        for (const fp of positions) {
          if (col >= fp.col - 1 && col <= fp.col + MINI_W + 1 &&
              row >= fp.row - 1 && row <= fp.row + MINI_H) { hitFace = true; break; }
        }
        if (hitFace) continue;

        // Skip if out of bounds
        if (row < 1 || row >= (process.stdout.rows || 24) || col < 1 || col >= (process.stdout.columns || 80)) continue;

        // Pulse: brighter dots traveling outward (~3s cycle)
        const quantizedPulseTime = Math.floor(this.time / BREATHE_STEP) * BREATHE_STEP;
        const pulsePos = (quantizedPulseTime * 0.0004) % 1;
        const dist = Math.abs(t - pulsePos);
        const bright = dist < 0.08 || Math.abs(t - ((pulsePos + 0.5) % 1)) < 0.08;

        const color = bright
          ? ansi.fg(...dimColor(lineColor, 0.7))
          : ansi.fg(...dimColor(lineColor, 0.2));
        out += `\x1b[${row};${col}H${color}\u00b7${r}`;
      }
    }
    return out;
  }

  _renderGroupTethers(positions, mainPos, accentColor) {
    let out = '';
    const r = ansi.reset;
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;

    // Group positions by group key
    const groupMap = new Map();
    for (const pos of positions) {
      const key = pos.face.teamName || pos.face.parentSession || pos.face.sessionId;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(pos);
    }

    for (const members of groupMap.values()) {
      if (members.length < 2) continue; // No tether for singletons

      // Use team color or dimmed accent
      const baseColor = (members[0].face.teamColor) || accentColor;
      const tetherColor = ansi.fg(...dimColor(baseColor, TETHER_BRIGHTNESS));

      // Draw dashed line between sequential pairs (A→B, B→C, not all permutations)
      for (let m = 0; m < members.length - 1; m++) {
        const a = members[m];
        const b = members[m + 1];

        // Skip tether segments where either endpoint is spawning
        if (a.face.spawning || b.face.spawning) continue;

        const ax = a.col + Math.floor(MINI_W / 2);
        const ay = a.row + 2; // vertical center of mini-face box
        const bx = b.col + Math.floor(MINI_W / 2);
        const by = b.row + 2;

        const dx = bx - ax;
        const dy = by - ay;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        if (steps < 3) continue;

        for (let s = 2; s < steps - 1; s++) {
          // Dashed: every other dot
          if (s % 2 !== 0) continue;

          const t = s / steps;
          const col = Math.round(ax + dx * t);
          const row = Math.round(ay + dy * t);

          if (row < 1 || row >= rows || col < 1 || col >= cols) continue;

          // Skip if inside ANY face bounding box (not just endpoints)
          let insideFace = false;
          for (const fp of positions) {
            if (col >= fp.col - 1 && col <= fp.col + MINI_W + 1 &&
                row >= fp.row - 1 && row <= fp.row + MINI_H) { insideFace = true; break; }
          }
          if (insideFace) continue;

          // Skip if inside main face area
          if (this._inMainZone(mainPos, row, col)) continue;

          out += `\x1b[${row};${col}H${tetherColor}\u00b7${r}`;
        }
      }
    }
    return out;
  }

  _getGroupLabel(members, stable) {
    const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'dev']);

    // Team groups: always use teamName
    const teamName = members[0].face.teamName;
    if (teamName) return sliceToWidth(teamName, 12);

    // Priority 1: shared non-default git branch
    const branches = stable.map(m => m.face.gitBranch).filter(Boolean);
    if (branches.length === stable.length && branches.length > 0) {
      const first = branches[0];
      if (!DEFAULT_BRANCHES.has(first) && branches.every(b => b === first)) {
        return sliceToWidth(first, 12);
      }
    }

    // Priority 2: shared cwd basename
    const cwds = stable.map(m => m.face.cwdBasename || '').filter(Boolean);
    if (cwds.length === stable.length && cwds.length > 0) {
      const first = cwds[0];
      if (cwds.every(c => c === first)) {
        return sliceToWidth(first, 12);
      }
    }

    // Priority 3: first member's taskDescription
    const desc = stable[0].face.taskDescription;
    if (desc) return sliceToWidth(desc, 12);

    // Priority 4: first member's face label
    return sliceToWidth(stable[0].face.label || '', 12);
  }

  _renderGroupLabels(positions, rows, cols, mainPos) {
    let out = '';
    const r = ansi.reset;

    // Group positions by group key
    const groupMap = new Map();
    for (const pos of positions) {
      const key = pos.face.teamName || pos.face.parentSession || pos.face.sessionId;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(pos);
    }

    for (const [key, members] of groupMap) {
      if (members.length < 2) continue; // No label for singletons

      // Filter out spawning faces for extent calculation
      const stable = members.filter(m => !m.face.spawning);
      if (stable.length < 2) continue; // Need 2+ non-spawning to show label

      // Get label text via priority chain
      const label = this._getGroupLabel(members, stable);
      if (!label) continue;

      // Position: below the bottommost stable face, centered horizontally
      let bottomRow = -Infinity;
      let sumCol = 0;
      for (const m of stable) {
        if (m.row + MINI_H > bottomRow) bottomRow = m.row + MINI_H;
        sumCol += m.col + MINI_W / 2;
      }
      const labelRow = bottomRow; // just below group
      const centroid = sumCol / stable.length;
      const labelW = strWidth(label);
      let labelCol = Math.round(centroid - labelW / 2);

      // Clamp to terminal bounds
      labelCol = Math.max(1, Math.min(cols - labelW, labelCol));
      if (labelRow < 1 || labelRow >= rows) continue;

      // Skip if label overlaps main face area
      if (mainPos) {
        let hit = false;
        for (let c = labelCol; c < labelCol + labelW && !hit; c++) hit = this._inMainZone(mainPos, labelRow, c);
        if (hit) continue;
      }

      // Render with dimmed color
      const baseColor = members[0].face.teamColor || [140, 170, 200];
      const color = ansi.fg(...dimColor(baseColor, GROUP_LABEL_BRIGHTNESS));
      out += `\x1b[${labelRow};${labelCol}H${color}${label}${r}`;
    }
    return out;
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.rotationAngle += this.rotationSpeed;
    if (this.rotationAngle > Math.PI * 2) this.rotationAngle -= Math.PI * 2;
    for (const face of this.faces.values()) {
      face.tick(dt);
    }
  }

  _renderSidePanel(cols, rows, mainPos, paletteThemes) {
    const sorted = this.getSortedFaces();
    if (sorted.length === 0) return '';

    // Columns come from the stable keep-out, never the transient bubble: a
    // column that stepped sideways whenever a thought appeared was a glitch.
    const SIDE_PAD = 2;
    const ko = keepOutOf(mainPos);
    const leftCol = ko.left + 1 - MINI_W - SIDE_PAD;
    const rightCol = ko.right + SIDE_PAD;
    const canLeft = leftCol >= 1;
    const canRight = rightCol + MINI_W <= cols;

    if (!canLeft && !canRight) {
      // Truly no space — show text indicator
      const n = sorted.length;
      const text = `+${n} subagent${n === 1 ? '' : 's'}`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 1, mainPos.row + mainPos.h + 7);
      const dc = ansi.fg(...dimColor([140, 170, 200], 0.65));
      return `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    // How many fit vertically per side?
    const maxPerSide = Math.max(1, Math.floor((rows - 1) / MINI_H));

    // Distribute faces: alternate left/right for visual balance
    const leftFaces = [];
    const rightFaces = [];
    for (const face of sorted) {
      if (canLeft && leftFaces.length < maxPerSide &&
          (!canRight || leftFaces.length <= rightFaces.length)) {
        leftFaces.push(face);
      } else if (canRight && rightFaces.length < maxPerSide) {
        rightFaces.push(face);
      } else if (canLeft && leftFaces.length < maxPerSide) {
        leftFaces.push(face);
      } else {
        break; // No more room
      }
    }

    const visibleCount = leftFaces.length + rightFaces.length;
    const overflow = sorted.length - visibleCount;
    let buf = '';

    // Render a vertical stack of faces centered on the main face
    const renderStack = (faces, col) => {
      if (faces.length === 0) return;
      const totalH = faces.length * MINI_H;
      let startRow = Math.max(1, Math.round(mainPos.centerY - totalH / 2));
      startRow = Math.min(startRow, Math.max(1, rows - totalH));
      for (let i = 0; i < faces.length; i++) {
        const faceRow = startRow + i * MINI_H;
        buf += faces[i].render(faceRow, col, this.time, paletteThemes);
      }
    };

    renderStack(leftFaces, leftCol);
    renderStack(rightFaces, rightCol);

    if (overflow > 0) {
      const text = `+${overflow} more`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 1, mainPos.row + mainPos.h + 7);
      const dc = ansi.fg(...dimColor([140, 170, 200], 0.65));
      buf += `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    return buf;
  }

  render(cols, rows, mainPos, paletteThemes) {
    // No pre-clear: the renderer erases the whole screen every frame.
    let buf = '';

    if (this.faces.size === 0) return buf;

    const orbit = this.calculateOrbit(cols, rows, mainPos);
    const { a, b, maxSlots } = orbit;

    // Terminal too small for orbits — use side panel layout
    if (maxSlots === 0) {
      buf += this._renderSidePanel(cols, rows, mainPos, paletteThemes);
      return buf;
    }

    const sorted = this.getSortedFaces();
    const visible = sorted.slice(0, maxSlots);
    const overflow = sorted.length - visible.length;
    const n = visible.length;

    // Calculate grouped orbital positions (clustered by team/parent)
    const angleMap = this._calculateGroupedAngles(visible, orbit.minGap);
    // Feed target offsets for smooth lerping
    for (const [face, absAngle] of angleMap) {
      face.setTargetOffset(absAngle - this.rotationAngle);
    }
    const positions = [];
    for (let i = 0; i < n; i++) {
      const face = visible[i];
      const u = (face.orbitalOffset !== null)
        ? this.rotationAngle + face.orbitalOffset
        : (angleMap.get(face) || (TAU * i / n) + this.rotationAngle);
      const angle = orbit.thetaAt(u);
      // Startup spawn scale for this face (0 -> 1)
      const scale = (face.spawning ? Math.max(0.3, face.spawnProgress / face.SPAWN_MS) : 1);
      const col = Math.round(orbit.cx + Math.cos(angle) * a * scale - MINI_W / 2);
      const row = Math.round(orbit.cy + Math.sin(angle) * b * scale - MINI_H / 2);

      // Clamp to terminal bounds (the last row is the key-hint bar's). No
      // thought-bubble nudge: the ellipse already clears the rows a bubble
      // can use, and the renderer draws the main face on top of the ring, so
      // a face drifting behind the bubble's tail is layered, not teleported.
      const clampedCol = Math.max(1, Math.min(cols - MINI_W, col));
      const clampedRow = Math.max(1, Math.min(rows - MINI_H, row));

      positions.push({ col: clampedCol, row: clampedRow, face: visible[i] });
    }

    // Resolve any remaining overlaps between orbital faces
    this._resolveOverlaps(positions, cols, rows);

    // Get accent color for connections from the theme
    const themeMap = paletteThemes || themes;
    const accentColor = (themeMap.subagent || themeMap.idle).accent || [100, 160, 210];

    // Render group tethers (dimmest layer — background structure between siblings)
    buf += this._renderGroupTethers(positions, mainPos, accentColor);

    // Render connection lines to main face (brighter pulsing — active data channels)
    buf += this._renderConnections(mainPos, positions, accentColor);

    // Render each mini-face at its orbital position
    for (let i = 0; i < n; i++) {
      buf += visible[i].render(
        positions[i].row, positions[i].col,
        this.time, paletteThemes
      );
    }

    // Render floating group labels beneath clustered groups
    buf += this._renderGroupLabels(positions, rows, cols, mainPos);

    // Overflow indicator
    if (overflow > 0) {
      const text = `+${overflow} more`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 2, mainPos.row + mainPos.h + 7);
      const dc = ansi.fg(...dimColor([140, 170, 200], 0.65));
      buf += `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    return buf;
  }
}

// -- Session List Overlay -------------------------------------------
// Renders a centered overlay listing the main session and all active
// subagent sessions with state, label, path, and detail info.

const MIN_SESSION_LIST_COLS = 50;
const MIN_SESSION_LIST_ROWS = 12;      // chrome + footer + both overflow marks + one entry

// Whether the session list can draw at all at this size. Below it the list
// draws nothing -- so the `l` key must not open it (an invisible list then
// swallowed the next key; an Enter would silently pin) and the hint bar must
// not offer it.
function sessionListFits(cols, rows) {
  return cols >= MIN_SESSION_LIST_COLS && rows >= MIN_SESSION_LIST_ROWS;
}
const SESSION_LIST_ENTRY_ROWS = 4;     // state row, path row, detail row, info row

// Age of a write as the list shows it: 3s, 2m, 1h.
function formatAge(ms) {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// Pure: the list's tree order. Main first with its agents under it, then the
// other top-level sessions by attention (newest prompt first, then firstSeen),
// each with its agents, then children whose parent is not on screen.
//   mainInfo  the synthesized main row ({ sessionId, ... }) or null
//   faces     the orbital MiniFaces (the main is not among them)
// Returns [{ face, depth }] with depth 0 (top-level) or 1 (child).
function orderSessionList(mainInfo, faces) {
  const list = [...faces];
  const mainId = mainInfo ? mainInfo.sessionId : null;
  const byFirstSeen = (a, b) => (a.firstSeen || 0) - (b.firstSeen || 0);
  const children = (pid) => list.filter(f => f.parentSession && f.parentSession === pid).sort(byFirstSeen);
  const out = [];
  const place = (face, depth) => out.push({ face, depth });

  if (mainInfo) {
    place(mainInfo, 0);
    for (const c of children(mainId)) place(c, 1);
  }
  const tops = list
    .filter(f => f.sessionId !== mainId && !f.parentSession)
    .sort((a, b) => ((b.lastPromptAt || 0) - (a.lastPromptAt || 0)) || byFirstSeen(a, b));
  for (const t of tops) {
    place(t, 0);
    for (const c of children(t.sessionId)) place(c, 1);
  }
  const placed = new Set(out.map(e => e.face.sessionId));
  for (const f of list) if (!placed.has(f.sessionId)) place(f, 0);
  return out;
}

// Pure: which of the rendered rows the cursor may land on. A stopped session
// lingers on the list for ~10s after it ends so the user sees it finish, but
// it is display-only: pinning it is a no-op the policy immediately undoes
// (a stopped session is never live, so the pin is released on the same tick),
// which reads as a dead key. The main row is always navigable: the cursor
// starts there, and unpinning it must keep working whatever its state.
//   entries  [{ face, depth }] from orderSessionList
// Returns the session ids, in rendered order, that j/k and Enter may select.
function listNavigableIds(entries) {
  return (entries || [])
    .filter(e => e && e.face && (e.face.isMain || !e.face.stopped))
    .map(e => e.face.sessionId);
}

function _truncatePath(fullPath, maxLen, foldCase = process.platform === 'win32') {
  if (!fullPath) return '';
  // Normalize to forward slashes
  const p = fullPath.replace(/\\/g, '/');
  // Replace home dir with ~
  // Only on a path boundary: HOME=/home/al must not turn /home/alice into ~ice.
  // Windows paths are case-insensitive, and editors disagree about the drive
  // letter (c:\Users\sam vs C:\Users\sam), so compare folded there.
  const home = HOME_FWD.replace(/\/+$/, '');
  const fold = (x) => (foldCase ? x.toLowerCase() : x);
  const fp = fold(p);
  const underHome = !!home && (fp === fold(home) || fp.startsWith(fold(home) + '/'));
  const display = underHome ? '~' + p.slice(home.length) : p;
  // maxLen is in terminal columns: a CJK folder is two per character.
  if (strWidth(display) <= maxLen) return display;
  // Show .../<last two segments>
  const parts = display.split('/');
  if (parts.length <= 2) return '...' + sliceFromEndToWidth(display, maxLen - 3);
  const tail = parts.slice(-2).join('/');
  if (strWidth(tail) + 4 > maxLen) return '...' + sliceFromEndToWidth(tail, maxLen - 3);
  return '.../' + tail;
}

function _sessionDot(face, themeMap) {
  if (face.stopped) return ['\u2715', [120, 120, 120]]; // ✕ grey
  const theme = themeMap[face.state] || themeMap.idle;
  return ['\u25cf', theme.border]; // ● colored by state
}

// The dim info row: what kind of thing this is, how busy, how fresh, whose.
function _infoLine(face, labelById, now) {
  const parts = [];
  if (face.parentSession) {
    parts.push(face.agentType || (face.isTeammate && face.teamName) || 'agent');
  } else {
    parts.push(`${face.toolCalls || 0} tools`, `${face.filesEdited || 0} files`);
  }
  // Pushed into parts BEFORE the join, so the caller's slice to `body` still
  // bounds the whole row -- appending after it would overrun the box.
  if (face.model) parts.push(face.model);
  if (face.lastUpdate) parts.push(formatAge(now - face.lastUpdate));
  let line = parts.join(' \u00b7 ');
  if (face.parentSession) {
    const parent = labelById.get(face.parentSession) || String(face.parentSession).slice(0, 8);
    line += ` \u00b7 \u21b3 ${parent}`;
  }
  return line;
}

// entriesOrFaces: [{ face, depth }] from orderSessionList, or a plain array of
// faces (all depth 0). selected: a session id, or a legacy row index.
function renderSessionList(cols, rows, entriesOrFaces, paletteThemes, mainInfo, selected) {
  if (!sessionListFits(cols, rows)) return '';
  const themeMap = paletteThemes || themes;
  const r = ansi.reset;
  const now = Date.now();

  // Normalise to entries. A plain face array is the legacy shape: main first.
  let entries;
  const raw = entriesOrFaces || [];
  if (raw.length && raw[0] && raw[0].face) {
    entries = raw;
  } else {
    entries = [];
    if (mainInfo) entries.push({ face: mainInfo, depth: 0 });
    for (const f of raw) entries.push({ face: f, depth: 0 });
  }
  if (mainInfo && !entries.some(e => e.face === mainInfo)) entries = [{ face: mainInfo, depth: 0 }, ...entries];
  const count = entries.length;

  const labelById = new Map();
  for (const e of entries) if (e.face.sessionId) labelById.set(e.face.sessionId, sliceToWidth(e.face.label || '?', 14));

  let selIdx = -1;
  if (typeof selected === 'number') selIdx = selected;
  else if (typeof selected === 'string') selIdx = entries.findIndex(e => e.face.sessionId === selected);

  // Box dimensions
  const boxW = Math.min(cols - 4, 54);
  const innerW = boxW - 2; // inside the │ borders
  const headerText = '  Sessions';
  const countText = `${count} total `;

  // Rows left after chrome (4), footer (1) and both overflow marks (2), at
  // ENTRY_ROWS + 1 separator per entry: the box can never outgrow the screen.
  const maxVisible = Math.max(1, Math.floor((rows - 7) / (SESSION_LIST_ENTRY_ROWS + 1)));
  const scrollOffset = (selIdx >= 0 && count > maxVisible)
    ? Math.min(Math.max(0, selIdx - (maxVisible - 1)), Math.max(0, count - maxVisible))
    : 0;
  const visible = entries.slice(scrollOffset, scrollOffset + maxVisible);
  const overflowBelow = count - (scrollOffset + visible.length);
  const overflowAbove = scrollOffset;

  let contentRows = 0;
  if (count === 0) {
    contentRows = 1; // "no sessions"
  } else {
    contentRows = visible.length * SESSION_LIST_ENTRY_ROWS + Math.max(0, visible.length - 1);
    if (overflowAbove > 0) contentRows += 1;
    if (overflowBelow > 0) contentRows += 1;
  }
  const hasFooter = selIdx >= 0 && count > 0;
  if (hasFooter) contentRows += 1;
  const boxH = contentRows + 4; // top border + header + separator + bottom border

  const bx = Math.max(1, Math.floor((cols - boxW) / 2));
  const by = Math.max(1, Math.floor((rows - boxH - 1) / 2));

  const bc = ansi.fg(...dimColor([140, 170, 200], 0.7));
  const tc = ansi.fg(...dimColor([200, 220, 240], 0.9));
  const dc = ansi.fg(...dimColor([140, 170, 200], 0.55));
  const line = (row, text) => ansi.to(row, bx) + `${bc}\u2502${text}${bc}\u2502${r}`;
  const centered = (row, text, color) => {
    const pad = Math.max(0, Math.floor((innerW - text.length) / 2));
    return line(row, `${color}${' '.repeat(pad)}${text}${' '.repeat(Math.max(0, innerW - pad - text.length))}`);
  };

  let buf = '';
  const headerPad = innerW - headerText.length - countText.length;
  buf += ansi.to(by, bx) + `${bc}\u256d${'\u2500'.repeat(innerW)}\u256e${r}`;
  buf += line(by + 1, `${tc}${headerText}${' '.repeat(Math.max(0, headerPad))}${dc}${countText}`);
  buf += ansi.to(by + 2, bx) + `${bc}\u251c${'\u2500'.repeat(innerW)}\u2524${r}`;

  let row = by + 3;

  if (count === 0) {
    buf += centered(row, 'no sessions', dc);
    row++;
  } else {
    if (overflowAbove > 0) { buf += centered(row, `\u2191${overflowAbove} above`, dc); row++; }
    for (let i = 0; i < visible.length; i++) {
      const { face, depth } = visible[i];
      const isSel = i === (selIdx - scrollOffset);
      const [dot, dotColor] = _sessionDot(face, themeMap);
      const dotC = ansi.fg(...dotColor);
      const stateTheme = themeMap[face.state] || themeMap.idle;
      const stateName = (stateTheme.status || face.state).slice(0, 12);
      const label = sliceToWidth(face.label || '?', 14);
      const selMarker = isSel ? '\u25b8' : ' ';
      const rowTc = isSel ? ansi.fg(...dimColor([240, 250, 255], 1.0)) : tc;
      const rowDc = isSel ? ansi.fg(...dimColor([180, 200, 220], 0.8)) : dc;

      // Row 1: " ▸● statename  editor      ⊛/★/☆ label". A child gets a tree
      // marker before the dot. Width priority: the label (with its marker, the
      // promote UX) is never sliced; the editor tag drops first; the state
      // name truncates last. Label and tag are file text, so measured in
      // columns (strWidth), not code units.
      const mainTag = face.isMain
        ? (face.isPinned ? '\u229b ' : '\u2605 ')
        : (face.isMainSession ? '\u2606 ' : '');
      const treeMark = depth > 0 ? '\u2514 ' : '';
      const prefix = ` ${selMarker}${treeMark}`;           // before the dot
      const row1Prefix = prefix.length + 2;                  // + dot + space
      const fullLabel = mainTag + label;
      const labelW = strWidth(fullLabel);
      const avail = innerW - row1Prefix;
      const tagRaw = sliceToWidth(face.editor || '', 8);
      let stateSeg = stateName;
      const tagSeg = (tagRaw && stateSeg.length + 2 + strWidth(tagRaw) + 2 + labelW <= avail)
        ? tagRaw : '';
      const tagW = strWidth(tagSeg);
      const maxState = avail - labelW - 2 - (tagSeg ? tagW + 2 : 0);
      if (stateSeg.length > maxState) stateSeg = stateSeg.slice(0, Math.max(0, maxState));
      const usedLeft = stateSeg.length + (tagSeg ? 2 + tagW : 0);
      const labelGap = Math.max(2, avail - usedLeft - labelW);
      const r1Pad = Math.max(0, avail - usedLeft - labelGap - labelW);
      buf += line(row, `${r}${rowTc}${prefix}${dotC}${dot}${r} ${rowTc}${stateSeg}${tagSeg ? `  ${rowDc}${tagSeg}` : ''}${' '.repeat(labelGap)}${rowTc}${fullLabel}${' '.repeat(r1Pad)}`);
      row++;

      const indent = '    ';
      const body = innerW - indent.length;

      // Row 2: "    ⎇ branch  ~/path"
      const branchRaw = face.gitBranch || '';
      let row2Text;
      if (branchRaw) {
        const branchDisplay = sliceToWidth('\u2387 ' + branchRaw, 20);
        const pathSpace = body - strWidth(branchDisplay) - 2;
        row2Text = branchDisplay + '  ' + _truncatePath(face.cwd, Math.max(8, pathSpace));
      } else {
        row2Text = _truncatePath(face.cwd, body);
      }
      const row2Full = indent + sliceToWidth(row2Text, body);
      buf += line(row, `${rowDc}${row2Full}${' '.repeat(Math.max(0, innerW - strWidth(row2Full)))}`);
      row++;

      // Row 3: "    task/detail text" — full task description preferred
      const row3Text = sliceToWidth(face.taskDescription || face.detail || 'waiting...', body);
      const row3Full = indent + row3Text;
      buf += line(row, `${rowDc}${row3Full}${' '.repeat(Math.max(0, innerW - strWidth(row3Full)))}`);
      row++;

      // Row 4: "    Explore · 3s · ↳ parent" / "    12 tools · 3 files · 3s"
      const infoText = sliceToWidth(_infoLine(face, labelById, now), body);
      const row4Full = indent + infoText;
      buf += line(row, `${rowDc}${row4Full}${' '.repeat(Math.max(0, innerW - strWidth(row4Full)))}`);
      row++;

      if (i < visible.length - 1) {
        buf += ansi.to(row, bx) + `${bc}\u251c${'\u2500'.repeat(innerW)}\u2524${r}`;
        row++;
      }
    }
    if (overflowBelow > 0) { buf += centered(row, `+${overflowBelow} more`, dc); row++; }
  }

  if (hasFooter) {
    const selEntry = entries[selIdx];
    const onMain = !!(selEntry && selEntry.face && selEntry.face.isMain);
    const isPinned = !!(mainInfo && mainInfo.isPinned);
    let hint;
    if (onMain && isPinned) hint = '\u2191\u2193 select  \u23ce unpin  esc close';
    else if (onMain) hint = '\u2191\u2193 select  \u23ce pin  esc close';
    else hint = '\u2191\u2193 select  \u23ce pin+promote  esc close';
    buf += centered(row, hint, dc);
    row++;
  }

  buf += ansi.to(row, bx) + `${bc}\u2570${'\u2500'.repeat(innerW)}\u256f${r}`;
  return buf;
}

module.exports = {
  MiniFace, OrbitalSystem, hashTeamColor, renderSessionList, isProcessAlive,
  orderSessionList, listNavigableIds, formatAge,
  MIN_SESSION_LIST_ROWS, MIN_SESSION_LIST_COLS, SESSION_LIST_ENTRY_ROWS, sessionListFits,
  ACTIVE_WORK_STATES, COMPLETION_STATES, INTERRUPTIBLE_STATES,
  isOwnedByLiveProcess, requestPidStartTime, _pidStartCache, _pidStartStatus, _sweepPidCache,
  _setPidResolver, KNOWN_EDITORS, _truncatePath,
  STALE_MS, ORPHAN_TIMEOUT, CHILD_ORPHAN_TIMEOUT, REPOSITION_MS, SLACK_MS, PID_PROTECT_CAP_MS, PID_CACHE_TTL_MS,
  INTER_GROUP_GAP, INTRA_GROUP_GAP, TETHER_BRIGHTNESS, GROUP_LABEL_BRIGHTNESS,
  CYCLE_WORK_STATES, CYCLE_INTERVAL, CYCLE_STALE_MS,
  computeOrbit, keepOutOf, MINI_W, MINI_H, ORBIT_SPACING,
};
