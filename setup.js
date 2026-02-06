#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Setup -- configures Claude Code hooks              |
// |  Works on Windows, macOS, and Linux                             |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const HOOK_SCRIPT = path.resolve(__dirname, 'update-state.js');

// Normalise to forward slashes -- works in Node on all platforms
// and avoids JSON escaping nightmares with backslashes
const hookPath = HOOK_SCRIPT.replace(/\\/g, '/');

// Build the hooks config
const faceHooks = {
  PreToolUse: [
    {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${hookPath}" PreToolUse`,
      }],
    },
  ],
  PostToolUse: [
    {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${hookPath}" PostToolUse`,
      }],
    },
  ],
  Stop: [
    {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${hookPath}" Stop`,
      }],
    },
  ],
  Notification: [
    {
      matcher: '',
      hooks: [{
        type: 'command',
        command: `node "${hookPath}" Notification`,
      }],
    },
  ],
};

console.log('\n  Claude Face Setup');
console.log('  ' + '='.repeat(40) + '\n');
console.log(`  Platform: ${process.platform}`);
console.log(`  Home:     ${HOME}`);
console.log(`  Hook:     ${hookPath}\n`);

// Read existing settings
let settings = {};
try {
  const raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
  settings = JSON.parse(raw);
  console.log('  [ok] Found existing Claude settings');
} catch {
  console.log('  [..] No existing settings found, creating new');
}

// Merge hooks (don't overwrite existing hooks)
if (!settings.hooks) {
  settings.hooks = {};
}

let modified = false;
for (const [event, hookConfigs] of Object.entries(faceHooks)) {
  if (!settings.hooks[event]) {
    settings.hooks[event] = [];
  }

  // Check if our hook is already installed
  const alreadyInstalled = settings.hooks[event].some(h =>
    h.hooks?.some(hh => hh.command?.includes('update-state.js'))
  );

  if (!alreadyInstalled) {
    settings.hooks[event].push(...hookConfigs);
    modified = true;
    console.log(`  + Added ${event} hook`);
  } else {
    console.log(`  [ok] ${event} hook already installed`);
  }
}

if (modified) {
  // Ensure .claude directory exists
  const claudeDir = path.dirname(CLAUDE_SETTINGS);
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // Write settings
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`\n  Hooks written to ${CLAUDE_SETTINGS}`);
} else {
  console.log('\n  All hooks already installed');
}

const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');
const demoPath = path.resolve(__dirname, 'demo.js').replace(/\\/g, '/');

console.log(`
  ${'─'.repeat(42)}

  To use Claude Face:

  1. Open a terminal and run:
     node "${rendererPath}"

  2. Use Claude Code as normal in another terminal.
     The face will react to what Claude is doing!

  3. To preview all expressions:
     node "${demoPath}"

  To uninstall, remove the claude-face hooks from:
     ${CLAUDE_SETTINGS}

  ${'─'.repeat(42)}
`);
