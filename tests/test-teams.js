#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Agent Teams support                     |
// |  Tests for team fields in MiniFace, hashTeamColor,               |
// |  _assignLabels with teammate names, session schema               |
// +================================================================+

const assert = require('assert');
const { MiniFace, OrbitalSystem, hashTeamColor } = require('../grid');

let passed = 0;
let failed = 0;

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`    \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`      ${e.message}`);
  }
}

// -- hashTeamColor ---------------------------------------------------

describe('teams -- hashTeamColor', () => {
  test('returns an RGB array', () => {
    const color = hashTeamColor('my-project');
    assert.ok(Array.isArray(color), 'should be an array');
    assert.strictEqual(color.length, 3, 'should have 3 components');
    assert.ok(color.every(c => typeof c === 'number'), 'components should be numbers');
  });

  test('same team name always returns same color', () => {
    const c1 = hashTeamColor('alpha');
    const c2 = hashTeamColor('alpha');
    assert.deepStrictEqual(c1, c2);
  });

  test('different team names can return different colors', () => {
    // Not guaranteed to differ, but with distinct names they statistically will
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    const colors = names.map(hashTeamColor);
    const unique = new Set(colors.map(c => c.join(',')));
    assert.ok(unique.size > 1, 'should produce more than one distinct color');
  });

  test('handles empty string without throwing', () => {
    const color = hashTeamColor('');
    assert.ok(Array.isArray(color));
    assert.strictEqual(color.length, 3);
  });

  test('handles null/undefined without throwing', () => {
    const color = hashTeamColor(null);
    assert.ok(Array.isArray(color));
  });
});

// -- MiniFace team fields -------------------------------------------

describe('teams -- MiniFace default team fields', () => {
  test('teamName defaults to empty string', () => {
    const face = new MiniFace('s1');
    assert.strictEqual(face.teamName, '');
  });

  test('teammateName defaults to empty string', () => {
    const face = new MiniFace('s1');
    assert.strictEqual(face.teammateName, '');
  });

  test('isTeammate defaults to false', () => {
    const face = new MiniFace('s1');
    assert.strictEqual(face.isTeammate, false);
  });

  test('teamColor defaults to null', () => {
    const face = new MiniFace('s1');
    assert.strictEqual(face.teamColor, null);
  });
});

describe('teams -- MiniFace.updateFromFile team fields', () => {
  test('reads teamName from data', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', teamName: 'my-project' });
    assert.strictEqual(face.teamName, 'my-project');
  });

  test('reads teammateName from data', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', teammateName: 'researcher' });
    assert.strictEqual(face.teammateName, 'researcher');
  });

  test('sets isTeammate from data', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', isTeammate: true });
    assert.strictEqual(face.isTeammate, true);
  });

  test('derives teamColor from teamName', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', teamName: 'my-project' });
    assert.deepStrictEqual(face.teamColor, hashTeamColor('my-project'));
  });

  test('teamColor stays null when no teamName provided', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting' });
    assert.strictEqual(face.teamColor, null);
  });

  test('does not reset teammateName on subsequent update without it', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', teammateName: 'researcher' });
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.teammateName, 'researcher');
  });
});

// -- OrbitalSystem _assignLabels with team names --------------------

describe('teams -- OrbitalSystem label assignment with teammates', () => {
  function makeOrbit() {
    const orb = new OrbitalSystem();
    // Patch loadSessions so we can inject faces directly
    return orb;
  }

  test('teammate face uses teammateName as label', () => {
    const orb = makeOrbit();
    const face = new MiniFace('t1');
    face.teammateName = 'researcher';
    face.isTeammate = true;
    orb.faces.set('t1', face);
    orb._assignLabels();
    assert.strictEqual(face.label, 'research'); // sliced to 8 chars
  });

  test('teammate label is truncated to 8 chars', () => {
    const orb = new OrbitalSystem();
    const face = new MiniFace('t1');
    face.teammateName = 'very-long-name';
    face.isTeammate = true;
    orb.faces.set('t1', face);
    orb._assignLabels();
    assert.strictEqual(face.label.length, 8);
    assert.strictEqual(face.label, 'very-lon');
  });

  test('non-teammate face falls back to sub-N label when cwd is ambiguous', () => {
    const orb = new OrbitalSystem();
    const f1 = new MiniFace('s1');
    const f2 = new MiniFace('s2');
    // No cwd, no teammateName
    orb.faces.set('s1', f1);
    orb.faces.set('s2', f2);
    orb._assignLabels();
    // Both should get sub-N style labels
    assert.ok(f1.label.startsWith('sub-') || f1.label.length > 0);
    assert.ok(f2.label.startsWith('sub-') || f2.label.length > 0);
  });

  test('mixed team and non-team faces label independently', () => {
    const orb = new OrbitalSystem();
    const teamFace = new MiniFace('t1');
    teamFace.teammateName = 'writer';
    teamFace.isTeammate = true;
    const subFace = new MiniFace('s1');
    orb.faces.set('t1', teamFace);
    orb.faces.set('s1', subFace);
    orb._assignLabels();
    assert.strictEqual(teamFace.label, 'writer');
    // subFace should still get some label
    assert.ok(typeof subFace.label === 'string');
  });
});

// -- Session schema fields ------------------------------------------

describe('teams -- session schema fields', () => {
  test('TeammateIdle session schema has required fields', () => {
    // Simulate what update-state.js writes for TeammateIdle
    const sessionData = {
      session_id: 'teammate-abc',
      state: 'waiting',
      detail: 'researcher idle',
      timestamp: Date.now(),
      cwd: '/tmp',
      stopped: false,
      teamName: 'my-project',
      teammateName: 'researcher',
      isTeammate: true,
    };
    const face = new MiniFace(sessionData.session_id);
    face.updateFromFile(sessionData);
    assert.strictEqual(face.state, 'waiting');
    assert.strictEqual(face.teamName, 'my-project');
    assert.strictEqual(face.teammateName, 'researcher');
    assert.strictEqual(face.isTeammate, true);
  });

  test('TaskCompleted session schema has task subject in detail', () => {
    const sessionData = {
      session_id: 'teammate-xyz',
      state: 'happy',
      detail: 'Implement auth',
      timestamp: Date.now(),
      teamName: 'backend-team',
      teammateName: 'coder',
      taskSubject: 'Implement auth endpoints',
      isTeammate: true,
    };
    const face = new MiniFace(sessionData.session_id);
    face.updateFromFile(sessionData);
    assert.strictEqual(face.state, 'happy');
    assert.strictEqual(face.teamName, 'backend-team');
    assert.strictEqual(face.teammateName, 'coder');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
