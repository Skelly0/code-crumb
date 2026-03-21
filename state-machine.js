'use strict';

// +================================================================+
// |  State Machine -- pure logic for Code Crumb state management         |
// |  Extracted for testability. No I/O, no side effects.            |
// |                                                                  |
// |  Handles:                                                        |
// |    - Tool name → face state mapping (multi-editor)              |
// |    - Forensic error detection (50+ regex patterns)               |
// |    - Post-tool result classification                             |
// |    - Streak tracking and milestone detection                     |
// |                                                                  |
// |  Supported editors:                                              |
// |    - Claude Code (edit, bash, grep, glob, read, task, etc.)     |
// |    - OpenAI Codex CLI (shell, apply_diff, apply_patch, etc.)    |
// |    - OpenCode (file_edit, terminal, search_files, etc.)         |
// |    - OpenClaw/Pi (read, write, edit, bash, exec, process, etc.) |
// +================================================================+

const path = require('path');

// -- Tool-to-State Mapping -------------------------------------------

// Tool name patterns per category — covers Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi
const EDIT_TOOLS = /^(edit|multiedit|write|str_replace|create_file|file_edit|write_file|create_file_with_contents|apply_diff|apply_patch|code_edit|insert_text|replace_text|patch)$/i;
const BASH_TOOLS = /^(bash|shell|terminal|execute|run_command|run|exec|process|sh|cmd|powershell|command|cli)$/i;
const READ_TOOLS = /^(read|view|cat|file_read|read_file|get_file_contents|open_file)$/i;
const SEARCH_TOOLS = /^(grep|glob|search|ripgrep|find|list|search_files|list_files|list_dir|find_files|file_search|codebase_search)$/i;
const WEB_TOOLS = /^(web_search|websearch|web_fetch|fetch|webfetch|browser|browse|http_request|curl|canvas)$/i;
const SUBAGENT_TOOLS = /^(task|agent|subagent|spawn_agent|delegate|codex_agent|sessions)$/i;
const REVIEW_TOOLS = /^(diff|review|compare|patch)$/i;

