'use strict';

// +================================================================+
// |  State Machine -- pure logic for Code Crumb state management   |
// |  Extracted for testability. No I/O, no side effects.           |
// |                                                                |
// |  Handles:                                                      |
// |    - Tool name → face state mapping (multi-editor)             |
// |    - Forensic error detection (50+ regex patterns)             |
// |    - Post-tool result classification                           |
// |    - Streak tracking and milestone detection                   |
// |                                                                |
// |  Supported editors:                                            |
// |    - Claude Code (edit, bash, grep, glob, read, task, etc.)    |
// |    - OpenAI Codex CLI (shell, apply_diff, apply_patch, etc.)   |
// |    - OpenCode (file_edit, terminal, search_files, etc.)        |
// |    - OpenClaw/Pi (read, write, edit, bash, exec, process, etc.)|
// +================================================================+

const path = require('path');

// -- Tool-to-State Mapping -------------------------------------------

// Tool name patterns per category — covers Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi
const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|notebook_edit|str_replace|create_file|file_edit|write_file|create_file_with_contents|apply_diff|apply_patch|code_edit|insert_text|replace_text|patch)$/i;
const BASH_TOOLS = /^(bash|shell|terminal|execute|run_command|run|exec|process|sh|cmd|powershell|command|cli|killshell|bashoutput|enterworktree|exitworktree)$/i;
// Shell-management tools: no command text of their own, so details fall back to the humanized name
const SHELL_MGMT_TOOLS = /^(killshell|bashoutput|enterworktree|exitworktree)$/i;
const READ_TOOLS = /^(read|view|cat|file_read|read_file|get_file_contents|open_file|notebookread|readmcpresourcetool|readmcpresourcedirtool|listmcpresourcestool)$/i;
const SEARCH_TOOLS = /^(grep|glob|search|ripgrep|find|list|ls|toolsearch|search_files|list_files|list_dir|find_files|file_search|codebase_search)$/i;
const LIST_TOOLS = /^(ls|list|list_dir|list_files)$/i;
const WEB_TOOLS = /^(web_search|websearch|web_fetch|fetch|webfetch|browser|browse|http_request|curl|canvas)$/i;
const SUBAGENT_TOOLS = /^(task|agent|subagent|spawn_agent|delegate|codex_agent|sessions|workflow|sendmessage|listagents|taskoutput|taskstop|monitor)$/i;
// Subsets of SUBAGENT_TOOLS: ones whose completion means an agent finished, vs. ones that just check in
const AGENT_DONE_TOOLS = /^(task|agent|subagent|spawn_agent|delegate|codex_agent|workflow|taskoutput)$/i;
const AGENT_MONITOR_TOOLS = /^(taskoutput|taskstop|listagents|monitor)$/i;
const REVIEW_TOOLS = /^(diff|review|compare|reportfindings|code_review)$/i;
const ASK_TOOLS = /^(askuserquestion|ask_user|ask_user_question|request_user_input)$/i;
const SKILL_TOOLS = /^(skill|loadskill|load_skill)$/i;
const PLAN_TOOLS = /^(todowrite|todoread|enterplanmode|exitplanmode|croncreate|cronlist|crondelete|schedulewakeup)$/i;
const SCHEDULE_TOOLS = /^(croncreate|cronlist|crondelete|schedulewakeup)$/i;
const PUBLISH_TOOLS = /^(artifact|senduserfile)$/i;

// MCP tool verbs (mcp__<server>__<verb>_<rest>) — read-ish, search-ish, and write-ish prefixes
const MCP_READ_VERBS = /^(read|get|list|fetch|describe|inspect|check|show|view|download|export|whoami|debug)(_|$)/i;
const MCP_SEARCH_VERBS = /^(search|find|query|lookup)(_|$)/i;
const MCP_WRITE_VERBS = /^(create|update|write|modify|edit|insert|delete|remove|append|set|move|replace|format|batch|push|merge|upload|import|add|manage|resize|copy|draft)(_|$)/i;

