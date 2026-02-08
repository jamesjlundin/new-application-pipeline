#!/usr/bin/env npx ts-node

import * as fs from 'fs';
import * as path from 'path';
import { runAgent, buildPrompt, Engine } from './lib/claude';
import { bootstrapRepo, gitStatusCheckpoint, gitDiffStat } from './lib/git';
import { summarizeRepoBaseline } from './lib/workspace';
import {
  RunConfig,
  validateArtifactsExist,
  loadConfig,
  saveConfig,
  readArtifact,
} from './lib/validate';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT_DIR = path.resolve(__dirname, '..');
const PROMPTS_DIR = path.join(ROOT_DIR, 'prompts');
const RUNS_DIR = path.join(ROOT_DIR, 'runs');

const DEFAULT_TEMPLATE = 'jamesjlundin/full-stack-web-and-mobile-template';
const DEFAULT_VISIBILITY = 'public' as const;
const DEFAULT_BRANCH = 'main';

interface PhaseDefinition {
  id: number;
  name: string;
  promptFile: string | null;
  needsRepo: boolean;
  artifactFile: string | null;
  requiredPhases: number[];
}

const PHASES: PhaseDefinition[] = [
  { id: 0, name: 'Idea Intake', promptFile: '00_idea_intake.md', needsRepo: false, artifactFile: '00_idea_intake.md', requiredPhases: [] },
  { id: 1, name: 'Problem Framing', promptFile: '01_problem_framing.md', needsRepo: false, artifactFile: '01_problem_framing.md', requiredPhases: [0] },
  { id: 2, name: 'Workflows', promptFile: '02_workflows.md', needsRepo: false, artifactFile: '02_workflows.md', requiredPhases: [0, 1] },
  { id: 3, name: 'PRD', promptFile: '03_prd.md', needsRepo: false, artifactFile: '03_prd.md', requiredPhases: [0, 1, 2] },
  { id: 3.5, name: 'Repo Bootstrap', promptFile: null, needsRepo: false, artifactFile: '03b_repo_baseline.md', requiredPhases: [3] },
  { id: 4, name: 'Feasibility Review', promptFile: '04_feasibility_review.md', needsRepo: true, artifactFile: '04_feasibility_review.md', requiredPhases: [0, 3, 3.5] },
  { id: 5, name: 'Tech Spec', promptFile: '05_tech_spec.md', needsRepo: true, artifactFile: '05_tech_spec.md', requiredPhases: [3, 3.5, 4] },
  { id: 6, name: 'Task Breakdown', promptFile: '06_task_breakdown.md', needsRepo: true, artifactFile: '06_task_breakdown.md', requiredPhases: [3, 4, 5] },
  { id: 7, name: 'Implementation', promptFile: '07_implementation.md', needsRepo: true, artifactFile: null, requiredPhases: [5, 6] },
  { id: 8, name: 'Audit', promptFile: '08_audit.md', needsRepo: true, artifactFile: '08_audit.md', requiredPhases: [3, 5, 6] },
];

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  idea?: string;
  resume?: string;
  fromPhase?: number;
  owner?: string;
  template?: string;
  visibility?: 'public' | 'private';
  repoName?: string;
  engine?: Engine;
  timeoutMs?: number;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume':
        result.resume = args[++i];
        break;
      case '--from-phase':
        result.fromPhase = parseFloat(args[++i]);
        break;
      case '--owner':
        result.owner = args[++i];
        break;
      case '--template':
        result.template = args[++i];
        break;
      case '--visibility':
        result.visibility = args[++i] as 'public' | 'private';
        break;
      case '--repo-name':
        result.repoName = args[++i];
        break;
      case '--engine':
        result.engine = args[++i] as Engine;
        break;
      case '--timeout':
        result.timeoutMs = parseInt(args[++i], 10) * 60 * 1000; // input in minutes
        break;
      case '--help':
        printUsage();
        process.exit(0);
      default:
        if (!args[i].startsWith('--')) {
          result.idea = args[i];
        }
        break;
    }
  }

  return result;
}

