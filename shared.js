'use strict';

// +================================================================+
// |  Shared constants and utilities                                |
// |  Common paths, config, and helpers used across all modules     |
// +================================================================+

const fs = require('fs');
const path = require('path');

// -- Paths -----------------------------------------------------------

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CODE_CRUMB_STATE || path.join(HOME, '.code-crumb-state');
const SESSIONS_DIR = path.join(HOME, '.code-crumb-sessions');
const STATS_FILE = path.join(HOME, '.code-crumb-stats.json');
const PREFS_FILE = path.join(HOME, '.code-crumb-prefs.json');
const TEAMS_DIR = path.join(HOME, '.claude', 'teams');
const PID_FILE = path.join(HOME, '.code-crumb.pid');
const QUIT_FLAG_FILE = path.join(HOME, '.code-crumb-quit');
const TMUX_FILE = path.join(HOME, '.code-crumb-tmux');
const SPAWN_LOCK_FILE = path.join(HOME, '.code-crumb-spawn.lock');
const STATS_LOCK_FILE = path.join(HOME, '.code-crumb-stats.lock');

// Stats lock policy. The stats file is a read-modify-write per hook, so
// parallel tool calls (parallel hooks) can lose a counter increment. The
// lock serializes them; the wait is deliberately short because a hook must
// never stall the editor -- a waiter that times out proceeds unlocked.
const LOCK_WAIT_MS = 150;   // max time a hook waits for the stats lock
const LOCK_STALE_MS = 2000; // a lock older than this belongs to a crashed hook
const LOCK_SPIN_MS = 2;     // pause between retries while the lock is held

// -- Face state sets ---------------------------------------------------
// Shared by face.js (main face), grid.js (orbital MiniFace) and renderer.js
// so the three never drift apart.

// Active tool states: real work happening NOW. They bypass the min display
// of passive/thinking/completion states (after a completion has had its
// guaranteed window).
const ACTIVE_WORK_STATES = new Set([
  'executing', 'coding', 'reading', 'searching', 'testing',
  'installing', 'committing', 'reviewing', 'subagent', 'responding',
  'training',
]);
// Reward faces shown when a tool finishes.
const COMPLETION_STATES = new Set(['happy', 'satisfied', 'proud', 'relieved']);
// States a work state may interrupt.
const INTERRUPTIBLE_STATES = new Set([
  'thinking', 'happy', 'satisfied', 'proud', 'relieved',
  'idle', 'sleeping', 'waiting',
]);

// -- Utilities -------------------------------------------------------

// A detail line as the renderer can draw it. Text only: an adapter once wrote
// an error OBJECT here, and `.slice` on it threw inside the orbital render,
// blanking the whole ring for as long as the file lived. One line: a raw
// newline spills the text into column 1 of the rows below. No control
// characters, C1 included: an escape sequence in a detail (a file name, a
// provider error) would reach the terminal as-is, and U+009B alone is a CSI.
function detailText(v) {
  let s = '';
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_empty';
}

// Only a plain object counts as prefs: a file holding `null` (or an array)
// parsed fine, crashed the renderer at startup on `prefs.paletteIndex`, and
// could never be repaired by savePrefs (Object.assign(null) threw).
function asPrefsObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function loadPrefs() {
  try {
    const raw = fs.readFileSync(PREFS_FILE, 'utf8').trim();
    if (!raw) return {};
    return asPrefsObject(JSON.parse(raw));
  } catch {
    return {};
  }
}

function savePrefs(updates) {
  try {
    let prefs = {};
    try {
      const raw = fs.readFileSync(PREFS_FILE, 'utf8').trim();
      if (raw) prefs = asPrefsObject(JSON.parse(raw));
    } catch {}
    Object.assign(prefs, updates);
    writeJsonAtomic(PREFS_FILE, prefs, 0o600);
  } catch {}
}

// -- Atomic writes, spawn lock and stats lock ------------------------

// Write JSON (or a pre-serialized string) atomically: temp file + rename, so
// the renderer (which watches these files) never reads a half-written one.
// Falls back to a direct write if the rename is refused. Returns true on
// success; never throws.
//
// On Windows a rename over a file someone else has open without delete
// sharing -- a virus scanner, the search indexer, another hook's read --
// fails EPERM/EACCES/EBUSY for a few milliseconds. Going straight to the
// direct write then is exactly the torn write this function exists to
// prevent, so those codes are retried briefly first.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRIES = 3;
function writeJsonAtomic(file, obj, mode = 0o600) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return true;
      } catch (e) {
        if (attempt >= RENAME_RETRIES || !e || !RENAME_RETRY_CODES.has(e.code)) throw e;
        sleepSync(2);
      }
    }
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    try {
      fs.writeFileSync(file, data, { encoding: 'utf8', mode });
      return true;
    } catch {
      return false;
    }
  }
}

