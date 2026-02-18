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
  claudeOutputFormat?: 'stream-json' | 'json';
}

export interface AgentResult {
  output: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  elapsed: string;
  stopReason?: string;
  resultSubtype?: string;
  outputSource?: string;
  claudeOutputFormat?: 'stream-json' | 'json';
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
  const outputFormat = options.claudeOutputFormat || 'json';
  const args: string[] = ['-p', '--output-format', outputFormat];

  // In json mode we prefer deterministic stdout payloads over debug chatter.
  // Verbose mode can emit extra output that complicates strict JSON parsing.
  if (outputFormat === 'stream-json') {
    args.push('--verbose');
  }

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
  let content = raw.replace(/\r\n/g, '\n').trim();

  // Prefer explicit artifact envelope when present.
  const outputEnvelopeMatch = content.match(/<artifact_output>\s*([\s\S]*?)\s*<\/artifact_output>/i);
  if (outputEnvelopeMatch?.[1]) {
    content = outputEnvelopeMatch[1].trim();
  }

  // Prefer explicit artifact tags when present.
  const artifactTagMatch = content.match(/<artifact[^>]*>\s*([\s\S]*?)\s*<\/artifact>/i);
  if (artifactTagMatch?.[1]) {
    content = artifactTagMatch[1].trim();
  }

