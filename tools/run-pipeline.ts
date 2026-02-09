#!/usr/bin/env npx ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { runAgent, buildPrompt, cleanArtifact, estimateTokens, Engine, AgentResult } from './lib/agent';
import { bootstrapRepo, gitStatusCheckpoint, gitDiffStat, gitCommitChanges, runWorkspaceTests } from './lib/git';
import { summarizeRepoBaseline } from './lib/workspace';
import {
  RunConfig,
  validateArtifactsExist,
  validateArtifactContent,
  loadConfig,
  saveConfig,
  readArtifact,
  validateOwner,
  validateRepoName,
  validateTemplateRepo,
  validateVisibility,
  validateEngine,
  validatePhaseId,
  validateTimeout,
  validateBudget,
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

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000]; // 30s, 60s, 120s

// Phases where human approval is requested in interactive mode
const APPROVAL_GATES = new Set(['3', '3.5', '6']);

// Context window warning threshold (tokens)
const CONTEXT_WARNING_THRESHOLD = 80_000;
const MAX_ARTIFACT_REPAIR_ATTEMPTS = 1;
const MAX_TEST_REPAIR_ATTEMPTS = 2;

interface PhaseDefinition {
  id: string;
  name: string;
  promptFile: string | null;
  needsRepo: boolean;
  artifactFile: string | null;
  requiredPhases: string[];
}

const PHASES: PhaseDefinition[] = [
  { id: '0', name: 'Idea Intake', promptFile: '00_idea_intake.md', needsRepo: false, artifactFile: '00_idea_intake.md', requiredPhases: [] },
  { id: '1', name: 'Problem Framing', promptFile: '01_problem_framing.md', needsRepo: false, artifactFile: '01_problem_framing.md', requiredPhases: ['0'] },
  { id: '2', name: 'Workflows', promptFile: '02_workflows.md', needsRepo: false, artifactFile: '02_workflows.md', requiredPhases: ['0', '1'] },
  { id: '2.5', name: 'Design & Theme', promptFile: '02b_design_theme.md', needsRepo: false, artifactFile: '02b_design_theme.md', requiredPhases: ['0', '1', '2'] },
  { id: '3', name: 'PRD', promptFile: '03_prd.md', needsRepo: false, artifactFile: '03_prd.md', requiredPhases: ['0', '1', '2'] },
  { id: '3.5', name: 'Repo Bootstrap', promptFile: null, needsRepo: false, artifactFile: '03b_repo_baseline.md', requiredPhases: ['3'] },
  { id: '4', name: 'Feasibility Review', promptFile: '04_feasibility_review.md', needsRepo: true, artifactFile: '04_feasibility_review.md', requiredPhases: ['0', '3', '3.5'] },
  { id: '5', name: 'Tech Spec', promptFile: '05_tech_spec.md', needsRepo: true, artifactFile: '05_tech_spec.md', requiredPhases: ['3', '3.5', '4'] },
  { id: '6', name: 'Task Breakdown', promptFile: '06_task_breakdown.md', needsRepo: true, artifactFile: '06_task_breakdown.md', requiredPhases: ['3', '4', '5'] },
  { id: '7', name: 'Implementation', promptFile: '07_implementation.md', needsRepo: true, artifactFile: null, requiredPhases: ['3', '5', '6'] },
  { id: '7.5', name: 'Test & Verify', promptFile: null, needsRepo: true, artifactFile: '07b_test_results.md', requiredPhases: ['7'] },
  { id: '8', name: 'Audit', promptFile: '08_audit.md', needsRepo: true, artifactFile: '08_audit.md', requiredPhases: ['3', '5', '6', '7', '7.5'] },
];

const ARTIFACT_PHASE_IDS = new Set(
  PHASES.filter((phase) => phase.artifactFile !== null).map((phase) => phase.id)
);

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