// One-shot lock for "spawn the renderer": N parallel hooks that all find the
// renderer dead must launch exactly one window. The lock is a file created
// with O_EXCL; a lock older than staleMs is taken over. Anything odd (no
// directory, permissions) yields true -- the lock is a courtesy, never a
// reason not to launch.
//
// Nothing deletes the lock, so every launch after the first goes through the
// stale takeover, and a plain overwrite there let every hook that saw the
// stale lock "win" (up to 3 of 8 in a race) -- each opening a terminal. The
// takeover is now exclusive too: only the hook that creates `<lock>.claim`
// (O_EXCL) may overwrite, and only while the lock is still the stale one it
// saw. A claim left by a hook that died mid-takeover is cleared once stale.
function acquireSpawnLock(lockFile, staleMs = 5000) {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return true;
    let seen;
    try { seen = fs.statSync(lockFile).mtimeMs; } catch { return true; }
    if (Date.now() - seen <= staleMs) return false;
    const claim = lockFile + '.claim';
    try {
      fs.writeFileSync(claim, String(process.pid), { flag: 'wx' });
    } catch {
      try {
        if (Date.now() - fs.statSync(claim).mtimeMs > staleMs) fs.unlinkSync(claim);
      } catch {}
      return false;
    }
    try {
      // Someone finished a takeover between our stat and our claim.
      if (fs.statSync(lockFile).mtimeMs !== seen) return false;
      fs.writeFileSync(lockFile, String(process.pid));
      return true;
    } catch {
      return true;
    } finally {
      try { fs.unlinkSync(claim); } catch {}
    }
  }
}

// -- Renderer liveness ----------------------------------------------
// Whether a renderer is running, by its PID file. The renderer rewrites the
// file every PID_HEARTBEAT_MS; one older than PID_STALE_MS belongs to a
// renderer that died without cleaning up -- a crash, a kill, or a Windows
// logoff, which delivers no signal at all -- whatever process has since been
// given that PID. The hook, launch.js and the renderer's own start-up guard
// all ask here: they used to disagree about EPERM (a PID reused by a process
// we may not signal), so a stale file on Windows made every hook open a
// window that printed "already running" and closed, forever.
const PID_HEARTBEAT_MS = 10000;
const PID_STALE_MS = 60000;
function isRendererAlive(pidFile = PID_FILE, now = Date.now()) {
  let pid, mtimeMs;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    mtimeMs = fs.statSync(pidFile).mtimeMs;
  } catch {
    return false;
  }
  // kill(0) would signal our own process group.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (now - mtimeMs > PID_STALE_MS) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

// Block this thread for ms without a busy loop. Hooks are short-lived
// synchronous scripts -- there is no event loop to yield to, and a spin on
// Date.now() would burn a core. Never throws: a runtime without
// SharedArrayBuffer (or one that forbids Atomics.wait) just returns.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
}

let lockSeq = 0;
// Create errors that mean "someone holds (or is just releasing) the lock".
const LOCK_HELD_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

// Remove a lock file that looked stale, so the caller can retry its O_EXCL
// create. Returns true when the caller should retry at once (the stale file
// is gone, or someone else already removed it), false to wait normally.
// The file is renamed to a name only this owner uses, which is atomic: of
// several waiters exactly one moves any given file. What was moved is then
// re-checked -- if it is fresh, a faster waiter had already replaced the
// stale lock with its own, and that live lock is restored with an exclusive
// create (never an overwrite; if a third party got in first, it is dropped
// and its owner's release is already a no-op thanks to the token check).
function breakStaleLock(lockFile, token, staleMs) {
  const aside = `${lockFile}.${token}.stale`;
  try {
    fs.renameSync(lockFile, aside);
  } catch (e) {
    return !!e && e.code === 'ENOENT';
  }
  try {
    if (Date.now() - fs.statSync(aside).mtimeMs <= staleMs) {
      const live = fs.readFileSync(aside, 'utf8');
      try { fs.writeFileSync(lockFile, live, { flag: 'wx', mode: 0o600 }); } catch {}
      try { fs.unlinkSync(aside); } catch {}
      return false;
    }
  } catch {}
  try { fs.unlinkSync(aside); } catch {}
  return true;
}

