import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Engine = 'claude' | 'codex';

const HEARTBEAT_INTERVAL_MS = 30 * 1000; // log every 30s

export interface ClaudeOptions {
  cwd?: string;
  maxTurns?: number;
  allowedTools?: string[];
  engine?: Engine;
  timeoutMs?: number;
}

function buildClaudeArgs(options: ClaudeOptions): { cmd: string; args: string[] } {
  const { maxTurns, allowedTools } = options;
  const args: string[] = ['-p', '--output-format', 'text', '--verbose'];

  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (allowedTools?.length) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  return { cmd: 'claude', args };
}

function buildCodexArgs(_options: ClaudeOptions): { cmd: string; args: string[] } {
  return { cmd: 'codex', args: ['exec', '--full-auto'] };
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
 * Runs an AI agent (claude or codex) synchronously.
 *
 * Uses a child Node process wrapper so that:
 * - stderr streams to console in real time (progress, debug info)
 * - a heartbeat logs every 30s so you know it's alive
 * - a timeout kills the process if it runs too long
 * - prompt size and timing are logged for diagnostics
 */
export function runAgent(prompt: string, options: ClaudeOptions = {}): string {
  const engine = options.engine || 'claude';
  const timeoutMs = options.timeoutMs;

  const { cmd, args } = engine === 'codex' ? buildCodexArgs(options) : buildClaudeArgs(options);

  // Log prompt diagnostics
  const promptBytes = Buffer.byteLength(prompt, 'utf-8');
  const approxTokens = Math.round(promptBytes / 4);
  console.log(`  [agent] Engine: ${engine} | Prompt: ${formatBytes(promptBytes)} (~${approxTokens.toLocaleString()} tokens)`);
  console.log(`  [agent] Timeout: ${timeoutMs ? formatDuration(timeoutMs) : 'none'} | Cmd: ${cmd} ${args.join(' ')}`);

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = path.join('/tmp', `agent-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, prompt);

  const startTime = Date.now();

  // Build a small wrapper script that:
  //  1. Spawns the agent command
  //  2. Pipes the prompt file into stdin
  //  3. Captures stdout (the result)
  //  4. Streams stderr to its own stderr (which we inherit below)
  //  5. Logs a heartbeat every 30s
  const wrapperScript = `
    const { spawn } = require('child_process');
    const fs = require('fs');

    const child = spawn(${JSON.stringify(cmd)}, ${JSON.stringify(args)}, {
      cwd: ${JSON.stringify(options.cwd || process.cwd())},
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdinStream = fs.createReadStream(${JSON.stringify(tmpFile)});
    stdinStream.pipe(child.stdin);

    const stdoutChunks = [];

    child.stdout.on('data', (data) => {
      stdoutChunks.push(data);
    });

    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });

    const startMs = ${startTime};
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      const outputSize = Buffer.concat(stdoutChunks).length;
      const kb = (outputSize / 1024).toFixed(1);
      process.stderr.write('  [agent ' + min + 'm' + sec + 's] Still running... (' + kb + 'KB output so far)\\n');
    }, ${HEARTBEAT_INTERVAL_MS});

    child.on('close', (code) => {
      clearInterval(heartbeat);
      const result = Buffer.concat(stdoutChunks).toString('utf-8');
      process.stdout.write(result);
      process.exit(code || 0);
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      process.stderr.write('  [agent] Spawn error: ' + err.message + '\\n');
      process.exit(1);
    });
  `;

  const wrapperFile = path.join('/tmp', `agent-wrapper-${Date.now()}.js`);
  fs.writeFileSync(wrapperFile, wrapperScript);

  try {
    const result = spawnSync('node', [wrapperFile], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr → streams to console
    });

    const elapsed = formatDuration(Date.now() - startTime);

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

    const output = (result.stdout || '').trim();

    if (result.status !== 0 && result.status !== null) {
      if (output.length > 0) {
        console.log(`  [agent] Exited with code ${result.status} after ${elapsed}, but has output — using it`);
        return output;
      }
      throw new Error(`Agent exited with code ${result.status} after ${elapsed} with no output`);
    }

    console.log(`  [agent] Completed in ${elapsed} | Output: ${formatBytes(Buffer.byteLength(output))}`);
    return output;
  } finally {
    try { fs.unlinkSync(wrapperFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
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
