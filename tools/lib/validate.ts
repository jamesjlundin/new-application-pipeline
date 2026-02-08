import * as fs from 'fs';
import * as path from 'path';

export interface RunConfig {
  run_id: string;
  idea: string;
  repo_name?: string;
  repo_owner: string;
  template_repo: string;
  workspace_path?: string;
  repo_url?: string;
  default_branch: string;
  visibility: 'public' | 'private';
  engine: 'claude' | 'codex';
  timeout_ms?: number;
  current_phase: number;
  completed_phases: number[];
}

const ARTIFACT_FILES: Record<number, string> = {
  0: '00_idea_intake.md',
  1: '01_problem_framing.md',
  2: '02_workflows.md',
  3: '03_prd.md',
  3.5: '03b_repo_baseline.md',
  4: '04_feasibility_review.md',
  5: '05_tech_spec.md',
  6: '06_task_breakdown.md',
  8: '08_audit.md',
};

export function validateArtifactsExist(artifactsDir: string, phases: number[]): void {
  const missing: string[] = [];

  for (const phase of phases) {
    const fileName = ARTIFACT_FILES[phase];
    if (!fileName) continue;

    const filePath = path.join(artifactsDir, fileName);
    if (!fs.existsSync(filePath)) {
      missing.push(`Phase ${phase}: ${fileName}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required artifacts:\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
        'Run earlier phases first or check the artifacts directory.'
    );
  }
}

export function validateConfig(config: RunConfig): void {
  const errors: string[] = [];

  if (!config.run_id) errors.push('run_id is required');
  if (!config.idea) errors.push('idea is required');
  if (!config.repo_owner) errors.push('repo_owner is required');
  if (!config.template_repo) errors.push('template_repo is required');

  if (config.visibility && !['public', 'private'].includes(config.visibility)) {
    errors.push('visibility must be "public" or "private"');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

export function loadConfig(runDir: string): RunConfig {
  const configPath = path.join(runDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as RunConfig;
  validateConfig(config);
  return config;
}

export function saveConfig(runDir: string, config: RunConfig): void {
  const configPath = path.join(runDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function readArtifact(artifactsDir: string, phase: number): string {
  const fileName = ARTIFACT_FILES[phase];
  if (!fileName) {
    throw new Error(`No artifact file defined for phase ${phase}`);
  }
  const filePath = path.join(artifactsDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Artifact not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}
