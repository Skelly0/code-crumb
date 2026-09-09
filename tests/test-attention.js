'use strict';

// +================================================================+
// |  Attention-following main face                                 |
// |                                                                |
// |  The center face follows the session the user most recently    |
// |  prompted. These tests pin the pure policy, the list ordering, |
// |  the age formatter, and the hook fields that feed them.        |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSuite, makeTempEnv, cleanup, readJSON } = require('./_harness');
const suite = createSuite();
const { describe, test } = suite;

const { pickMainSession } = require('../renderer');

const S = (id, over = {}) => ({
  id, parentSession: null, isTeammate: false, stopped: false, stale: false,
  attentionAt: 0, lastUpdate: 0, ...over,
});

describe('renderer -- pickMainSession', () => {
  test('first pick: highest attention wins', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 20 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('first pick with no attention stamps: newest write wins', () => {
    const r = pickMainSession({ sessions: [S('a', { lastUpdate: 5 }), S('b', { lastUpdate: 9 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a newer prompt elsewhere moves the center', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 30 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a tie keeps the current main', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10, lastUpdate: 1 }), S('b', { attentionAt: 10, lastUpdate: 99 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });

  test('a live pin wins over a newer prompt', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 30 })], currentId: 'a', pinnedId: 'a' });
    assert.strictEqual(r.mainId, 'a');
    assert.strictEqual(r.pinnedId, 'a');
  });

  test('a pinned child (promoted agent) stays main while live', () => {
    const r = pickMainSession({ sessions: [S('p', { attentionAt: 50 }), S('p-agent-1', { parentSession: 'p' })], currentId: 'p-agent-1', pinnedId: 'p-agent-1' });
    assert.strictEqual(r.mainId, 'p-agent-1');
  });

  test('a stopped pin is released and the policy moves on', () => {
    const r = pickMainSession({ sessions: [S('p', { attentionAt: 50 }), S('p-agent-1', { parentSession: 'p', stopped: true })], currentId: 'p-agent-1', pinnedId: 'p-agent-1' });
    assert.strictEqual(r.mainId, 'p');
    assert.strictEqual(r.pinnedId, null);
  });

  test('a stale pin is released too', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 1, stale: true }), S('b', { attentionAt: 0 })], currentId: 'a', pinnedId: 'a' });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('a pin for a session that vanished is released', () => {
    const r = pickMainSession({ sessions: [S('b')], currentId: 'gone', pinnedId: 'gone' });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('children and teammates are never chosen unpinned', () => {
    const r = pickMainSession({ sessions: [S('p-agent-1', { parentSession: 'p', attentionAt: 99 }), S('mate', { isTeammate: true, attentionAt: 99 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, null);
  });

  test('stopped and stale sessions are never chosen', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 99, stopped: true }), S('b', { attentionAt: 98, stale: true })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, null);
  });

  test('no live candidate keeps the current main', () => {
    const r = pickMainSession({ sessions: [S('a', { stopped: true })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });

  test('a current main that went stale loses to a live one', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 99, stale: true }), S('b', { attentionAt: 1 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a current main missing from the set keeps its seat when nothing is live', () => {
    const r = pickMainSession({ sessions: [], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });
});

module.exports = suite;