// Coerce a tool_input field to text. Strings pass through, numbers and
// booleans stringify, and objects/arrays/null become '' — MCP inputs are
// often structured, and a non-string here used to throw inside stripAnsi.
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// "AskUserQuestion" -> "ask user question", "mcp__foo__bar_baz" -> "foo bar baz".
// Used wherever a tool has no better detail than its own name.
function humanizeToolName(name) {
  return toText(name)
    .replace(/^mcp__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// mcp__<server>__<tool>. Plugin-installed servers arrive as plugin_<x>_<x>;
// collapse that to <x> so the status line reads "github: create pull request".
function splitMcpToolName(toolName) {
  const parts = toText(toolName).split('__');
  let server = (parts[1] || 'external').replace(/^plugin_/, '');
  const segs = server.split('_');
  if (segs.length === 2 && segs[0] === segs[1]) server = segs[0];
  const rawTool = parts.slice(2).join('__');
  return {
    server: server.replace(/_/g, ' '),
    tool: rawTool.replace(/_/g, ' '),
    rawTool,
  };
}

function mcpVerbState(rawTool) {
  if (MCP_SEARCH_VERBS.test(rawTool)) return 'searching';
  if (MCP_READ_VERBS.test(rawTool)) return 'reading';
  if (MCP_WRITE_VERBS.test(rawTool)) return 'coding';
  return 'executing';
}

function toolToState(toolName, toolInput) {
  let result;
  const name = toText(toolName);
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const filePath = toText(input.file_path || input.notebook_path || input.path || input.target_file);
  const shortPath = filePath ? path.basename(filePath) : '';

  // Writing/editing code
  if (EDIT_TOOLS.test(name)) {
    result = { state: 'coding', detail: shortPath ? `editing ${shortPath}` : 'writing code' };
  }

  // Running commands
  else if (BASH_TOOLS.test(name)) {
    const cmd = toText(input.command || input.cmd || input.input);
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
      const fallback = SHELL_MGMT_TOOLS.test(name) ? humanizeToolName(name) : 'running command';
      result = { state: 'executing', detail: shortCmd || fallback };
    }
  }

  // Reviewing / diffing code
  else if (REVIEW_TOOLS.test(name)) {
    result = { state: 'reviewing', detail: humanizeToolName(name) || 'reviewing' };
  }

  // Reading files
  else if (READ_TOOLS.test(name)) {
    result = { state: 'reading', detail: shortPath ? `reading ${shortPath}` : 'reading' };
  }

  // Searching
  else if (SEARCH_TOOLS.test(name)) {
    const pattern = toText(input.pattern || input.query || input.search_term);
    if (!pattern && LIST_TOOLS.test(name) && shortPath) {
      result = { state: 'searching', detail: `listing ${shortPath}` };
    } else {
      result = { state: 'searching', detail: pattern ? `looking for "${pattern}"` : 'searching' };
    }
  }

  // Web/fetch
  else if (WEB_TOOLS.test(name)) {
    const query = toText(input.query || input.url);
    const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
    result = { state: 'searching', detail: shortQuery ? `searching "${shortQuery}"` : 'searching the web' };
  }

  // Asking the user something — the face waits on them
  else if (ASK_TOOLS.test(name)) {
    result = { state: 'waiting', detail: 'asking you' };
  }

  // Loading a skill = reading instructions
  else if (SKILL_TOOLS.test(name)) {
    const skill = toText(input.skill || input.name);
    result = { state: 'reading', detail: skill ? `skill: ${skill}` : 'loading a skill' };
  }

  // Planning / scheduling tools are thinking, not doing
  else if (PLAN_TOOLS.test(name)) {
    result = { state: 'thinking', detail: SCHEDULE_TOOLS.test(name) ? 'scheduling' : 'planning' };
  }

  // Publishing an artifact or sending a file is producing output
  else if (PUBLISH_TOOLS.test(name)) {
    result = { state: 'coding', detail: /^senduserfile$/i.test(name) ? 'sending a file' : 'publishing' };
  }

  // Task/subagent
  else if (SUBAGENT_TOOLS.test(name)) {
    const desc = toText(input.description || input.prompt);
    const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
    let fallback = 'spawning subagent';
    if (/^workflow$/i.test(name)) fallback = 'orchestrating';
    else if (/^sendmessage$/i.test(name)) fallback = 'messaging an agent';
    else if (AGENT_MONITOR_TOOLS.test(name)) fallback = 'checking on agents';
    result = { state: 'subagent', detail: shortDesc || fallback };
  }

  // MCP tools — classify by verb so "read_sheet_values" reads and
  // "create_pull_request" codes instead of everything being "executing"
  else if (/^mcp__/.test(name)) {
    const { server, tool, rawTool } = splitMcpToolName(name);
    result = { state: mcpVerbState(rawTool), detail: `${server}: ${tool}` };
  }

  // Default: unknown tool, best we can do is say its name in plain words
  else {
    result = { state: 'thinking', detail: humanizeToolName(name) };
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
// This normalizes both into a consistent {stdout, stderr} object and keeps
// the signals that mean trouble — `interrupted` (user hit Esc), `isError` /
// `is_error` (MCP), and a numeric `exitCode` / `exit_code` — so
// classifyToolResult can react to them. Without this an interrupted
// command used to render as relieved / "command succeeded".
function normalizeToolResponse(data) {
  const rawResult = data.tool_result ?? data.tool_response ?? {};
  if (typeof rawResult === 'string') return { stdout: rawResult, stderr: '' };
  if (Array.isArray(rawResult)) {
    // Content block array: [{type:"text", text:"..."}]
    const text = rawResult
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
    return { stdout: text, stderr: '' };
  }
  if (typeof rawResult !== 'object' || rawResult === null) {
    return { stdout: toText(rawResult), stderr: '' };
  }
  const out = { stdout: toText(rawResult.stdout), stderr: toText(rawResult.stderr) };
  const isError = rawResult.isError ?? rawResult.is_error;
  if (isError !== undefined) out.isError = !!isError;
  if (rawResult.interrupted !== undefined) out.interrupted = !!rawResult.interrupted;
  const exit = rawResult.exitCode ?? rawResult.exit_code;
  if (typeof exit === 'number') out.exitCode = exit;
  // Claude Code's edit diff, carried through only when it is the array we expect.
  // It is read for line counts and never persisted -- see diffFromPatch.
  if (Array.isArray(rawResult.structuredPatch)) out.structuredPatch = rawResult.structuredPatch;
  return out;
}

// -- Post-Tool Classification ----------------------------------------

// Detect git merge conflicts in command output
function isMergeConflict(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  return /\bCONFLICT\s+\(.*\):/.test(combined) ||
         /\bAutomatic merge failed\b/i.test(combined) ||
         /\bfix conflicts and then commit\b/i.test(combined);
}

// -- Edit Diff Counting ----------------------------------------------

// Claude Code attaches a `structuredPatch` to PostToolUse for Edit/MultiEdit/
// Write-over-existing: hunks of { oldStart, oldLines, newStart, newLines,
// lines } where each line keeps its '+', '-' or ' ' prefix. Counting those is
// exact -- a same-length replacement is +1 -1, where counting the raw inputs
// claims +2 -2. Returns null when the patch is absent or malformed so the
// caller can fall back. Only the two totals are kept; the patch is never
// written to the state file.
function diffFromPatch(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  let added = 0, removed = 0, sawHunk = false;
  for (const hunk of structuredPatch) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    sawHunk = true;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return sawHunk ? { added, removed } : null;
}

// Fallback when no patch is available (other editors, Write to a new file):
// line counts of the edit's own inputs. Approximate -- a replacement counts
// both sides in full -- but it is all these tools give us.
function diffFromInput(input) {
  if (Array.isArray(input.edits)) {              // MultiEdit
    let added = 0, removed = 0;
    for (const e of input.edits) {
      const o = toText(e && e.old_string), n = toText(e && e.new_string);
      if (o) removed += o.split('\n').length;
      if (n) added += n.split('\n').length;
    }
    return added || removed ? { added, removed } : null;
  }
  const oldStr = toText(input.old_string || input.old_str);
  const newStr = toText(input.new_string || input.new_str || input.content || input.new_source);
  if (!oldStr && !newStr) return null;
  return { added: newStr ? newStr.split('\n').length : 0, removed: oldStr ? oldStr.split('\n').length : 0 };
}

// Encapsulates the full PostToolUse decision tree.
// Returns { state, detail, diffInfo }
function classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag) {
  const name = toText(toolName);
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const stdout = toText(toolResponse?.stdout);
  const stderr = toText(toolResponse?.stderr);
  const isError = isErrorFlag || toolResponse?.isError || false;
  const inferredExit = extractExitCode(stdout);
  const exitCode = typeof toolResponse?.exitCode === 'number' ? toolResponse.exitCode : null;
  const fp = toText(input.file_path || input.notebook_path || input.path || input.target_file);

  let state, detail;
  let diffInfo = null;

  // Decision tree -- in order of confidence
  if (isError) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (toolResponse?.interrupted) {
    state = 'error';
    detail = 'interrupted';
  } else if (exitCode !== null && exitCode !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, exitCode);
  } else if (inferredExit !== null && inferredExit !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, inferredExit);
  } else if (!READ_TOOLS.test(name) && !SEARCH_TOOLS.test(name) && !WEB_TOOLS.test(name) && looksLikeError(stderr, stderrErrorPatterns)) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (BASH_TOOLS.test(name) && looksLikeError(stdout, stdoutErrorPatterns)) {
    // Only check stdout patterns for shell commands -- other tools have structured output
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (EDIT_TOOLS.test(name)) {
    state = 'proud';
    detail = fp ? `saved ${path.basename(fp)}` : 'code written';
    // Diff info for thought bubbles: exact from the patch when we got one,
    // otherwise estimated from the edit's inputs
    diffInfo = diffFromPatch(toolResponse && toolResponse.structuredPatch) || diffFromInput(input);
  } else if (READ_TOOLS.test(name)) {
    state = 'satisfied';
    detail = fp ? `read ${path.basename(fp)}` : 'got it';
  } else if (SEARCH_TOOLS.test(name)) {
    state = 'satisfied';
    const pattern = toText(input.pattern || input.query || input.search_term);
    detail = pattern ? `found "${pattern.length > 20 ? pattern.slice(0, 17) + '...' : pattern}"` : 'got it';
  } else if (WEB_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'search complete';
  } else if (BASH_TOOLS.test(name)) {
    state = 'relieved';
    const cmd = toText(input.command || input.cmd || input.input);
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
    } else if (SHELL_MGMT_TOOLS.test(name)) {
      detail = `${humanizeToolName(name)} done`;
    } else {
      detail = 'command succeeded';
    }
  } else if (ASK_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'got your answer';
  } else if (SKILL_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'skill loaded';
  } else if (PLAN_TOOLS.test(name)) {
    state = 'satisfied';
    detail = SCHEDULE_TOOLS.test(name) ? 'scheduled' : 'planned';
  } else if (PUBLISH_TOOLS.test(name)) {
    state = 'proud';
    detail = /^senduserfile$/i.test(name) ? 'sent' : 'published';
  } else if (SUBAGENT_TOOLS.test(name)) {
    // A returning Agent/Task/Workflow/TaskOutput means a helper finished
    if (AGENT_DONE_TOOLS.test(name)) {
      state = 'happy';
      detail = 'agent done';
    } else if (/^sendmessage$/i.test(name)) {
      state = 'satisfied';
      detail = 'message sent';
    } else {
      state = 'satisfied';
      detail = 'checked in';
    }
  } else if (REVIEW_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'reviewed';
  } else if (/^mcp__/.test(name)) {
    state = 'satisfied';
    detail = `${splitMcpToolName(name).server} done`;
  } else {
    state = 'satisfied';
    detail = 'step complete';
  }

  // Strip ANSI escape sequences from detail before returning
  if (detail) detail = stripAnsi(detail).replace(/[\r\n]+/g, ' ');
  return { state, detail, diffInfo };
}

// Detail for a non-zero exit: the forensic message when the output says
// something specific, otherwise the bare exit code (errorDetail never
// returns an empty string, so `|| exit N` used to be unreachable).
function exitDetail(stdout, stderr, code) {
  const d = errorDetail(stdout, stderr);
  return d === 'something went wrong' ? `exit ${code}` : d;
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
    UserPromptSubmit:   { state: 'thinking',   detail: 'reading your message' },
    TeammateIdle:       { state: 'waiting',    detail: 'teammate idle' },
    TaskCompleted:      { state: 'happy',      detail: 'task done' },
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
    topLevelSessions: {},
  };
}

// Repair a stats object read from disk so every field the hooks touch exists.
// A truncated write, an older schema, or a hand-edited file can leave `{}` or
// a partial shape; without this, `stats.session.id` throws inside a hook.
function normalizeStats(parsed) {
  const def = defaultStats();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const out = { ...def, ...parsed };
  out.records = { ...def.records, ...obj(parsed.records) };
  out.session = { ...def.session, ...obj(parsed.session) };
  if (!Array.isArray(out.session.filesEdited)) out.session.filesEdited = [];
  out.daily = { ...def.daily, ...obj(parsed.daily) };
  out.frequentFiles = obj(parsed.frequentFiles);
  out.topLevelSessions = obj(parsed.topLevelSessions);
  return out;
}