interface CLIArgs {
  idea?: string;
  ideaFile?: string;
  resume?: string;
  fromPhase?: string;
  owner?: string;
  template?: string;
  visibility?: 'public' | 'private';
  repoName?: string;
  engine?: Engine;
  timeoutMs?: number;
  budgetUsd?: number;
  interactive?: boolean;
  dryRun?: boolean;
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = { interactive: true }; // interactive by default

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--resume':
        result.resume = args[++i];
        break;
      case '--idea-file':
        result.ideaFile = args[++i];
        break;
      case '--from-phase':
        result.fromPhase = args[++i];
        validatePhaseId(result.fromPhase);
        break;
      case '--owner': {
        const owner = args[++i];
        validateOwner(owner);
        result.owner = owner;
        break;
      }
      case '--template': {
        const tmpl = args[++i];
        validateTemplateRepo(tmpl);
        result.template = tmpl;
        break;
      }
      case '--visibility': {
        const vis = args[++i];
        validateVisibility(vis);
        result.visibility = vis;
        break;
      }
      case '--repo-name': {
        const name = args[++i];
        validateRepoName(name);
        result.repoName = name;
        break;
      }
      case '--engine': {
        const eng = args[++i];
        validateEngine(eng);
        result.engine = eng;
        break;
      }
      case '--timeout': {
        const mins = parseInt(args[++i], 10);
        validateTimeout(mins);
        result.timeoutMs = mins * 60 * 1000;
        break;
      }
      case '--budget': {
        const budget = parseFloat(args[++i]);
        validateBudget(budget);
        result.budgetUsd = budget;
        break;
      }
      case '--interactive':
        result.interactive = true;
        break;
      case '--auto':
        result.interactive = false;
        break;
      case '--dry-run':
        result.dryRun = true;
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
  --idea-file <path>       Read app idea from a Markdown/text file
  --resume <run-dir>       Resume from an existing run directory
  --from-phase <n>         Start from a specific phase (e.g., 4, 3.5)
  --owner <github-user>    GitHub owner for new repo (default: auto-detect)
  --template <owner/repo>  Template repo (default: ${DEFAULT_TEMPLATE})
  --visibility <pub|priv>  Repo visibility (default: ${DEFAULT_VISIBILITY})
  --repo-name <name>       Explicit repo name (default: slugified from idea)
  --engine <claude|codex>  AI engine to use (default: claude)
  --timeout <minutes>      Timeout per phase in minutes (default: no timeout)
  --budget <dollars>       Maximum total cost in USD (aborts if exceeded)
  --interactive            Pause for human approval at key phases (default)
  --auto                   Run all phases without pausing for approval
  --dry-run                Print assembled prompts without running agents
  --help                   Show this help message

Examples:
  npx ts-node tools/run-pipeline.ts "A task management app for remote teams"
  npx ts-node tools/run-pipeline.ts --idea-file ideas/orphan-app.md
  npx ts-node tools/run-pipeline.ts --budget 25 --auto "A task management app"
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_task-manager
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_task-manager --from-phase 4
  npx ts-node tools/run-pipeline.ts --dry-run "A task management app"
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

function loadIdeaFromFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Idea file not found: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, 'utf-8').trim();
  if (!content) {
    throw new Error(`Idea file is empty: ${resolved}`);
  }
  return content;
}

/**
 * Prompts the user for yes/no confirmation. Returns true if approved.
 */
async function promptApproval(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`\n${question} [Y/n] `, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

function retryAgent(
  prompt: string,
  options: Parameters<typeof runAgent>[1],
  phaseId: string,
  runDir: string
): AgentResult {
  let lastError: Error | null = null;
  const sleepArray = new Int32Array(new SharedArrayBuffer(4));

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return runAgent(prompt, options);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message;

      // Only retry on transient errors
      const isTransient =
        msg.includes('timed out') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNRESET') ||
        msg.includes('rate limit') ||
        msg.includes('429') ||
        msg.includes('503');

      if (!isTransient || attempt >= MAX_RETRIES) {
        throw lastError;
      }

      const delay = RETRY_DELAYS_MS[attempt] || 120_000;
      const delaySec = Math.round(delay / 1000);
      log(phaseId, `Attempt ${attempt + 1} failed (${msg}). Retrying in ${delaySec}s...`);
      appendLog(runDir, `Phase ${phaseId}: attempt ${attempt + 1} failed: ${msg}. Retrying in ${delaySec}s.`);

      // Cross-platform synchronous wait between retries.
      Atomics.wait(sleepArray, 0, 0, delay);
    }
  }

  throw lastError || new Error('All retry attempts failed');
}

// ---------------------------------------------------------------------------
// Cost Tracking
// ---------------------------------------------------------------------------

function trackCost(config: RunConfig, phaseId: string, costUsd: number): void {
  if (!config.phase_costs) config.phase_costs = {};
  config.phase_costs[phaseId] = (config.phase_costs[phaseId] || 0) + costUsd;
  config.total_cost_usd = (config.total_cost_usd || 0) + costUsd;
}

function checkBudget(config: RunConfig, budgetUsd: number | undefined): void {
  if (!budgetUsd) return;
  const total = config.total_cost_usd || 0;
  if (total >= budgetUsd) {
    throw new Error(
      `Budget limit exceeded: $${total.toFixed(2)} spent of $${budgetUsd.toFixed(2)} budget. ` +
      `Use --budget with a higher value or --resume to continue.`
    );
  }
  if (total >= budgetUsd * 0.8) {
    log('Budget', `Warning: $${total.toFixed(2)} of $${budgetUsd.toFixed(2)} budget used (${Math.round((total / budgetUsd) * 100)}%)`);
  }
}

