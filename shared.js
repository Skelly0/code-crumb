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

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || '_empty';
}

function loadPrefs() {
  try {
    const raw = fs.readFileSync(PREFS_FILE, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePrefs(updates) {
  try {
    let prefs = {};
    try {
      const raw = fs.readFileSync(PREFS_FILE, 'utf8').trim();
      if (raw) prefs = JSON.parse(raw);
    } catch {}
    Object.assign(prefs, updates);
    writeJsonAtomic(PREFS_FILE, prefs, 0o600);
  } catch {}
}

// -- Atomic writes and spawn lock ------------------------------------

// Write JSON (or a pre-serialized string) atomically: temp file + rename, so
// the renderer (which watches these files) never reads a half-written one.
// Falls back to a direct write if the rename is refused. Returns true on
// success; never throws.
function writeJsonAtomic(file, obj, mode = 0o600) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { encoding: 'utf8', mode });
    fs.renameSync(tmp, file);
    return true;
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
function acquireSpawnLock(lockFile, staleMs = 5000) {
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return true;
    try {
      if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
        fs.writeFileSync(lockFile, String(process.pid));
        return true;
      }
    } catch {
      return true;
    }
    return false;
  }
}

// -- Process spawning helpers -----------------------------------------

// Quote one argument for a Windows command line built by hand (shell:true or
// windowsVerbatimArguments). Node does no quoting in those modes.
function quoteArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"]/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
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
function buildRendererCommands(platform, rendererArgs, windowTitle) {
  const detached = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') {
    const quoted = rendererArgs.map(quoteArg);
    return {
      // wt is an app-execution alias that can only be started through a
      // shell; shell:true joins args verbatim, so every arg is pre-quoted.
      wt: {
        cmd: 'wt',
        args: ['-w', '0', 'new-tab', '--title', quoteArg(windowTitle), 'node', ...quoted],
        opts: { ...detached, shell: true },
      },
      // cmd.exe's `start` parses its own line; hand it one verbatim string.
      cmd: {
        cmd: 'cmd',
        args: ['/c', `start ${quoteArg(windowTitle)} node ${quoted.join(' ')}`],
        opts: { ...detached, windowsVerbatimArguments: true },
      },
    };
  }
  if (platform === 'darwin') {
    const shellLine = 'node ' + rendererArgs.map(shQuote).join(' ') + '; exit';
    return {
      osascript: {
        cmd: 'osascript',
        args: ['-e', `tell application "Terminal" to do script "${appleScriptEscape(shellLine)}"`],
        opts: detached,
      },
    };
  }
  return {
    'gnome-terminal': { cmd: 'gnome-terminal', args: ['--title=' + windowTitle, '--', 'node', ...rendererArgs], opts: detached },
    konsole:          { cmd: 'konsole', args: ['--new-tab', '-e', 'node', ...rendererArgs], opts: detached },
    'xfce4-terminal': { cmd: 'xfce4-terminal', args: ['--title=' + windowTitle, '-e', 'node ' + rendererArgs.map(shQuote).join(' ')], opts: detached },
    xterm:            { cmd: 'xterm', args: ['-T', windowTitle, '-e', 'node', ...rendererArgs], opts: detached },
  };
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
          // Worktree: .git is a file like "gitdir: /path/to/.git/worktrees/foo"
          const content = fs.readFileSync(gitPath, 'utf8').trim();
          if (content.startsWith('gitdir:')) {
            headFile = path.join(content.slice(7).trim(), 'HEAD');
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
  ACTIVE_WORK_STATES, COMPLETION_STATES, INTERRUPTIBLE_STATES,
  safeFilename, loadPrefs, savePrefs, getGitBranch, getIsWorktree,
  writeJsonAtomic, acquireSpawnLock, quoteArg, shQuote, buildRendererCommands,
};