// -- Subagent Session State (pure logic) ---------------------------------

// Build the state object for writing to a subagent's session file.
// Preserves sticky fields (modelName, editor, taskDescription, cwd, gitBranch)
// from the existing session file, falling back to values from the sub entry.
function buildSubagentSessionState(existing, sub, parentSessionId, defaultCwd) {
  if (existing.stopped) return null;
  return {
    sessionId: sub.id,
    modelName: existing.modelName || sub.model || 'haiku',
    editor: existing.editor || sub.editor || '',
    cwd: existing.cwd || defaultCwd || '',
    gitBranch: existing.gitBranch || '',
    parentSession: parentSessionId,
    taskDescription: existing.taskDescription || sub.taskDescription || sub.description,
  };
}

// -- Parallel Session Classification (pure logic) -------------------------

// Registry limits for stats.topLevelSessions ({ sessionId: lastSeenMs }).
const TOP_LEVEL_REGISTRY_MAX = 200;
const TOP_LEVEL_REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Decide whether a foreign session (id differs from the stats owner) seen
// while the owner has active subagents is a real subagent or an unrelated
// parallel top-level session (#134).
//   registryHit            session fired SessionStart (in stats.topLevelSessions)
//   fileBornAt             birthtime of the session's own file (null/0 = unknown)
//   earliestSubagentStart  startedAt of the oldest active subagent
// A real subagent's session file is created by its own first hook, which can
// only fire after SubagentStart — so a file born before the earliest active
// subagent spawned proves the session is an independent parallel one.
// Unknown birthtime (unsupported filesystem) falls back to 'subagent', the
// pre-fix behavior, so real subagent grouping never regresses.
function classifyForeignSession({ registryHit, fileBornAt, earliestSubagentStart }) {
  if (registryHit) return 'parallel';
  if (typeof fileBornAt === 'number' && fileBornAt > 0 &&
      typeof earliestSubagentStart === 'number' && earliestSubagentStart > 0 &&
      fileBornAt < earliestSubagentStart) {
    return 'parallel';
  }
  return 'subagent';
}

