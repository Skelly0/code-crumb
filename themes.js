'use strict';

// +================================================================+
// |  Themes, colors, ANSI codes, and thought bubble data            |
// |  Pure data and small utility functions used by all renderers     |
// +================================================================+

// -- ANSI ----------------------------------------------------------
const CSI = '\x1b[';
const ansi = {
  reset:      `${CSI}0m`,
  bold:       `${CSI}1m`,
  dim:        `${CSI}2m`,
  italic:     `${CSI}3m`,
  hide:       `${CSI}?25l`,
  show:       `${CSI}?25h`,
  clear:      `${CSI}2J${CSI}H`,
  home:       `${CSI}H`,
  to:         (r, c) => `${CSI}${r};${c}H`,
  fg:         (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg:         (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  clearLine:  `${CSI}2K`,
  clearBelow: `${CSI}J`,
};

// -- Color math ----------------------------------------------------
const BREATH_PERIOD = 4000;

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function dimColor(color, factor) {
  return color.map(c => Math.round(c * factor));
}

function breathe(color, time) {
  const t = (Math.sin(time * Math.PI * 2 / BREATH_PERIOD) + 1) / 2;
  const factor = 0.65 + t * 0.35;
  return dimColor(color, factor);
}

// -- Themes --------------------------------------------------------
const themes = {
  idle: {
    border: [100,160,210], eye: [180,220,255], mouth: [140,190,230],
    accent: [80,130,180], label: [120,170,210], status: 'idle', emoji: '\u00b7',
  },
  thinking: {
    border: [170,110,220], eye: [210,180,255], mouth: [160,120,200],
    accent: [200,140,255], label: [180,130,230], status: 'thinking', emoji: '\u25c6',
  },
  coding: {
    border: [70,190,110], eye: [150,240,180], mouth: [100,200,140],
    accent: [90,210,130], label: [80,200,120], status: 'writing code', emoji: '\u25aa',
  },
  reading: {
    border: [100,180,180], eye: [160,220,220], mouth: [120,190,190],
    accent: [80,200,200], label: [110,190,190], status: 'reading', emoji: '\u25cb',
  },
  searching: {
    border: [210,190,70], eye: [250,240,150], mouth: [200,180,90],
    accent: [230,210,100], label: [220,200,80], status: 'searching', emoji: '\u25c7',
  },
  executing: {
    border: [210,150,70], eye: [250,210,150], mouth: [200,160,100],
    accent: [230,170,90], label: [220,160,80], status: 'running command', emoji: '\u25b8',
  },
  happy: {
    border: [220,200,60], eye: [255,250,150], mouth: [230,210,90],
    accent: [255,240,100], label: [240,220,80], status: 'done!', emoji: '\u2726',
  },
  satisfied: {
    border: [90,180,150], eye: [150,220,200], mouth: [120,200,170],
    accent: [110,200,180], label: [100,190,160], status: 'satisfied', emoji: '\u2218',
  },
  proud: {
    border: [130,200,80], eye: [190,240,140], mouth: [150,210,100],
    accent: [170,230,110], label: [150,220,90], status: 'proud', emoji: '\u25b8',
  },
  relieved: {
    border: [190,170,110], eye: [230,220,170], mouth: [210,190,140],
    accent: [220,200,140], label: [200,190,130], status: 'relieved', emoji: '\u25cb',
  },
  error: {
    border: [210,70,70], eye: [255,150,150], mouth: [200,100,100],
    accent: [230,90,90], label: [220,90,90], status: 'hit a snag', emoji: '\u00d7',
  },
  sleeping: {
    border: [80,70,140], eye: [110,100,170], mouth: [90,80,150],
    accent: [160,140,210], label: [150,140,210], status: 'sleeping', emoji: 'z',
  },
  waiting: {
    border: [150,140,180], eye: [190,180,220], mouth: [160,150,190],
    accent: [180,170,210], label: [160,150,190], status: 'waiting', emoji: '?',
  },
  testing: {
    border: [180,200,70], eye: [220,240,130], mouth: [190,210,100],
    accent: [200,220,90], label: [190,210,80], status: 'running tests', emoji: '\u29eb',
  },
  installing: {
    border: [70,160,190], eye: [130,200,230], mouth: [100,170,200],
    accent: [90,180,210], label: [80,170,200], status: 'installing', emoji: '\u25bc',
  },
  caffeinated: {
    border: [255,180,50], eye: [255,220,100], mouth: [240,190,70],
    accent: [255,200,80], label: [250,190,60], status: 'hyperdrive!', emoji: '\u25c9',
  },
  subagent: {
    border: [150,100,210], eye: [190,160,240], mouth: [140,110,200],
    accent: [180,130,230], label: [160,120,220], status: 'spawning', emoji: '\u25c8',
  },
};

// -- Timeline colors -----------------------------------------------
const TIMELINE_COLORS = {
  idle:        [60, 70, 80],
  thinking:    [140, 90, 180],
  coding:      [60, 160, 90],
  reading:     [80, 150, 150],
  searching:   [180, 160, 50],
  executing:   [180, 130, 50],
  happy:       [190, 170, 40],
  satisfied:   [90, 180, 150],
  proud:       [130, 200, 80],
  relieved:    [190, 170, 110],
  error:       [190, 50, 50],
  sleeping:    [65, 55, 115],
  waiting:     [120, 110, 150],
  testing:     [150, 170, 50],
  installing:  [50, 130, 160],
  caffeinated: [220, 150, 30],
  subagent:    [120, 80, 180],
};

// -- Sparkline blocks (activity density) ---------------------------
const SPARKLINE_BLOCKS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587';

// -- Completion linger times ---------------------------------------
const COMPLETION_LINGER = {
  happy: 8000,
  proud: 7000,
  satisfied: 5500,
  relieved: 6000,
};

// -- Thought bubbles -----------------------------------------------
const IDLE_THOUGHTS = [
  'thinking about types',
  'contemplating recursion',
  'wondering about edge cases',
  'refactoring dreams',
  'pondering abstractions',
  'imagining clean code',
  'considering the void',
  'counting semicolons',
  'mapping dependencies',
  'tracing call stacks',
  'optimizing nothing',
  'cataloguing lint warnings',
];
const THINKING_THOUGHTS = [
  'hmm...', 'what if...', 'let me think...',
  'almost there...', 'connecting dots', 'following a thread',
  'one sec...', 'untangling this',
];
const COMPLETION_THOUGHTS = [
  'nice', 'good', 'clean', 'got it', 'smooth',
  'okay', 'that worked', 'moving on', 'next...',
];

// Per-state reactive thoughts -- personality, not status
const STATE_THOUGHTS = {
  coding: [
    'refactoring this...', 'let me fix this', 'almost there...',
    'one more edit', 'cleaning this up', 'this should work',
    'restructuring...', 'tweaking...', 'here we go',
  ],
  reading: [
    'let me see...', 'hmm interesting', 'checking this out',
    'scanning through', 'ah I see...', 'okay okay...',
    'taking notes...', 'absorbing this',
  ],
  searching: [
    'where is it...', 'gotta be somewhere', 'looking around...',
    'digging through', 'hunting...', 'let me find this',
    'scanning...', 'it must be here',
  ],
  executing: [
    'let\'s see...', 'running this...', 'here goes...',
    'fingers crossed', 'moment of truth', 'let me try this',
  ],
  testing: [
    'please pass...', 'moment of truth', 'sweating a bit',
    'come on...', 'hope this works', 'deep breath...',
  ],
  installing: [
    'downloading...', 'pulling deps', 'this might take a sec',
    'loading up...', 'grabbing packages', 'patience...',
  ],
  subagent: [
    'delegating this', 'sending a helper', 'teamwork...',
    'splitting the work', 'parallel vibes', 'tag team',
  ],
  error: [
    'ugh', 'wait what', 'hmm not right',
    'okay let me think', 'well that broke', 'debugging time',
  ],
};

// -- Palettes --------------------------------------------------------
// Each palette: { name, themes (17 states), timelineColors (17 states) }
// status/emoji are semantic (same across all palettes), only colors change.

function _buildPaletteThemes(colorMap) {
  const result = {};
  for (const state of Object.keys(themes)) {
    const c = colorMap[state];
    result[state] = {
      border: c[0], eye: c[1], mouth: c[2], accent: c[3], label: c[4],
      status: themes[state].status, emoji: themes[state].emoji,
    };
  }
  return result;
}

const PALETTES = [
  // 0: Default (existing colors)
  { name: 'default', themes, timelineColors: TIMELINE_COLORS },

  // 1: Neon (high saturation cyans/magentas/limes)
  {
    name: 'neon',
    themes: _buildPaletteThemes({
      idle:        [[0,180,255],[100,220,255],[50,200,255],[0,160,240],[60,200,255]],
      thinking:    [[255,0,200],[255,100,230],[230,50,200],[255,60,220],[255,80,220]],
      coding:      [[0,255,100],[100,255,170],[50,240,120],[30,255,130],[40,255,110]],
      reading:     [[0,240,220],[80,255,240],[40,240,220],[0,230,210],[50,240,225]],
      searching:   [[255,255,0],[255,255,120],[240,240,50],[255,255,60],[255,250,40]],
      executing:   [[255,160,0],[255,200,80],[240,170,40],[255,180,30],[255,170,20]],
      happy:       [[200,255,0],[230,255,80],[210,255,40],[220,255,50],[210,255,30]],
      satisfied:   [[0,255,180],[80,255,210],[40,240,190],[50,255,200],[40,250,185]],
      proud:       [[100,255,0],[160,255,80],[130,245,50],[140,255,60],[120,255,40]],
      relieved:    [[180,255,100],[210,255,160],[190,245,130],[200,255,140],[190,255,120]],
      error:       [[255,0,60],[255,80,120],[240,40,80],[255,50,90],[255,60,80]],
      sleeping:    [[50,40,210],[90,80,240],[70,60,220],[150,130,255],[130,110,255]],
      waiting:     [[180,100,255],[210,150,255],[190,120,240],[200,130,255],[190,120,250]],
      testing:     [[180,255,0],[210,255,60],[190,245,30],[200,255,40],[190,250,20]],
      installing:  [[0,200,255],[60,220,255],[30,210,250],[40,210,255],[20,200,250]],
      caffeinated: [[255,220,0],[255,240,60],[250,230,30],[255,235,40],[255,225,20]],
      subagent:    [[180,0,255],[210,80,255],[190,50,240],[200,60,255],[190,40,250]],
    }),
    timelineColors: {
      idle:        [0,120,180],   thinking:  [200,0,160],
      coding:      [0,200,80],    reading:   [0,190,175],
      searching:   [200,200,0],   executing: [200,130,0],
      happy:       [160,200,0],   satisfied: [0,200,145],
      proud:       [80,200,0],    relieved:  [145,200,80],
      error:       [200,0,45],    sleeping:  [40,30,170],
      waiting:     [145,80,200],  testing:   [145,200,0],
      installing:  [0,160,200],   caffeinated:[200,175,0],
      subagent:    [145,0,200],
    },
  },

  // 2: Pastel (soft pinks/lavenders/mints)
  {
    name: 'pastel',
    themes: _buildPaletteThemes({
      idle:        [[160,190,220],[190,210,235],[170,195,225],[150,180,210],[165,192,218]],
      thinking:    [[200,170,220],[220,195,235],[210,180,225],[210,180,230],[205,175,225]],
      coding:      [[150,210,170],[180,225,195],[165,215,180],[160,215,180],[155,212,175]],
      reading:     [[170,210,210],[195,225,225],[180,215,215],[175,215,215],[175,212,212]],
      searching:   [[220,210,150],[235,230,180],[225,215,165],[225,215,165],[222,212,158]],
      executing:   [[220,190,150],[235,210,180],[225,200,165],[225,200,165],[222,195,158]],
      happy:       [[230,220,140],[240,235,175],[235,225,160],[235,225,160],[232,222,155]],
      satisfied:   [[160,210,195],[190,225,215],[175,215,205],[175,215,205],[170,212,200]],
      proud:       [[175,215,160],[200,230,185],[185,220,175],[185,220,175],[180,218,168]],
      relieved:    [[210,200,170],[225,220,195],[215,210,180],[215,210,180],[212,205,175]],
      error:       [[220,150,160],[235,180,188],[225,165,175],[225,165,175],[222,158,168]],
      sleeping:    [[155,150,195],[175,170,210],[165,160,200],[180,175,220],[175,170,215]],
      waiting:     [[190,185,210],[210,208,225],[200,195,218],[200,195,218],[195,192,215]],
      testing:     [[200,215,150],[220,230,180],[210,222,165],[210,222,165],[205,218,158]],
      installing:  [[150,195,210],[180,215,225],[165,205,218],[165,205,218],[158,200,215]],
      caffeinated: [[230,210,150],[240,225,180],[235,218,165],[235,218,165],[232,215,158]],
      subagent:    [[190,170,215],[210,195,230],[200,182,222],[200,182,222],[195,178,218]],
    }),
    timelineColors: {
      idle:        [130,155,185], thinking:  [165,140,185],
      coding:      [120,175,140], reading:   [140,175,175],
      searching:   [185,175,120], executing: [185,155,120],
      happy:       [195,185,110], satisfied: [130,175,160],
      proud:       [145,180,130], relieved:  [175,165,140],
      error:       [185,120,130], sleeping:  [125,120,165],
      waiting:     [155,150,175], testing:   [165,180,120],
      installing:  [120,160,175], caffeinated:[195,175,120],
      subagent:    [155,140,180],
    },
  },

  // 3: Monochrome (greyscale, R=G=B)
  {
    name: 'mono',
    themes: _buildPaletteThemes({
      idle:        [[140,140,140],[190,190,190],[160,160,160],[120,120,120],[150,150,150]],
      thinking:    [[170,170,170],[210,210,210],[180,180,180],[190,190,190],[175,175,175]],
      coding:      [[160,160,160],[210,210,210],[180,180,180],[170,170,170],[165,165,165]],
      reading:     [[150,150,150],[195,195,195],[165,165,165],[155,155,155],[155,155,155]],
      searching:   [[180,180,180],[220,220,220],[195,195,195],[190,190,190],[185,185,185]],
      executing:   [[175,175,175],[215,215,215],[190,190,190],[185,185,185],[180,180,180]],
      happy:       [[200,200,200],[240,240,240],[215,215,215],[220,220,220],[205,205,205]],
      satisfied:   [[155,155,155],[200,200,200],[175,175,175],[165,165,165],[160,160,160]],
      proud:       [[170,170,170],[215,215,215],[190,190,190],[185,185,185],[175,175,175]],
      relieved:    [[160,160,160],[205,205,205],[180,180,180],[175,175,175],[165,165,165]],
      error:       [[220,220,220],[250,250,250],[230,230,230],[235,235,235],[225,225,225]],
      sleeping:    [[85,85,85],[110,110,110],[95,95,95],[145,145,145],[135,135,135]],
      waiting:     [[130,130,130],[170,170,170],[145,145,145],[150,150,150],[135,135,135]],
      testing:     [[175,175,175],[215,215,215],[190,190,190],[185,185,185],[180,180,180]],
      installing:  [[145,145,145],[190,190,190],[160,160,160],[155,155,155],[150,150,150]],
      caffeinated: [[210,210,210],[245,245,245],[225,225,225],[230,230,230],[215,215,215]],
      subagent:    [[165,165,165],[205,205,205],[180,180,180],[175,175,175],[170,170,170]],
    }),
    timelineColors: {
      idle:        [100,100,100], thinking:  [140,140,140],
      coding:      [130,130,130], reading:   [120,120,120],
      searching:   [150,150,150], executing: [145,145,145],
      happy:       [170,170,170], satisfied: [125,125,125],
      proud:       [140,140,140], relieved:  [130,130,130],
      error:       [190,190,190], sleeping:  [70,70,70],
      waiting:     [100,100,100], testing:   [145,145,145],
      installing:  [115,115,115], caffeinated:[180,180,180],
      subagent:    [135,135,135],
    },
  },

  // 4: Sunset (warm oranges/reds/golds/purples)
  {
    name: 'sunset',
    themes: _buildPaletteThemes({
      idle:        [[200,130,60],[230,170,100],[210,150,80],[180,120,50],[210,140,70]],
      thinking:    [[150,70,160],[190,120,200],[160,90,170],[170,90,180],[160,80,170]],
      coding:      [[210,170,40],[240,200,90],[220,180,60],[220,180,50],[215,175,45]],
      reading:     [[190,120,80],[220,160,120],[200,140,100],[200,130,90],[195,125,85]],
      searching:   [[240,190,40],[255,220,90],[245,200,60],[245,200,60],[242,195,50]],
      executing:   [[230,120,40],[250,170,90],[240,140,60],[240,140,50],[235,130,45]],
      happy:       [[250,200,50],[255,230,100],[250,210,70],[255,220,80],[252,205,55]],
      satisfied:   [[180,130,100],[210,170,140],[190,150,120],[190,140,110],[185,135,105]],
      proud:       [[220,160,50],[245,200,100],[230,175,70],[230,175,65],[225,165,55]],
      relieved:    [[200,150,90],[230,190,140],[210,165,110],[210,160,100],[205,155,95]],
      error:       [[200,40,40],[240,90,90],[210,60,60],[220,50,50],[210,50,50]],
      sleeping:    [[100,60,130],[130,90,160],[110,70,140],[165,125,190],[155,115,180]],
      waiting:     [[170,120,150],[200,160,185],[180,135,165],[185,135,165],[175,125,155]],
      testing:     [[210,180,50],[235,210,100],[220,190,70],[220,190,60],[215,185,55]],
      installing:  [[170,100,130],[200,140,170],[180,115,145],[180,110,140],[175,105,135]],
      caffeinated: [[255,160,30],[255,200,80],[250,180,50],[255,180,50],[252,170,35]],
      subagent:    [[160,80,180],[200,130,215],[175,100,195],[180,100,200],[165,85,185]],
    }),
    timelineColors: {
      idle:        [170,100,40],  thinking:  [120,50,130],
      coding:      [175,140,25],  reading:   [155,95,60],
      searching:   [200,155,25],  executing: [190,95,25],
      happy:       [210,165,30],  satisfied: [150,105,80],
      proud:       [185,130,30],  relieved:  [170,120,70],
      error:       [170,25,25],   sleeping:  [85,50,105],
      waiting:     [140,95,120],  testing:   [175,150,30],
      installing:  [140,80,105],  caffeinated:[215,130,15],
      subagent:    [130,60,150],
    },
  },
];

const PALETTE_NAMES = PALETTES.map(p => p.name);

module.exports = {
  ansi,
  BREATH_PERIOD,
  lerpColor,
  dimColor,
  breathe,
  themes,
  TIMELINE_COLORS,
  SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS,
  THINKING_THOUGHTS,
  COMPLETION_THOUGHTS,
  STATE_THOUGHTS,
  PALETTES,
  PALETTE_NAMES,
};
