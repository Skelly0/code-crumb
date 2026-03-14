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

// -- Orbital Grouping with Teams -----------------------------------

describe('teams.js -- Orbital grouping with team data', () => {
  test('_buildGroups clusters teammates by teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('t1'); f1.teamName = 'backend'; f1.teamColor = [255, 120, 120]; f1.isTeammate = true;
    const f2 = new MiniFace('t2'); f2.teamName = 'backend'; f2.teamColor = [255, 120, 120]; f2.isTeammate = true;
    const f3 = new MiniFace('t3'); f3.parentSession = 'main';
    const groups = os._buildGroups([f1, f2, f3]);
    const teamGroup = groups.find(g => g.key === 'backend');
    assert.ok(teamGroup, 'should have a backend group');
    assert.strictEqual(teamGroup.members.length, 2);
    assert.deepStrictEqual(teamGroup.color, [255, 120, 120]);
  });

  test('tethers use team color for team groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('t1'); f1.teamName = 'ops'; f1.teamColor = [100, 255, 210]; f1.isTeammate = true;
    const f2 = new MiniFace('t2'); f2.teamName = 'ops'; f2.teamColor = [100, 255, 210]; f2.isTeammate = true;
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 30, row: 15, w: 12, h: 8, centerX: 36, centerY: 19 };
    const result = os._renderGroupTethers(positions, mainPos, [100, 160, 210], dots);
    // Tether should exist (team members grouped)
    assert.ok(result.length > 0, 'should render tethers for team group');
  });

  test('group labels show team name for team groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('t1'); f1.teamName = 'frontend'; f1.teamColor = [140, 255, 120];
    const f2 = new MiniFace('t2'); f2.teamName = 'frontend'; f2.teamColor = [140, 255, 120];
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.ok(result.includes('frontend'), 'group label should contain team name');
  });

  test('mixed team and non-team faces form separate groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('t1'); f1.teamName = 'backend'; f1.isTeammate = true;
    const f2 = new MiniFace('t2'); f2.teamName = 'backend'; f2.isTeammate = true;
    const f3 = new MiniFace('s1'); f3.parentSession = 'main';
    const f4 = new MiniFace('s2'); f4.parentSession = 'main';
    const groups = os._buildGroups([f1, f2, f3, f4]);
    assert.strictEqual(groups.length, 2);
    const teamGroup = groups.find(g => g.key === 'backend');
    const subGroup = groups.find(g => g.key === 'main');
    assert.strictEqual(teamGroup.members.length, 2);
    assert.strictEqual(subGroup.members.length, 2);
  });
});

// -- hashTeamColor boundary values -----------------------------------

describe('teams -- hashTeamColor boundary values', () => {
  test('all returned color components are in [0, 255] range', () => {
    const names = ['alpha', 'beta', 'gamma', '', 'test-team', '0', 'zzzzzz'];
    for (const name of names) {
      const color = hashTeamColor(name);
      for (const c of color) {
        assert.ok(c >= 0 && c <= 255, `component ${c} for "${name}" should be in [0, 255]`);
      }
    }
  });

  test('handles very long team name (100 chars)', () => {
    const longName = 'a'.repeat(100);
    const color = hashTeamColor(longName);
    assert.ok(Array.isArray(color), 'should return an array');
    assert.strictEqual(color.length, 3, 'should have 3 components');
    for (const c of color) {
      assert.ok(c >= 0 && c <= 255, `component ${c} should be in [0, 255]`);
    }
  });

  test('handles special characters in team name', () => {
    const specialNames = ['team!@#$%', 'über-team', '日本語チーム', 'team\nnewline', 'team\ttab'];
    for (const name of specialNames) {
      const color = hashTeamColor(name);
      assert.ok(Array.isArray(color), `should return array for "${name}"`);
      assert.strictEqual(color.length, 3, `should have 3 components for "${name}"`);
      for (const c of color) {
        assert.ok(c >= 0 && c <= 255, `component ${c} for "${name}" should be in [0, 255]`);
      }
    }
  });
});

// -- MiniFace.updateFromFile gitBranch --------------------------------

describe('teams -- MiniFace.updateFromFile gitBranch', () => {
  test('sets gitBranch from data', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'coding', gitBranch: 'feature/xyz' });
    assert.strictEqual(face.gitBranch, 'feature/xyz');
  });

  test('gitBranch persists when subsequent updates omit it', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'coding', gitBranch: 'feature/xyz' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.gitBranch, 'feature/xyz');
  });
});

// -- MiniFace.updateFromFile taskDescription --------------------------

describe('teams -- MiniFace.updateFromFile taskDescription', () => {
  test('sets taskDescription from data', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'thinking', taskDescription: 'fix auth bug' });
    assert.strictEqual(face.taskDescription, 'fix auth bug');
  });

  test('taskDescription is sticky (persists when omitted in subsequent updates)', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'thinking', taskDescription: 'fix auth bug' });
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.taskDescription, 'fix auth bug');
  });
});

// -- MiniFace isMainSession classification ----------------------------

describe('teams -- MiniFace isMainSession classification', () => {
  test('face with no parentSession and isTeammate=false has isMainSession=true', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.isMainSession, true);
    assert.strictEqual(face.parentSession, null);
    assert.strictEqual(face.isTeammate, false);
  });

  test('face with parentSession has isMainSession=false', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'coding', parentSession: 'parent-123' });
    assert.strictEqual(face.isMainSession, false);
  });

  test('teammate has isMainSession=false', () => {
    const face = new MiniFace('s1');
    face.updateFromFile({ state: 'waiting', isTeammate: true, teamName: 'backend' });
    assert.strictEqual(face.isMainSession, false);
  });
});

// -- OrbitalSystem._assignLabels with taskDescription -----------------

describe('teams -- OrbitalSystem._assignLabels with taskDescription', () => {
  test('face with taskDescription gets label from taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('s1');
    face.taskDescription = 'fix bug';
    os.faces.set('s1', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'fix bug');
  });

  test('long taskDescription is truncated to 8 chars', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('s1');
    face.taskDescription = 'implement authentication system';
    os.faces.set('s1', face);
    os._assignLabels();
    assert.strictEqual(face.label.length, 8);
    assert.strictEqual(face.label, 'implemen');
  });

  test('teammateName takes priority over taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('s1');
    face.teammateName = 'writer';
    face.taskDescription = 'fix bug';
    face.isTeammate = true;
    os.faces.set('s1', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'writer');
  });

  test('taskDescription takes priority over cwd basename', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('s1');
    face.taskDescription = 'audit';
    face.cwd = '/home/user/my-project';
    os.faces.set('s1', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'audit');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