function validatePhasePrerequisites(
  config: RunConfig,
  artifactsDir: string,
  phase: PhaseDefinition
): void {
  const incomplete = phase.requiredPhases.filter(
    (phaseId) => !config.completed_phases.includes(phaseId)
  );
  if (incomplete.length > 0) {
    throw new Error(
      `Phase ${phase.id} requires completed phases: ${incomplete.join(', ')}. ` +
      `Resume from an earlier phase to continue.`
    );
  }

  const requiredArtifacts = phase.requiredPhases.filter((phaseId) =>
    ARTIFACT_PHASE_IDS.has(phaseId)
  );
  validateArtifactsExist(artifactsDir, requiredArtifacts);
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

  // Previous artifacts — wrapped in boundary markers to mitigate prompt injection
  const artifactMap: Record<string, string> = {
    'ARTIFACT_00': '0',
    'ARTIFACT_01': '1',
    'ARTIFACT_02': '2',
    'ARTIFACT_025': '2.5',
    'ARTIFACT_03': '3',
    'ARTIFACT_03B': '3.5',
    'ARTIFACT_04': '4',
    'ARTIFACT_05': '5',
    'ARTIFACT_06': '6',
  };

  for (const [placeholder, phaseId] of Object.entries(artifactMap)) {
    try {
      const content = readArtifact(artifactsDir, phaseId);
      // Wrap artifacts in boundary markers to differentiate data from instructions
      replacements[placeholder] = `<artifact phase="${phaseId}">\n${content}\n</artifact>`;
    } catch {
      replacements[placeholder] = '(not available)';
    }
  }

  // For repo-dependent phases, Claude runs in the repo and can read files itself.
  // We provide git status data and test results for the audit phase.
  if (phase.needsRepo && config.workspace_path && fs.existsSync(config.workspace_path)) {
    replacements['GIT_DIFF'] = gitDiffStat(config.workspace_path);

    // Load real test results if available (generated by Phase 7.5)
    const testResultsPath = path.join(artifactsDir, '07b_test_results.md');
    if (fs.existsSync(testResultsPath)) {
      replacements['TEST_RESULTS'] = fs.readFileSync(testResultsPath, 'utf-8');
    } else {
      replacements['TEST_RESULTS'] = '(tests not yet run — Phase 7.5 will generate real results)';
    }
  } else {
    replacements['GIT_DIFF'] = '(no changes yet)';
    replacements['TEST_RESULTS'] = '(no tests run yet)';
  }

  // Task placeholder (used in phase 7)
  replacements['TASK'] = '(see individual task below)';

  return replacements;
}

// Phases that benefit from web research (library docs, API references, domain knowledge)
const WEB_SEARCH_PHASES = new Set(['0', '1', '2', '2.5', '3', '4', '5']);

function shouldRepairArtifact(warnings: string[], content: string): boolean {
  if (warnings.some((warning) => warning.includes('Missing expected section'))) return true;
  if (content.length === 8192) return true;
  if (!content.endsWith('\n') && /[a-zA-Z0-9]$/.test(content) && !/[.!?`)]$/.test(content)) {
    return true;
  }
  return false;
}

function buildArtifactRepairPrompt(
  phase: PhaseDefinition,
  previousOutput: string,
  warnings: string[]
): string {
  return [
    `You are repairing a markdown artifact for phase ${phase.id}: ${phase.name}.`,
    '',
    'The previous output did not satisfy structural checks.',
    '',
    'Validation warnings:',
    ...warnings.map((warning) => `- ${warning}`),
    '',
    'Previous output:',
    '```markdown',
    previousOutput,
    '```',
    '',
    'Rewrite the entire artifact from scratch so all required sections are fully present.',
    'Start immediately with the first H2 heading of the document.',
    'Do not include preamble, explanation, or tool logs.',
    'Do not truncate output.',
    'Output only the final markdown document.',
  ].join('\n');
}

function getMissingSectionWarnings(warnings: string[]): string[] {
  const missing: string[] = [];
  for (const warning of warnings) {
    const match = warning.match(/Missing expected section "([^"]+)"/i);
    if (match?.[1]) {
      missing.push(match[1]);
    }
  }
  return missing;
}

function buildMissingSectionsPrompt(
  phase: PhaseDefinition,
  baseDocument: string,
  missingSections: string[]
): string {
  return [
    `You are filling missing sections for phase ${phase.id}: ${phase.name}.`,
    '',
    'Current artifact (do not rewrite this entire document):',
    '```markdown',
    baseDocument,
    '```',
    '',
    `Missing required sections: ${missingSections.join(', ')}`,
    '',
    'Output only the missing sections as H2 headings with complete content.',
    'Do not repeat sections that already exist.',
    'Do not include preamble or closing remarks.',
  ].join('\n');
}

interface VerificationBlock {
  title: string;
  result: ReturnType<typeof runWorkspaceTests>;
}

function renderVerificationArtifact(blocks: VerificationBlock[]): string {
  const parts: string[] = ['# Phase 7.5: Test & Verification Results', ''];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const failedChecks = block.result.checks.filter((check) => !check.success);
    const summary = [
      `- Overall Result: ${block.result.allPassed ? 'PASS' : 'FAIL'}`,
      `- Passed Checks: ${block.result.checks.length - failedChecks.length}/${block.result.checks.length}`,
      ...(failedChecks.length > 0
        ? [`- Failed Checks: ${failedChecks.map((check) => check.name).join(', ')}`]
        : []),
    ].join('\n');

    parts.push(`## ${block.title}`);
    parts.push('');
    parts.push(summary);
    parts.push('');
    parts.push(block.result.report);
    parts.push('');

    if (i < blocks.length - 1) {
      parts.push('---');
      parts.push('');
    }
  }

  return parts.join('\n');
}

