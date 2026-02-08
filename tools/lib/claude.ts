import { execSync, ExecSyncOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ClaudeOptions {
  cwd?: string;
  maxTurns?: number;
  allowedTools?: string[];
}

export function runClaude(prompt: string, options: ClaudeOptions = {}): string {
  const { cwd, maxTurns, allowedTools } = options;

  const args: string[] = ['claude', '-p', '--output-format', 'text'];

  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (allowedTools?.length) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  const execOptions: ExecSyncOptions = {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  if (cwd) execOptions.cwd = cwd;

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = path.join('/tmp', `claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = `${args.join(' ')} < "${tmpFile}"`;
    const result = execSync(cmd, execOptions);
    return (result as string).trim();
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
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
