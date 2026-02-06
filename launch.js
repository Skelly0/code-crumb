#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Launcher                                           |
// |  Starts the face renderer (if not running) then launches        |
// |  Claude Code, passing through all arguments.                    |
// |                                                                 |
// |  Usage:                                                         |
// |    node launch.js                                               |
// |    node launch.js --dangerously-skip-permissions                |
// |    node launch.js -p "fix the bug in auth.ts"                   |
// |    node launch.js --resume                                      |
// |                                                                 |
// |  Or via the batch/shell wrappers:                               |
// |    claude-face                                                  |
// |    claude-face --dangerously-skip-permissions                   |
// +================================================================+

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const PID_FILE = path.join(HOME, '.claude-face.pid');
const rendererPath = path.resolve(__dirname, 'renderer.js');

function isRendererRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
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
    // Open renderer in a new Windows Terminal tab/window
    // Try wt.exe first (Windows Terminal), fall back to cmd start
    try {
      spawn('wt', ['-w', '0', 'new-tab', '--title', 'Claude Face', 'node', rendererPath], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      }).unref();
    } catch {
      // Fall back to old-school cmd start
      spawn('cmd', ['/c', 'start', '"Claude Face"', 'node', rendererPath], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  } else if (platform === 'darwin') {
    // macOS: open a new Terminal.app window
    const escaped = rendererPath.replace(/'/g, "'\\''");
    spawn('osascript', ['-e', `tell application "Terminal" to do script "node '${escaped}'; exit"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    // Linux: try common terminal emulators in order of popularity
    const terminals = [
      ['gnome-terminal', ['--title=Claude Face', '--', 'node', rendererPath]],
      ['konsole', ['--new-tab', '-e', 'node', rendererPath]],
      ['xfce4-terminal', ['--title=Claude Face', '-e', `node ${rendererPath}`]],
      ['xterm', ['-T', 'Claude Face', '-e', 'node', rendererPath]],
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

// Pass all arguments through to claude
const args = process.argv.slice(2);
const claude = spawn('claude', args, {
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