function toolToState(toolName, toolInput) {
  let result;

  // Writing/editing code
  if (EDIT_TOOLS.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    result = { state: 'coding', detail: shortPath ? `editing ${shortPath}` : 'writing code' };
  }

  // Running commands
  else if (BASH_TOOLS.test(toolName)) {
    const cmd = toolInput?.command || toolInput?.cmd || toolInput?.input || '';
    const shortCmd = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;

    // Detect test commands
    if (/\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|\.spec\.)\b/i.test(cmd) ||
        /\b(npm|yarn|pnpm|bun|go|cargo|dotnet)\s+(run\s+)?(test|tests)\b/i.test(cmd) ||
        /\b(rake|npx|composer)\s+test\b/i.test(cmd) ||
        /\b(pytest|nosetests)\b/i.test(cmd) ||
        /\bnode\s+(--test|test)\b/i.test(cmd) ||
        /\b(make|gradle|mvn|php\s+artisan)\s+test\b/i.test(cmd)) {
      result = { state: 'testing', detail: shortCmd || 'running tests' };
    }

    // Detect install commands
    else if (/\b(npm|yarn|pnpm|bun)\s+(install|i|add)\b/i.test(cmd) ||
        /\b(pip|pip3)\s+(install|-r)\b/i.test(cmd) ||
        /\b(cargo\s+build|cargo\s+add)\b/i.test(cmd) ||
        /\b(apt|apt-get|apk)\s+(install|add)\b/i.test(cmd) ||
        /\b(brew\s+install|homebrew)\b/i.test(cmd) ||
        /\b(go\s+get|go\s+install)\b/i.test(cmd) ||
        /\b(composer\s+require|composer\s+install)\b/i.test(cmd) ||
        /\b(dotnet\s+add|dotnet\s+restore)\b/i.test(cmd)) {
      result = { state: 'installing', detail: shortCmd || 'installing' };
    }

    // Detect ML training commands (must come after install detection)
    else if (/\b(python|python3|torchrun|deepspeed|accelerate)\b.*\btrain\b/i.test(cmd) ||
        /\bunsloth\b/i.test(cmd) ||
        /\b(python|python3)\b.*\b(fine.?tune|finetune)\b/i.test(cmd) ||
        /\b(python|python3)\b.*(--epochs?|--learning.?rate|--lr)\b/i.test(cmd) ||
        /\bnohup\b.*\btrain\b/i.test(cmd)) {
      result = { state: 'training', detail: shortCmd || 'training model' };
    }

    // Detect git commit / push / tag operations
    else if (/\bgit\s+(commit|push|tag)\b/i.test(cmd)) {
      const isPush = /\bgit\s+push\b/i.test(cmd);
      const isTag  = /\bgit\s+tag\b/i.test(cmd);
      const detail = isPush ? 'pushing to remote' : isTag ? 'tagging release' : 'committing changes';
      result = { state: 'committing', detail: shortCmd || detail };
    }

    else {
      result = { state: 'executing', detail: shortCmd || 'running command' };
    }
  }

  // Reviewing / diffing code
  else if (REVIEW_TOOLS.test(toolName)) {
    result = { state: 'reviewing', detail: toolName || 'reviewing' };
  }

  // Reading files
  else if (READ_TOOLS.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    result = { state: 'reading', detail: shortPath ? `reading ${shortPath}` : 'reading' };
  }

  // Searching
  else if (SEARCH_TOOLS.test(toolName)) {
    const pattern = toolInput?.pattern || toolInput?.query || toolInput?.search_term || '';
    result = { state: 'searching', detail: pattern ? `looking for "${pattern}"` : 'searching' };
  }

  // Web/fetch
  else if (WEB_TOOLS.test(toolName)) {
    const query = toolInput?.query || toolInput?.url || '';
    const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
    result = { state: 'searching', detail: shortQuery ? `searching "${shortQuery}"` : 'searching the web' };
  }

  // Task/subagent
  else if (SUBAGENT_TOOLS.test(toolName)) {
    const desc = toolInput?.description || toolInput?.prompt || '';
    const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
    result = { state: 'subagent', detail: shortDesc || 'spawning subagent' };
  }

  // MCP tools
  else if (/^mcp__/.test(toolName)) {
    const parts = toolName.split('__');
    const server = parts[1] || 'external';
    const tool = parts[2] || '';
    result = { state: 'executing', detail: `${server}: ${tool}` };
  }

  // Default
  else {
    result = { state: 'thinking', detail: toolName || '' };
  }

  // Strip ANSI escape sequences from detail before returning
  if (result.detail) {
    result.detail = stripAnsi(result.detail).replace(/[\r\n]+/g, ' ');
  }
  return result;
}

// -- Error Detection -------------------------------------------------

// Signature patterns that scream "something broke" in stdout
const stdoutErrorPatterns = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\bsegmentation fault\b/i,
  /\bsyntax error\b/i,
  /\bENOENT\b/,
  /\bENOTDIR\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bFATAL\b/,
  /\bPANIC\b/i,
  /\bUnhandledPromiseRejection\b/,
  /\bTraceback \(most recent call last\)/,        // Python
  /\bat Object\.<anonymous>.*\n\s+at /,           // Node stack trace
  /\bCannot find module\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bCompilation failed\b/i,
  /\bbuild failed\b/i,
  /\btest(s)? failed\b/i,
  /\d+\s+fail(ed|ing)\b/i,                          // "3 failed" (jest/pytest/code-crumb), "3 failing" (mocha)
  /^FAIL\b/m,                                        // Go test output
  /# fail [1-9]\d*/i,                                  // node --test TAP format (excludes "# fail 0")
  /\bfailed with exit code\b/i,
  /\bnpm ERR!/,
  /\bcargo error\b/i,
  /\brustc.*error\[E\d+\]/,                       // Rust compiler errors
  /\bCONFLICT\s+\(.*?\):/,                         // git merge conflicts (requires git format)
  /\bAutomatic merge failed\b/i,
  /\bfix conflicts and then commit\b/i,
];

