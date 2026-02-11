'use strict';

// +================================================================+
// |  Shared constants and utilities                                  |
// |  Common paths, config, and helpers used across all modules       |
// +================================================================+

const path = require('path');

// -- Paths -----------------------------------------------------------

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');
const STATS_FILE = path.join(HOME, '.claude-face-stats.json');

// -- Utilities -------------------------------------------------------

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

module.exports = { HOME, STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename };
