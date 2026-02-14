#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Orbital Demo                                          |
// |  Simulates subagent sessions orbiting the main face             |
// |  Run renderer.js first! (node renderer.js)                      |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR } = require('./shared');

// Ensure dir exists
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

function writeMainState(state, detail, sessionId) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    state,
    detail,
    timestamp: Date.now(),
    sessionId,
    modelName: 'claude',
  }), 'utf8');
}

function writeSession(id, state, detail, cwd, stopped = false) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify({
    session_id: id,
    state,
    detail,
    timestamp: Date.now(),
    cwd: cwd || process.cwd(),
    stopped,
    modelName: 'claude',
  }), 'utf8');
}

function removeSession(id) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  try { fs.unlinkSync(path.join(SESSIONS_DIR, filename)); } catch {}
}

const mainId = 'demo-main';
const subagents = [
  { id: 'demo-sub-1', cwd: '/home/user/my-app/src' },
  { id: 'demo-sub-2', cwd: '/home/user/my-app/tests' },
  { id: 'demo-sub-3', cwd: '/home/user/api-server' },
];

// Script: a sequence of { time (ms), actions }
const script = [
  {
    time: 0,
    label: 'Main session starts thinking',
    actions: () => {
      writeMainState('thinking', '', mainId);
    },
  },
  {
    time: 3000,
    label: 'Main spawns subagent — first orbital appears',
    actions: () => {
      writeMainState('subagent', 'spawning subagent', mainId);
      writeSession(subagents[0].id, 'reading', 'reading index.ts', subagents[0].cwd);
    },
  },
  {
    time: 6000,
    label: 'Second subagent spawns — two orbitals now',
    actions: () => {
      writeSession(subagents[1].id, 'testing', 'npm test', subagents[1].cwd);
      writeSession(subagents[0].id, 'coding', 'editing App.tsx', subagents[0].cwd);
    },
  },
  {
    time: 9000,
    label: 'Third subagent! Full constellation. Sub-2 hits error.',
    actions: () => {
      writeSession(subagents[2].id, 'searching', 'looking for TODO', subagents[2].cwd);
      writeSession(subagents[1].id, 'error', 'tests failed (exit 1)', subagents[1].cwd);
    },
  },
  {
    time: 12000,
    label: 'Sub-2 recovers, sub-1 goes caffeinated, sub-3 coding',
    actions: () => {
      writeSession(subagents[0].id, 'caffeinated', 'hyperdrive!', subagents[0].cwd);
      writeSession(subagents[1].id, 'coding', 'editing fix.ts', subagents[1].cwd);
      writeSession(subagents[2].id, 'coding', 'editing handler.ts', subagents[2].cwd);
    },
  },
  {
    time: 15000,
    label: 'Sub-3 finishes and stops — orbital disappears',
    actions: () => {
      writeSession(subagents[2].id, 'happy', 'all done!', subagents[2].cwd, true);
      writeSession(subagents[0].id, 'executing', 'npm run build', subagents[0].cwd);
    },
  },
  {
    time: 18000,
    label: 'All subagents done — main face goes happy',
    actions: () => {
      writeSession(subagents[0].id, 'happy', 'all done!', subagents[0].cwd, true);
      writeSession(subagents[1].id, 'happy', 'all done!', subagents[1].cwd, true);
      writeMainState('happy', 'all done!', mainId);
    },
  },
];

console.log('\n  Code Crumb Orbital Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure renderer.js is running!');
console.log('  (node renderer.js)\n');

async function runDemo() {
  for (const step of script) {
    console.log(`  > ${step.label}`);
    step.actions();
    const nextStep = script[script.indexOf(step) + 1];
    const wait = nextStep ? nextStep.time - step.time : 3000;
    await new Promise(r => setTimeout(r, wait));
  }

  // Clean up demo files
  await new Promise(r => setTimeout(r, 8000));
  for (const s of subagents) {
    removeSession(s.id);
  }

  console.log('\n  Demo complete! Sessions cleaned up.\n');
}

runDemo();
