import { execFileSync, execSync } from 'child_process';
import * as path from 'path';

export interface TestCheckResult {
  name: string;
  command: string;
  success: boolean;
  output: string;
}

export interface WorkspaceTestResult {
  report: string;
  checks: TestCheckResult[];
  allPassed: boolean;
}

export interface RepoConfig {
  repoName: string;
  repoOwner: string;
  templateRepo: string;
  workspacePath: string;
  visibility: 'public' | 'private';
}

export interface BootstrapResult {
  workspacePath: string;
  repoUrl: string;
}

export function bootstrapRepo(config: RepoConfig): BootstrapResult {
  const { repoName, repoOwner, templateRepo, workspacePath, visibility } = config;
  const fullRepoName = `${repoOwner}/${repoName}`;

  console.log(`Creating repo ${fullRepoName} from template ${templateRepo}...`);

  // Use execFileSync with argument array to prevent command injection
  execFileSync('gh', [
    'repo', 'create', fullRepoName,
    '--template', templateRepo,
    `--${visibility}`,
    '--clone',
  ], {
    cwd: path.dirname(workspacePath),
    encoding: 'utf-8',
    stdio: 'inherit',
  });

  const repoUrl = `https://github.com/${fullRepoName}`;

  console.log(`Repo created: ${repoUrl}`);
  console.log(`Cloned to: ${workspacePath}`);

  return { workspacePath, repoUrl };
}

export function gitStatusCheckpoint(workspacePath: string): string {
  try {
    const status = execSync('git status --porcelain', {
      cwd: workspacePath,
      encoding: 'utf-8',
    });
    return status.trim() || '(clean working directory)';
  } catch {
    return '(failed to get git status)';
  }
}

export function gitDiffStat(workspacePath: string): string {
  try {
    const diff = execSync('git diff --stat', {
      cwd: workspacePath,
      encoding: 'utf-8',
    });
    const staged = execSync('git diff --staged --stat', {
      cwd: workspacePath,
      encoding: 'utf-8',
    });
    return [
      'Unstaged changes:',
      diff.trim() || '(none)',
      '',
      'Staged changes:',
      staged.trim() || '(none)',
    ].join('\n');
  } catch {
    return '(failed to get git diff)';
  }
}

/**
 * Commits all changes in the workspace with a descriptive message.
 * Returns true if a commit was made, false if there was nothing to commit.
 */
export function gitCommitChanges(workspacePath: string, message: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: workspacePath,
      encoding: 'utf-8',
    }).trim();

    if (!status) {
      return false; // Nothing to commit
    }

    execSync('git add -A', {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    execFileSync('git', ['commit', '-m', message], {
      cwd: workspacePath,
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    return true;
  } catch {
    console.log(`  [git] Warning: failed to commit changes: ${message}`);
    return false;
  }
}

/**
 * Runs tests in the workspace and returns the results.
 * Tries common test commands in order of preference.
 */
export function runWorkspaceTests(
  workspacePath: string,
  timeoutMs: number = 300_000
): WorkspaceTestResult {
  const sections: string[] = [];
  const checks: TestCheckResult[] = [];

  function runCheck(name: string, command: string, tailLimit: number = 4000): void {
    try {
      const output = execSync(`${command} 2>&1`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: 'pipe',
      });
      const trimmed = (output || '').trim();
      const finalOutput = trimmed.length > tailLimit ? trimmed.slice(-tailLimit) : trimmed;
      checks.push({
        name,
        command,
        success: true,
        output: finalOutput || 'No output',
      });
      sections.push(
        `## ${name} (${command})\n\`\`\`\n${finalOutput || 'No output'}\n\`\`\``
      );
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const raw = `${e.stdout || ''}\n${e.stderr || ''}`.trim() || e.message || 'unknown error';
      const finalOutput = raw.length > tailLimit ? raw.slice(-tailLimit) : raw;
      checks.push({
        name,
        command,
        success: false,
        output: finalOutput,
      });
      sections.push(`## ${name} (${command})\n\`\`\`\n${finalOutput}\n\`\`\``);
    }
  }

  runCheck('TypeScript Typecheck', 'npm run typecheck --if-present');
  runCheck('Lint', 'npm run lint --if-present');
  runCheck('Build', 'npm run build --if-present');
  runCheck('Tests', 'npm test --if-present');

  return {
    report: sections.join('\n\n') || '(no test results available)',
    checks,
    allPassed: checks.every((c) => c.success),
  };
}