// Patterns in stderr that actually mean trouble (not just warnings)
const stderrErrorPatterns = [
  /\berror\b/i,
  /\bfatal\b/i,
  /\bfailed\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bsegmentation fault\b/i,
  /\bpanic\b/i,
];

// False positive guards: these look scary but aren't
const falsePositives = [
  /0 errors?\b/i,
  /no errors?\b/i,
  /errors?:\s*0\b/i,
  /error handling/i,
  /error\.js/i,                                     // Just a filename
  /stderr/i,                                        // Talking about stderr
  /\.error\s*[=(]/,                                 // Property/method named error
  /error_count.*0/i,
  /warning/i,                                       // warnings aren't errors
  /no conflicts?\b/i,                               // "no conflicts" isn't a conflict
  /Merge made by/i,                                 // git merge success ("Merge made by recursive strategy")
  /Already up.to.date/i,                            // git pull/merge when nothing to do
  /conflicts? resolved/i,                           // past-tense resolution, not an active failure
  /\b0\s+fail(ed|ing)\b/i,                          // "0 failed" / "0 failing" is success
];

// Strip ANSI escape sequences (SGR colors/bold/underline, CSI controls, OSC hyperlinks/titles)
// so regex patterns match through styled output and detail strings are clean for rendering.
function stripAnsi(text) {
  return text ? text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '') : '';
}

function looksLikeError(text, patterns) {
  if (!text) return false;
  const clean = stripAnsi(text);
  const hit = patterns.some(p => p.test(clean));
  if (!hit) return false;
  // Check it's not a false positive
  if (!falsePositives.some(p => p.test(clean))) return true;
  // (a) If "warning" triggered the false positive, check if explicit error keywords
  // also appear (mixed warning+error output like "2 warnings, 1 error" should detect)
  if (/warning/i.test(clean) && /\berrors?\b/i.test(clean)
      && !/0 errors?\b/i.test(clean) && !/no errors?\b/i.test(clean) && !/errors?:\s*0\b/i.test(clean)) {
    return true;
  }
  // (b) Error pattern matches a line that doesn't contain "warning" --
  // isolates e.g. "DeprecationWarning" (line A) from "tests failed" (line B)
  if (/warning/i.test(clean)) {
    const lines = clean.split('\n');
    for (const line of lines) {
      if (/warning/i.test(line)) continue;
      if (patterns.some(p => p.test(line))) return true;
    }
  }
  return false;
}

