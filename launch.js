#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Launcher                                           |
// |  Starts the face renderer (if not running) then launches        |
// |  Claude Code, passing through all arguments.                    |
// |                                                                 |
// |  Usage:                                                         |
// |    node launch.js                        (single face)          |
// |    node launch.js --grid                 (multi-face grid)      |
// |    node launch.js --dangerously-skip-permissions                |
// |    node launch.js --grid -p "fix the bug"                       |
// |                                                                 |
// |  Or via the batch/shell wrappers:                               |
// |    claude-face                                                  |
// |    claude-face --grid --dangerously-skip-permissions             |
// +================================================================+

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const SINGLE_PID = path.join(HOME, '.claude-face.pid');
const GRID_PID = path.join(HOME, '.claude-face-grid.pid');

// Parse our own flags (consumed here, not passed to claude)
const rawArgs = process.argv.slice(2);
const gridMode = rawArgs.includes('--grid');
const claudeArgs = rawArgs.filter(a => a !== '--grid');

const pidFile = gridMode ? GRID_PID : SINGLE_PID;
const rendererFile = gridMode ? 'grid-renderer.js' : 'renderer.js';
const rendererPath = path.resolve(__dirname, rendererFile);
const windowTitle = gridMode ? 'Claude Face Grid' : 'Claude Face';

function isRendererRunning() {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startRenderer() {
  const platform = process.platform;

  if (platform === 'win32') {
    // Try Windows Terminal first, fall back to cmd start
    try {
      spawn('wt', ['-w', '0', 'new-tab', '--title', windowTitle, 'node', rendererPath], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    } catch {
      spawn('cmd', ['/c', 'start', `"${windowTitle}"`, 'node', rendererPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } else if (platform === 'darwin') {
    const escaped = rendererPath.replace(/'/g, "'\\''");
    spawn('osascript', ['-e', `tell application "Terminal" to do script "node '${escaped}'; exit"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    const terminals = [
      ['gnome-terminal', ['--title=' + windowTitle, '--', 'node', rendererPath]],
      ['konsole', ['--new-tab', '-e', 'node', rendererPath]],
      ['xfce4-terminal', ['--title=' + windowTitle, '-e', `node ${rendererPath}`]],
      ['xterm', ['-T', windowTitle, '-e', 'node', rendererPath]],
    ];

    let launched = false;
    for (const [cmd, args] of terminals) {
      try {
        const which = require('child_process').execSync(`which ${cmd} 2>/dev/null`);
        if (which) {
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
          launched = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!launched) {
      console.error('  Could not find a terminal emulator to launch the face.');
      console.error('  Start it manually: node ' + rendererPath);
    }
  }
}

// --- Main ---

if (!isRendererRunning()) {
  startRenderer();
  // Brief pause to let the renderer window appear
  const start = Date.now();
  while (Date.now() - start < 500) { /* spin */ }
}

// Pass remaining arguments through to claude
const claude = spawn('claude', claudeArgs, {
  stdio: 'inherit',
  shell: true,
});

claude.on('error', (err) => {
  console.error('Failed to start claude:', err.message);
  process.exit(1);
});

claude.on('exit', (code) => {
  process.exit(code || 0);
});
