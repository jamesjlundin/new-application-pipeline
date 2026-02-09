import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Engine = 'claude' | 'codex';

const HEARTBEAT_INTERVAL_MS = 30 * 1000; // log every 30s

export interface AgentOptions {
  cwd?: string;
  maxTurns?: number;
  permissions?: 'read-only' | 'read-write';
  webSearch?: boolean;
  engine?: Engine;
  timeoutMs?: number;
}

export interface AgentResult {
  output: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  elapsed: string;
}

interface CodexCapabilities {
  supportsAskForApproval: boolean;
  supportsSearch: boolean;
  supportsOutputLastMessage: boolean;
}

let codexCapabilitiesCache: CodexCapabilities | null = null;

function getCodexCapabilities(): CodexCapabilities {
  if (codexCapabilitiesCache) return codexCapabilitiesCache;

  try {
    const topLevelHelp = spawnSync('codex', ['--help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const execHelp = spawnSync('codex', ['exec', '--help'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 10_000,
    });
    const topHelpText = `${topLevelHelp.stdout || ''}\n${topLevelHelp.stderr || ''}`;
    const execHelpText = `${execHelp.stdout || ''}\n${execHelp.stderr || ''}`;
    codexCapabilitiesCache = {
      supportsAskForApproval:
        topHelpText.includes('--ask-for-approval') || topHelpText.includes('-a, --ask-for-approval'),
      supportsSearch: topHelpText.includes('--search'),
      supportsOutputLastMessage:
        execHelpText.includes('--output-last-message') || execHelpText.includes('-o, --output-last-message'),
    };
  } catch {
    // Conservative defaults when detection fails.
    codexCapabilitiesCache = {
      supportsAskForApproval: false,
      supportsSearch: false,
      supportsOutputLastMessage: false,
    };
  }

  return codexCapabilitiesCache;
}

function buildClaudeArgs(options: AgentOptions): { cmd: string; args: string[] } {
  const { maxTurns, permissions, webSearch } = options;
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];

  if (maxTurns) args.push('--max-turns', String(maxTurns));

  // Build allowed tools list based on permissions.
  // When permissions is unset, no --allowedTools is passed and the agent
  // gets its default tool set.
  if (permissions) {
    const tools: string[] = ['Read', 'Glob', 'Grep'];
    if (permissions === 'read-write') {
      tools.push('Edit', 'Write', 'Bash');
    }
    if (webSearch) {
      tools.push('WebSearch', 'WebFetch');
    }
    args.push('--allowedTools', tools.join(','));
  }

  return { cmd: 'claude', args };
}