// Short-lived advisory lock around a read-modify-write of a shared file.
// The lock is a file created with O_EXCL holding a per-owner token; a lock
// older than staleMs belongs to a crashed writer and is taken over.
// Returns release() on success, or null if the lock stayed held for waitMs.
// release() unlinks only while the file still carries this owner's token, so
// a crashed owner's late release cannot free the lock its successor took over.
// Any unexpected fs error behaves as acquired (no-op release): the lock is a
// courtesy, never a reason to skip the caller's work.
function acquireFileLock(lockFile, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, spinMs = LOCK_SPIN_MS } = {}) {
  // pid + time identifies the owner across processes; the counter keeps two
  // acquires inside one process (same millisecond) from sharing a token.
  const token = `${process.pid}.${Date.now().toString(36)}.${(lockSeq++).toString(36)}`;
  const release = () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8') === token) fs.unlinkSync(lockFile);
    } catch {}
  };
  const deadline = Date.now() + waitMs;
  let takeovers = 0;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, token, { flag: 'wx', mode: 0o600 });
      return release;
    } catch (e) {
      // Anything but "held" (no directory, say) -- proceed. On Windows a
      // lock that is being unlinked by its owner sits in a delete-pending
      // state, and creating it then fails EPERM/EACCES, not EEXIST (~0.2% of
      // attempts with six contending writers). Treating that as "proceed"
      // ran the read-modify-write unlocked and lost increments; it is held,
      // so it waits like EEXIST. A genuine permission failure costs waitMs.
      if (!e || !LOCK_HELD_CODES.has(e.code)) return () => {};
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
      } catch {
        // Vanished or unreadable between the two calls -- retry below.
      }
      // Stale takeover must go back through the O_EXCL create, so that of
      // several waiters who all saw the same stale lock only one wins (a
      // plain overwrite let every one of them "take" it). The stale file is
      // moved aside rather than unlinked: between our stat and our move a
      // faster waiter may already have replaced it with its own fresh lock,
      // and a moved file can be checked -- if what we moved is fresh it is
      // somebody's live lock, and it is put back without clobbering.
      // The retry skips the sleep and the deadline, but only a few times --
      // a filesystem that never lets the create succeed must not spin.
      if (stale && takeovers < 3 && breakStaleLock(lockFile, token, staleMs)) {
        takeovers++;
        continue;
      }
    }
    if (Date.now() >= deadline) return null;
    sleepSync(spinMs);
  }
}

// Run fn() with the stats lock held, releasing it however fn ends. A failed
// acquire is not an error: the caller proceeds unlocked (worst case, the
// pre-lock behaviour of a possibly-lost counter increment).
function withStatsLock(fn) {
  let release = null;
  try { release = acquireFileLock(STATS_LOCK_FILE); } catch {}
  try {
    return fn();
  } finally {
    if (release) { try { release(); } catch {} }
  }
}

// -- Process spawning helpers -----------------------------------------

// Quote one argument for a Windows command line built by hand (shell:true or
// windowsVerbatimArguments). Node does no quoting in those modes, and the
// line is parsed twice: first by cmd.exe, then by the program's own argv
// parser (MSVCRT/UCRT -- node, and every npm .cmd shim that ends in node).
//
//   - Any cmd metacharacter forces quoting, not just whitespace: an unquoted
//     `fix&whoami` ran `whoami`. Inside double quotes & | < > ^ ( ) , ; = are
//     literal to cmd.
//   - An embedded " becomes "" -- cmd toggles its quote state on every ", so
//     the pair keeps it inside the quoted region, and the UCRT parser reads ""
//     inside quotes as one literal ". The old \" toggled cmd out of quotes and
//     exposed the rest of the argument (`a"b & whoami` ran whoami).
//   - Backslashes are literal to the argv parser except before a ", so a run
//     of them before an embedded " or the closing quote is doubled -- and so
//     is a run before a %, because the % splice below puts a " right after
//     it (`a\%b` used to arrive as `a"%b`, and a path could split in two).
//   - cmd expands %VAR% even inside quotes and nothing escapes a % there, so
//     each % is emitted outside the quotes as ^% ("50"^%" off"): the caret
//     breaks the variable name before expansion and is removed afterwards.
//   - cmd ends the command at a line break, silently dropping the rest of the
//     line, so CR/LF become spaces -- a multi-line prompt arrives as one line.
//   - Not covered: `!` is only special under delayed expansion, which cmd /c
//     leaves off by default; a machine that enables it in the registry would
//     still expand !VAR!.
// Verified on Windows 11 through shell:true (direct and via a .cmd shim) and
// through `cmd /c start` with windowsVerbatimArguments.
function quoteArg(arg) {
  let s = String(arg).replace(/\r\n|[\r\n]/g, ' ');
  if (s === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(s)) return s;
  s = s.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, '$1$1').replace(/(\\+)(?=%)/g, '$1$1');
  return '"' + s.replace(/%/g, '"^%"') + '"';
}

