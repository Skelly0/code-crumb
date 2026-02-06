#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Grid Demo                                          |
// |  Simulates multiple sessions with different states to           |
// |  preview the grid renderer. Run grid-renderer.js first!         |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');

// Ensure dir exists
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

function writeSession(id, state, detail, cwd, stopped = false) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify({
    session_id: id,
    state,
    detail,
    timestamp: Date.now(),
    cwd: cwd || process.cwd(),
    stopped,
  }), 'utf8');
}

function removeSession(id) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  try { fs.unlinkSync(path.join(SESSIONS_DIR, filename)); } catch {}
}

const sessions = [
  { id: 'demo-main',  cwd: '/home/user/my-app' },
  { id: 'demo-sub-1', cwd: '/home/user/my-app' },
  { id: 'demo-sub-2', cwd: '/home/user/my-app' },
  { id: 'demo-other', cwd: '/home/user/api-server' },
];

// Script: a sequence of { time (ms), actions: [{ session, state, detail }] }
const script = [
  {
    time: 0,
    label: 'All sessions start idle',
    actions: sessions.map(s => ({ id: s.id, cwd: s.cwd, state: 'idle', detail: '' })),
  },
  {
    time: 2500,
    label: 'Main starts thinking, sub-1 reads a file',
    actions: [
      { id: 'demo-main',  cwd: sessions[0].cwd, state: 'thinking', detail: '' },
      { id: 'demo-sub-1', cwd: sessions[1].cwd, state: 'reading', detail: 'reading index.ts' },
    ],
  },
  {
    time: 5000,
    label: 'Main writes code, sub-1 searches, sub-2 runs tests',
    actions: [
      { id: 'demo-main',  cwd: sessions[0].cwd, state: 'coding',    detail: 'editing App.tsx' },
      { id: 'demo-sub-1', cwd: sessions[1].cwd, state: 'searching', detail: 'looking for "TODO"' },
      { id: 'demo-sub-2', cwd: sessions[2].cwd, state: 'testing',   detail: 'npm test' },
    ],
  },
  {
    time: 8000,
    label: 'Sub-2 hits an error! Other installs deps. Main goes caffeinated.',
    actions: [
      { id: 'demo-main',  cwd: sessions[0].cwd, state: 'caffeinated', detail: 'hyperdrive!' },
      { id: 'demo-sub-2', cwd: sessions[2].cwd, state: 'error', detail: 'tests failed (exit 1)' },
      { id: 'demo-other', cwd: sessions[3].cwd, state: 'installing', detail: 'npm install' },
    ],
  },
  {
    time: 11000,
    label: 'Main spawns subagent, sub-2 recovers, other starts coding',
    actions: [
      { id: 'demo-main',  cwd: sessions[0].cwd, state: 'subagent', detail: 'spawning subagent' },
      { id: 'demo-sub-2', cwd: sessions[2].cwd, state: 'coding',  detail: 'editing fix.ts' },
      { id: 'demo-other', cwd: sessions[3].cwd, state: 'coding',  detail: 'editing handler.ts' },
    ],
  },
  {
    time: 13500,
    label: 'Sub-1 sleeping, main waiting for input, others working',
    actions: [
      { id: 'demo-main',  cwd: sessions[0].cwd, state: 'waiting',  detail: 'needs input' },
      { id: 'demo-sub-1', cwd: sessions[1].cwd, state: 'sleeping', detail: '' },
      { id: 'demo-other', cwd: sessions[3].cwd, state: 'executing', detail: 'npm run build' },
    ],
  },
  {
    time: 16000,
    label: 'Everyone finishes up',
    actions: sessions.map(s => ({ id: s.id, cwd: s.cwd, state: 'happy', detail: 'all done!' })),
  },
  {
    time: 19000,
    label: 'Sessions stop and disappear',
    actions: sessions.map(s => ({ id: s.id, cwd: s.cwd, state: 'happy', detail: 'all done!', stopped: true })),
  },
];

console.log('\n  Claude Face Grid Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure grid-renderer.js is running!');
console.log('  (node grid-renderer.js)\n');

async function runDemo() {
  for (const step of script) {
    console.log(`  > ${step.label}`);
    for (const a of step.actions) {
      writeSession(a.id, a.state, a.detail, a.cwd, a.stopped || false);
    }
    const nextStep = script[script.indexOf(step) + 1];
    const wait = nextStep ? nextStep.time - step.time : 3000;
    await new Promise(r => setTimeout(r, wait));
  }

  // Clean up demo files
  await new Promise(r => setTimeout(r, 6000));
  for (const s of sessions) {
    removeSession(s.id);
  }

  console.log('\n  Demo complete! Sessions cleaned up.\n');
}

runDemo();