function buildCodexArgs(
  options: AgentOptions,
  outputLastMessagePath?: string
): { cmd: string; args: string[] } {
  const { permissions, webSearch } = options;
  const args: string[] = [];
  const capabilities = getCodexCapabilities();

  // Codex global flags must appear before the subcommand.
  if (capabilities.supportsAskForApproval) {
    args.push('-a', 'never');
  }

  if (webSearch && capabilities.supportsSearch) {
    args.push('--search');
  }

  args.push('exec', '--json');
  if (outputLastMessagePath && capabilities.supportsOutputLastMessage) {
    args.push('--output-last-message', outputLastMessagePath);
  }

  // Sandbox mode based on permissions
  if (permissions === 'read-only') {
    args.push('--sandbox', 'read-only');
  } else {
    // read-write or unspecified: allow workspace writes
    args.push('--sandbox', 'workspace-write');
  }

  return { cmd: 'codex', args };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

/**
 * Creates a secure temporary file with restricted permissions.
 * Uses crypto.randomBytes for filename uniqueness and 0o600 permissions.
 */
function createSecureTempFile(prefix: string, ext: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-'));
  const name = `${prefix}-${crypto.randomBytes(16).toString('hex')}${ext}`;
  const filePath = path.join(dir, name);
  return filePath;
}

/**
 * Cleans AI meta-commentary from artifact output.
 * Strips preamble before the first markdown heading and trailing commentary.
 */
export function cleanArtifact(raw: string): string {
  let content = raw.trim();

  // Strip everything before the first markdown heading
  const headingMatch = content.match(/^(#{1,3}\s)/m);
  if (headingMatch && headingMatch.index !== undefined && headingMatch.index > 0) {
    content = content.slice(headingMatch.index);
  }

  // Strip trailing AI commentary after the last meaningful section
  // Look for common trailing patterns
  const trailingPatterns = [
    /\n---\n(?:Let me know|Is there anything|I hope|Feel free|Would you like|If you)[^\n]*/s,
    /\n(?:Let me know|Is there anything|I hope|Feel free|Would you like|If you have)[^\n]*$/s,
  ];
  for (const pattern of trailingPatterns) {
    content = content.replace(pattern, '');
  }

  return content.trim();
}

/**
 * Estimates token count from a string (rough approximation: ~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.round(Buffer.byteLength(text, 'utf-8') / 4);
}

/**
 * Runs an AI agent (claude or codex) synchronously.
 *
 * Uses a child Node process wrapper that:
 * - Parses the NDJSON stream (stream-json for Claude, --json for Codex)
 * - Tracks turns, tool calls, and text output in real time
 * - Streams stderr to console (progress, debug info)
 * - Logs a heartbeat every 30s with turn count, last tool, and output size
 * - Supports timeout to kill runaway agents
 * - Reports cost and token usage on completion (Claude)
 */
export function runAgent(prompt: string, options: AgentOptions = {}): AgentResult {
  const engine = options.engine || 'claude';
  const maxTurns = options.maxTurns || 0;
  const timeoutMs = options.timeoutMs;

  // Write prompt to secure temp file to avoid shell escaping issues
  const tmpFile = createSecureTempFile('prompt', '.md');
  fs.writeFileSync(tmpFile, prompt, { mode: 0o600 });
  const codexOutputFile = engine === 'codex'
    ? createSecureTempFile('codex-last-message', '.md')
    : null;

  const { cmd, args } = engine === 'codex'
    ? buildCodexArgs(options, codexOutputFile || undefined)
    : buildClaudeArgs(options);

  // Log prompt diagnostics
  const promptBytes = Buffer.byteLength(prompt, 'utf-8');
  const approxTokens = Math.round(promptBytes / 4);
  console.log(`  [agent] Engine: ${engine} | Prompt: ${formatBytes(promptBytes)} (~${approxTokens.toLocaleString()} tokens)`);
  console.log(`  [agent] Timeout: ${timeoutMs ? formatDuration(timeoutMs) : 'none'} | Cmd: ${cmd} ${args.join(' ')}`);

  const startTime = Date.now();

  // Build a wrapper script that spawns the agent, parses its NDJSON stream,
  // tracks turns/tools/output, logs heartbeats, and emits final text to stdout.
  // Also outputs a JSON stats line to stderr for the parent to parse.
  const wrapperScript = `
    const { spawn } = require('child_process');
    const fs = require('fs');

    const ENGINE = ${JSON.stringify(engine)};
    const MAX_TURNS = ${maxTurns};
    const START_MS = ${startTime};
    const HEARTBEAT_MS = ${HEARTBEAT_INTERVAL_MS};

    // ---------------------------------------------------------------
    // State tracked from the NDJSON stream
    // ---------------------------------------------------------------
    const state = {
      turn: 0,
      lastTool: '',
      textBytes: 0,
      finalText: '',
      numTurns: null,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
    };

    // Accumulated text from all assistant messages (fallback if result event missing)
    let accumulatedText = '';

    // ---------------------------------------------------------------
    // Tool name formatter — shows tool + brief context
    // ---------------------------------------------------------------
    function briefTool(name, input) {
      if (!input) return name;
      const fp = input.file_path || input.path || '';
      if (fp) return name + '(' + fp.split('/').pop() + ')';
      const pat = input.pattern || '';
      if (pat) return name + '(' + pat.substring(0, 30) + ')';
      const cmd = input.command || '';
      if (cmd) return name + '(' + cmd.substring(0, 30) + ')';
      return name;
    }

    // ---------------------------------------------------------------
    // Claude stream-json parser
    // Events: system, assistant, user, result
    // ---------------------------------------------------------------
    function appendClaudeText(text) {
      if (!text) return;

      // Avoid duplicating snapshot-style partial payloads.
      if (accumulatedText.length === 0) {
        accumulatedText = text;
      } else if (text.includes(accumulatedText)) {
        accumulatedText = text;
      } else if (!accumulatedText.endsWith(text)) {
        accumulatedText += text;
      }

      state.textBytes = Buffer.byteLength(accumulatedText);
    }

    function parseClaude(event) {
      if (event.type === 'assistant' && event.message && event.message.content) {
        let hasTool = false;
        for (const block of event.message.content) {
          if (block.type === 'text') {
            appendClaudeText(block.text || '');
          }
          if (block.type === 'tool_use') {
            hasTool = true;
            state.lastTool = briefTool(block.name, block.input);
          }
        }
        if (hasTool) state.turn++;
      }
      if (event.type === 'result') {
        state.finalText = event.result || '';
        state.numTurns = event.num_turns != null ? event.num_turns : null;
        state.costUsd = event.total_cost_usd != null ? event.total_cost_usd : null;
        state.inputTokens = event.input_tokens || 0;
        state.outputTokens = event.output_tokens || 0;
      }
    }

    // ---------------------------------------------------------------
    // Codex --json parser
    // Events: turn.started, turn.completed, item.started, item.completed
    // ---------------------------------------------------------------
    function parseCodex(event) {
      if (event.type === 'turn.started') {
        state.turn++;
      }
      if (event.type === 'item.completed' && event.item) {
        if (event.item.type === 'agent_message') {
          const text = event.item.text || '';
          accumulatedText += text;
          state.finalText = accumulatedText;
          state.textBytes = Buffer.byteLength(state.finalText);
        }
        if (event.item.type === 'command_execution') {
          state.lastTool = 'Bash(' + (event.item.command || '').substring(0, 30) + ')';
        }
        if (event.item.type === 'mcp_tool_call') {
          state.lastTool = briefTool(event.item.tool || 'tool', event.item.arguments);
        }
        if (event.item.type === 'file_change') {
          const fname = (event.item.file || '').split('/').pop() || 'file';
          state.lastTool = 'FileChange(' + fname + ')';
        }
      }
      if (event.type === 'turn.completed' && event.usage) {
        state.inputTokens += event.usage.input_tokens || 0;
        state.outputTokens += event.usage.output_tokens || 0;
      }
    }

    // ---------------------------------------------------------------
    // NDJSON line processor
    // ---------------------------------------------------------------
    let lineBuffer = '';

    function processChunk(data) {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (ENGINE === 'claude') parseClaude(event);
          else parseCodex(event);
        } catch (e) { /* not valid JSON, skip */ }
      }
    }

    // ---------------------------------------------------------------
    // Spawn the agent process
    // ---------------------------------------------------------------
    const child = spawn(${JSON.stringify(cmd)}, ${JSON.stringify(args)}, {
      cwd: ${JSON.stringify(options.cwd || process.cwd())},
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdinStream = fs.createReadStream(${JSON.stringify(tmpFile)});
    child.stdin.on('error', (err) => {
      // Agent may exit before stdin is fully piped (for example, CLI arg parse errors).
      if (!err || err.code === 'EPIPE') return;
      process.stderr.write('  [agent] stdin error: ' + err.message + '\\n');
    });
    stdinStream.on('error', (err) => {
      process.stderr.write('  [agent] prompt stream error: ' + err.message + '\\n');
    });
    stdinStream.pipe(child.stdin);

    child.stdout.on('data', processChunk);
    child.stderr.on('data', (data) => process.stderr.write(data));

    // ---------------------------------------------------------------
    // Heartbeat — shows turn, last tool, output size
    // ---------------------------------------------------------------
    function formatElapsed(startMs) {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      return min + 'm' + sec + 's';
    }

    function formatSize(bytes) {
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
      return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    }

    const heartbeat = setInterval(() => {
      const elapsed = formatElapsed(START_MS);
      const turnStr = MAX_TURNS > 0
        ? 'Turn ' + state.turn + '/' + MAX_TURNS
        : 'Turn ' + state.turn;
      const toolStr = state.lastTool ? ' | ' + state.lastTool : '';
      const sizeStr = formatSize(state.textBytes) + ' text output';
      process.stderr.write('  [agent ' + elapsed + '] ' + turnStr + toolStr + ' | ' + sizeStr + '\\n');
    }, HEARTBEAT_MS);

    // ---------------------------------------------------------------
    // Completion handler
    // ---------------------------------------------------------------
    child.on('close', (code) => {
      clearInterval(heartbeat);

      // Process any remaining buffered data
      if (lineBuffer.trim()) processChunk(lineBuffer + '\\n');

      // Determine final output: prefer result event, fall back to accumulated text
      let output = state.finalText || accumulatedText;
      if (ENGINE === 'claude') {
        if (accumulatedText.length > output.length) {
          output = accumulatedText;
        }
      }
      process.stdout.write(output);

      // Log completion summary to stderr
      const parts = [];
      const turns = state.numTurns != null ? state.numTurns : state.turn;
      parts.push('Turns: ' + turns);
      if (state.costUsd != null && state.costUsd > 0) {
        parts.push('Cost: $' + state.costUsd.toFixed(4));
      }
      if (state.inputTokens > 0 || state.outputTokens > 0) {
        parts.push('Tokens: ' + state.inputTokens.toLocaleString() + ' in / ' + state.outputTokens.toLocaleString() + ' out');
      }
      process.stderr.write('  [agent] ' + parts.join(' | ') + '\\n');

      // Emit stats as final stderr JSON line for parent to parse
      const stats = JSON.stringify({
        __agent_stats__: true,
        costUsd: state.costUsd || 0,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        turns: turns,
      });
      process.stderr.write('  [agent-stats] ' + stats + '\\n');

      process.exit(code || 0);
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      process.stderr.write('  [agent] Spawn error: ' + err.message + '\\n');
      process.exit(1);
    });
  `;

  const wrapperFile = createSecureTempFile('wrapper', '.js');
  fs.writeFileSync(wrapperFile, wrapperScript, { mode: 0o600 });

  // Track the temp directory for cleanup
  const tmpDir1 = path.dirname(tmpFile);
  const tmpDir2 = path.dirname(wrapperFile);
  const tmpDir3 = codexOutputFile ? path.dirname(codexOutputFile) : null;

  try {
    const result = spawnSync('node', [wrapperFile], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      stdio: ['pipe', 'pipe', 'pipe'], // capture stderr to parse stats
    });

    const elapsed = formatDuration(Date.now() - startTime);

    // Forward stderr to console (except stats line)
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turns = 0;

    if (result.stderr) {
      for (const line of result.stderr.split('\n')) {
        if (line.includes('[agent-stats]')) {
          try {
            const jsonStr = line.slice(line.indexOf('{'));
            const stats = JSON.parse(jsonStr);
            if (stats.__agent_stats__) {
              costUsd = stats.costUsd || 0;
              inputTokens = stats.inputTokens || 0;
              outputTokens = stats.outputTokens || 0;
              turns = stats.turns || 0;
            }
          } catch { /* ignore parse errors */ }
        } else {
          process.stderr.write(line + '\n');
        }
      }
    }

    if (result.error) {
      const msg = result.error.message || '';
      if (msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        const partial = (result.stdout || '').trim();
        throw new Error(
          `Agent timed out after ${elapsed}. ` +
          `Partial output: ${formatBytes(Buffer.byteLength(partial))}. ` +
          `Try increasing timeout or reducing prompt size.`
        );
      }
      throw new Error(`Agent failed after ${elapsed}: ${msg}`);
    }

    let output = (result.stdout || '').trim();
    if (engine === 'codex' && codexOutputFile && fs.existsSync(codexOutputFile)) {
      try {
        const fileOutput = fs.readFileSync(codexOutputFile, 'utf-8').trim();
        if (fileOutput.length > 0) {
          output = fileOutput;
        }
      } catch {
        // Fall back to stream-parsed output if reading file fails.
      }
    }

    if (result.status !== 0 && result.status !== null) {
      if (output.length > 0) {
        console.log(`  [agent] Exited with code ${result.status} after ${elapsed}, but has output — using it`);
        return { output, costUsd, inputTokens, outputTokens, turns, elapsed };
      }
      throw new Error(`Agent exited with code ${result.status} after ${elapsed} with no output`);
    }

    console.log(`  [agent] Completed in ${elapsed} | Output: ${formatBytes(Buffer.byteLength(output))}`);
    return { output, costUsd, inputTokens, outputTokens, turns, elapsed };
  } finally {
    // Clean up temp files and directories
    try { fs.rmSync(tmpDir1, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch { /* ignore */ }
    if (tmpDir3) {
      try { fs.rmSync(tmpDir3, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export function buildPrompt(
  templatePath: string,
  replacements: Record<string, string>
): string {
  let template = fs.readFileSync(templatePath, 'utf-8');

  for (const [key, value] of Object.entries(replacements)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return template;
}