function buildTestRepairPrompt(
  artifactsDir: string,
  failedCheckNames: string[],
  testArtifactContent: string
): string {
  const prd = readArtifact(artifactsDir, '3');
  const techSpec = readArtifact(artifactsDir, '5');
  const taskBreakdown = readArtifact(artifactsDir, '6');

  return [
    'You are a senior software engineer fixing a repository after automated verification failures.',
    '',
    'Your objective is to make the failing checks pass without changing product scope.',
    'Do not add placeholder hacks, and do not silence failing checks.',
    '',
    `Failing checks: ${failedCheckNames.join(', ')}`,
    '',
    '## Test Results',
    testArtifactContent,
    '',
    '## PRD',
    prd,
    '',
    '## Tech Spec',
    techSpec,
    '',
    '## Task Breakdown',
    taskBreakdown,
    '',
    '## Instructions',
    '- Read relevant files before editing.',
    '- Make the smallest safe code changes required to pass checks.',
    '- Install dependencies if needed by repo scripts.',
    '- Run the failing checks locally before finishing.',
    '- Keep code style consistent with existing repo conventions.',
    '- Output a concise summary of changes made.',
  ].join('\n');
}

function runArtifactPhase(
  phase: PhaseDefinition,
  config: RunConfig,
  artifactsDir: string,
  runDir: string,
  opts: { budgetUsd?: number; dryRun?: boolean }
): void {
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase ${phase.id} (${phase.name}) started`);

  validatePhasePrerequisites(config, artifactsDir, phase);

  // Build prompt
  const promptPath = path.join(PROMPTS_DIR, phase.promptFile!);
  if (!fs.existsSync(promptPath)) {
    throw new Error(`Prompt template not found: ${promptPath}`);
  }

  const replacements = gatherReplacements(config, phase, artifactsDir);
  const fullPrompt = buildPrompt(promptPath, replacements);

  // Context window estimation
  const estimatedTokens = estimateTokens(fullPrompt);
  if (estimatedTokens > CONTEXT_WARNING_THRESHOLD) {
    log(phase.name, `Warning: Prompt is ~${estimatedTokens.toLocaleString()} tokens. This may approach context limits.`);
  }

  // Dry-run mode: print prompt info and skip execution
  if (opts.dryRun) {
    console.log(`  [dry-run] Phase ${phase.id} prompt: ${estimatedTokens.toLocaleString()} tokens`);
    console.log(`  [dry-run] Prompt file: ${promptPath}`);
    console.log(`  [dry-run] Required phases: ${phase.requiredPhases.join(', ') || 'none'}`);
    return;
  }

  // Check budget before calling agent
  checkBudget(config, opts.budgetUsd);

  const cwd = phase.needsRepo ? config.workspace_path : ROOT_DIR;
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(
      `Phase ${phase.id} requires a workspace path. Run phase 3.5 (Repo Bootstrap) first.`
    );
  }

  log(phase.name, `Calling ${config.engine}... (running in ${cwd})`);
  const result = retryAgent(fullPrompt, {
    cwd,
    engine: config.engine,
    timeoutMs: config.timeout_ms,
    permissions: 'read-only',
    webSearch: WEB_SEARCH_PHASES.has(phase.id),
    maxTurns: phase.needsRepo ? 15 : 12,
  }, phase.id, runDir);

  // Track cost
  trackCost(config, phase.id, result.costUsd);

  // Clean and validate artifact
  if (phase.artifactFile) {
    let cleaned = cleanArtifact(result.output);
    let warnings = validateArtifactContent(phase.id, cleaned);

    if (warnings.length > 0 && shouldRepairArtifact(warnings, cleaned)) {
      const maxRepairAttempts = config.engine === 'claude' ? 2 : MAX_ARTIFACT_REPAIR_ATTEMPTS;
      for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
        log(phase.name, `Attempting artifact repair (${attempt}/${maxRepairAttempts})...`);
        checkBudget(config, opts.budgetUsd);

        const repairPrompt = buildArtifactRepairPrompt(phase, cleaned, warnings);
        const repairResult = retryAgent(repairPrompt, {
          cwd,
          engine: config.engine,
          timeoutMs: config.timeout_ms,
          permissions: 'read-only',
          webSearch: false,
          maxTurns: phase.needsRepo ? 10 : 8,
        }, `${phase.id}-repair-${attempt}`, runDir);

        trackCost(config, phase.id, repairResult.costUsd);
        cleaned = cleanArtifact(repairResult.output);
        warnings = validateArtifactContent(phase.id, cleaned);

        if (!shouldRepairArtifact(warnings, cleaned)) {
          break;
        }
      }
    }

    const missingSections = getMissingSectionWarnings(warnings);
    if (missingSections.length > 0) {
      log(phase.name, `Backfilling missing sections: ${missingSections.join(', ')}`);
      checkBudget(config, opts.budgetUsd);

      const supplementPrompt = buildMissingSectionsPrompt(phase, cleaned, missingSections);
      const supplementResult = retryAgent(supplementPrompt, {
        cwd,
        engine: config.engine,
        timeoutMs: config.timeout_ms,
        permissions: 'read-only',
        webSearch: false,
        maxTurns: phase.needsRepo ? 8 : 6,
      }, `${phase.id}-section-backfill`, runDir);

      trackCost(config, phase.id, supplementResult.costUsd);
      const supplement = cleanArtifact(supplementResult.output);
      if (supplement.length > 0) {
        cleaned = `${cleaned.trim()}\n\n${supplement.trim()}\n`;
      }
      warnings = validateArtifactContent(phase.id, cleaned);
    }

    if (warnings.length > 0) {
      log(phase.name, 'Artifact warnings:');
      for (const w of warnings) {
        log(phase.name, `  - ${w}`);
      }
      appendLog(runDir, `Phase ${phase.id} warnings: ${warnings.join('; ')}`);
    }

    const artifactPath = path.join(artifactsDir, phase.artifactFile);
    fs.writeFileSync(artifactPath, cleaned + '\n');
    log(phase.name, `Artifact saved: ${artifactPath}`);
  }

  // Update config
  if (!config.completed_phases.includes(phase.id)) {
    config.completed_phases.push(phase.id);
  }
  config.current_phase = phase.id;
  appendLog(runDir, `Phase ${phase.id} (${phase.name}) completed | Cost: $${result.costUsd.toFixed(4)}`);
}

function runRepoBootstrap(config: RunConfig, artifactsDir: string, runDir: string): void {
  const phase = PHASES.find((p) => p.id === '3.5')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 3.5 (${phase.name}) started`);

  validatePhasePrerequisites(config, artifactsDir, phase);

  // Derive repo name from idea if not set
  if (!config.repo_name) {
    config.repo_name = slugify(config.idea);
  }
  validateRepoName(config.repo_name);

  // Set workspace path as sibling to the pipeline repo
  if (!config.workspace_path) {
    const workspaceParent = path.resolve(ROOT_DIR, '..');
    const resolvedWorkspace = path.resolve(workspaceParent, config.repo_name);
    const relative = path.relative(workspaceParent, resolvedWorkspace);
    if (
      relative === '' ||
      relative === '.' ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Invalid repo name path resolution: ${config.repo_name}`);
    }
    config.workspace_path = resolvedWorkspace;
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
  if (!config.completed_phases.includes('3.5')) {
    config.completed_phases.push('3.5');
  }
  config.current_phase = '3.5';
  appendLog(runDir, `Phase 3.5 (${phase.name}) completed`);
}

interface ImplementationTask {
  title: string;
  body: string;
}

function normalizeManifestTask(task: Record<string, unknown>, index: number): ImplementationTask | null {
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!title) return null;
  const taskId = typeof task.id === 'string' && task.id.trim() ? task.id.trim() : String(index + 1);

  const markdownBody = typeof task.markdown === 'string' ? task.markdown.trim() : '';
  if (markdownBody) {
    if (/^###\s+Task\b/i.test(markdownBody)) {
      return { title, body: markdownBody };
    }
    return { title, body: `### Task ${taskId}: ${title}\n\n${markdownBody}` };
  }

  const lines: string[] = [];
  lines.push(`### Task ${taskId}: ${title}`);
  lines.push('');

  if (typeof task.priority === 'string') lines.push(`**Priority**: ${task.priority}`);
  if (typeof task.complexity === 'string') lines.push(`**Complexity**: ${task.complexity}`);
  if (typeof task.milestone === 'string') lines.push(`**Milestone**: ${task.milestone}`);
  if (lines[lines.length - 1] !== '') lines.push('');

  if (typeof task.description === 'string' && task.description.trim()) {
    lines.push('**Description**:');
    lines.push(task.description.trim());
    lines.push('');
  }

  if (Array.isArray(task.targetFiles) && task.targetFiles.length > 0) {
    lines.push('**Target Files**:');
    for (const file of task.targetFiles) {
      if (typeof file === 'string') lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0) {
    lines.push('**Acceptance Criteria**:');
    for (const criterion of task.acceptanceCriteria) {
      if (typeof criterion === 'string') lines.push(`- [ ] ${criterion}`);
    }
    lines.push('');
  }

  if (Array.isArray(task.testExpectations) && task.testExpectations.length > 0) {
    lines.push('**Test Expectations**:');
    for (const testExpectation of task.testExpectations) {
      if (typeof testExpectation === 'string') lines.push(`- ${testExpectation}`);
    }
    lines.push('');
  }

  if (typeof task.dependencies === 'string' && task.dependencies.trim()) {
    lines.push('**Dependencies**:');
    lines.push(task.dependencies.trim());
    lines.push('');
  }

  if (typeof task.implementationNotes === 'string' && task.implementationNotes.trim()) {
    lines.push('**Implementation Notes**:');
    lines.push(task.implementationNotes.trim());
    lines.push('');
  }

  return { title, body: lines.join('\n').trim() };
}

function tryParseManifestBlock(raw: string): ImplementationTask[] {
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!parsed || !Array.isArray(parsed.tasks)) return [];

    const tasks: ImplementationTask[] = [];
    for (let i = 0; i < parsed.tasks.length; i++) {
      const entry = parsed.tasks[i];
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeManifestTask(entry as Record<string, unknown>, i);
      if (normalized) tasks.push(normalized);
    }
    return tasks;
  } catch {
    return [];
  }
}

