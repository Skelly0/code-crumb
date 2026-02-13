#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Setup -- configures hooks for supported editors     |
// |  Works on Windows, macOS, and Linux                              |
// |                                                                  |
// |  Usage:                                                          |
// |    node setup.js              (Claude Code -- default)           |
// |    node setup.js claude       (Claude Code -- explicit)          |
// |    node setup.js codex        (Codex CLI)                        |
// |    node setup.js opencode     (OpenCode)                         |
// |    node setup.js openclaw     (OpenClaw / Pi)                    |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const HOOK_SCRIPT = path.resolve(__dirname, 'update-state.js');

// Normalise to forward slashes -- works in Node on all platforms
// and avoids JSON escaping nightmares with backslashes
const hookPath = HOOK_SCRIPT.replace(/\\/g, '/');

// -- Editor detection ------------------------------------------------

const editor = (process.argv[2] || 'claude').toLowerCase();

// -- Claude Code Setup -----------------------------------------------

function setupClaude() {
  const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');

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

  console.log('\n  Claude Face Setup (Claude Code)');
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

  Plugin install (alternative to manual setup):
     claude plugin install --plugin-dir "${path.resolve(__dirname).replace(/\\/g, '/')}"

  To uninstall, remove the claude-face hooks from:
     ${CLAUDE_SETTINGS}

  ${'─'.repeat(42)}
`);
}

// -- Codex CLI Setup -------------------------------------------------

function setupCodex() {
  const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml');
  const notifyPath = path.resolve(__dirname, 'adapters', 'codex-notify.js').replace(/\\/g, '/');
  const wrapperPath = path.resolve(__dirname, 'adapters', 'codex-wrapper.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Claude Face Setup (Codex CLI)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${notifyPath}\n`);

  // Read existing config or create new
  let configText = '';
  let hasNotify = false;
  try {
    configText = fs.readFileSync(CODEX_CONFIG, 'utf8');
    hasNotify = /^\s*notify\s*=/m.test(configText);
    console.log('  [ok] Found existing Codex config');
  } catch {
    console.log('  [..] No existing config found');
  }

  if (hasNotify) {
    // Check if our handler is already configured
    if (configText.includes('codex-notify.js')) {
      console.log('  [ok] Claude Face notify handler already configured');
    } else {
      console.log('\n  [!!] Codex already has a notify handler configured.');
      console.log('  To add Claude Face, edit ~/.codex/config.toml:');
      console.log(`  notify = ["node", "${notifyPath}"]`);
    }
  } else {
    // Append notify config
    const notifyLine = `\n# Claude Face integration\nnotify = ["node", "${notifyPath}"]\n`;
    const codexDir = path.dirname(CODEX_CONFIG);
    if (!fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
    }
    fs.writeFileSync(CODEX_CONFIG, configText + notifyLine, 'utf8');
    console.log(`  + Added notify handler to ${CODEX_CONFIG}`);
  }

  console.log(`
  ${'─'.repeat(42)}

  Codex CLI integration has two modes:

  1. NOTIFY MODE (basic -- turn-level events only):
     Already configured above. The face will react when
     Codex completes a turn. Start the renderer:
       node "${rendererPath}"
     Then use Codex normally.

  2. WRAPPER MODE (rich -- tool-level events):
     Use the wrapper instead of \`codex exec\`:
       node "${wrapperPath}" "your prompt"
     This intercepts the JSONL stream for real-time
     tool-level face reactions.

  Note: Codex CLI lacks a hook system, so interactive
  TUI sessions cannot be observed at the tool level.

  ${'─'.repeat(42)}
`);
}

// -- OpenCode Setup --------------------------------------------------

function setupOpenCode() {
  const adapterPath = path.resolve(__dirname, 'adapters', 'opencode-adapter.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Claude Face Setup (OpenCode)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${adapterPath}\n`);

  console.log(`
  ${'─'.repeat(42)}

  OpenCode integration uses the generic adapter.
  Pipe events from OpenCode to the adapter via stdin:

    echo '{"event":"tool_start","tool":"file_edit","input":{"file_path":"src/app.ts"}}' | \\
      node "${adapterPath}"

  Event types:
    tool_start  - Before a tool runs (maps to face activity states)
    tool_end    - After a tool completes (maps to outcome states)
    turn_end    - Session/turn finished (happy face)
    error       - Something went wrong (error face)
    waiting     - Needs user attention (waiting face)

  The adapter accepts the same JSON fields as Claude Code
  hooks (tool_name, tool_input, tool_response) plus generic
  fields (tool, input, output, error) for flexibility.

  To start the renderer:
    node "${rendererPath}"

  For integration help, see:
    https://github.com/Skelly0/claude-face

  ${'─'.repeat(42)}
`);
}

// -- OpenClaw / Pi Setup ---------------------------------------------

function setupOpenClaw() {
  const adapterPath = path.resolve(__dirname, 'adapters', 'openclaw-adapter.js').replace(/\\/g, '/');
  const rendererPath = path.resolve(__dirname, 'renderer.js').replace(/\\/g, '/');

  console.log('\n  Claude Face Setup (OpenClaw / Pi)');
  console.log('  ' + '='.repeat(40) + '\n');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Home:     ${HOME}`);
  console.log(`  Adapter:  ${adapterPath}\n`);

  console.log(`
  ${'─'.repeat(42)}

  OpenClaw uses the Pi coding agent engine, which
  has an extension system with tool lifecycle events.

  OPTION 1: Pi Extension (recommended)
  ${'─'.repeat(38)}

  Create a Pi extension that pipes events to the adapter.
  Add this to your OpenClaw workspace or ~/.openclaw/extensions/:

    // claude-face-extension.js
    module.exports = function(pi) {
      const { execSync } = require('child_process');
      const adapter = '${adapterPath}';

      function send(payload) {
        try {
          execSync(\`node "\${adapter}"\`,
            { input: JSON.stringify(payload), timeout: 2000, stdio: ['pipe','ignore','ignore'] });
        } catch {}
      }

      pi.on('tool_call', (event) => {
        send({ event: 'tool_call', toolName: event.toolName,
               input: event.input });
      });

      pi.on('tool_result', (event) => {
        send({ event: 'tool_result', toolName: event.toolName,
               input: event.input, output: event.result || '',
               error: event.error || false });
      });
    };

  OPTION 2: Standalone adapter (pipe JSON)
  ${'─'.repeat(38)}

  Pipe events from any script or tool:

    echo '{"event":"tool_call","toolName":"edit","input":{"file_path":"src/app.ts"}}' | \\
      node "${adapterPath}"

  Pi-native event types:
    tool_call             → face shows activity state
    tool_execution_start  → face shows activity state
    tool_execution_end    → face shows outcome state
    tool_result           → face shows outcome state

  Generic event types (also accepted):
    tool_start, tool_end, turn_end, error, waiting

  To start the renderer:
    node "${rendererPath}"

  ${'─'.repeat(42)}
`);
}

// -- Dispatch --------------------------------------------------------

switch (editor) {
  case 'claude':
  case 'claude-code':
    setupClaude();
    break;
  case 'codex':
  case 'openai':
    setupCodex();
    break;
  case 'opencode':
    setupOpenCode();
    break;
  case 'openclaw':
  case 'claw':
  case 'pi':
    setupOpenClaw();
    break;
  default:
    console.log(`\n  Unknown editor: "${editor}"`);
    console.log('  Supported editors: claude, codex, opencode, openclaw');
    console.log('  Usage: node setup.js [claude|codex|opencode|openclaw]\n');
    process.exit(1);
}