  // If output is wrapped in a single markdown fence, unwrap it.
  const fencedMatches = [...content.matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/gi)];
  if (fencedMatches.length === 1) {
    const fencedBody = fencedMatches[0]?.[1]?.trim();
    if (fencedBody && /^#{1,3}\s/m.test(fencedBody)) {
      content = fencedBody;
    }
  }

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

  // Strip explicit output end marker if present.
  content = content.replace(/\n?<!--\s*END_ARTIFACT\s*-->\s*$/i, '');

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
 * - Parses JSON outputs (Claude json/stream-json and Codex --json)
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
  const claudeOutputFormat = options.claudeOutputFormat || 'json';

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

  // Build a wrapper script that spawns the agent, parses its JSON stream/output,
  // tracks turns/tools/output, logs heartbeats, and emits final text to stdout.
  // Also outputs a JSON stats line to stderr for the parent to parse.
  const wrapperScript = `
    const { spawn } = require('child_process');
    const fs = require('fs');

    const ENGINE = ${JSON.stringify(engine)};
    const MAX_TURNS = ${maxTurns};
    const CLAUDE_OUTPUT_FORMAT = ${JSON.stringify(claudeOutputFormat)};
    const START_MS = ${startTime};
    const HEARTBEAT_MS = ${HEARTBEAT_INTERVAL_MS};

    // ---------------------------------------------------------------
    // State tracked from the CLI JSON stream/output
    // ---------------------------------------------------------------
    const state = {
      turn: 0,
      lastTool: '',
      textBytes: 0,
      finalText: '',
      lastAssistantText: '',
      longestAssistantText: '',
      numTurns: null,
      costUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      stopReason: '',
      resultSubtype: '',
    };

    // Accumulated text from all assistant messages (fallback if result event missing)
    let accumulatedText = '';
    let rawStdout = '';

    const ARTIFACT_OPEN = '<artifact_output>';
    const ARTIFACT_CLOSE = '</artifact_output>';
    const ARTIFACT_END = '<!-- END_ARTIFACT -->';

    function contains(haystack, needle) {
      return haystack.toLowerCase().includes(needle.toLowerCase());
    }

    function scoreClaudeCandidate(text) {
      const trimmed = (text || '').trim();
      if (!trimmed) return -1;

      let score = 0;
      if (contains(trimmed, ARTIFACT_OPEN)) score += 4;
      if (contains(trimmed, ARTIFACT_CLOSE)) score += 4;
      if (contains(trimmed, ARTIFACT_END)) score += 8;
      if (/^#{1,3}\\s/m.test(trimmed)) score += 1;
      if (trimmed.length > 8192) score += 2;
      if (trimmed.length === 8192) score -= 1;
      score += Math.min(Math.floor(trimmed.length / 4096), 5);
      return score;
    }

    function selectClaudeOutput() {
      const rawCandidates = [
        { source: 'result', text: state.finalText || '' },
        { source: 'last_assistant', text: state.lastAssistantText || '' },
        { source: 'longest_assistant', text: state.longestAssistantText || '' },
        { source: 'accumulated_assistant', text: accumulatedText || '' },
      ];

      const seen = new Set();
      let best = { source: 'result', text: state.finalText || '', score: -1 };

      for (const candidate of rawCandidates) {
        const trimmed = candidate.text.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);

        const score = scoreClaudeCandidate(trimmed);
        if (
          score > best.score ||
          (score === best.score && trimmed.length > best.text.trim().length)
        ) {
          best = { source: candidate.source, text: trimmed, score };
        }
      }

      return best;
    }

    function parseClaudeResultPayload(payload) {
      if (!payload || typeof payload !== 'object') return;

      if (typeof payload.result === 'string') {
        state.finalText = payload.result;
        if (state.finalText.trim().length > 0) {
          state.textBytes = Math.max(state.textBytes, Buffer.byteLength(state.finalText.trim()));
        }
      }

      if (payload.num_turns != null) {
        state.numTurns = payload.num_turns;
      }
      if (payload.total_cost_usd != null) {
        state.costUsd = payload.total_cost_usd;
      }
      if (payload.input_tokens != null) {
        state.inputTokens = payload.input_tokens;
      }
      if (payload.output_tokens != null) {
        state.outputTokens = payload.output_tokens;
      }

      if (typeof payload.subtype === 'string') {
        state.resultSubtype = payload.subtype;
      } else if (typeof payload.result_subtype === 'string') {
        state.resultSubtype = payload.result_subtype;
      }

      if (typeof payload.stop_reason === 'string') {
        state.stopReason = payload.stop_reason;
      } else if (typeof payload.stopReason === 'string') {
        state.stopReason = payload.stopReason;
      }
    }

    function tryParseJsonPayload(raw) {
      const trimmed = (raw || '').trim();
      if (!trimmed) return null;

      // Best case: single JSON object payload.
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        // continue
      }

      // Fallback: parse last JSON-looking line/object from mixed output.
      const lines = trimmed.split('\\n').map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith('{')) continue;
        try {
          return JSON.parse(line);
        } catch (e) {
          // continue
        }
      }

      // Fallback: parse largest bracketed object in the raw output.
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(candidate);
        } catch (e) {
          // continue
        }
      }

      return null;
    }

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
    // Claude parser
    // Handles stream-json events and json-mode result objects.
    // ---------------------------------------------------------------
    function parseClaude(event) {
      if (!event || typeof event !== 'object') return;

      // stream-json assistant event
      if (event.type === 'assistant' && event.message && event.message.content) {
        let hasTool = false;
        let assistantText = '';
        for (const block of event.message.content) {
          if (block.type === 'text') {
            assistantText += block.text || '';
          }
          if (block.type === 'tool_use') {
            hasTool = true;
            state.lastTool = briefTool(block.name, block.input);
          }
        }
        if (assistantText.trim().length > 0) {
          const trimmed = assistantText.trim();
          state.lastAssistantText = trimmed;
          if (trimmed.length > state.longestAssistantText.length) {
            state.longestAssistantText = trimmed;
          }
          if (trimmed.length > accumulatedText.length) {
            accumulatedText = trimmed;
          }
          state.textBytes = Math.max(state.textBytes, Buffer.byteLength(trimmed));
        }
        if (hasTool) state.turn++;
      }

      // stream-json final event
      if (event.type === 'result') {
        parseClaudeResultPayload(event);
        return;
      }

      // json mode can emit a single result object (without type)
      if (!event.type && ('result' in event || 'stop_reason' in event || 'num_turns' in event)) {
        parseClaudeResultPayload(event);
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
    // JSON line processor (for stream-json / codex --json)
    // ---------------------------------------------------------------
    let lineBuffer = '';

    function processChunk(data) {
      const text = data.toString();
      rawStdout += text;
      lineBuffer += text;
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
      if (ENGINE === 'claude' && state.finalText.trim().length === 0 && CLAUDE_OUTPUT_FORMAT === 'json') {
        const parsed = tryParseJsonPayload(rawStdout);
        if (parsed) {
          parseClaude(parsed);
        }
      }

      // Determine final output.
      let output = state.finalText || '';
      let outputSource = 'result';
      if (ENGINE === 'claude' && CLAUDE_OUTPUT_FORMAT === 'stream-json') {
        const selected = selectClaudeOutput();
        output = selected.text;
        outputSource = selected.source;
      } else if (ENGINE === 'claude' && output.trim().length === 0) {
        output = state.lastAssistantText || state.longestAssistantText || accumulatedText;
        outputSource = 'assistant_fallback';
      }
      if (output.trim().length === 0) {
        output = accumulatedText;
        outputSource = 'accumulated_assistant';
      }
      if (ENGINE === 'claude' && output.trim().length === 0 && CLAUDE_OUTPUT_FORMAT === 'json') {
        const rawFallback = rawStdout.trim();
        if (rawFallback.length > 0) {
          output = rawFallback;
          outputSource = 'raw_stdout_fallback';
        }
      }
      if (ENGINE === 'claude') {
        const resultSize = Buffer.byteLength(state.finalText || '');
        const selectedSize = Buffer.byteLength(output || '');
        const subtype = state.resultSubtype || 'n/a';
        const stopReason = state.stopReason || 'n/a';
        process.stderr.write(
          '  [agent] Claude output source: ' +
            outputSource +
            ' | format=' +
            CLAUDE_OUTPUT_FORMAT +
            ' | result=' +
            formatSize(resultSize) +
            ' | selected=' +
            formatSize(selectedSize) +
            ' | subtype=' +
            subtype +
            ' | stop_reason=' +
            stopReason +
            '\\n'
        );
        if (
          CLAUDE_OUTPUT_FORMAT === 'stream-json' &&
          state.finalText.trim().length > 0 &&
          output.trim().length > 0 &&
          state.finalText.trim() !== output.trim()
        ) {
          process.stderr.write(
            '  [agent] Claude mismatch: selected output differs from result payload.\\n'
          );
        }
      }
      // Write final output synchronously to avoid truncation when exiting quickly.
      // Large payloads can be partially written if we exit immediately after async writes.
      try {
        fs.writeSync(1, output);
      } catch (err) {
        process.stderr.write('  [agent] stdout write error: ' + (err && err.message ? err.message : String(err)) + '\\n');
      }

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
        stopReason: state.stopReason || '',
        resultSubtype: state.resultSubtype || '',
        outputSource: outputSource,
        claudeOutputFormat: CLAUDE_OUTPUT_FORMAT,
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
    let stopReason = '';
    let resultSubtype = '';
    let outputSource = '';
    let selectedClaudeOutputFormat: 'stream-json' | 'json' | undefined = undefined;

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
              stopReason = stats.stopReason || '';
              resultSubtype = stats.resultSubtype || '';
              outputSource = stats.outputSource || '';
              selectedClaudeOutputFormat = stats.claudeOutputFormat || undefined;
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
        return {
          output,
          costUsd,
          inputTokens,
          outputTokens,
          turns,
          elapsed,
          stopReason,
          resultSubtype,
          outputSource,
          claudeOutputFormat: selectedClaudeOutputFormat,
        };
      }
      throw new Error(`Agent exited with code ${result.status} after ${elapsed} with no output`);
    }

    console.log(`  [agent] Completed in ${elapsed} | Output: ${formatBytes(Buffer.byteLength(output))}`);
    return {
      output,
      costUsd,
      inputTokens,
      outputTokens,
      turns,
      elapsed,
      stopReason,
      resultSubtype,
      outputSource,
      claudeOutputFormat: selectedClaudeOutputFormat,
    };
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
