import { execSync } from 'child_process';
import * as path from 'path';

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

  // Create repo from template
  execSync(
    `gh repo create ${fullRepoName} --template ${templateRepo} --${visibility} --clone`,
    {
      cwd: path.dirname(workspacePath),
      encoding: 'utf-8',
      stdio: 'inherit',
    }
  );

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