// Try to extract an exit code from stdout -- Claude Code often
// appends "Exit code: N" to the output even though it doesn't
// give us exit_code as a field.
function extractExitCode(stdout) {
  const clean = stripAnsi(stdout);
  const match = clean.match(/(?:exit code|exited with|exit status|returned)[:=\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

// Friendly error detail based on what we found
function errorDetail(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  if (isMergeConflict(stdout, stderr)) return 'merge conflict!';
  if (/command not found/i.test(combined)) return 'command not found';
  if (/permission denied/i.test(combined)) return 'permission denied';
  if (/no such file or directory/i.test(combined)) return 'file not found';
  if (/segmentation fault/i.test(combined)) return 'segfault!';
  if (/ENOENT/.test(combined)) return 'missing file/path';
  if (/syntax error/i.test(combined)) return 'syntax error';
  if (/Cannot find module|ModuleNotFound/i.test(combined)) return 'missing module';
  if (/Traceback|at Object\.<anonymous>|Error:/.test(combined)) return 'exception thrown';
  if (/Compilation failed|build failed/i.test(combined)) return 'build broke';
  if (/test(s)? failed|\d+\s+fail(ed|ing)|^FAIL\b|# fail [1-9]/im.test(combined)) return 'tests failed';
  if (/npm ERR!/i.test(combined)) return 'npm error';
  return 'something went wrong';
}

// -- Tool Response Normalization --------------------------------------

// Claude Code sends tool output as `tool_result` (string or object).
// Other editors may use `tool_response` with {stdout, stderr}.
// This normalizes both into a consistent {stdout, stderr} object.
function normalizeToolResponse(data) {
  const rawResult = data.tool_result || data.tool_response || {};
  if (typeof rawResult === 'string') return { stdout: rawResult, stderr: '' };
  if (Array.isArray(rawResult)) {
    // Content block array: [{type:"text", text:"..."}]
    const text = rawResult
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
    return { stdout: text, stderr: '' };
  }
  return { stdout: rawResult.stdout || '', stderr: rawResult.stderr || '' };
}

// -- Post-Tool Classification ----------------------------------------

// Detect git merge conflicts in command output
function isMergeConflict(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  return /\bCONFLICT\s+\(.*\):/.test(combined) ||
         /\bAutomatic merge failed\b/i.test(combined) ||
         /\bfix conflicts and then commit\b/i.test(combined);
}

// Encapsulates the full PostToolUse decision tree.
// Returns { state, detail, diffInfo }
function classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag) {
  const stdout = toolResponse?.stdout || '';
  const stderr = toolResponse?.stderr || '';
  const isError = isErrorFlag || toolResponse?.isError || false;
  const inferredExit = extractExitCode(stdout);

  let state, detail;
  let diffInfo = null;

  // Decision tree -- in order of confidence
  if (isError) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (toolResponse?.interrupted) {
    state = 'error';
    detail = 'interrupted';
  } else if (inferredExit !== null && inferredExit !== 0) {
    state = 'error'; detail = errorDetail(stdout, stderr) || `exit ${inferredExit}`;
  } else if (!READ_TOOLS.test(toolName) && !SEARCH_TOOLS.test(toolName) && !WEB_TOOLS.test(toolName) && looksLikeError(stderr, stderrErrorPatterns)) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (BASH_TOOLS.test(toolName) && looksLikeError(stdout, stdoutErrorPatterns)) {
    // Only check stdout patterns for shell commands -- other tools have structured output
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (EDIT_TOOLS.test(toolName)) {
    state = 'proud';
    const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    detail = fp ? `saved ${path.basename(fp)}` : 'code written';
    // Calculate diff info for thought bubbles
    const oldStr = toolInput?.old_string || toolInput?.old_str || '';
    const newStr = toolInput?.new_string || toolInput?.new_str || toolInput?.content || '';
    if (oldStr || newStr) {
      const removed = oldStr ? oldStr.split('\n').length : 0;
      const added = newStr ? newStr.split('\n').length : 0;
      diffInfo = { added, removed };
    }
  } else if (READ_TOOLS.test(toolName)) {
    state = 'satisfied';
    const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    detail = fp ? `read ${path.basename(fp)}` : 'got it';
  } else if (SEARCH_TOOLS.test(toolName)) {
    state = 'satisfied';
    const pattern = toolInput?.pattern || toolInput?.query || toolInput?.search_term || '';
    detail = pattern ? `found "${pattern.length > 20 ? pattern.slice(0, 17) + '...' : pattern}"` : 'got it';
  } else if (WEB_TOOLS.test(toolName)) {
    state = 'satisfied';
    detail = 'search complete';
  } else if (BASH_TOOLS.test(toolName)) {
    state = 'relieved';
    const cmd = toolInput?.command || toolInput?.cmd || toolInput?.input || '';
    const isTest = /\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|spec)\b/i.test(cmd) ||
                   /\bnpm\s+(run\s+)?test\b/i.test(cmd) ||
                   /\bnode\s+(--test|test)\b/i.test(cmd) ||
                   /\b(make|gradle|mvn|php\s+artisan)\s+test\b/i.test(cmd);
    const isBuild = /\b(build|compile|tsc|webpack|vite|esbuild|rollup|make)\b/i.test(cmd);
    const isGit = /\bgit\s/i.test(cmd);
    const isInstall = /\b(npm\s+install|yarn|pip\s+install|cargo\s+build|pnpm|bun\s+(add|install))\b/i.test(cmd);

    if (isTest) {
      // Try to pull test count from stdout
      const cleanStdout = stripAnsi(stdout);
      const testCount = cleanStdout.match(/(\d+)\s+(?:tests?|specs?)\s+passed/i)
                       || cleanStdout.match(/(\d+)\s+passing/i);
      detail = testCount ? `${testCount[1]} tests passed` : 'tests passed';
    } else if (isBuild) {
      detail = 'build succeeded';
    } else if (isGit) {
      if (isMergeConflict(stdout, stderr)) {
        state = 'error';
        detail = 'merge conflict!';
      } else if (/\bgit\s+push\b/i.test(cmd)) {
        state = 'proud';
        detail = 'pushed!';
      } else if (/\bgit\s+commit\b/i.test(cmd)) {
        state = 'proud';
        detail = 'committed';
      } else if (/\bgit\s+(merge|pull|rebase)\b/i.test(cmd)) {
        state = 'satisfied';
        detail = 'merged clean';
      } else {
        detail = 'git done';
      }
    } else if (isInstall) {
      detail = 'installed';
    } else {
      detail = 'command succeeded';
    }
  } else {
    state = 'satisfied';
    detail = 'step complete';
  }

  // Strip ANSI escape sequences from detail before returning
  if (detail) detail = stripAnsi(detail).replace(/[\r\n]+/g, ' ');
  return { state, detail, diffInfo };
}

// -- Truncated Input Classification -----------------------------------

// When stdin exceeds MAX_INPUT (1MB), the full JSON can't be parsed.
// This function extracts what it can from the raw (truncated) text to
// avoid silently swallowing errors.  Returns { state, detail }.
function classifyTruncatedInput(hookEvent, rawInput) {
  // PostToolUseFailure is always an error
  if (hookEvent === 'PostToolUseFailure') {
    return { state: 'error', detail: 'tool failed' };
  }
  // PostToolUse -- attempt forensic error detection from truncated data.
  // Also runs when hookEvent is empty (adapter path) so exit codes and
  // isError flags are still detected even without event type info.
  if (hookEvent === 'PostToolUse' || !hookEvent) {
    // Tier 1: isError flag (appears early in JSON, before large stdout)
    if (/"isError"\s*:\s*true/.test(rawInput)) {
      return { state: 'error', detail: errorDetail(rawInput, '') || 'something went wrong' };
    }
    // Tier 2: exit code embedded in stdout
    const exitCode = extractExitCode(rawInput);
    if (exitCode !== null && exitCode !== 0) {
      return { state: 'error', detail: errorDetail(rawInput, '') || `exit ${exitCode}` };
    }
    // Tier 3: stdout error patterns for Bash tools
    const toolMatch = rawInput.match(/"tool_name"\s*:\s*"([^"]+)"/);
    const toolName = toolMatch ? toolMatch[1] : '';
    if (BASH_TOOLS.test(toolName) && looksLikeError(rawInput, stdoutErrorPatterns)) {
      return { state: 'error', detail: errorDetail(rawInput, '') || 'something went wrong' };
    }
    // No error detected in the captured data -- fall through to default
  }

  // Non-PostToolUse events -- map to correct face states
  const eventMap = {
    Stop:               { state: 'responding', detail: 'wrapping up' },
    SessionEnd:         { state: 'responding', detail: 'session ending' },
    Notification:       { state: 'waiting',    detail: 'needs attention' },
    SessionStart:       { state: 'idle',       detail: 'session starting' },
    SubagentStart:      { state: 'subagent',   detail: 'spawning subagent' },
    SubagentStop:       { state: 'happy',      detail: 'subagent done' },
    StopFailure:        { state: 'error',      detail: 'API error' },
    PreCompact:         { state: 'thinking',   detail: 'compacting memory' },
    PostCompact:        { state: 'satisfied',  detail: 'memory compacted' },
    PermissionRequest:  { state: 'waiting',    detail: 'needs permission' },
    Setup:              { state: 'starting',   detail: 'setting up' },
    Elicitation:        { state: 'waiting',    detail: 'needs input' },
    ElicitationResult:  { state: 'satisfied',  detail: 'input received' },
    ConfigChange:       { state: 'reading',    detail: 'config updated' },
    InstructionsLoaded: { state: 'reading',    detail: 'loading instructions' },
  };
  return eventMap[hookEvent] || { state: 'thinking', detail: 'large input' };
}

// -- Streak Management -----------------------------------------------

const MILESTONES = [10, 25, 50, 100, 200, 500];

// Mutates and returns stats. Call after classifyToolResult.
function updateStreak(stats, isError) {
  if (isError) {
    stats.brokenStreak = stats.streak || 0;
    stats.brokenStreakAt = Date.now();
    stats.streak = 0;
    stats.totalErrors = (stats.totalErrors || 0) + 1;
  } else {
    stats.streak = (stats.streak || 0) + 1;
    if (stats.streak > (stats.bestStreak || 0)) {
      stats.bestStreak = stats.streak;
    }
    if (MILESTONES.includes(stats.streak)) {
      stats.recentMilestone = { type: 'streak', value: stats.streak, at: Date.now() };
    }
  }
  return stats;
}

// -- Frequent Files Management ----------------------------------------

const MAX_FREQUENT_FILES = 50;

// Prunes the frequentFiles map in-place to stay within bounds.
// Only acts when the map exceeds MAX_FREQUENT_FILES entries.
// Filters out count < 2 (single-touch noise), then keeps the top N by count.
function pruneFrequentFiles(frequentFiles) {
  if (!frequentFiles) return frequentFiles;
  const keys = Object.keys(frequentFiles);
  if (keys.length <= MAX_FREQUENT_FILES) return frequentFiles;
  const sorted = keys
    .map(k => [k, frequentFiles[k]])
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_FILES);
  for (const k of keys) delete frequentFiles[k];
  for (const [k, v] of sorted) frequentFiles[k] = v;
  return frequentFiles;
}

// Returns a small subset of frequentFiles suitable for embedding in state files.
// Only includes entries with count >= 3 (the _getTopFile threshold), capped at 10.
function topFrequentFiles(frequentFiles, limit) {
  if (!frequentFiles) return {};
  const cap = limit || 10;
  const entries = Object.entries(frequentFiles)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap);
  const result = {};
  for (const [k, v] of entries) result[k] = v;
  return result;
}