// Prune the top-level session registry in place: drop entries older than the
// TTL, then oldest-first down to the cap. Returns the registry.
function pruneTopLevelSessions(registry, now) {
  if (!registry) return registry;
  for (const id of Object.keys(registry)) {
    if (now - registry[id] > TOP_LEVEL_REGISTRY_TTL_MS) delete registry[id];
  }
  const ids = Object.keys(registry);
  if (ids.length > TOP_LEVEL_REGISTRY_MAX) {
    ids.sort((a, b) => registry[a] - registry[b]);
    for (const id of ids.slice(0, ids.length - TOP_LEVEL_REGISTRY_MAX)) {
      delete registry[id];
    }
  }
  return registry;
}

module.exports = {
  toolToState,
  humanizeToolName,
  EDIT_TOOLS,
  BASH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  WEB_TOOLS,
  SUBAGENT_TOOLS,
  REVIEW_TOOLS,
  ASK_TOOLS,
  SKILL_TOOLS,
  PLAN_TOOLS,
  PUBLISH_TOOLS,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  isMergeConflict,
  looksLikeError,
  stripAnsi,
  errorDetail,
  extractExitCode,
  normalizeToolResponse,
  diffFromPatch,
  diffFromInput,
  classifyToolResult,
  classifyTruncatedInput,
  MILESTONES,
  updateStreak,
  defaultStats,
  normalizeStats,
  MAX_FREQUENT_FILES,
  pruneFrequentFiles,
  topFrequentFiles,
  buildSubagentSessionState,
  classifyForeignSession,
  pruneTopLevelSessions,
  TOP_LEVEL_REGISTRY_MAX,
  TOP_LEVEL_REGISTRY_TTL_MS,
};
