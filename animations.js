'use strict';

// +================================================================+
// |  Face animations -- eyes, mouths, and grid mouths               |
// |  Pure visual data used by ClaudeFace and MiniFace               |
// +================================================================+

// -- Mouths (full-size face) ---------------------------------------
const mouths = {
  smile:      () => '\u25e1\u25e1\u25e1',
  neutral:    () => '\u2500\u2500\u2500',
  wide:       () => '\u25e1\u25e1\u25e1\u25e1\u25e1',
  curious:    () => ' \u25cb ',
  frown:      () => '\u25e0\u25e0\u25e0',
  smirk:      () => '  \u25e1\u25e1',
  ooh:        () => ' \u25cb ',
  determined: () => '\u2550\u2550\u2550',
  glitch: () => {
    const ms = ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2550\u25e1\u2550', '\u25e1\u2550\u25e1', '\u2500\u25e1\u2500', '\u25e1\u2500\u25e1'];
    return ms[Math.floor(Math.random() * ms.length)];
  },
  wavy:       () => '~~~',
  wait:       () => '\u2500\u2500\u2500',
  tight:      () => '\u2550\u2550\u2550',
  dots:       () => '\u00b7\u00b7\u00b7',
  grin:       () => '\u25aa\u25e1\u25aa',
  calm:       () => ' \u25e1\u25e1',
  exhale:     () => ' \u25e1 ',
  content:    () => '\u25e1\u25e1 ',
};

// -- Grid mouths (compact for BOX_INNER=6) -------------------------
const gridMouths = {
  idle:        '\u25e1\u25e1\u25e1',
  thinking:    '\u2500\u2500\u2500',
  reading:     '\u2500\u2500\u2500',
  searching:   ' \u25cb ',
  coding:      '\u2550\u2550\u2550',
  executing:   ' \u25e1\u25e1',
  happy:       '\u25e1\u25e1\u25e1',
  error:       '\u25e0\u25e0\u25e0',
  sleeping:    '~~~',
  waiting:     '\u2500\u2500\u2500',
  testing:     '\u2550\u2550\u2550',
  installing:  '\u00b7\u00b7\u00b7',
  caffeinated: '\u25aa\u25e1\u25aa',
  subagent:    ' \u25e1\u25e1',
  satisfied:   '\u25e1\u25e1\u25e1',
  proud:       '  \u25e1\u25e1',
  relieved:    ' \u25e1 ',
};

// -- Eyes (2-row, full-size face) ----------------------------------
const eyes = {
  open()     { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },
  blink()    { return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] }; },
  halfClose(){ return { left: ['\u2580\u2580', '  '], right: ['\u2580\u2580', '  '] }; },
  narrowed() { return { left: ['\u2500\u2500', '\u2500\u2500'], right: ['\u2500\u2500', '\u2500\u2500'] }; },
  focused()  { return { left: ['\u2584\u2584', '\u2580\u2580'], right: ['\u2584\u2584', '\u2580\u2580'] }; },
  lookLeft() { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588 ', '\u2588 '] }; },
  lookRight(){ return { left: [' \u2588', ' \u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  sparkle(theme, frame) {
    const chars = ['\u2726 ', ' \u2726', '\u2727 ', ' \u2727'];
    const i = frame % chars.length;
    return {
      left:  [chars[i], chars[(i + 1) % chars.length]],
      right: [chars[(i + 2) % chars.length], chars[(i + 3) % chars.length]],
    };
  },

  cross() { return { left: ['\u2572\u2571', '\u2571\u2572'], right: ['\u2572\u2571', '\u2571\u2572'] }; },

  glitch() {
    const g = ['\u2588\u2593', '\u2593\u2591', '\u2591\u2592', '\u2592\u2588', '\u2593\u2593', '\u2591\u2591', '\u2588\u2588', '\u2592\u2593'];
    const i = Math.floor(Math.random() * g.length);
    const j = Math.floor(Math.random() * g.length);
    return {
      left:  [g[i], g[j]],
      right: [g[(i+3) % g.length], g[(j+2) % g.length]],
    };
  },

  spin(theme, frame) {
    const phases = [
      { left: ['\u25cf ', '  '], right: ['  ', '  '] },
      { left: ['  ', '  '], right: ['\u25cf ', '  '] },
      { left: ['  ', '  '], right: ['  ', ' \u25cf'] },
      { left: ['  ', ' \u25cf'], right: ['  ', '  '] },
    ];
    return phases[frame % phases.length];
  },

  wide()  { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  sleeping(theme, frame) {
    if (frame % 150 > 145) return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] };
    return { left: ['  ', '\u2500\u2500'], right: ['  ', '\u2500\u2500'] };
  },

  waiting(theme, frame) {
    const drift = Math.floor(frame / 40) % 3;
    if (drift === 1) return { left: ['\u2584\u2584', '\u2588 '], right: ['\u2584\u2584', ' \u2588'] };
    return { left: ['\u2584\u2584', '\u2588\u2588'], right: ['\u2584\u2584', '\u2588\u2588'] };
  },

  intense(theme, frame) {
    if (frame % 25 < 2) return { left: ['\u2588\u2588', '\u2580\u2580'], right: ['\u2580\u2580', '\u2588\u2588'] };
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  down()  { return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] }; },

  vibrate(theme, frame) {
    const j = frame % 3;
    if (j === 0) return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
    if (j === 1) return { left: [' \u2588', '\u2588 '], right: ['\u2588 ', ' \u2588'] };
    return { left: ['\u2588 ', ' \u2588'], right: [' \u2588', '\u2588 '] };
  },

  echo() { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  pleased(theme, frame) {
    if (frame % 50 < 3) return { left: ['\u2580\u2580', '\u2500\u2500'], right: ['\u2580\u2580', '\u2500\u2500'] };
    return { left: ['\u2584\u2584', '\u2588\u2588'], right: ['\u2584\u2584', '\u2588\u2588'] };
  },

  content() { return { left: ['\u2580\u2580', '  '], right: ['\u2580\u2580', '  '] }; },
};

module.exports = { mouths, gridMouths, eyes };