function printUsage(): void {
  console.log(`
Usage: npx ts-node tools/run-pipeline.ts [options] "<idea>"

Options:
  --resume <run-dir>       Resume from an existing run directory
  --from-phase <n>         Start from a specific phase (e.g., 4, 3.5)
  --owner <github-user>    GitHub owner for new repo (default: auto-detect)
  --template <owner/repo>  Template repo (default: ${DEFAULT_TEMPLATE})
  --visibility <pub|priv>  Repo visibility (default: ${DEFAULT_VISIBILITY})
  --repo-name <name>       Explicit repo name (default: slugified from idea)
  --engine <claude|codex>  AI engine to use (default: claude)
  --timeout <minutes>      Timeout per phase in minutes (default: no timeout)
  --help                   Show this help message

Examples:
  npx ts-node tools/run-pipeline.ts "A task management app for remote teams"
  npx ts-node tools/run-pipeline.ts --repo-name my-task-app "A task management app for remote teams"
  npx ts-node tools/run-pipeline.ts --engine codex "A task management app for remote teams"
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_task-manager
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_task-manager --from-phase 4
`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function timestamp(): string {
  return new Date().toISOString().split('T')[0];
}

function log(phase: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${phase}] ${message}`);
}

function appendLog(runDir: string, message: string): void {
  const logDir = path.join(runDir, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'pipeline.log');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

function getGitHubOwner(): string {
  try {
    const { execSync } = require('child_process');
    const result = execSync('gh api user --jq .login', { encoding: 'utf-8' });
    return result.trim();
  } catch {
    throw new Error(
      'Could not detect GitHub user. Pass --owner <username> or ensure `gh` is authenticated.'
    );
  }
}

// ---------------------------------------------------------------------------
// Phase Execution
// ---------------------------------------------------------------------------

function loadTemplateContext(): string {
  const templateContextPath = path.join(PROMPTS_DIR, 'template_context.md');
  if (fs.existsSync(templateContextPath)) {
    return fs.readFileSync(templateContextPath, 'utf-8');
  }
  return '(no template context available)';
}

function gatherReplacements(
  config: RunConfig,
  phase: PhaseDefinition,
  artifactsDir: string
): Record<string, string> {
  const replacements: Record<string, string> = {};

  // Raw idea
  replacements['IDEA'] = config.idea;

  // Template context — injected into every phase so the model knows what already exists
  replacements['TEMPLATE_CONTEXT'] = loadTemplateContext();

  // Previous artifacts
  const artifactMap: Record<string, number> = {
    'ARTIFACT_00': 0,
    'ARTIFACT_01': 1,
    'ARTIFACT_02': 2,
    'ARTIFACT_03': 3,
    'ARTIFACT_03B': 3.5,
    'ARTIFACT_04': 4,
    'ARTIFACT_05': 5,
    'ARTIFACT_06': 6,
  };

  for (const [placeholder, phaseId] of Object.entries(artifactMap)) {
    try {
      replacements[placeholder] = readArtifact(artifactsDir, phaseId);
    } catch {
      replacements[placeholder] = '(not available)';
    }
  }

  // For repo-dependent phases, Claude runs in the repo and can read files itself.
  // We just provide git status data that's useful for the audit phase.
  if (phase.needsRepo && config.workspace_path && fs.existsSync(config.workspace_path)) {
    replacements['GIT_DIFF'] = gitDiffStat(config.workspace_path);
    replacements['TEST_RESULTS'] = '(run tests manually or integrate test runner)';
  } else {
    replacements['GIT_DIFF'] = '(no changes yet)';
    replacements['TEST_RESULTS'] = '(no tests run yet)';
  }

  // Task placeholder (used in phase 7)
  replacements['TASK'] = '(see individual task below)';

  return replacements;
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

function runArtifactPhase(
  phase: PhaseDefinition,
  config: RunConfig,
  artifactsDir: string
): void {
  log(phase.name, 'Starting...');
  appendLog(path.dirname(artifactsDir), `Phase ${phase.id} (${phase.name}) started`);

  // Validate required artifacts exist
  validateArtifactsExist(artifactsDir, phase.requiredPhases);

  // Build prompt
  const promptPath = path.join(PROMPTS_DIR, phase.promptFile!);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt template not found: ${promptPath}`);
  }

  const replacements = gatherReplacements(config, phase, artifactsDir);
  const fullPrompt = buildPrompt(promptPath, replacements);

  // For repo-dependent phases, run in the workspace with read tools
  // so the model can explore the codebase itself instead of getting a bloated prompt
  const useRepo = phase.needsRepo && config.workspace_path && fs.existsSync(config.workspace_path);

  log(phase.name, `Calling ${config.engine}...${useRepo ? ` (running in ${config.workspace_path})` : ''}`);
  const result = runAgent(fullPrompt, {
    engine: config.engine,
    timeoutMs: config.timeout_ms,
    ...(useRepo ? {
      cwd: config.workspace_path,
      allowedTools: READ_ONLY_TOOLS,
      maxTurns: 15,
    } : {}),
  });

  // Save artifact
  if (phase.artifactFile) {
    const artifactPath = path.join(artifactsDir, phase.artifactFile);
    fs.writeFileSync(artifactPath, result + '\n');
    log(phase.name, `Artifact saved: ${artifactPath}`);
  }

  // Update config
  if (!config.completed_phases.includes(phase.id)) {
    config.completed_phases.push(phase.id);
  }
  config.current_phase = phase.id;
  appendLog(path.dirname(artifactsDir), `Phase ${phase.id} (${phase.name}) completed`);
}

