'use strict';

// +================================================================+
// |  Accessories -- hats, glasses, and other face adornments        |
// |  Small ASCII art layered above the face, one per state          |
// |  Toggle with 'a' key. State-specific: hard hat for installing,  |
// |  reading glasses for reading, party hat for happy, etc.         |
// +================================================================+

// Each accessory: { lines: string[] }
// lines[0] is topmost, lines[last] is closest to the face border.
// Lines are centered horizontally on the face at render time.

const ACCESSORIES = {
  hardhat: {
    lines: [
      '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557  ',
      '\u2550\u2550\u2569\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2569\u2550\u2550',
    ],
  },
  glasses: {
    lines: [
      '-\u25cb\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u25cb-',
    ],
  },
  wizardhat: {
    lines: [
      '     \u2605     ',
      '   \u2571\u2592\u2592\u2592\u2592\u2592\u2572   ',
    ],
  },
  headphones: {
    lines: [
      ' \u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e ',
      ' \u25cf          \u25cf ',
    ],
  },
  partyhat: {
    lines: [
      '     \u25c6     ',
      '   \u2571\u2591\u2591\u2591\u2591\u2591\u2572   ',
    ],
  },
  nightcap: {
    lines: [
      '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 \u25cb',
    ],
  },
  detective: {
    lines: [
      '  \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2584  ',
      '\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580',
    ],
  },
  shades: {
    lines: [
      '\u2593\u2593\u2593\u2500\u2500\u2500\u2500\u2500\u2500\u2593\u2593\u2593',
    ],
  },
  crown: {
    lines: [
      ' \u25c6  \u25c6  \u25c6  \u25c6 ',
      ' \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557 ',
    ],
  },
  antenna: {
    lines: [
      '     \u25c9     ',
      '    \u2571\u2502\u2572    ',
    ],
  },
  goggles: {
    lines: [
      '(\u25ce)\u2500\u2500\u2500\u2500(\u25ce)',
    ],
  },
  caution: {
    lines: [
      '\u2571\u2572\u2571\u2572\u2571\u2572\u2571\u2572\u2571\u2572\u2571\u2572',
    ],
  },
};

// -- State-to-accessory mapping ------------------------------------
// Maps face states to accessory names. States not listed show no accessory.

const STATE_ACCESSORIES = {
  installing:  'hardhat',
  reading:     'glasses',
  thinking:    'wizardhat',
  coding:      'headphones',
  happy:       'partyhat',
  sleeping:    'nightcap',
  searching:   'detective',
  caffeinated: 'shades',
  proud:       'crown',
  subagent:    'antenna',
  testing:     'goggles',
  error:       'caution',
};

// -- Lookup --------------------------------------------------------

function getAccessory(state) {
  const name = STATE_ACCESSORIES[state];
  if (!name) return null;
  return ACCESSORIES[name] || null;
}

module.exports = { ACCESSORIES, STATE_ACCESSORIES, getAccessory };