function parseTaskManifest(taskBreakdown: string): ImplementationTask[] {
  const results: ImplementationTask[] = [];
  const taskManifestRegex = /```task-manifest\s*([\s\S]*?)```/gi;
  const jsonRegex = /```json\s*([\s\S]*?)```/gi;
  const xmlRegex = /<task_manifest>\s*([\s\S]*?)<\/task_manifest>/gi;

  for (const regex of [taskManifestRegex, jsonRegex, xmlRegex]) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(taskBreakdown)) !== null) {
      const parsed = tryParseManifestBlock(match[1]);
      if (parsed.length > 0) {
        results.push(...parsed);
      }
    }
  }

  return results;
}

function parseMarkdownTasks(taskBreakdown: string): ImplementationTask[] {
  const taskRegex = /### Task [^\n]+\n([\s\S]*?)(?=### Task |\n## |\n# |$)/g;
  const tasks: ImplementationTask[] = [];
  let match: RegExpExecArray | null;

  while ((match = taskRegex.exec(taskBreakdown)) !== null) {
    const fullMatch = match[0];
    const titleMatch = fullMatch.match(/### Task ([^\n]+)/);
    tasks.push({
      title: titleMatch ? titleMatch[1].trim() : `Task ${tasks.length + 1}`,
      body: fullMatch.trim(),
    });
  }

  return tasks;
}

function runImplementation(
  config: RunConfig,
  artifactsDir: string,
  runDir: string,
  opts: { budgetUsd?: number; dryRun?: boolean }
): void {
  const phase = PHASES.find((p) => p.id === '7')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 7 (${phase.name}) started`);

  validatePhasePrerequisites(config, artifactsDir, phase);

  if (!config.workspace_path || !fs.existsSync(config.workspace_path)) {
    throw new Error('Workspace not found. Run repo bootstrap (phase 3.5) first.');
  }

  const taskBreakdown = readArtifact(artifactsDir, '6');
  const tasks = parseTaskManifest(taskBreakdown);
  const usedManifest = tasks.length > 0;
  if (!usedManifest) {
    tasks.push(...parseMarkdownTasks(taskBreakdown));
  }

  if (usedManifest) {
    log(phase.name, `Parsed ${tasks.length} tasks from machine-readable task manifest`);
  }

  if (tasks.length === 0) {
    // Fallback: send entire breakdown as one task
    log(phase.name, 'Could not parse individual tasks. Running as single implementation pass.');
    tasks.push({ title: 'Full Implementation', body: taskBreakdown });
  }

  log(phase.name, `Found ${tasks.length} tasks to implement`);

  // Dry-run mode
  if (opts.dryRun) {
    console.log(`  [dry-run] Phase 7: ${tasks.length} tasks to implement`);
    for (let i = 0; i < tasks.length; i++) {
      console.log(`  [dry-run]   Task ${i + 1}: ${tasks[i].title}`);
    }
    return;
  }

  // Record pre-implementation status
  const preStatus = gitStatusCheckpoint(config.workspace_path);
  appendLog(runDir, `Pre-implementation git status:\n${preStatus}`);

  // Skip already-completed tasks (task-level checkpointing)
  const startTask = config.last_completed_task || 0;
  if (startTask > 0) {
    log(phase.name, `Resuming from task ${startTask + 1} (${startTask} already completed)`);
  }

  // Execute each task
  for (let i = startTask; i < tasks.length; i++) {
    const task = tasks[i];
    log(phase.name, `Implementing task ${i + 1}/${tasks.length}: ${task.title}`);

    // Check budget before each task
    checkBudget(config, opts.budgetUsd);

    const promptPath = path.join(PROMPTS_DIR, phase.promptFile!);
    const replacements = gatherReplacements(config, phase, artifactsDir);
    replacements['TASK'] = task.body;

    const fullPrompt = buildPrompt(promptPath, replacements);

    // Run AI agent in the workspace directory with edit permissions
    const result = retryAgent(fullPrompt, {
      cwd: config.workspace_path,
      maxTurns: 20,
      permissions: 'read-write',
      engine: config.engine,
      timeoutMs: config.timeout_ms,
    }, `7-task-${i + 1}`, runDir);

    // Track cost
    trackCost(config, '7', result.costUsd);

    // Commit changes after each task for rollback safety
    const committed = gitCommitChanges(
      config.workspace_path!,
      `Pipeline Phase 7 - Task ${i + 1}/${tasks.length}: ${task.title}`
    );
    if (committed) {
      log(phase.name, `  Committed changes for task ${i + 1}`);
    }

    // Update task checkpoint
    config.last_completed_task = i + 1;
    saveConfig(runDir, config);

    // Record status after each task
    const postStatus = gitStatusCheckpoint(config.workspace_path!);
    appendLog(
      runDir,
      `After task "${task.title}" (cost: $${result.costUsd.toFixed(4)}):\n${postStatus}`
    );

    log(phase.name, `Task ${i + 1}/${tasks.length} complete`);
  }

  // Record post-implementation status
  const finalDiff = gitDiffStat(config.workspace_path!);
  appendLog(runDir, `Post-implementation diff:\n${finalDiff}`);

  if (!config.completed_phases.includes('7')) {
    config.completed_phases.push('7');
  }
  config.current_phase = '7';
  appendLog(runDir, `Phase 7 (${phase.name}) completed`);
}

/**
 * Phase 7.5: Run tests in the workspace and save results as an artifact.
 * This feeds real test results into the Phase 8 audit.
 */
function runTestVerification(
  config: RunConfig,
  artifactsDir: string,
  runDir: string,
  opts: { dryRun?: boolean; budgetUsd?: number }
): void {
  const phase = PHASES.find((p) => p.id === '7.5')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 7.5 (${phase.name}) started`);
  validatePhasePrerequisites(config, artifactsDir, phase);

  if (!config.workspace_path || !fs.existsSync(config.workspace_path)) {
    throw new Error('Workspace not found for test verification.');
  }

  if (opts.dryRun) {
    console.log('  [dry-run] Phase 7.5: Would run typecheck, lint, build, and tests');
    return;
  }

  log(phase.name, 'Running typecheck, lint, build, and tests...');
  const artifactPath = path.join(artifactsDir, '07b_test_results.md');
  const verificationBlocks: VerificationBlock[] = [];
  let latestResults = runWorkspaceTests(config.workspace_path);
  verificationBlocks.push({
    title: 'Initial Verification',
    result: latestResults,
  });
  fs.writeFileSync(artifactPath, renderVerificationArtifact(verificationBlocks) + '\n');
  log(phase.name, `Test results saved: ${artifactPath}`);

  if (!latestResults.allPassed) {
    for (let attempt = 1; attempt <= MAX_TEST_REPAIR_ATTEMPTS; attempt++) {
      const failedChecks = latestResults.checks
        .filter((check) => !check.success)
        .map((check) => check.name);
      log(
        phase.name,
        `Verification failed (${failedChecks.join(', ')}). Starting repair attempt ${attempt}/${MAX_TEST_REPAIR_ATTEMPTS}...`
      );

      checkBudget(config, opts.budgetUsd);
      const repairPrompt = buildTestRepairPrompt(
        artifactsDir,
        failedChecks,
        renderVerificationArtifact(verificationBlocks)
      );
      const repairResult = retryAgent(repairPrompt, {
        cwd: config.workspace_path,
        maxTurns: 20,
        permissions: 'read-write',
        engine: config.engine,
        timeoutMs: config.timeout_ms,
      }, `7.5-repair-${attempt}`, runDir);
      trackCost(config, '7.5', repairResult.costUsd);

      const committed = gitCommitChanges(
        config.workspace_path,
        `Pipeline Phase 7.5 - Verification repair attempt ${attempt}`
      );
      if (committed) {
        log(phase.name, `Committed verification repair attempt ${attempt}.`);
      }

      latestResults = runWorkspaceTests(config.workspace_path);
      verificationBlocks.push({
        title: `Repair Attempt ${attempt} Verification`,
        result: latestResults,
      });
      fs.writeFileSync(artifactPath, renderVerificationArtifact(verificationBlocks) + '\n');
      log(phase.name, `Updated test results saved: ${artifactPath}`);

      if (latestResults.allPassed) {
        break;
      }
    }
  }

  if (!latestResults.allPassed) {
    const failedChecks = latestResults.checks
      .filter((check) => !check.success)
      .map((check) => check.name);
    appendLog(runDir, `Phase 7.5 failed after repair attempts: ${failedChecks.join(', ')}`);
    throw new Error(`Phase 7.5 failed after repair attempts. Checks failed: ${failedChecks.join(', ')}`);
  }

  // Commit any test-related changes (e.g., lockfile updates)
  gitCommitChanges(config.workspace_path, 'Pipeline Phase 7.5 - Post-implementation test verification');

  if (!config.completed_phases.includes('7.5')) {
    config.completed_phases.push('7.5');
  }
  config.current_phase = '7.5';
  appendLog(runDir, `Phase 7.5 (${phase.name}) completed`);
}

