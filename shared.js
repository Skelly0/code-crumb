'use strict';

// +================================================================+
// |  Shared constants and utilities                                  |
// |  Common paths, config, and helpers used across all modules       |
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

// -- Utilities -------------------------------------------------------

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
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
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs), 'utf8');
  } catch {}
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

module.exports = { HOME, STATE_FILE, SESSIONS_DIR, STATS_FILE, PREFS_FILE, TEAMS_DIR, safeFilename, loadPrefs, savePrefs, getGitBranch };