function runRepoBootstrap(config: RunConfig, artifactsDir: string): void {
  const phase = PHASES.find((p) => p.id === 3.5)!;
  log(phase.name, 'Starting...');
  appendLog(path.dirname(artifactsDir), `Phase 3.5 (${phase.name}) started`);

  // Validate PRD exists
  validateArtifactsExist(artifactsDir, [3]);

  // Derive repo name from idea if not set
  if (!config.repo_name) {
    config.repo_name = slugify(config.idea);
  }

  // Set workspace path as sibling to the pipeline repo
  if (!config.workspace_path) {
    config.workspace_path = path.resolve(ROOT_DIR, '..', config.repo_name);
  }

  // Bootstrap the repo
  const result = bootstrapRepo({
    repoName: config.repo_name,
    repoOwner: config.repo_owner,
    templateRepo: config.template_repo,
    workspacePath: config.workspace_path,
    visibility: config.visibility,
  });

  config.repo_url = result.repoUrl;
  config.workspace_path = result.workspacePath;

  // Generate repo baseline
  log(phase.name, 'Generating repo baseline...');
  const baseline = summarizeRepoBaseline(config.workspace_path);
  const baselinePath = path.join(artifactsDir, '03b_repo_baseline.md');
  fs.writeFileSync(baselinePath, baseline + '\n');
  log(phase.name, `Baseline saved: ${baselinePath}`);

  // Update config
  if (!config.completed_phases.includes(3.5)) {
    config.completed_phases.push(3.5);
  }
  config.current_phase = 3.5;
  appendLog(path.dirname(artifactsDir), `Phase 3.5 (${phase.name}) completed`);
}