// Quote one argument for a POSIX shell: single quotes, with ' -> '\''.
function shQuote(arg) {
  return "'" + String(arg).replace(/'/g, "'\\''") + "'";
}

// Escape text for use inside an AppleScript double-quoted string literal.
function appleScriptEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// How to open the renderer in a new terminal window on each platform.
// Returns { key: { cmd, args, opts } }; Linux returns several candidates to
// probe in order. Used by launch.js and by update-state.js autolaunch so the
// two can never disagree on quoting again.
// Windows Terminal splits its command line into subcommands on `;` -- even
// inside double quotes -- so a literal semicolon must be written `\;` (wt
// strips the backslash). Without it a renderer path containing `;` was cut
// in two and the tab never opened. Applied after quoteArg, to wt args only.
function wtEscape(quotedArg) {
  return String(quotedArg).replace(/;/g, '\\;');
}

// opts.nodeBin is the node to run (default `node`, resolved by the launched
// shell -- callers pass process.execPath); opts.cwd is the launch directory.
function buildRendererCommands(platform, rendererArgs, windowTitle, opts = {}) {
  const nodeBin = opts.nodeBin || 'node';
  // A plain word stays as is; a path (spaces, quotes...) is single-quoted.
  const shNode = /^[\w\/.,:+=@%-]+$/.test(nodeBin) ? nodeBin : shQuote(nodeBin);
  const detached = { detached: true, stdio: 'ignore', ...(opts.cwd ? { cwd: opts.cwd } : {}) };
  if (platform === 'win32') {
    const quoted = rendererArgs.map(quoteArg);
    const node = quoteArg(nodeBin);
    return {
      // wt is an app-execution alias that can only be started through a
      // shell; shell:true joins args verbatim, so every arg is pre-quoted.
      wt: {
        cmd: 'wt',
        args: ['-w', '0', 'new-tab', '--title', wtEscape(quoteArg(windowTitle)), wtEscape(node), ...quoted.map(wtEscape)],
        opts: { ...detached, shell: true },
      },
      // cmd.exe's `start` parses its own line; hand it one verbatim string.
      cmd: {
        cmd: opts.cmdExe || 'cmd',
        args: ['/c', `start ${quoteArg(windowTitle)} ${node} ${quoted.join(' ')}`],
        opts: { ...detached, windowsVerbatimArguments: true },
      },
    };
  }
  if (platform === 'darwin') {
    const shellLine = shNode + ' ' + rendererArgs.map(shQuote).join(' ') + '; exit';
    return {
      osascript: {
        cmd: 'osascript',
        args: ['-e', `tell application "Terminal" to do script "${appleScriptEscape(shellLine)}"`],
        opts: detached,
      },
    };
  }
  return {
    'gnome-terminal': { cmd: 'gnome-terminal', args: ['--title=' + windowTitle, '--', nodeBin, ...rendererArgs], opts: detached },
    konsole:          { cmd: 'konsole', args: ['--new-tab', '-e', nodeBin, ...rendererArgs], opts: detached },
    'xfce4-terminal': { cmd: 'xfce4-terminal', args: ['--title=' + windowTitle, '-e', shNode + ' ' + rendererArgs.map(shQuote).join(' ')], opts: detached },
    xterm:            { cmd: 'xterm', args: ['-T', windowTitle, '-e', nodeBin, ...rendererArgs], opts: detached },
  };
}

// Open the renderer in a new terminal window. Returns true if a terminal was
// started. Shared by the hook's autolaunch and launch.js.
//
// Everything runs from HOME with absolute binaries. A hook's cwd is the
// user's project, and cmd.exe looks in the current directory BEFORE the PATH
// (and tries PATHEXT, .JS included): a cloned repo's where.bat, wt.cmd or
// node.cmd ran silently the first time autolaunch fired, a project file named
// node.js opened in Windows Script Host instead of the face, and the renderer
// kept the project folder locked for its whole life. process.execPath is the
// node running this code, so the new terminal needs no `node` on its own
// PATH either (Windows Terminal starts tabs with its own environment).
function spawnRendererWindow(rendererPath, windowTitle, platform = process.platform) {
  const { spawn, execFileSync, execSync } = require('child_process');
  const sysDir = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  const cmds = buildRendererCommands(platform, [rendererPath], windowTitle, {
    nodeBin: process.execPath,
    cwd: HOME,
    cmdExe: process.env.ComSpec || path.join(sysDir, 'cmd.exe'),
  });
  let child = null;
  if (platform === 'win32') {
    // Probe for Windows Terminal before spawning (spawn doesn't throw synchronously)
    let hasWt = false;
    try {
      execFileSync(path.join(sysDir, 'where.exe'), ['wt'], { stdio: 'ignore', cwd: HOME, windowsHide: true });
      hasWt = true;
    } catch {}
    const c = hasWt ? cmds.wt : cmds.cmd;
    child = spawn(c.cmd, c.args, c.opts);
  } else if (platform === 'darwin') {
    child = spawn(cmds.osascript.cmd, cmds.osascript.args, cmds.osascript.opts);
  } else {
    // Linux -- try common terminal emulators in order
    for (const key of Object.keys(cmds)) {
      try {
        execSync(`command -v ${cmds[key].cmd}`, { stdio: 'ignore', cwd: HOME });
        child = spawn(cmds[key].cmd, cmds[key].args, cmds[key].opts);
        break;
      } catch {}
    }
  }
  if (!child) return false;
  child.on('error', () => {});
  child.unref();
  return true;
}

// Returns true if the nearest .git entry in the dir tree is a file (worktree),
// false if it is a directory (regular clone), or false if not a git repo.
function getIsWorktree(cwd) {
  try {
    let dir = cwd || process.cwd();
    for (let i = 0; i < 20; i++) {
      const gitPath = path.join(dir, '.git');
      try {
        const stat = fs.statSync(gitPath);
        return !stat.isDirectory();
      } catch {
        // .git not here, walk up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return false;
}

// Read .git/HEAD directly (no subprocess -- fast and safe for hook use)
// Walks up from cwd to find a .git dir/file (max 20 levels).
// Returns branch name, short SHA for detached HEAD, or null if not a git repo.
function getGitBranch(cwd) {
  try {
    let dir = cwd || process.cwd();
    for (let i = 0; i < 20; i++) {
      const gitPath = path.join(dir, '.git');
      let headFile = path.join(gitPath, 'HEAD');
      try {
        const stat = fs.statSync(gitPath);
        if (!stat.isDirectory()) {
          // Worktree: .git is a file like "gitdir: /path/to/.git/worktrees/foo".
          // A submodule's is relative ("gitdir: ../.git/modules/lib"), and it is
          // relative to the directory holding the .git file -- resolving it
          // against process.cwd() read the superproject's HEAD from any
          // subfolder of the submodule.
          const content = fs.readFileSync(gitPath, 'utf8').trim();
          if (content.startsWith('gitdir:')) {
            headFile = path.join(path.resolve(dir, content.slice(7).trim()), 'HEAD');
          }
        }
        const head = fs.readFileSync(headFile, 'utf8').trim();
        if (head.startsWith('ref: refs/heads/')) {
          return head.slice('ref: refs/heads/'.length);
        }
        // Detached HEAD — return short SHA
        return head.slice(0, 7) || null;
      } catch {
        // .git doesn't exist here, keep walking up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break; // Filesystem root
      dir = parent;
    }
  } catch {}
  return null;
}

module.exports = {
  HOME, STATE_FILE, SESSIONS_DIR, STATS_FILE, PREFS_FILE, PID_FILE, QUIT_FLAG_FILE, TEAMS_DIR, TMUX_FILE, SPAWN_LOCK_FILE,
  PID_HEARTBEAT_MS, PID_STALE_MS, isRendererAlive,
  STATS_LOCK_FILE, LOCK_WAIT_MS, LOCK_STALE_MS, LOCK_SPIN_MS,
  ACTIVE_WORK_STATES, COMPLETION_STATES, INTERRUPTIBLE_STATES,
  safeFilename, detailText, loadPrefs, savePrefs, getGitBranch, getIsWorktree,
  writeJsonAtomic, acquireSpawnLock, sleepSync, acquireFileLock, withStatsLock,
  quoteArg, shQuote, buildRendererCommands, spawnRendererWindow,
};