// -- Default Stats ---------------------------------------------------

function defaultStats() {
  return {
    streak: 0, bestStreak: 0,
    brokenStreak: 0, brokenStreakAt: 0,
    totalToolCalls: 0, totalErrors: 0,
    records: { longestSession: 0, mostSubagents: 0, mostFilesEdited: 0 },
    session: { id: '', start: 0, toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0 },
    recentMilestone: null,
    daily: { date: '', sessionCount: 0, cumulativeMs: 0 },
    frequentFiles: {},
  };
}

// -- Subagent Session State (pure logic) ---------------------------------

// Build the state object for writing to a subagent's session file.
// Preserves sticky fields (modelName, taskDescription, cwd, gitBranch) from
// the existing session file, falling back to values from the sub entry.
function buildSubagentSessionState(existing, sub, parentSessionId, defaultCwd) {
  if (existing.stopped) return null;
  return {
    sessionId: sub.id,
    modelName: existing.modelName || sub.model || 'haiku',
    cwd: existing.cwd || defaultCwd || '',
    gitBranch: existing.gitBranch || '',
    parentSession: parentSessionId,
    taskDescription: existing.taskDescription || sub.taskDescription || sub.description,
  };
}

module.exports = {
  toolToState,
  EDIT_TOOLS,
  BASH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  WEB_TOOLS,
  SUBAGENT_TOOLS,
  REVIEW_TOOLS,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  isMergeConflict,
  looksLikeError,
  stripAnsi,
  errorDetail,
  extractExitCode,
  normalizeToolResponse,
  classifyToolResult,
  classifyTruncatedInput,
  MILESTONES,
  updateStreak,
  defaultStats,
  MAX_FREQUENT_FILES,
  pruneFrequentFiles,
  topFrequentFiles,
  buildSubagentSessionState,
};