function runImplementation(config: RunConfig, artifactsDir: string): void {
  const phase = PHASES.find((p) => p.id === 7)!;
  log(phase.name, 'Starting...');
  appendLog(path.dirname(artifactsDir), `Phase 7 (${phase.name}) started`);

  validateArtifactsExist(artifactsDir, phase.requiredPhases);

  if (!config.workspace_path || !fs.existsSync(config.workspace_path)) {
    throw new Error('Workspace not found. Run repo bootstrap (phase 3.5) first.');
  }

  const taskBreakdown = readArtifact(artifactsDir, 6);
  const techSpec = readArtifact(artifactsDir, 5);

  // Extract tasks from breakdown (look for ### Task patterns)
  const taskRegex = /### Task [^\n]+\n([\s\S]*?)(?=### Task |\n## |\n# |$)/g;
  const tasks: { title: string; body: string }[] = [];
  let match;

  while ((match = taskRegex.exec(taskBreakdown)) !== null) {
    const fullMatch = match[0];
    const titleMatch = fullMatch.match(/### Task ([^\n]+)/);
    tasks.push({
      title: titleMatch ? titleMatch[1].trim() : `Task ${tasks.length + 1}`,
      body: fullMatch.trim(),
    });
  }

  if (tasks.length === 0) {
    // Fallback: send entire breakdown as one task
    log(phase.name, 'Could not parse individual tasks. Running as single implementation pass.');
    tasks.push({ title: 'Full Implementation', body: taskBreakdown });
  }

  log(phase.name, `Found ${tasks.length} tasks to implement`);

  // Record pre-implementation status
  const preStatus = gitStatusCheckpoint(config.workspace_path);
  appendLog(path.dirname(artifactsDir), `Pre-implementation git status:\n${preStatus}`);

  // Execute each task
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    log(phase.name, `Implementing task ${i + 1}/${tasks.length}: ${task.title}`);

    const promptPath = path.join(PROMPTS_DIR, phase.promptFile!);
    const replacements = gatherReplacements(config, phase, artifactsDir);
    replacements['TASK'] = task.body;

    const fullPrompt = buildPrompt(promptPath, replacements);

    // Run AI agent in the workspace directory with edit permissions
    runAgent(fullPrompt, {
      cwd: config.workspace_path,
      maxTurns: 20,
      allowedTools: ['Edit', 'Write', 'Bash', 'Read', 'Glob', 'Grep'],
      engine: config.engine,
      timeoutMs: config.timeout_ms,
    });

    // Record status after each task
    const postStatus = gitStatusCheckpoint(config.workspace_path);
    appendLog(
      path.dirname(artifactsDir),
      `After task "${task.title}":\n${postStatus}`
    );

    log(phase.name, `Task ${i + 1}/${tasks.length} complete`);
  }

  // Record post-implementation status
  const finalDiff = gitDiffStat(config.workspace_path);
  appendLog(path.dirname(artifactsDir), `Post-implementation diff:\n${finalDiff}`);

  if (!config.completed_phases.includes(7)) {
    config.completed_phases.push(7);
  }
  config.current_phase = 7;
  appendLog(path.dirname(artifactsDir), `Phase 7 (${phase.name}) completed`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();

  let config: RunConfig;
  let runDir: string;
  let artifactsDir: string;

  if (args.resume) {
    // Resume existing run
    runDir = path.resolve(args.resume);
    if (!fs.existsSync(runDir)) {
      console.error(`Run directory not found: ${runDir}`);
      process.exit(1);
    }
    config = loadConfig(runDir);
    artifactsDir = path.join(runDir, 'artifacts');
    log('Resume', `Resuming run: ${config.run_id}`);
    log('Resume', `Completed phases: ${config.completed_phases.join(', ')}`);
  } else if (args.idea) {
    // New run
    const slug = slugify(args.idea);
    const runId = `${timestamp()}_${slug}`;
    runDir = path.join(RUNS_DIR, runId);
    artifactsDir = path.join(runDir, 'artifacts');

    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });

    const owner = args.owner || getGitHubOwner();

    config = {
      run_id: runId,
      idea: args.idea,
      repo_name: args.repoName,
      repo_owner: owner,
      template_repo: args.template || DEFAULT_TEMPLATE,
      default_branch: DEFAULT_BRANCH,
      visibility: args.visibility || DEFAULT_VISIBILITY,
      engine: args.engine || 'claude',
      timeout_ms: args.timeoutMs,
      current_phase: -1,
      completed_phases: [],
    };

    saveConfig(runDir, config);
    log('Init', `New run created: ${runId}`);
    log('Init', `Run directory: ${runDir}`);
  } else {
    printUsage();
    process.exit(1);
  }

  // Determine starting phase
  let startPhaseId = args.fromPhase ?? -1;
  if (startPhaseId === -1) {
    // Find the next uncompleted phase
    for (const phase of PHASES) {
      if (!config.completed_phases.includes(phase.id)) {
        startPhaseId = phase.id;
        break;
      }
    }
    if (startPhaseId === -1) {
      log('Done', 'All phases already completed!');
      return;
    }
  }

  log('Pipeline', `Starting from phase ${startPhaseId}`);

  // Execute phases
  for (const phase of PHASES) {
    if (phase.id < startPhaseId) continue;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Phase ${phase.id}: ${phase.name}`);
    console.log(`${'='.repeat(60)}\n`);

    if (phase.id === 3.5) {
      runRepoBootstrap(config, artifactsDir);
    } else if (phase.id === 7) {
      runImplementation(config, artifactsDir);
    } else {
      runArtifactPhase(phase, config, artifactsDir);
    }

    // Save config after each phase
    saveConfig(runDir, config);

    log(phase.name, 'Phase complete.\n');
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  Pipeline Complete!');
  console.log(`${'='.repeat(60)}`);
  console.log(`Run directory: ${runDir}`);
  if (config.workspace_path) {
    console.log(`Workspace: ${config.workspace_path}`);
  }
  if (config.repo_url) {
    console.log(`Repo: ${config.repo_url}`);
  }
}

main().catch((err) => {
  console.error('\nPipeline failed:', err.message);
  process.exit(1);
});