// ---------------------------------------------------------------------------
// Run Report Generation
// ---------------------------------------------------------------------------

function generateRunReport(config: RunConfig, runDir: string): void {
  const sections: string[] = [];

  sections.push('# Pipeline Run Report\n');
  sections.push(`- **Run ID**: ${config.run_id}`);
  sections.push(`- **Idea**: ${config.idea}`);
  sections.push(`- **Engine**: ${config.engine}`);
  if (config.repo_url) sections.push(`- **Repo**: ${config.repo_url}`);
  if (config.workspace_path) sections.push(`- **Workspace**: ${config.workspace_path}`);
  sections.push(`- **Completed Phases**: ${config.completed_phases.join(', ')}`);
  sections.push('');

  // Cost summary
  if (config.total_cost_usd) {
    sections.push('## Cost Summary\n');
    sections.push(`**Total**: $${config.total_cost_usd.toFixed(4)}\n`);
    if (config.phase_costs) {
      sections.push('| Phase | Cost |');
      sections.push('|-------|------|');
      for (const [phaseId, cost] of Object.entries(config.phase_costs)) {
        const phaseName = PHASES.find((p) => p.id === phaseId)?.name || phaseId;
        sections.push(`| ${phaseId} - ${phaseName} | $${cost.toFixed(4)} |`);
      }
      sections.push('');
    }
  }

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, sections.join('\n') + '\n');
  log('Report', `Run report saved: ${reportPath}`);
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
    if (config.total_cost_usd) {
      log('Resume', `Cost so far: $${config.total_cost_usd.toFixed(4)}`);
    }
  } else {
    if (args.idea && args.ideaFile) {
      throw new Error('Provide either a quoted idea or --idea-file, not both.');
    }

    const idea = args.ideaFile ? loadIdeaFromFile(args.ideaFile) : args.idea;
    if (!idea) {
      printUsage();
      process.exit(1);
    }

    // New run
    const slug = slugify(idea);
    const runId = `${timestamp()}_${slug}`;
    runDir = path.join(RUNS_DIR, runId);
    artifactsDir = path.join(runDir, 'artifacts');

    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });

    const owner = args.owner || getGitHubOwner();

    config = {
      run_id: runId,
      idea,
      repo_name: args.repoName,
      repo_owner: owner,
      template_repo: args.template || DEFAULT_TEMPLATE,
      default_branch: DEFAULT_BRANCH,
      visibility: args.visibility || DEFAULT_VISIBILITY,
      engine: args.engine || 'claude',
      timeout_ms: args.timeoutMs,
      current_phase: '-1',
      completed_phases: [],
      total_cost_usd: 0,
      phase_costs: {},
    };

    saveConfig(runDir, config);
    log('Init', `New run created: ${runId}`);
    log('Init', `Run directory: ${runDir}`);
    if (args.budgetUsd) {
      log('Init', `Budget limit: $${args.budgetUsd.toFixed(2)}`);
    }
  }

  // Determine starting phase
  let startPhaseId = args.fromPhase ?? '';
  if (!startPhaseId) {
    // Find the next uncompleted phase
    for (const phase of PHASES) {
      if (!config.completed_phases.includes(phase.id)) {
        startPhaseId = phase.id;
        break;
      }
    }
    if (!startPhaseId) {
      log('Done', 'All phases already completed!');
      generateRunReport(config, runDir);
      return;
    }
  }

  log('Pipeline', `Starting from phase ${startPhaseId}`);
  if (args.dryRun) {
    log('Pipeline', 'DRY RUN MODE — prompts will be assembled but agents will not be called');
  }

  // Execute phases
  for (const phase of PHASES) {
    if (PHASES.indexOf(phase) < PHASES.findIndex((p) => p.id === startPhaseId)) continue;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  Phase ${phase.id}: ${phase.name}`);
    console.log(`${'='.repeat(60)}\n`);

    // Human approval gate (in interactive mode)
    if (args.interactive && !args.dryRun && APPROVAL_GATES.has(phase.id)) {
      const costStr = config.total_cost_usd ? ` (cost so far: $${config.total_cost_usd.toFixed(2)})` : '';
      const approved = await promptApproval(
        `Phase ${phase.id} (${phase.name}) is about to run${costStr}. Continue?`
      );
      if (!approved) {
        log(phase.name, 'Skipped by user. Pipeline paused.');
        appendLog(runDir, `Phase ${phase.id} skipped by user`);
        saveConfig(runDir, config);
        console.log(`\nPipeline paused. Resume with: --resume ${runDir} --from-phase ${phase.id}`);
        return;
      }
    }

    if (phase.id === '3.5') {
      if (args.dryRun) {
        console.log('  [dry-run] Phase 3.5: Would create GitHub repo and generate baseline');
      } else {
        runRepoBootstrap(config, artifactsDir, runDir);
      }
    } else if (phase.id === '7') {
      runImplementation(config, artifactsDir, runDir, {
        budgetUsd: args.budgetUsd,
        dryRun: args.dryRun,
      });
    } else if (phase.id === '7.5') {
      runTestVerification(config, artifactsDir, runDir, {
        dryRun: args.dryRun,
        budgetUsd: args.budgetUsd,
      });
    } else {
      runArtifactPhase(phase, config, artifactsDir, runDir, {
        budgetUsd: args.budgetUsd,
        dryRun: args.dryRun,
      });
    }

    // Save config after each phase
    saveConfig(runDir, config);

    log(phase.name, 'Phase complete.\n');
  }

  // Generate run report
  generateRunReport(config, runDir);

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
  if (config.total_cost_usd) {
    console.log(`Total cost: $${config.total_cost_usd.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error('\nPipeline failed:', err.message);
  process.exit(1);
});
