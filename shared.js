'use strict';

// +================================================================+
// |  Shared constants and utilities                                  |
// |  Common paths, config, and helpers used across all modules       |
// +================================================================+

const fs = require('fs');
const path = require('path');

// -- Paths -----------------------------------------------------------

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');
const STATS_FILE = path.join(HOME, '.claude-face-stats.json');
const PREFS_FILE = path.join(HOME, '.claude-face-prefs.json');

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

module.exports = { HOME, STATE_FILE, SESSIONS_DIR, STATS_FILE, PREFS_FILE, safeFilename, loadPrefs, savePrefs };
