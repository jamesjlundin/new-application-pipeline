#!/usr/bin/env npx ts-node

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { runAgent, buildPrompt, cleanArtifact, estimateTokens, Engine, AgentResult } from './lib/agent';
import {
  bootstrapRepo,
  cleanupWorkspaceVerificationArtifacts,
  gitStatusCheckpoint,
  gitDiffStat,
  gitCommitChanges,
  getGitHeadSha,
  hasGitChanges,
  gitResetHard,
  TestCheckResult,
  WorkspaceTestResult,
  WorkspaceTestSuite,
  runWorkspaceDependencyInstall,
  runWorkspaceQualityChecks,
  runWorkspaceTests,
} from './lib/git';
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
const APPROVAL_GATES = new Set(['4', '5', '8', '11']);

// Context window warning threshold (tokens)
const CONTEXT_WARNING_THRESHOLD = 80_000;
const MAX_ARTIFACT_REPAIR_ATTEMPTS = 1;
const MAX_TEST_REPAIR_ATTEMPTS = 3;
const MAX_TEST_REPAIR_ATTEMPTS_CAP = 5;
const MAX_PHASE11_UX_REPAIR_ATTEMPTS = 2;
const MAX_PHASE12_AUDIT_REPAIR_ATTEMPTS = 2;
const MAX_PHASE12_VERIFICATION_REPAIR_ATTEMPTS = 2;
const MAX_TASK_QUALITY_REPAIR_ATTEMPTS = 2;
const MAX_CLAUDE_ARTIFACT_REPAIR_ATTEMPTS = 3;
const MAX_CLAUDE_MISSING_SECTION_BACKFILL_ATTEMPTS = 3;
const MAX_TARGET_FILES_PER_TASK = 6;
const MAX_ACCEPTANCE_CRITERIA_PER_TASK = 6;
const MAX_TASK_BODY_CHARS = 7_500;
const TASK_DECOMPOSITION_FILE_SLICE_SIZE = 4;
const TASK_DECOMPOSITION_ACCEPTANCE_SLICE_SIZE = 3;
const MAX_DYNAMIC_FOLLOW_UP_TASKS_PER_TASK = 4;
const TASK_PROMPT_CONTEXT_CHAR_LIMIT = 90_000;
const TEST_REPAIR_CONTEXT_CHAR_LIMIT = 130_000;
const TEST_REPAIR_EVIDENCE_MAX_CHARS = 14_000;
const PHASE11_REPAIR_CONTEXT_CHAR_LIMIT = 120_000;
const PHASE12_REPAIR_CONTEXT_CHAR_LIMIT = 130_000;
const CANONICAL_TEMPLATE_TEST_FILE_PATTERNS = [
  /^packages\/tests\/src\/.+\.test\.[cm]?[tj]sx?$/i,
  /^apps\/web\/e2e\/.+\.spec\.[cm]?[tj]sx?$/i,
  /^apps\/web\/e2e\/.+\.setup\.[cm]?[tj]sx?$/i,
];
const DISALLOWED_TEST_EXPECTATION_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bunit tests?\b/i, reason: 'unit-test expectation (template uses integration + e2e only)' },
  { pattern: /\btest:unit\b/i, reason: 'non-canonical test script (`test:unit`)' },
  { pattern: /\b(jest|mocha|cypress|ava|karma)\b/i, reason: 'non-template test framework reference' },
  {
    pattern: /\bpnpm\s+(?:run\s+)?test\b(?!:integration\b|:e2e\b)/i,
    reason: 'non-canonical `pnpm test` command (use `pnpm test:integration` / `pnpm test:e2e`)',
  },
  {
    pattern: /\bnpm\s+(?:run\s+)?test\b(?!:integration\b|:e2e\b)/i,
    reason: 'non-canonical `npm test` command (use `npm run test:integration --if-present` / `npm run test:e2e --if-present`)',
  },
  { pattern: /\b(?:npx|pnpm\s+exec)\s+vitest\b/i, reason: 'direct vitest command (use root test scripts)' },
  {
    pattern: /\b(?:npx|pnpm\s+exec)\s+playwright\b/i,
    reason: 'direct playwright command (use root `test:e2e` script)',
  },
];
const PHASE9_E2E_SETUP_SMOKE_TIMEOUT_MS = 12 * 60 * 1000;
const PHASE9_E2E_SETUP_SMOKE_KEYWORDS =
  /\b(auth|login|log in|sign in|signup|sign up|session|redirect|onboarding|better auth|playwright|e2e)\b/i;
const PHASE9_E2E_SETUP_SMOKE_FILE_HINTS = [
  'apps/web/e2e/',
  'apps/web/app/(auth',
  'apps/web/app/auth',
  'apps/web/app/(public)/login',
  'apps/web/app/(public)/signup',
  'apps/web/app/login',
  'apps/web/app/signup',
  'packages/auth/',
];

const CODEX_EST_INPUT_USD_PER_1M = Number.parseFloat(
  process.env.CODEX_EST_INPUT_USD_PER_1M || '3'
);
const CODEX_EST_OUTPUT_USD_PER_1M = Number.parseFloat(
  process.env.CODEX_EST_OUTPUT_USD_PER_1M || '15'
);

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
  { id: '3', name: 'Design & Theme', promptFile: '02b_design_theme.md', needsRepo: false, artifactFile: '02b_design_theme.md', requiredPhases: ['0', '1', '2'] },
  { id: '4', name: 'PRD', promptFile: '03_prd.md', needsRepo: false, artifactFile: '03_prd.md', requiredPhases: ['0', '1', '2', '3'] },
  { id: '5', name: 'Repo Bootstrap', promptFile: null, needsRepo: false, artifactFile: '03b_repo_baseline.md', requiredPhases: ['4'] },
  { id: '6', name: 'Feasibility Review', promptFile: '04_feasibility_review.md', needsRepo: true, artifactFile: '04_feasibility_review.md', requiredPhases: ['0', '4', '5'] },
  { id: '7', name: 'Tech Spec', promptFile: '05_tech_spec.md', needsRepo: true, artifactFile: '05_tech_spec.md', requiredPhases: ['2', '3', '4', '5', '6'] },
  { id: '8', name: 'Task Breakdown', promptFile: '06_task_breakdown.md', needsRepo: true, artifactFile: '06_task_breakdown.md', requiredPhases: ['2', '3', '4', '6', '7'] },
  { id: '9', name: 'Implementation', promptFile: '07_implementation.md', needsRepo: true, artifactFile: null, requiredPhases: ['4', '7', '8'] },
  { id: '10', name: 'Test & Verify', promptFile: null, needsRepo: true, artifactFile: '07b_test_results.md', requiredPhases: ['9'] },
  { id: '11', name: 'UX Reachability', promptFile: '07c_ux_reachability.md', needsRepo: true, artifactFile: '07c_ux_reachability.md', requiredPhases: ['2', '7', '8', '9', '10'] },
  { id: '12', name: 'Audit', promptFile: '08_audit.md', needsRepo: true, artifactFile: '08_audit.md', requiredPhases: ['2', '3', '4', '7', '8', '9', '10', '11'] },
];

const ARTIFACT_PHASE_IDS = new Set(
  PHASES.filter((phase) => phase.artifactFile !== null).map((phase) => phase.id)
);
let ACTIVE_RUN_DIR: string | null = null;

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
  claudeOutputFormat?: 'stream-json' | 'json';
  timeoutMs?: number;
  budgetUsd?: number;
  interactive?: boolean;
  dryRun?: boolean;
}

function validateClaudeOutputFormat(value: string): asserts value is 'stream-json' | 'json' {
  if (value !== 'stream-json' && value !== 'json') {
    throw new Error(`Invalid Claude output format: "${value}". Must be "stream-json" or "json".`);
  }
}

function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const result: CLIArgs = {};

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
      case '--claude-output-format': {
        const format = args[++i];
        validateClaudeOutputFormat(format);
        result.claudeOutputFormat = format;
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
  --from-phase <n>         Start from a specific phase (e.g., 6, 5, 11)
  --owner <github-user>    GitHub owner for new repo (default: auto-detect)
  --template <owner/repo>  Template repo (default: ${DEFAULT_TEMPLATE})
  --visibility <pub|priv>  Repo visibility (default: ${DEFAULT_VISIBILITY})
  --repo-name <name>       Explicit repo name (default: slugified from idea)
  --engine <claude|codex>  AI engine to use (default: claude)
  --claude-output-format   Claude output mode: stream-json | json (default: json)
  --timeout <minutes>      Timeout per phase in minutes (default: no timeout)
  --budget <dollars>       Maximum total cost in USD (aborts if exceeded)
  --interactive            Pause for human approval at key phases (default for new runs)
  --auto                   Run all phases without pausing for approval
  --dry-run                Print assembled prompts without running agents
  --help                   Show this help message

Examples:
  npx ts-node tools/run-pipeline.ts "A task management app for remote teams"
  npx ts-node tools/run-pipeline.ts --idea-file ideas/orphan-app.md
  npx ts-node tools/run-pipeline.ts --budget 25 --auto "A task management app"
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_claude_task-manager
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_codex_task-manager --from-phase 6
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_codex_task-manager --from-phase 11 --auto
  npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_codex_task-manager --from-phase 11
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

function logAgentDiagnostics(scope: string, result: AgentResult, runDir: string): void {
  const details: string[] = [];
  if (result.claudeOutputFormat) details.push(`format=${result.claudeOutputFormat}`);
  if (result.outputSource) details.push(`source=${result.outputSource}`);
  if (result.resultSubtype) details.push(`subtype=${result.resultSubtype}`);
  if (result.stopReason) details.push(`stop_reason=${result.stopReason}`);
  if (details.length === 0) return;

  const line = `${scope} agent diagnostics: ${details.join(' | ')}`;
  log(scope, line);
  appendLog(runDir, line);
}

// ---------------------------------------------------------------------------
// Cost Tracking
// ---------------------------------------------------------------------------

interface CostComputation {
  actualUsd: number;
  estimatedUsd: number;
  effectiveUsd: number;
  source: 'actual' | 'estimated' | 'none';
}

function ensureRunConfigDefaults(config: RunConfig): void {
  if (!config.phase_costs) config.phase_costs = {};
  if (!config.phase_costs_actual) config.phase_costs_actual = {};
  if (!config.phase_costs_estimated) config.phase_costs_estimated = {};
  if (typeof config.total_cost_usd !== 'number') config.total_cost_usd = 0;
  if (typeof config.total_actual_cost_usd !== 'number') config.total_actual_cost_usd = 0;
  if (typeof config.total_estimated_cost_usd !== 'number') config.total_estimated_cost_usd = 0;
  if (typeof config.total_input_tokens !== 'number') config.total_input_tokens = 0;
  if (typeof config.total_output_tokens !== 'number') config.total_output_tokens = 0;
  if (typeof config.task_decomposition_events !== 'number') config.task_decomposition_events = 0;
  if (typeof config.dynamic_tasks_added !== 'number') config.dynamic_tasks_added = 0;
  if (!Array.isArray(config.phase10_completed_stages)) {
    config.phase10_completed_stages = [];
  } else {
    const normalized = config.phase10_completed_stages
      .map((stage) => String(stage).toUpperCase())
      .filter((stage): stage is '10A' | '10B' => stage === '10A' || stage === '10B');
    config.phase10_completed_stages = Array.from(new Set(normalized));
  }
  if (typeof config.interactive_mode !== 'boolean') {
    config.interactive_mode = true;
  }
}

function sanitizeRate(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function computeAgentCost(config: RunConfig, result: AgentResult): CostComputation {
  const actualUsd = result.costUsd > 0 ? result.costUsd : 0;
  if (actualUsd > 0) {
    return { actualUsd, estimatedUsd: 0, effectiveUsd: actualUsd, source: 'actual' };
  }

  if (config.engine === 'codex' && (result.inputTokens > 0 || result.outputTokens > 0)) {
    const inputRate = sanitizeRate(CODEX_EST_INPUT_USD_PER_1M, 3);
    const outputRate = sanitizeRate(CODEX_EST_OUTPUT_USD_PER_1M, 15);
    const estimatedUsd =
      (result.inputTokens / 1_000_000) * inputRate +
      (result.outputTokens / 1_000_000) * outputRate;
    return {
      actualUsd: 0,
      estimatedUsd,
      effectiveUsd: estimatedUsd,
      source: 'estimated',
    };
  }

  return { actualUsd: 0, estimatedUsd: 0, effectiveUsd: 0, source: 'none' };
}

function trackAgentUsage(config: RunConfig, phaseId: string, result: AgentResult): CostComputation {
  ensureRunConfigDefaults(config);
  const computed = computeAgentCost(config, result);

  config.phase_costs![phaseId] = (config.phase_costs![phaseId] || 0) + computed.effectiveUsd;
  config.total_cost_usd = (config.total_cost_usd || 0) + computed.effectiveUsd;

  if (computed.actualUsd > 0) {
    config.phase_costs_actual![phaseId] =
      (config.phase_costs_actual![phaseId] || 0) + computed.actualUsd;
    config.total_actual_cost_usd = (config.total_actual_cost_usd || 0) + computed.actualUsd;
  }

  if (computed.estimatedUsd > 0) {
    config.phase_costs_estimated![phaseId] =
      (config.phase_costs_estimated![phaseId] || 0) + computed.estimatedUsd;
    config.total_estimated_cost_usd =
      (config.total_estimated_cost_usd || 0) + computed.estimatedUsd;
  }

  config.total_input_tokens = (config.total_input_tokens || 0) + (result.inputTokens || 0);
  config.total_output_tokens = (config.total_output_tokens || 0) + (result.outputTokens || 0);

  return computed;
}

function recordAgentUsage(
  config: RunConfig,
  phaseId: string,
  result: AgentResult,
  runDir: string,
  scope: string
): void {
  const computed = trackAgentUsage(config, phaseId, result);
  if (computed.source === 'estimated') {
    const line =
      `${scope}: estimated Codex cost $${computed.estimatedUsd.toFixed(4)} ` +
      `(input ${result.inputTokens.toLocaleString()} / output ${result.outputTokens.toLocaleString()} tokens)`;
    log('Cost', line);
    appendLog(runDir, line);
  }
}

function checkBudget(
  config: RunConfig,
  budgetUsd: number | undefined,
  opts?: { runDir?: string }
): void {
  if (!budgetUsd) return;
  ensureRunConfigDefaults(config);
  const total = config.total_cost_usd || 0;
  if (total >= budgetUsd) {
    throw new Error(
      `Budget limit exceeded: $${total.toFixed(2)} spent of $${budgetUsd.toFixed(2)} budget. ` +
      `Use --budget with a higher value or --resume to continue.`
    );
  }
  if (total >= budgetUsd * 0.8) {
    log('Budget', `Warning: $${total.toFixed(2)} of $${budgetUsd.toFixed(2)} budget used (${Math.round((total / budgetUsd) * 100)}%)`);
    if (opts?.runDir) {
      appendLog(
        opts.runDir,
        `Budget warning: $${total.toFixed(2)} / $${budgetUsd.toFixed(2)} consumed.`
      );
    }
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
    'ARTIFACT_025': '3',
    'ARTIFACT_03': '4',
    'ARTIFACT_03B': '5',
    'ARTIFACT_04': '6',
    'ARTIFACT_05': '7',
    'ARTIFACT_06': '8',
    'ARTIFACT_07C': '11',
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

    // Load real test results if available (generated by Phase 10)
    const testResultsPath = path.join(artifactsDir, '07b_test_results.md');
    if (fs.existsSync(testResultsPath)) {
      replacements['TEST_RESULTS'] = fs.readFileSync(testResultsPath, 'utf-8');
    } else {
      replacements['TEST_RESULTS'] = '(tests not yet run — Phase 10 will generate real results)';
    }
  } else {
    replacements['GIT_DIFF'] = '(no changes yet)';
    replacements['TEST_RESULTS'] = '(no tests run yet)';
  }

  // Task placeholder (used in phase 9)
  replacements['TASK'] = '(see individual task below)';

  return replacements;
}

// Phases that benefit from web research (library docs, API references, domain knowledge)
const WEB_SEARCH_PHASES = new Set(['0', '1', '2', '3', '4', '6', '7']);
const ARTIFACT_ENVELOPE_OPEN = '<artifact_output>';
const ARTIFACT_ENVELOPE_CLOSE = '</artifact_output>';
const ARTIFACT_END_MARKER = '<!-- END_ARTIFACT -->';

function buildArtifactOutputContract(phase: PhaseDefinition): string {
  return [
    '',
    '## Output Contract (required)',
    `Return ONLY the artifact wrapped exactly as:`,
    ARTIFACT_ENVELOPE_OPEN,
    `## ...phase ${phase.id} markdown...`,
    ARTIFACT_ENVELOPE_CLOSE,
    ARTIFACT_END_MARKER,
    '',
    'No text before the opening tag and no text after the end marker.',
    'No tool logs, no self-commentary, and no explanation.',
  ].join('\n');
}

function artifactEnvelopeWarnings(phaseId: string, rawOutput: string): string[] {
  const warnings: string[] = [];
  const trimmed = rawOutput.trim();
  const strict = new RegExp(
    `^\\s*${ARTIFACT_ENVELOPE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*` +
      `${ARTIFACT_ENVELOPE_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*` +
      `${ARTIFACT_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
    'i'
  );

  if (!strict.test(trimmed)) {
    warnings.push(
      `Phase ${phaseId}: Artifact missing required output envelope or end marker (${ARTIFACT_END_MARKER}).`
    );
  }

  return warnings;
}

function isEnvelopeWarning(warning: string): boolean {
  return /output envelope|end marker/i.test(warning);
}

function shouldRepairArtifact(warnings: string[], content: string, engine: Engine): boolean {
  const actionableWarnings = engine === 'claude'
    ? warnings.filter((warning) => !isEnvelopeWarning(warning))
    : warnings;

  if (actionableWarnings.some((warning) => warning.includes('Missing expected section'))) return true;
  if (
    actionableWarnings.some((warning) =>
      /meta-commentary|no markdown headings|suspiciously small|output envelope|end marker/i.test(
        warning
      )
    )
  ) {
    return true;
  }
  if (content.length === 8192) return true;
  if (!content.endsWith('\n') && /[a-zA-Z0-9]$/.test(content) && !/[.!?`)]$/.test(content)) {
    return true;
  }
  return false;
}

function hasFatalArtifactWarnings(warnings: string[], engine: Engine): boolean {
  const actionableWarnings = engine === 'claude'
    ? warnings.filter((warning) => !isEnvelopeWarning(warning))
    : warnings;

  return actionableWarnings.some((warning) =>
    /Missing expected section|meta-commentary|suspiciously small|no markdown headings|output envelope|end marker/i.test(
      warning
    )
  );
}

function normalizeVerdict(value: string): string {
  return value
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getPhaseQualityGateFailure(phaseId: string, content: string): string | null {
  if (phaseId === '11') {
    const verdictMatch = content.match(
      /^\s*[-*]?\s*\**(?:overall\s+)?(?:reachability\s+)?verdict\**\s*:\s*(.+)$/im
    );
    if (!verdictMatch?.[1]) {
      return 'Phase 11 must include an explicit "Overall verdict" line.';
    }

    const verdict = normalizeVerdict(verdictMatch[1]);
    if (verdict.includes('fail')) {
      return `Phase 11 quality gate failed with verdict: "${verdictMatch[1].trim()}".`;
    }
  }

  if (phaseId === '12') {
    const readinessMatch = content.match(/^\s*[-*]?\s*\**ship readiness\**\s*:\s*(.+)$/im);
    if (!readinessMatch?.[1]) {
      return 'Phase 12 must include an explicit "Ship readiness" line.';
    }

    const readiness = normalizeVerdict(readinessMatch[1]);
    if (readiness.includes('not ready')) {
      return `Phase 12 quality gate failed with ship readiness: "${readinessMatch[1].trim()}".`;
    }
  }

  return null;
}

function isPhase11VerdictFailure(message: string | null): boolean {
  if (!message) return false;
  return /Phase 11 quality gate failed with verdict/i.test(message);
}

function isPhase12ReadinessFailure(message: string | null): boolean {
  if (!message) return false;
  return /Phase 12 quality gate failed with ship readiness/i.test(message);
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
    'Do not describe what you are about to do.',
    'Do not mention files, permissions, tooling limitations, or inability to write files.',
    'Do not truncate output.',
    'Output only the final markdown document wrapped with the required output contract.',
    buildArtifactOutputContract(phase),
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
    'Do not mention files, permissions, tooling limitations, or inability to write files.',
    buildArtifactOutputContract(phase),
  ].join('\n');
}

interface VerificationBlock {
  title: string;
  result: ReturnType<typeof runWorkspaceTests>;
}

interface Phase10Stage {
  id: '10A' | '10B';
  name: string;
  suite: WorkspaceTestSuite;
  timeoutMs: number;
}

function renderVerificationArtifact(blocks: VerificationBlock[]): string {
  const parts: string[] = ['# Phase 10: Test & Verification Results', ''];

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

interface ParsedFailureRecord {
  checkName: string;
  file: string;
  title: string;
  normalizedTitle: string;
}

function stripAnsiSequences(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function decodePercentEscapesBestEffort(value: string): string {
  const sanitized = value.replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  try {
    return decodeURIComponent(sanitized);
  } catch {
    return value;
  }
}

function normalizeFailureTitle(title: string): string {
  return title
    .replace(/^\[[^\]]+\]\s*›\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePlaywrightSummaryFailures(checkName: string, output: string): ParsedFailureRecord[] {
  const decoded = decodePercentEscapesBestEffort(stripAnsiSequences(output));
  const records: ParsedFailureRecord[] = [];
  const lines = decoded.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^\[[^\]]+\]\s+›\s+(.+)$/u);
    if (!match?.[1]) continue;
    const descriptor = match[1].trim();
    const fileMatch = descriptor.match(/\b(e2e\/[^\s:]+?\.(?:spec|setup)\.[cm]?[tj]sx?)\b/i);
    const file = fileMatch?.[1] || '(unknown e2e file)';
    records.push({
      checkName,
      file,
      title: descriptor,
      normalizedTitle: normalizeFailureTitle(descriptor),
    });
  }
  return records;
}

function parsePlaywrightAnnotationFailures(checkName: string, output: string): ParsedFailureRecord[] {
  const decoded = decodePercentEscapesBestEffort(stripAnsiSequences(output));
  const records: ParsedFailureRecord[] = [];
  const pattern = /::error file=([^,]+),title=(.*?)::/g;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(decoded)) !== null) {
    const file = (match[1] || '').trim() || '(unknown e2e file)';
    const title = (match[2] || '').trim() || '(untitled failure)';
    records.push({
      checkName,
      file,
      title,
      normalizedTitle: normalizeFailureTitle(title),
    });
  }
  return records;
}

function parseVitestFailures(checkName: string, output: string): ParsedFailureRecord[] {
  const decoded = decodePercentEscapesBestEffort(stripAnsiSequences(output));
  const records: ParsedFailureRecord[] = [];
  const pattern = /^\s*FAIL\s+([^\s]+)\s*>\s*(.+)$/gm;
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(decoded)) !== null) {
    const file = (match[1] || '').trim() || '(unknown test file)';
    const title = (match[2] || '').trim() || '(untitled failure)';
    records.push({
      checkName,
      file,
      title,
      normalizedTitle: normalizeFailureTitle(title),
    });
  }
  return records;
}

function extractFailureInventory(failedChecks: TestCheckResult[]): {
  markdown: string;
  uniqueFailureCount: number;
} {
  const parsed: ParsedFailureRecord[] = [];
  for (const check of failedChecks) {
    const lowerName = check.name.toLowerCase();
    if (lowerName.includes('playwright')) {
      const annotationFailures = parsePlaywrightAnnotationFailures(check.name, check.output);
      if (annotationFailures.length > 0) {
        parsed.push(...annotationFailures);
      } else {
        parsed.push(...parsePlaywrightSummaryFailures(check.name, check.output));
      }
      continue;
    }
    if (lowerName.includes('integration') || lowerName.includes('test')) {
      parsed.push(...parseVitestFailures(check.name, check.output));
    }
  }

  const deduped = new Map<string, ParsedFailureRecord>();
  for (const record of parsed) {
    const key = `${record.file}::${record.normalizedTitle}`;
    if (!deduped.has(key)) deduped.set(key, record);
  }
  const entries = Array.from(deduped.values());

  if (entries.length === 0) {
    return {
      markdown: '- Unable to parse structured failures from output; use raw evidence below.',
      uniqueFailureCount: Math.max(1, failedChecks.length),
    };
  }

  const maxRows = 50;
  const rows = entries.slice(0, maxRows);
  const lines: string[] = [
    `- Parsed unique failures: ${entries.length}`,
    '',
    '| Check | File | Failure |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.checkName} | ${row.file} | ${row.normalizedTitle.replace(/\|/g, '\\|')} |`),
  ];
  if (entries.length > maxRows) {
    lines.push('');
    lines.push(`- +${entries.length - maxRows} more failures omitted from table (see raw evidence).`);
  }

  return {
    markdown: lines.join('\n'),
    uniqueFailureCount: entries.length,
  };
}

function estimateRemainingFailureUnits(failedChecks: TestCheckResult[]): number {
  if (failedChecks.length === 0) return 0;
  const inventory = extractFailureInventory(failedChecks);
  return Math.max(1, inventory.uniqueFailureCount);
}

function buildFailureSignatureSet(failedChecks: TestCheckResult[]): Set<string> {
  const inventory = extractFailureInventory(failedChecks);
  const signatures = new Set<string>();
  if (inventory.uniqueFailureCount > 0 && !inventory.markdown.includes('Unable to parse structured failures')) {
    const parsed: ParsedFailureRecord[] = [];
    for (const check of failedChecks) {
      const lowerName = check.name.toLowerCase();
      if (lowerName.includes('playwright')) {
        const annotated = parsePlaywrightAnnotationFailures(check.name, check.output);
        parsed.push(...(annotated.length > 0 ? annotated : parsePlaywrightSummaryFailures(check.name, check.output)));
      } else if (lowerName.includes('integration') || lowerName.includes('test')) {
        parsed.push(...parseVitestFailures(check.name, check.output));
      } else {
        parsed.push({
          checkName: check.name,
          file: '(n/a)',
          title: check.name,
          normalizedTitle: check.name,
        });
      }
    }
    for (const record of parsed) {
      signatures.add(`${record.file}::${record.normalizedTitle}`);
    }
    if (signatures.size > 0) return signatures;
  }

  for (const check of failedChecks) {
    signatures.add(check.name);
  }
  return signatures;
}

function summarizeFailureDelta(previousFailures: TestCheckResult[], currentFailures: TestCheckResult[]): string {
  const previousSet = buildFailureSignatureSet(previousFailures);
  const currentSet = buildFailureSignatureSet(currentFailures);
  const resolved: string[] = [];
  const introduced: string[] = [];

  for (const signature of previousSet) {
    if (!currentSet.has(signature)) resolved.push(signature);
  }
  for (const signature of currentSet) {
    if (!previousSet.has(signature)) introduced.push(signature);
  }

  const lines: string[] = [
    `- Previous failure units: ${previousSet.size}`,
    `- Current failure units: ${currentSet.size}`,
    `- Resolved: ${resolved.length}`,
    `- Newly introduced: ${introduced.length}`,
  ];
  if (resolved.length > 0) {
    lines.push(`- Resolved examples: ${resolved.slice(0, 6).join(' | ')}`);
  }
  if (introduced.length > 0) {
    lines.push(`- New regressions/examples: ${introduced.slice(0, 6).join(' | ')}`);
  }
  return lines.join('\n');
}

function buildTestRepairPrompt(
  artifactsDir: string,
  failedChecks: TestCheckResult[],
  testArtifactContent: string,
  options: {
    stageLabel?: string;
    attempt?: number;
    maxAttempts?: number;
    failureDeltaSummary?: string;
    priorFailureSummary?: string;
  } = {}
): string {
  const stageLabel = options.stageLabel;
  const workflows = trimContextContent('Workflows', readArtifact(artifactsDir, '2'), 12_000);
  const prd = trimContextContent('PRD', readArtifact(artifactsDir, '4'), 12_000);
  const techSpec = trimContextContent('Tech Spec', readArtifact(artifactsDir, '7'), 24_000);
  const taskBreakdown = trimContextContent('Task Breakdown', readArtifact(artifactsDir, '8'), 12_000);
  const planSummaryPath = path.join(artifactsDir, '09a_task_plan_summary.md');
  const planSummary = fs.existsSync(planSummaryPath)
    ? trimContextContent('Task Plan Summary', fs.readFileSync(planSummaryPath, 'utf-8'), 6_000)
    : '(not available)';
  const failingCheckList = failedChecks
    .map((check) => `- ${check.name}: \`${check.command}\``)
    .join('\n');
  const failureInventory = extractFailureInventory(failedChecks);
  const failureEvidence = failedChecks
    .map((check) => {
      const compactEvidence = trimContextContent(
        `${check.name} failure output`,
        check.output,
        TEST_REPAIR_EVIDENCE_MAX_CHARS
      );
      return [
        `### ${check.name}`,
        `Command: \`${check.command}\``,
        '```',
        compactEvidence || '(no output)',
        '```',
      ].join('\n');
    })
    .join('\n\n');

  return [
    'You are a senior software engineer fixing a repository after automated verification failures.',
    '',
    'Your objective is to make the failing checks pass without changing product scope.',
    'Treat this as a production-quality fix pass focused on root causes.',
    'Do not add placeholder hacks, and do not silence or skip failing checks.',
    'Do not weaken lint/type/test rules, and do not add bypasses like ts-ignore or disabling assertions.',
    '',
    '## Failing Checks (must pass)',
    failingCheckList || '- (none provided)',
    '',
    ...(stageLabel
      ? [
          '## Active Verification Stage',
          `- ${stageLabel}`,
          '',
        ]
      : []),
    ...(typeof options.attempt === 'number' && typeof options.maxAttempts === 'number'
      ? [
          '## Repair Attempt',
          `- Attempt ${options.attempt}/${options.maxAttempts}`,
          '',
        ]
      : []),
    ...(options.priorFailureSummary
      ? [
          '## Prior Failure Snapshot',
          options.priorFailureSummary,
          '',
        ]
      : []),
    ...(options.failureDeltaSummary
      ? [
          '## Failure Delta Vs Previous Attempt',
          options.failureDeltaSummary,
          '',
        ]
      : []),
    '## Remaining Failure Inventory (parsed)',
    failureInventory.markdown,
    '',
    '## Failure Evidence',
    failureEvidence || '(no failure evidence provided)',
    '',
    '## Template Verification Context',
    '- The generated repository is template-based, so prefer template conventions over ad-hoc fixes.',
    '- Phase 10 uses staged verification: integration stage (dependency/env/typecheck/lint/build + DB reset/bootstrap + `test:integration`) and e2e stage (Playwright browser install + `test:e2e`).',
    '- Phase 10 also sets test-safe env overrides (for example rate-limit bypass and local auth/URL defaults). Do not re-introduce custom bootstrap scripts unless missing in repo scripts.',
    '- Phase 10 repair attempts are cumulative and committed. Keep fixes incremental; do not undo prior successful repairs.',
    '- Keep fixes generic and production-safe: no endpoint-specific hacks in shared pipeline logic.',
    '',
    '## Workflows',
    workflows,
    '',
    '## Test Results',
    trimContextContent('Test Results', testArtifactContent, 20_000),
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
    '## Phase 9 Task Queue Summary',
    planSummary,
    '',
    '## Instructions',
    '- Read relevant files before editing.',
    '- Make the smallest safe code changes required to pass checks.',
    '- Fix only failures that are evidenced in the failing checks; avoid unrelated refactors.',
    '- Resolve all currently failing checks in this repair attempt; do not stop after addressing only one test/spec.',
    '- Start with a quick classification for each failing check: (A) test harness/bootstrap mismatch, (B) stale/incorrect test expectation, or (C) application logic defect.',
    '- Resolve in order: first ensure harness/bootstrap parity with template scripts, then decide whether to fix test expectations or product logic based on PRD/Tech Spec/Task Breakdown intent.',
    '- If a test expectation conflicts with intentional current behavior and product intent, update the test. If behavior conflicts with product intent, fix application code.',
    '- Remove mock/fake/placeholder production data and replace with real API/domain wiring where relevant to failing checks.',
    '- For auth/session/onboarding redirects, verify loop safety (no self-redirect cycles) and deterministic post-login destination.',
    '- Install dependencies if needed by repo scripts.',
    '- When running dependency install with pnpm in this non-interactive environment, use `CI=true pnpm install --frozen-lockfile`.',
    '- For integration bootstrap, use one canonical path via the root script only: `pnpm run --if-present test:integration` (or `npm run test:integration --if-present`).',
    '- Run Playwright verification via the root script only: `pnpm run --if-present test:e2e` (or `npm run test:e2e --if-present`).',
    '- Do not rewrite `test:e2e` scripts to force local browser cache paths; rely on Phase 10 browser-install preflight and standard Playwright resolution.',
    '- Before integration tests, reset the DB using root scripts: `pnpm run --if-present db:down && pnpm run --if-present db:up` (or npm equivalent).',
    '- Do not invoke ad-hoc migration commands (for example direct `drizzle-kit migrate` calls) unless they are inside the canonical root integration script.',
    '- Run each failing command locally after your changes and ensure it passes.',
    '- If one fix changes the next failing check, keep iterating until all listed checks pass.',
    ...(stageLabel?.toLowerCase().includes('integration')
      ? ['- This repair stage is integration-only; prioritize integration harness/bootstrap and integration tests.']
      : []),
    ...(stageLabel?.toLowerCase().includes('e2e')
      ? [
          '- This repair stage is e2e-only; prioritize Playwright reliability and e2e expectations.',
          '- In e2e stage, ensure setup project (`--project=setup`) succeeds first before broad e2e expectations.',
          '- Keep auth origin consistency: `APP_BASE_URL` and `TEST_BASE_URL` must share the same host (prefer localhost, avoid localhost<->127.0.0.1 rewrites).',
        ]
      : []),
    '- Keep code style consistent with existing repo conventions.',
    '- Output a concise summary including: root cause, files changed, commands run, and final pass status.',
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

  const replacements = compactPhaseReplacements(
    phase.id,
    gatherReplacements(config, phase, artifactsDir),
    runDir
  );
  const fullPrompt = buildPrompt(promptPath, replacements);
  const artifactPrompt = capPromptLength(
    `${fullPrompt}\n${buildArtifactOutputContract(phase)}`,
    140_000,
    `Phase ${phase.id} artifact`,
    runDir
  );

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
  checkBudget(config, opts.budgetUsd, { runDir });

  const cwd = phase.needsRepo ? config.workspace_path : ROOT_DIR;
  if (!cwd || !fs.existsSync(cwd)) {
    throw new Error(
      `Phase ${phase.id} requires a workspace path. Run phase 5 (Repo Bootstrap) first.`
    );
  }

  log(phase.name, `Calling ${config.engine}... (running in ${cwd})`);
  const result = retryAgent(artifactPrompt, {
    cwd,
    engine: config.engine,
    claudeOutputFormat: config.claude_output_format,
    timeoutMs: config.timeout_ms,
    permissions: 'read-only',
    webSearch: WEB_SEARCH_PHASES.has(phase.id),
    maxTurns: phase.needsRepo ? 15 : 12,
  }, phase.id, runDir);

  // Track cost
  recordAgentUsage(config, phase.id, result, runDir, `Phase ${phase.id}`);
  logAgentDiagnostics(`Phase ${phase.id}`, result, runDir);

  // Clean and validate artifact
  if (phase.artifactFile) {
    let cleaned = cleanArtifact(result.output);
    let warnings = [
      ...artifactEnvelopeWarnings(phase.id, result.output),
      ...validateArtifactContent(phase.id, cleaned),
    ];
    if ((result.stopReason || '').toLowerCase() === 'max_tokens') {
      warnings.push(`Phase ${phase.id}: Model stopped due to max_tokens.`);
    }

    if (warnings.length > 0 && shouldRepairArtifact(warnings, cleaned, config.engine)) {
      const maxRepairAttempts =
        config.engine === 'claude'
          ? MAX_CLAUDE_ARTIFACT_REPAIR_ATTEMPTS
          : MAX_ARTIFACT_REPAIR_ATTEMPTS;
      for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
        log(phase.name, `Attempting artifact repair (${attempt}/${maxRepairAttempts})...`);
        checkBudget(config, opts.budgetUsd, { runDir });

        const repairPrompt = buildArtifactRepairPrompt(phase, cleaned, warnings);
        const repairResult = retryAgent(repairPrompt, {
          cwd,
          engine: config.engine,
          claudeOutputFormat: config.claude_output_format,
          timeoutMs: config.timeout_ms,
          permissions: 'read-only',
          webSearch: false,
          maxTurns: phase.needsRepo ? 10 : 8,
        }, `${phase.id}-repair-${attempt}`, runDir);

        recordAgentUsage(
          config,
          phase.id,
          repairResult,
          runDir,
          `Phase ${phase.id}-repair-${attempt}`
        );
        logAgentDiagnostics(`Phase ${phase.id}-repair-${attempt}`, repairResult, runDir);
        cleaned = cleanArtifact(repairResult.output);
        warnings = [
          ...artifactEnvelopeWarnings(phase.id, repairResult.output),
          ...validateArtifactContent(phase.id, cleaned),
        ];
        if ((repairResult.stopReason || '').toLowerCase() === 'max_tokens') {
          warnings.push(`Phase ${phase.id}: Model stopped due to max_tokens during repair.`);
        }

        if (!shouldRepairArtifact(warnings, cleaned, config.engine)) {
          break;
        }
      }
    }

    const maxBackfillAttempts =
      config.engine === 'claude' ? MAX_CLAUDE_MISSING_SECTION_BACKFILL_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxBackfillAttempts; attempt++) {
      const missingSections = getMissingSectionWarnings(warnings);
      if (missingSections.length === 0) {
        break;
      }

      if (attempt === 1) {
        log(phase.name, `Backfilling missing sections: ${missingSections.join(', ')}`);
      } else {
        log(
          phase.name,
          `Backfilling missing sections retry (${attempt}/${maxBackfillAttempts}): ${missingSections.join(', ')}`
        );
      }
      checkBudget(config, opts.budgetUsd, { runDir });

      const supplementPrompt = buildMissingSectionsPrompt(phase, cleaned, missingSections);
      const supplementResult = retryAgent(supplementPrompt, {
        cwd,
        engine: config.engine,
        claudeOutputFormat: config.claude_output_format,
        timeoutMs: config.timeout_ms,
        permissions: 'read-only',
        webSearch: false,
        maxTurns: phase.needsRepo ? 8 : 6,
      }, `${phase.id}-section-backfill-${attempt}`, runDir);

      recordAgentUsage(
        config,
        phase.id,
        supplementResult,
        runDir,
        `Phase ${phase.id}-section-backfill-${attempt}`
      );
      logAgentDiagnostics(`Phase ${phase.id}-section-backfill-${attempt}`, supplementResult, runDir);
      const supplement = cleanArtifact(supplementResult.output);
      if (supplement.length > 0) {
        cleaned = `${cleaned.trim()}\n\n${supplement.trim()}\n`;
      }
      warnings = [
        ...artifactEnvelopeWarnings(phase.id, supplementResult.output),
        ...validateArtifactContent(phase.id, cleaned),
      ];
    }

    if (warnings.length > 0) {
      log(phase.name, 'Artifact warnings:');
      for (const w of warnings) {
        log(phase.name, `  - ${w}`);
      }
      appendLog(runDir, `Phase ${phase.id} warnings: ${warnings.join('; ')}`);
    }

    if (hasFatalArtifactWarnings(warnings, config.engine)) {
      const msg =
        `Phase ${phase.id} produced invalid artifact after repair attempts. ` +
        `Warnings: ${warnings.join('; ')}`;
      appendLog(runDir, msg);
      throw new Error(msg);
    }

    const artifactPath = path.join(artifactsDir, phase.artifactFile);
    fs.writeFileSync(artifactPath, cleaned + '\n');
    log(phase.name, `Artifact saved: ${artifactPath}`);

    let qualityGateFailure = getPhaseQualityGateFailure(phase.id, cleaned);
    let phase12VerificationBlocker: string | null = null;
    if (
      phase.id === '11' &&
      isPhase11VerdictFailure(qualityGateFailure) &&
      config.workspace_path &&
      fs.existsSync(config.workspace_path)
    ) {
      const phase11RepairNotes: string[] = [];
      for (let attempt = 1; attempt <= MAX_PHASE11_UX_REPAIR_ATTEMPTS; attempt++) {
        log(
          phase.name,
          `Phase 11 verdict is failing. Starting UX remediation attempt ${attempt}/${MAX_PHASE11_UX_REPAIR_ATTEMPTS}...`
        );
        checkBudget(config, opts.budgetUsd, { runDir });
        const remediationPrompt = capPromptLength(
          buildPhase11ReachabilityRepairPrompt(
            artifactsDir,
            cleaned,
            qualityGateFailure || 'Phase 11 verdict failed.',
            attempt,
            MAX_PHASE11_UX_REPAIR_ATTEMPTS,
            phase11RepairNotes
          ),
          PHASE11_REPAIR_CONTEXT_CHAR_LIMIT,
          `Phase 11 UX remediation ${attempt}`,
          runDir
        );
        const remediationResult = retryAgent(
          remediationPrompt,
          {
            cwd: config.workspace_path,
            maxTurns: 18,
            permissions: 'read-write',
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
          },
          `11-ux-remediation-${attempt}`,
          runDir
        );
        recordAgentUsage(config, phase.id, remediationResult, runDir, `Phase 11-ux-remediation-${attempt}`);
        logAgentDiagnostics(`Phase 11-ux-remediation-${attempt}`, remediationResult, runDir);

        const remediationCommitted = gitCommitChanges(
          config.workspace_path,
          `Pipeline Phase 11 - UX reachability remediation attempt ${attempt}`
        );
        if (!remediationCommitted && hasGitChanges(config.workspace_path)) {
          throw new Error(
            `Phase 11 remediation attempt ${attempt} left uncommitted workspace changes and could not be committed.`
          );
        }

        const postRepairQuality = runWorkspaceQualityChecks(
          config.workspace_path,
          config.timeout_ms ?? 300_000,
          { forceFullWorkspace: true }
        );
        if (!postRepairQuality.allPassed) {
          const failedNames = postRepairQuality.checks
            .filter((check) => !check.success)
            .map((check) => check.name)
            .join(', ');
          const note = `Attempt ${attempt}: quality checks failed (${failedNames}).`;
          phase11RepairNotes.push(note);
          appendLog(runDir, `Phase 11 remediation note: ${note}`);
          continue;
        }

        const postRepairE2ESetup = runWorkspaceTests(
          config.workspace_path,
          Math.max(config.timeout_ms || 0, 900_000),
          'e2e_setup'
        );
        if (!postRepairE2ESetup.allPassed) {
          const failedNames = postRepairE2ESetup.checks
            .filter((check) => !check.success)
            .map((check) => check.name)
            .join(', ');
          const note = `Attempt ${attempt}: e2e setup verification failed (${failedNames}).`;
          phase11RepairNotes.push(note);
          appendLog(runDir, `Phase 11 remediation note: ${note}`);
          continue;
        }

        const reevaluationResult = retryAgent(
          artifactPrompt,
          {
            cwd,
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
            permissions: 'read-only',
            webSearch: WEB_SEARCH_PHASES.has(phase.id),
            maxTurns: phase.needsRepo ? 15 : 12,
          },
          `11-reevaluate-${attempt}`,
          runDir
        );
        recordAgentUsage(config, phase.id, reevaluationResult, runDir, `Phase 11-reevaluate-${attempt}`);
        logAgentDiagnostics(`Phase 11-reevaluate-${attempt}`, reevaluationResult, runDir);

        cleaned = cleanArtifact(reevaluationResult.output);
        warnings = [
          ...artifactEnvelopeWarnings(phase.id, reevaluationResult.output),
          ...validateArtifactContent(phase.id, cleaned),
        ];
        if ((reevaluationResult.stopReason || '').toLowerCase() === 'max_tokens') {
          warnings.push(`Phase ${phase.id}: Model stopped due to max_tokens during reevaluation.`);
        }
        if (hasFatalArtifactWarnings(warnings, config.engine)) {
          const note = `Attempt ${attempt}: reevaluated artifact still has fatal warnings (${warnings.join('; ')}).`;
          phase11RepairNotes.push(note);
          appendLog(runDir, `Phase 11 remediation note: ${note}`);
          continue;
        }

        fs.writeFileSync(artifactPath, cleaned + '\n');
        log(phase.name, `Artifact updated after UX remediation attempt ${attempt}: ${artifactPath}`);

        qualityGateFailure = getPhaseQualityGateFailure(phase.id, cleaned);
        if (!qualityGateFailure) {
          break;
        }
        const note = `Attempt ${attempt}: quality gate still failing (${qualityGateFailure}).`;
        phase11RepairNotes.push(note);
        appendLog(runDir, `Phase 11 remediation note: ${note}`);
      }
    }

    if (
      phase.id === '12' &&
      isPhase12ReadinessFailure(qualityGateFailure) &&
      config.workspace_path &&
      fs.existsSync(config.workspace_path)
    ) {
      const workspacePath = config.workspace_path;
      const phase12RepairNotes: string[] = [];
      const phase11Definition = PHASES.find((candidate) => candidate.id === '11');
      if (!phase11Definition?.promptFile || !phase11Definition.artifactFile) {
        throw new Error('Phase 12 remediation requires Phase 11 prompt/artifact definitions.');
      }
      const phase10ArtifactPath = path.join(artifactsDir, '07b_test_results.md');
      const verificationTimeoutMs = Math.max(config.timeout_ms || 0, 900_000);
      const flattenFailedChecks = (checks: TestCheckResult[]): TestCheckResult[] =>
        checks.filter((check) => !check.success);
      const collectVerificationFailures = (
        quality: WorkspaceTestResult,
        integration: WorkspaceTestResult,
        e2e: WorkspaceTestResult
      ): TestCheckResult[] => flattenFailedChecks([
        ...quality.checks,
        ...integration.checks,
        ...e2e.checks,
      ]);
      const persistPhase12VerificationBlocks = (blocks: VerificationBlock[]): void => {
        fs.writeFileSync(phase10ArtifactPath, renderVerificationArtifact(blocks) + '\n');
        log(phase.name, `Test results saved: ${phase10ArtifactPath}`);
      };
      const cleanupPhase12VerificationArtifacts = (label: string): void => {
        const cleanedArtifacts = cleanupWorkspaceVerificationArtifacts(workspacePath);
        if (cleanedArtifacts.length === 0) return;
        const cleanupMessage =
          `Phase 12 ${label}: removed ephemeral test artifacts (${cleanedArtifacts.join(', ')}).`;
        log(phase.name, cleanupMessage);
        appendLog(runDir, cleanupMessage);
      };

      // Capture baseline verification state before any remediation attempt.
      const baselineQuality = runWorkspaceQualityChecks(
        workspacePath,
        config.timeout_ms ?? 300_000,
        { forceFullWorkspace: true, forceFullWorkspaceLintTypecheck: true }
      );
      const baselineIntegration = runWorkspaceTests(
        workspacePath,
        verificationTimeoutMs,
        'integration'
      );
      const baselineE2E = runWorkspaceTests(workspacePath, verificationTimeoutMs, 'e2e');
      const baselineVerificationBlocks: VerificationBlock[] = [
        { title: 'Phase 12 Baseline - Workspace Quality', result: baselineQuality },
        { title: 'Phase 12 Baseline - Integration Verification', result: baselineIntegration },
        { title: 'Phase 12 Baseline - E2E Verification', result: baselineE2E },
      ];
      persistPhase12VerificationBlocks(baselineVerificationBlocks);
      cleanupPhase12VerificationArtifacts('baseline verification');
      const baselineFailedChecks = collectVerificationFailures(
        baselineQuality,
        baselineIntegration,
        baselineE2E
      );
      const baselineFailureNames = new Set(
        baselineFailedChecks.map((check) => check.name)
      );
      if (baselineFailedChecks.length > 0) {
        const baselineNames = Array.from(baselineFailureNames).join(', ');
        const baselineNote =
          `Baseline verification before Phase 12 remediation is already failing (${baselineNames}). ` +
          'Remediation attempts must not introduce additional failing checks.';
        phase12RepairNotes.push(baselineNote);
        appendLog(runDir, `Phase 12 remediation note: ${baselineNote}`);
      }

      for (let attempt = 1; attempt <= MAX_PHASE12_AUDIT_REPAIR_ATTEMPTS; attempt++) {
        const attemptStartSha = getGitHeadSha(workspacePath);
        log(
          phase.name,
          `Phase 12 readiness is failing. Starting audit remediation attempt ${attempt}/${MAX_PHASE12_AUDIT_REPAIR_ATTEMPTS}...`
        );
        checkBudget(config, opts.budgetUsd, { runDir });

        const remediationPrompt = capPromptLength(
          buildPhase12AuditRepairPrompt(
            artifactsDir,
            cleaned,
            qualityGateFailure || 'Phase 12 readiness failed.',
            attempt,
            MAX_PHASE12_AUDIT_REPAIR_ATTEMPTS,
            phase12RepairNotes
          ),
          PHASE12_REPAIR_CONTEXT_CHAR_LIMIT,
          `Phase 12 audit remediation ${attempt}`,
          runDir
        );

        const remediationResult = retryAgent(
          remediationPrompt,
          {
            cwd: workspacePath,
            maxTurns: 22,
            permissions: 'read-write',
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
          },
          `12-audit-remediation-${attempt}`,
          runDir
        );
        recordAgentUsage(
          config,
          phase.id,
          remediationResult,
          runDir,
          `Phase 12-audit-remediation-${attempt}`
        );
        logAgentDiagnostics(`Phase 12-audit-remediation-${attempt}`, remediationResult, runDir);

        const remediationCommitted = gitCommitChanges(
          workspacePath,
          `Pipeline Phase 12 - Audit remediation attempt ${attempt}`
        );
        if (!remediationCommitted && hasGitChanges(workspacePath)) {
          throw new Error(
            `Phase 12 remediation attempt ${attempt} left uncommitted workspace changes and could not be committed.`
          );
        }

        let postRepairQuality = runWorkspaceQualityChecks(
          workspacePath,
          config.timeout_ms ?? 300_000,
          { forceFullWorkspace: true, forceFullWorkspaceLintTypecheck: true }
        );
        let postRepairIntegration = runWorkspaceTests(
          workspacePath,
          verificationTimeoutMs,
          'integration'
        );
        let postRepairE2E = runWorkspaceTests(workspacePath, verificationTimeoutMs, 'e2e');
        let postRepairVerificationBlocks: VerificationBlock[] = [
          {
            title: `Phase 12 Repair ${attempt} - Workspace Quality`,
            result: postRepairQuality,
          },
          {
            title: `Phase 12 Repair ${attempt} - Integration Verification`,
            result: postRepairIntegration,
          },
          {
            title: `Phase 12 Repair ${attempt} - E2E Verification`,
            result: postRepairE2E,
          },
        ];
        persistPhase12VerificationBlocks(postRepairVerificationBlocks);
        cleanupPhase12VerificationArtifacts(`post-remediation-${attempt} verification`);

        let postRepairFailedChecks = collectVerificationFailures(
          postRepairQuality,
          postRepairIntegration,
          postRepairE2E
        );
        if (postRepairFailedChecks.length > 0) {
          let previousFailures: TestCheckResult[] | null = null;
          for (
            let verificationRepairAttempt = 1;
            verificationRepairAttempt <= MAX_PHASE12_VERIFICATION_REPAIR_ATTEMPTS;
            verificationRepairAttempt++
          ) {
            const failureDeltaSummary = previousFailures
              ? summarizeFailureDelta(previousFailures, postRepairFailedChecks)
              : undefined;
            const priorFailureSummary = previousFailures
              ? trimContextContent(
                  'Prior verification failure inventory',
                  extractFailureInventory(previousFailures).markdown,
                  6000
                )
              : undefined;
            const repairPrompt = capPromptLength(
              buildTestRepairPrompt(
                artifactsDir,
                postRepairFailedChecks,
                renderVerificationArtifact(postRepairVerificationBlocks),
                {
                  stageLabel: `Phase 12 post-remediation verification (attempt ${attempt})`,
                  attempt: verificationRepairAttempt,
                  maxAttempts: MAX_PHASE12_VERIFICATION_REPAIR_ATTEMPTS,
                  failureDeltaSummary,
                  priorFailureSummary,
                }
              ),
              TEST_REPAIR_CONTEXT_CHAR_LIMIT,
              `Phase 12 verification stabilization ${attempt}.${verificationRepairAttempt}`,
              runDir
            );
            const verificationRepairResult = retryAgent(
              repairPrompt,
              {
                cwd: workspacePath,
                maxTurns: 18,
                permissions: 'read-write',
                engine: config.engine,
                claudeOutputFormat: config.claude_output_format,
                timeoutMs: config.timeout_ms,
              },
              `12-verification-repair-${attempt}-${verificationRepairAttempt}`,
              runDir
            );
            recordAgentUsage(
              config,
              phase.id,
              verificationRepairResult,
              runDir,
              `Phase 12-verification-repair-${attempt}-${verificationRepairAttempt}`
            );
            logAgentDiagnostics(
              `Phase 12-verification-repair-${attempt}-${verificationRepairAttempt}`,
              verificationRepairResult,
              runDir
            );

            const verificationRepairCommitted = gitCommitChanges(
              workspacePath,
              `Pipeline Phase 12 - Verification stabilization attempt ${attempt}.${verificationRepairAttempt}`
            );
            if (!verificationRepairCommitted && hasGitChanges(workspacePath)) {
              throw new Error(
                `Phase 12 verification stabilization ${attempt}.${verificationRepairAttempt} left uncommitted changes and could not be committed.`
              );
            }

            previousFailures = postRepairFailedChecks;
            postRepairQuality = runWorkspaceQualityChecks(
              workspacePath,
              config.timeout_ms ?? 300_000,
              { forceFullWorkspace: true, forceFullWorkspaceLintTypecheck: true }
            );
            postRepairIntegration = runWorkspaceTests(
              workspacePath,
              verificationTimeoutMs,
              'integration'
            );
            postRepairE2E = runWorkspaceTests(workspacePath, verificationTimeoutMs, 'e2e');
            postRepairVerificationBlocks = [
              {
                title: `Phase 12 Repair ${attempt}.${verificationRepairAttempt} - Workspace Quality`,
                result: postRepairQuality,
              },
              {
                title: `Phase 12 Repair ${attempt}.${verificationRepairAttempt} - Integration Verification`,
                result: postRepairIntegration,
              },
              {
                title: `Phase 12 Repair ${attempt}.${verificationRepairAttempt} - E2E Verification`,
                result: postRepairE2E,
              },
            ];
            persistPhase12VerificationBlocks(postRepairVerificationBlocks);
            cleanupPhase12VerificationArtifacts(
              `post-remediation-${attempt} verification-repair-${verificationRepairAttempt}`
            );
            postRepairFailedChecks = collectVerificationFailures(
              postRepairQuality,
              postRepairIntegration,
              postRepairE2E
            );
            if (postRepairFailedChecks.length === 0) {
              break;
            }
          }
        }
        if (postRepairFailedChecks.length > 0) {
          const failedNameSet = new Set(postRepairFailedChecks.map((check) => check.name));
          const newFailureNames = Array.from(failedNameSet).filter(
            (name) => !baselineFailureNames.has(name)
          );
          const failedNames = Array.from(failedNameSet).join(', ');
          const regressionNote =
            newFailureNames.length > 0
              ? `Attempt ${attempt}: post-remediation verification introduced new failing checks (${newFailureNames.join(', ')}).`
              : `Attempt ${attempt}: post-remediation verification still failing (${failedNames}).`;
          const rollbackNote =
            `Rolling back Phase 12 remediation attempt ${attempt} to ${attemptStartSha} due to verification failures.`;
          const note = `${regressionNote} ${rollbackNote}`;
          phase12RepairNotes.push(note);
          appendLog(runDir, `Phase 12 remediation note: ${note}`);
          phase12VerificationBlocker =
            newFailureNames.length > 0
              ? `Phase 12 remediation blocked by verification regressions (${newFailureNames.join(', ')}).`
              : `Phase 12 remediation blocked by unresolved verification failures (${failedNames}).`;
          gitResetHard(workspacePath, attemptStartSha);
          cleanupPhase12VerificationArtifacts(`post-remediation-${attempt} rollback`);
          continue;
        }

        const phase11PromptPath = path.join(PROMPTS_DIR, phase11Definition.promptFile);
        const phase11Replacements = compactPhaseReplacements(
          phase11Definition.id,
          gatherReplacements(config, phase11Definition, artifactsDir),
          runDir
        );
        const phase11Prompt = capPromptLength(
          `${buildPrompt(phase11PromptPath, phase11Replacements)}\n${buildArtifactOutputContract(phase11Definition)}`,
          140_000,
          `Phase 11 reevaluation for Phase 12 remediation ${attempt}`,
          runDir
        );
        const phase11ReevaluationResult = retryAgent(
          phase11Prompt,
          {
            cwd: workspacePath,
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
            permissions: 'read-only',
            webSearch: WEB_SEARCH_PHASES.has(phase11Definition.id),
            maxTurns: phase11Definition.needsRepo ? 15 : 12,
          },
          `11-reevaluate-for-12-${attempt}`,
          runDir
        );
        recordAgentUsage(
          config,
          phase.id,
          phase11ReevaluationResult,
          runDir,
          `Phase 11-reevaluate-for-12-${attempt}`
        );
        logAgentDiagnostics(
          `Phase 11-reevaluate-for-12-${attempt}`,
          phase11ReevaluationResult,
          runDir
        );

        const phase11Cleaned = cleanArtifact(phase11ReevaluationResult.output);
        const phase11Warnings = [
          ...artifactEnvelopeWarnings(phase11Definition.id, phase11ReevaluationResult.output),
          ...validateArtifactContent(phase11Definition.id, phase11Cleaned),
        ];
        if ((phase11ReevaluationResult.stopReason || '').toLowerCase() === 'max_tokens') {
          phase11Warnings.push(
            `Phase ${phase11Definition.id}: Model stopped due to max_tokens during reevaluation.`
          );
        }
        if (hasFatalArtifactWarnings(phase11Warnings, config.engine)) {
          const note = `Attempt ${attempt}: Phase 11 reevaluation had fatal artifact warnings (${phase11Warnings.join('; ')}).`;
          phase12RepairNotes.push(note);
          appendLog(runDir, `Phase 12 remediation note: ${note}`);
          continue;
        }

        const phase11ArtifactPath = path.join(artifactsDir, phase11Definition.artifactFile);
        fs.writeFileSync(phase11ArtifactPath, phase11Cleaned + '\n');
        const phase11GateFailure = getPhaseQualityGateFailure(phase11Definition.id, phase11Cleaned);
        if (phase11GateFailure) {
          const note = `Attempt ${attempt}: Phase 11 reevaluation still failing (${phase11GateFailure}).`;
          phase12RepairNotes.push(note);
          appendLog(runDir, `Phase 12 remediation note: ${note}`);
          continue;
        }

        const phase12Replacements = compactPhaseReplacements(
          phase.id,
          gatherReplacements(config, phase, artifactsDir),
          runDir
        );
        const phase12Prompt = capPromptLength(
          `${buildPrompt(promptPath, phase12Replacements)}\n${buildArtifactOutputContract(phase)}`,
          140_000,
          `Phase 12 reevaluation ${attempt}`,
          runDir
        );
        const reevaluationResult = retryAgent(
          phase12Prompt,
          {
            cwd: workspacePath,
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
            permissions: 'read-only',
            webSearch: WEB_SEARCH_PHASES.has(phase.id),
            maxTurns: phase.needsRepo ? 15 : 12,
          },
          `12-reevaluate-${attempt}`,
          runDir
        );
        recordAgentUsage(
          config,
          phase.id,
          reevaluationResult,
          runDir,
          `Phase 12-reevaluate-${attempt}`
        );
        logAgentDiagnostics(`Phase 12-reevaluate-${attempt}`, reevaluationResult, runDir);

        cleaned = cleanArtifact(reevaluationResult.output);
        warnings = [
          ...artifactEnvelopeWarnings(phase.id, reevaluationResult.output),
          ...validateArtifactContent(phase.id, cleaned),
        ];
        if ((reevaluationResult.stopReason || '').toLowerCase() === 'max_tokens') {
          warnings.push(`Phase ${phase.id}: Model stopped due to max_tokens during reevaluation.`);
        }
        if (hasFatalArtifactWarnings(warnings, config.engine)) {
          const note = `Attempt ${attempt}: reevaluated artifact still has fatal warnings (${warnings.join('; ')}).`;
          phase12RepairNotes.push(note);
          appendLog(runDir, `Phase 12 remediation note: ${note}`);
          continue;
        }

        fs.writeFileSync(artifactPath, cleaned + '\n');
        log(phase.name, `Artifact updated after audit remediation attempt ${attempt}: ${artifactPath}`);

        qualityGateFailure = getPhaseQualityGateFailure(phase.id, cleaned);
        if (!qualityGateFailure) {
          break;
        }
        const note = `Attempt ${attempt}: quality gate still failing (${qualityGateFailure}).`;
        phase12RepairNotes.push(note);
        appendLog(runDir, `Phase 12 remediation note: ${note}`);
      }
    }

    if (qualityGateFailure) {
      if (phase.id === '12' && phase12VerificationBlocker) {
        const classifiedFailure =
          `${phase12VerificationBlocker} Latest audit gate state: ${qualityGateFailure}`;
        appendLog(runDir, `Phase ${phase.id} quality gate failed: ${classifiedFailure}`);
        throw new Error(classifiedFailure);
      }
      appendLog(runDir, `Phase ${phase.id} quality gate failed: ${qualityGateFailure}`);
      throw new Error(qualityGateFailure);
    }
  }

  // Update config
  if (!config.completed_phases.includes(phase.id)) {
    config.completed_phases.push(phase.id);
  }
  config.current_phase = phase.id;
  const effectivePhaseCost = config.phase_costs?.[phase.id] || 0;
  appendLog(
    runDir,
    `Phase ${phase.id} (${phase.name}) completed | Raw cost: $${result.costUsd.toFixed(4)} | Effective tracked phase cost: $${effectivePhaseCost.toFixed(4)}`
  );
}

function runRepoBootstrap(config: RunConfig, artifactsDir: string, runDir: string): void {
  const phase = PHASES.find((p) => p.id === '5')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 5 (${phase.name}) started`);

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
  if (!config.completed_phases.includes('5')) {
    config.completed_phases.push('5');
  }
  config.current_phase = '5';
  appendLog(runDir, `Phase 5 (${phase.name}) completed`);
}

interface ImplementationTask {
  id: string;
  title: string;
  body: string;
  priority: string;
  complexity: string;
  milestone: string;
  description: string;
  targetFiles: string[];
  acceptanceCriteria: string[];
  testExpectations: string[];
  dependencies: string;
  implementationNotes: string;
  source: 'manifest' | 'decomposed' | 'dynamic';
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function markdownBodyWithoutHeading(markdownBody: string): string {
  return markdownBody.replace(/^###\s+Task[^\n]*\n*/i, '').trim();
}

function buildTaskBody(task: ImplementationTask): string {
  const lines: string[] = [];
  lines.push(`### Task ${task.id}: ${task.title}`);
  lines.push('');

  if (task.priority) lines.push(`**Priority**: ${task.priority}`);
  if (task.complexity) lines.push(`**Complexity**: ${task.complexity}`);
  if (task.milestone) lines.push(`**Milestone**: ${task.milestone}`);
  if (lines[lines.length - 1] !== '') lines.push('');

  if (task.description) {
    lines.push('**Description**:');
    lines.push(task.description);
    lines.push('');
  }

  if (task.targetFiles.length > 0) {
    lines.push('**Target Files**:');
    for (const file of task.targetFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push('');
  }

  if (task.acceptanceCriteria.length > 0) {
    lines.push('**Acceptance Criteria**:');
    for (const criterion of task.acceptanceCriteria) {
      lines.push(`- [ ] ${criterion}`);
    }
    lines.push('');
  }

  if (task.testExpectations.length > 0) {
    lines.push('**Test Expectations**:');
    for (const expectation of task.testExpectations) {
      lines.push(`- ${expectation}`);
    }
    lines.push('');
  }

  if (task.dependencies) {
    lines.push('**Dependencies**:');
    lines.push(task.dependencies);
    lines.push('');
  }

  if (task.implementationNotes) {
    lines.push('**Implementation Notes**:');
    lines.push(task.implementationNotes);
    lines.push('');
  }

  return lines.join('\n').trim();
}

function normalizeManifestTask(
  task: Record<string, unknown>,
  index: number,
  source: ImplementationTask['source'] = 'manifest'
): ImplementationTask | null {
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!title) return null;
  const taskId = typeof task.id === 'string' && task.id.trim() ? task.id.trim() : String(index + 1);
  const priority = typeof task.priority === 'string' ? task.priority.trim() || 'P1' : 'P1';
  const complexity = typeof task.complexity === 'string' ? task.complexity.trim() || 'Medium' : 'Medium';
  const milestone = typeof task.milestone === 'string' ? task.milestone.trim() || 'M? - Unspecified' : 'M? - Unspecified';
  const description = typeof task.description === 'string' ? task.description.trim() : '';
  const targetFiles = normalizeStringArray(task.targetFiles);
  const acceptanceCriteria = normalizeStringArray(task.acceptanceCriteria);
  const testExpectations = normalizeStringArray(task.testExpectations);
  const dependencies = typeof task.dependencies === 'string' ? task.dependencies.trim() : '';
  const implementationNotes =
    typeof task.implementationNotes === 'string' ? task.implementationNotes.trim() : '';

  const markdownBody = typeof task.markdown === 'string' ? task.markdown.trim() : '';
  const normalized: ImplementationTask = {
    id: taskId,
    title,
    body: '',
    priority,
    complexity,
    milestone,
    description,
    targetFiles,
    acceptanceCriteria,
    testExpectations,
    dependencies,
    implementationNotes,
    source,
  };

  if (markdownBody) {
    if (/^###\s+Task\b/i.test(markdownBody)) {
      normalized.body = markdownBody;
      if (!normalized.description) {
        normalized.description = markdownBodyWithoutHeading(markdownBody).slice(0, 600).trim();
      }
    } else {
      normalized.body = `### Task ${taskId}: ${title}\n\n${markdownBody}`;
    }
  } else {
    normalized.body = buildTaskBody(normalized);
  }
  return normalized;
}

function tryParseManifestBlock(
  raw: string,
  source: ImplementationTask['source'] = 'manifest'
): ImplementationTask[] {
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!parsed || !Array.isArray(parsed.tasks)) return [];

    const tasks: ImplementationTask[] = [];
    for (let i = 0; i < parsed.tasks.length; i++) {
      const entry = parsed.tasks[i];
      if (!entry || typeof entry !== 'object') continue;
      const normalized = normalizeManifestTask(entry as Record<string, unknown>, i, source);
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
      const parsed = tryParseManifestBlock(match[1], 'manifest');
      if (parsed.length > 0) {
        results.push(...parsed);
      }
    }
  }

  return results;
}

function parseFollowUpTaskManifest(raw: string, parentTask: ImplementationTask): ImplementationTask[] {
  const results: ImplementationTask[] = [];
  const followUpRegexes = [
    /```follow-up-task-manifest\s*([\s\S]*?)```/gi,
    /<follow_up_task_manifest>\s*([\s\S]*?)<\/follow_up_task_manifest>/gi,
  ];

  for (const regex of followUpRegexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const parsed = tryParseManifestBlock(match[1], 'dynamic');
      if (parsed.length === 0) continue;
      for (let i = 0; i < parsed.length; i++) {
        const task = parsed[i];
        const id = task.id?.trim() ? task.id.trim() : `${parentTask.id}-F${i + 1}`;
        results.push({
          ...task,
          id,
          milestone: task.milestone || parentTask.milestone,
          priority: task.priority || parentTask.priority || 'P1',
          complexity: task.complexity || 'Medium',
          dependencies: task.dependencies || `Depends on: ${parentTask.id}`,
          source: 'dynamic',
          body: buildTaskBody({
            ...task,
            id,
            milestone: task.milestone || parentTask.milestone,
            priority: task.priority || parentTask.priority || 'P1',
            complexity: task.complexity || 'Medium',
            dependencies: task.dependencies || `Depends on: ${parentTask.id}`,
            source: 'dynamic',
          }),
        });
      }
    }
  }

  return results.slice(0, MAX_DYNAMIC_FOLLOW_UP_TASKS_PER_TASK);
}

function sanitizeTaskId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

function ensureUniqueTaskId(candidate: string, existingIds: Set<string>): string {
  let normalized = candidate.trim() || `TASK-${existingIds.size + 1}`;
  if (!existingIds.has(normalized)) return normalized;
  let suffix = 2;
  while (existingIds.has(`${normalized}-${suffix}`)) {
    suffix++;
  }
  return `${normalized}-${suffix}`;
}

function sanitizeMilestoneLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'milestone';
}

function chunkStrings(items: string[], size: number): string[][] {
  if (items.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function taskSizeWarnings(task: ImplementationTask): string[] {
  const warnings: string[] = [];
  if (task.targetFiles.length > MAX_TARGET_FILES_PER_TASK) {
    warnings.push(`targetFiles=${task.targetFiles.length}`);
  }
  if (task.acceptanceCriteria.length > MAX_ACCEPTANCE_CRITERIA_PER_TASK) {
    warnings.push(`acceptanceCriteria=${task.acceptanceCriteria.length}`);
  }
  if (task.body.length > MAX_TASK_BODY_CHARS) {
    warnings.push(`bodyChars=${task.body.length}`);
  }
  return warnings;
}

function decomposeTask(task: ImplementationTask): ImplementationTask[] {
  const fileChunks = chunkStrings(task.targetFiles, TASK_DECOMPOSITION_FILE_SLICE_SIZE);
  const acceptanceChunks = chunkStrings(
    task.acceptanceCriteria,
    TASK_DECOMPOSITION_ACCEPTANCE_SLICE_SIZE
  );
  const chunkCount = Math.max(fileChunks.length, acceptanceChunks.length, 2);
  const tasks: ImplementationTask[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const id = `${task.id}-S${i + 1}`;
    const files = fileChunks[i] || [];
    const acceptance = acceptanceChunks[i] || [];
    const dependencies = i === 0
      ? task.dependencies
      : `Depends on: ${tasks[i - 1]?.id || `${task.id}-S${i}`}`;
    const description = [
      task.description || `Slice ${i + 1} of ${task.title}.`,
      files.length > 0 ? `Focus files: ${files.join(', ')}` : 'Focus this slice on remaining scope and integration gaps.',
    ]
      .filter(Boolean)
      .join('\n');
    const subTask: ImplementationTask = {
      ...task,
      id,
      title: `${task.title} (Slice ${i + 1}/${chunkCount})`,
      description,
      targetFiles: files.length > 0 ? files : task.targetFiles.slice(0, TASK_DECOMPOSITION_FILE_SLICE_SIZE),
      acceptanceCriteria:
        acceptance.length > 0
          ? acceptance
          : [`Complete slice ${i + 1}/${chunkCount} for task ${task.id} without regressions.`],
      dependencies,
      source: 'decomposed',
      body: '',
    };
    subTask.body = buildTaskBody(subTask);
    tasks.push(subTask);
  }

  return tasks;
}

function applyTaskDecomposition(
  tasks: ImplementationTask[],
  config: RunConfig,
  runDir: string
): { tasks: ImplementationTask[]; decomposedCount: number } {
  const output: ImplementationTask[] = [];
  let decomposedCount = 0;

  for (const task of tasks) {
    const warnings = taskSizeWarnings(task);
    if (warnings.length === 0) {
      output.push(task);
      continue;
    }

    const decomposed = decomposeTask(task);
    decomposedCount++;
    config.task_decomposition_events = (config.task_decomposition_events || 0) + 1;
    const msg =
      `Task ${task.id} decomposed into ${decomposed.length} slices due to: ${warnings.join(', ')}`;
    log('Implementation', msg);
    appendLog(runDir, msg);
    output.push(...decomposed);
  }

  return { tasks: output, decomposedCount };
}

function saveTaskQueueArtifact(artifactsDir: string, tasks: ImplementationTask[]): void {
  const queuePath = path.join(artifactsDir, '09a_task_queue.json');
  fs.writeFileSync(queuePath, JSON.stringify({ tasks }, null, 2) + '\n');
}

function loadTaskQueueArtifact(artifactsDir: string): ImplementationTask[] {
  const queuePath = path.join(artifactsDir, '09a_task_queue.json');
  if (!fs.existsSync(queuePath)) return [];
  try {
    const raw = fs.readFileSync(queuePath, 'utf-8');
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!parsed || !Array.isArray(parsed.tasks)) return [];
    const tasks: ImplementationTask[] = [];
    for (let i = 0; i < parsed.tasks.length; i++) {
      const entry = parsed.tasks[i];
      if (!entry || typeof entry !== 'object') continue;
      const rawEntry = entry as Record<string, unknown>;
      const source =
        rawEntry.source === 'dynamic' || rawEntry.source === 'decomposed'
          ? (rawEntry.source as ImplementationTask['source'])
          : 'manifest';
      const normalized = normalizeManifestTask(rawEntry, i, source);
      if (normalized) tasks.push(normalized);
    }
    return tasks;
  } catch {
    return [];
  }
}

function appendDynamicBacklogArtifact(
  artifactsDir: string,
  parentTask: ImplementationTask,
  dynamicTasks: ImplementationTask[]
): void {
  if (dynamicTasks.length === 0) return;
  const backlogPath = path.join(artifactsDir, '09_dynamic_backlog.md');
  const lines: string[] = [];
  lines.push(`## Added after ${parentTask.id}: ${parentTask.title}`);
  lines.push('');
  for (const task of dynamicTasks) {
    lines.push(`- ${task.id} — ${task.title} (${task.milestone})`);
  }
  lines.push('');
  fs.appendFileSync(backlogPath, lines.join('\n'));
}

function parseTaskIdsFromRoutingMatrix(taskBreakdown: string): Set<string> {
  const ids = new Set<string>();
  const matrixMatch = taskBreakdown.match(
    /##\s*4\.\s*Routing Coverage Matrix([\s\S]*?)(?:\n##\s*5\.|\n##\s*6\.|\n##\s*7\.|\n##\s*8\.|$)/i
  );
  if (!matrixMatch?.[1]) return ids;

  const taskIdRegex = /\bM\d+-\d+(?:-[A-Z]\d+)?\b/g;
  const lines = matrixMatch[1].split('\n');
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const matches = line.match(taskIdRegex);
    if (!matches) continue;
    for (const match of matches) ids.add(match);
  }
  return ids;
}

function validateTaskTraceability(
  taskBreakdown: string,
  tasks: ImplementationTask[]
): string[] {
  const warnings: string[] = [];
  const manifestIds = new Set(tasks.map((task) => task.id));
  const matrixIds = parseTaskIdsFromRoutingMatrix(taskBreakdown);

  if (matrixIds.size === 0) {
    warnings.push('Routing Coverage Matrix did not reference any task IDs.');
    return warnings;
  }

  for (const id of matrixIds) {
    const coveredBySlice = tasks.some((task) => task.id === id || task.id.startsWith(`${id}-`));
    if (!manifestIds.has(id) && !coveredBySlice) {
      warnings.push(`Routing Coverage Matrix references unknown task ID: ${id}`);
    }
  }

  return warnings;
}

function normalizeFilePathForValidation(filePath: string): string {
  return filePath.replace(/\\/g, '/').trim();
}

function isCanonicalTemplateTestFile(filePath: string): boolean {
  const normalized = normalizeFilePathForValidation(filePath);
  return CANONICAL_TEMPLATE_TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function looksLikeTestFile(filePath: string): boolean {
  const normalized = normalizeFilePathForValidation(filePath).toLowerCase();
  if (normalized.includes('/packages/tests/src/')) return true;
  if (normalized.includes('/apps/web/e2e/')) return true;
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/e2e/') ||
    /\.(test|spec)\.[cm]?[tj]sx?$/i.test(normalized)
  );
}

function validateTemplateTestConventions(tasks: ImplementationTask[]): string[] {
  const warnings: string[] = [];

  for (const task of tasks) {
    for (const filePath of task.targetFiles) {
      if (!looksLikeTestFile(filePath)) continue;
      if (!isCanonicalTemplateTestFile(filePath)) {
        warnings.push(
          `Task ${task.id} references non-canonical test file path "${filePath}". ` +
            'Allowed test targets: packages/tests/src/*.test.ts(x), apps/web/e2e/*.spec.ts(x), and apps/web/e2e/*.setup.ts(x).'
        );
      }
    }

    for (const expectation of task.testExpectations) {
      for (const rule of DISALLOWED_TEST_EXPECTATION_PATTERNS) {
        if (!rule.pattern.test(expectation)) continue;
        warnings.push(
          `Task ${task.id} test expectation "${expectation}" violates template test conventions: ${rule.reason}.`
        );
      }
    }
  }

  return warnings;
}

function writeTaskPlanSummary(
  artifactsDir: string,
  tasks: ImplementationTask[],
  traceabilityWarnings: string[]
): void {
  const milestoneCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();

  for (const task of tasks) {
    milestoneCounts.set(task.milestone, (milestoneCounts.get(task.milestone) || 0) + 1);
    sourceCounts.set(task.source, (sourceCounts.get(task.source) || 0) + 1);
  }

  const lines: string[] = [];
  lines.push('# Phase 9 Task Queue Summary');
  lines.push('');
  lines.push(`- Total tasks: ${tasks.length}`);
  lines.push(
    `- Source breakdown: ${Array.from(sourceCounts.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`
  );
  lines.push('');
  lines.push('## Milestone Counts');
  for (const [milestone, count] of milestoneCounts.entries()) {
    lines.push(`- ${milestone}: ${count}`);
  }
  lines.push('');
  lines.push('## Traceability');
  if (traceabilityWarnings.length === 0) {
    lines.push('- Routing matrix references valid task IDs.');
  } else {
    for (const warning of traceabilityWarnings) lines.push(`- ⚠️ ${warning}`);
  }
  lines.push('');
  fs.writeFileSync(path.join(artifactsDir, '09a_task_plan_summary.md'), lines.join('\n') + '\n');
}

function trimContextContent(label: string, content: string, maxChars: number): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const headChars = Math.floor(maxChars * 0.65);
  const tailChars = Math.floor(maxChars * 0.35);
  return [
    trimmed.slice(0, headChars),
    `\n\n<!-- ${label} trimmed for context size (${trimmed.length} chars) -->\n\n`,
    trimmed.slice(-tailChars),
  ].join('');
}

function extractTaskSection(taskBreakdown: string, taskId: string): string {
  const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(^###\\s+Task\\s+${escapedId}:[\\s\\S]*?)(?=\\n###\\s+Task\\s+M\\d+-\\d+:|\\n##\\s+3\\.|\\n##\\s+4\\.|\\n##\\s+5\\.|\\n##\\s+6\\.|\\n##\\s+7\\.|\\n##\\s+8\\.|$)`,
    'im'
  );
  const match = taskBreakdown.match(regex);
  return match?.[1]?.trim() || '';
}

function extractTechSpecContext(techSpec: string, task: ImplementationTask): string {
  const snippets: string[] = [];
  const sectionsToCapture = [
    /##\s*3\.\s*API Design[\s\S]*?(?=\n##\s*4\.|\n##\s*5\.|$)/i,
    /##\s*6\.\s*Authentication & Authorization[\s\S]*?(?=\n##\s*7\.|\n##\s*8\.|$)/i,
    /##\s*7\.\s*Error Handling Strategy[\s\S]*?(?=\n##\s*8\.|\n##\s*9\.|$)/i,
    /##\s*8\.\s*Testing Strategy[\s\S]*?(?=\n##\s*9\.|\n##\s*10\.|$)/i,
    /##\s*11\.\s*File-by-File Change Plan[\s\S]*?(?=\n##\s*12\.|\n##\s*13\.|$)/i,
  ];

  for (const sectionRegex of sectionsToCapture) {
    const match = techSpec.match(sectionRegex);
    if (match?.[0]) snippets.push(match[0].trim());
  }

  for (const filePath of task.targetFiles) {
    const basename = path.basename(filePath);
    if (!basename) continue;
    const idx = techSpec.toLowerCase().indexOf(basename.toLowerCase());
    if (idx === -1) continue;
    const start = Math.max(0, idx - 700);
    const end = Math.min(techSpec.length, idx + 1200);
    snippets.push(techSpec.slice(start, end).trim());
  }

  if (snippets.length === 0) {
    return trimContextContent('Tech Spec', techSpec, 28_000);
  }
  return trimContextContent('Tech Spec', snippets.join('\n\n---\n\n'), 28_000);
}

function buildImplementationReplacements(
  config: RunConfig,
  artifactsDir: string,
  task: ImplementationTask
): Record<string, string> {
  const phase = PHASES.find((p) => p.id === '9')!;
  const base = gatherReplacements(config, phase, artifactsDir);
  const techSpec = readArtifact(artifactsDir, '7');
  const taskBreakdown = readArtifact(artifactsDir, '8');
  const prd = readArtifact(artifactsDir, '4');
  const designTheme = readArtifact(artifactsDir, '3');
  const taskSection = extractTaskSection(taskBreakdown, task.id) || task.body;
  const compactTaskBreakdown = trimContextContent('Task Breakdown', taskSection, 18_000);

  base['TASK'] = task.body;
  base['ARTIFACT_05'] = `<artifact phase="7">\n${extractTechSpecContext(techSpec, task)}\n</artifact>`;
  base['ARTIFACT_06'] = `<artifact phase="8">\n${compactTaskBreakdown}\n</artifact>`;
  base['ARTIFACT_03'] = `<artifact phase="4">\n${trimContextContent('PRD', prd, 14_000)}\n</artifact>`;
  base['ARTIFACT_025'] = `<artifact phase="3">\n${trimContextContent('Design Theme', designTheme, 10_000)}\n</artifact>`;
  base['TEMPLATE_CONTEXT'] = trimContextContent('Template Context', loadTemplateContext(), 12_000);
  return base;
}

function capPromptLength(prompt: string, maxChars: number, label: string, runDir: string): string {
  if (prompt.length <= maxChars) return prompt;
  const capped = trimContextContent(label, prompt, maxChars);
  appendLog(
    runDir,
    `${label} prompt trimmed from ${prompt.length.toLocaleString()} chars to ${capped.length.toLocaleString()} chars.`
  );
  return capped;
}

function compactWrappedArtifact(value: string, label: string, maxChars: number): string {
  const trimmed = value.trim();
  const artifactMatch = trimmed.match(/^<artifact[^>]*>\s*([\s\S]*?)\s*<\/artifact>$/i);
  if (!artifactMatch?.[1]) {
    return trimContextContent(label, value, maxChars);
  }
  const openingTag = trimmed.match(/^<artifact[^>]*>/i)?.[0] || '<artifact>';
  const compactBody = trimContextContent(label, artifactMatch[1], maxChars);
  return `${openingTag}\n${compactBody}\n</artifact>`;
}

function compactPhaseReplacements(
  phaseId: string,
  replacements: Record<string, string>,
  runDir: string
): Record<string, string> {
  const compacted = { ...replacements };
  const plans: Record<string, Array<{ key: string; maxChars: number }>> = {
    '6': [
      { key: 'ARTIFACT_03', maxChars: 16_000 },
      { key: 'ARTIFACT_03B', maxChars: 18_000 },
      { key: 'TEMPLATE_CONTEXT', maxChars: 12_000 },
    ],
    '7': [
      { key: 'ARTIFACT_02', maxChars: 16_000 },
      { key: 'ARTIFACT_03', maxChars: 16_000 },
      { key: 'ARTIFACT_04', maxChars: 14_000 },
      { key: 'ARTIFACT_03B', maxChars: 16_000 },
      { key: 'ARTIFACT_025', maxChars: 10_000 },
      { key: 'TEMPLATE_CONTEXT', maxChars: 12_000 },
    ],
    '8': [
      { key: 'ARTIFACT_02', maxChars: 16_000 },
      { key: 'ARTIFACT_05', maxChars: 24_000 },
      { key: 'ARTIFACT_03', maxChars: 14_000 },
      { key: 'ARTIFACT_04', maxChars: 12_000 },
      { key: 'ARTIFACT_025', maxChars: 10_000 },
      { key: 'TEMPLATE_CONTEXT', maxChars: 12_000 },
    ],
  };

  const plan = plans[phaseId];
  if (!plan) return compacted;

  for (const entry of plan) {
    const existing = compacted[entry.key];
    if (!existing || existing === '(not available)') continue;
    const compactedValue = compactWrappedArtifact(existing, `${phaseId}:${entry.key}`, entry.maxChars);
    if (compactedValue.length < existing.length) {
      appendLog(
        runDir,
        `Phase ${phaseId} context compacted ${entry.key}: ${existing.length.toLocaleString()} -> ${compactedValue.length.toLocaleString()} chars`
      );
    }
    compacted[entry.key] = compactedValue;
  }

  return compacted;
}

function writeTaskQualityArtifact(
  artifactsDir: string,
  task: ImplementationTask,
  taskIndex: number,
  suffix: string,
  qualityResults: WorkspaceTestResult
): void {
  const qualityDir = path.join(artifactsDir, '09_quality');
  fs.mkdirSync(qualityDir, { recursive: true });
  const safeTaskId = sanitizeTaskId(task.id || String(taskIndex));
  const fileName = `${String(taskIndex).padStart(2, '0')}_${safeTaskId}_${suffix}.md`;
  const content = [
    `# Quality Report — Task ${taskIndex}: ${task.title}`,
    '',
    `- Task ID: ${task.id}`,
    `- Milestone: ${task.milestone}`,
    `- Result: ${qualityResults.allPassed ? 'PASS' : 'FAIL'}`,
    '',
    qualityResults.report,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(qualityDir, fileName), content);
}

function isMilestoneBoundary(tasks: ImplementationTask[], currentIndex: number): boolean {
  const current = tasks[currentIndex]?.milestone || '';
  const next = tasks[currentIndex + 1]?.milestone || '';
  return !next || current !== next;
}

function shouldRunTaskE2ESetupSmoke(task: ImplementationTask): boolean {
  const fileSignals = task.targetFiles.some((filePath) => {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    return PHASE9_E2E_SETUP_SMOKE_FILE_HINTS.some((hint) => normalized.includes(hint.toLowerCase()));
  });
  if (fileSignals) return true;

  const textSignals = [
    task.title,
    task.description,
    task.body,
    task.implementationNotes,
    task.dependencies,
    ...task.acceptanceCriteria,
    ...task.testExpectations,
  ]
    .join('\n')
    .slice(0, 10_000);
  return PHASE9_E2E_SETUP_SMOKE_KEYWORDS.test(textSignals);
}

function runImplementation(
  config: RunConfig,
  artifactsDir: string,
  runDir: string,
  opts: { budgetUsd?: number; dryRun?: boolean }
): void {
  const phase = PHASES.find((p) => p.id === '9')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 9 (${phase.name}) started`);

  validatePhasePrerequisites(config, artifactsDir, phase);

  if (!config.workspace_path || !fs.existsSync(config.workspace_path)) {
    throw new Error('Workspace not found. Run repo bootstrap (phase 5) first.');
  }

  const taskBreakdown = readArtifact(artifactsDir, '8');
  let tasks = loadTaskQueueArtifact(artifactsDir);
  if (tasks.length === 0) {
    tasks = parseTaskManifest(taskBreakdown);
    if (tasks.length === 0) {
      const hasManifestBlock = /```task-manifest/i.test(taskBreakdown) || /<task_manifest>/i.test(taskBreakdown);
      if (hasManifestBlock) {
        throw new Error(
          'Phase 8 task manifest exists but could not be parsed. Ensure the `task-manifest` block is valid JSON with a non-empty `tasks` array.'
        );
      }
      throw new Error(
        'Phase 8 output is missing a machine-readable `task-manifest` block. Re-run phase 8 before implementation.'
      );
    }
    if ((config.last_completed_task || 0) > 0) {
      log(
        phase.name,
        'Loaded manifest tasks without decomposition because resume checkpoint already exists and no persisted queue was found.'
      );
      saveTaskQueueArtifact(artifactsDir, tasks);
    } else {
      const decomposition = applyTaskDecomposition(tasks, config, runDir);
      tasks = decomposition.tasks;
      saveTaskQueueArtifact(artifactsDir, tasks);
      log(
        phase.name,
        `Parsed ${tasks.length} implementation tasks from manifest (${decomposition.decomposedCount} oversized task(s) decomposed)`
      );
    }
  } else {
    log(phase.name, `Loaded persisted task queue with ${tasks.length} task(s) from prior run state.`);
  }

  const traceabilityWarnings = validateTaskTraceability(taskBreakdown, tasks);
  const testConventionWarnings = validateTemplateTestConventions(tasks);
  writeTaskPlanSummary(artifactsDir, tasks, traceabilityWarnings);
  if (traceabilityWarnings.length > 0) {
    const fatalWarnings = traceabilityWarnings.filter((warning) => /unknown task ID/i.test(warning));
    if (fatalWarnings.length > 0) {
      throw new Error(
        `Task traceability validation failed: ${fatalWarnings.join('; ')}. Re-run phase 8 to repair coverage mapping.`
      );
    }
    appendLog(runDir, `Phase 9 traceability warnings: ${traceabilityWarnings.join('; ')}`);
  }
  if (testConventionWarnings.length > 0) {
    appendLog(runDir, `Phase 9 test convention warnings: ${testConventionWarnings.join('; ')}`);
    const preview = testConventionWarnings.slice(0, 6).join('; ');
    const suffix = testConventionWarnings.length > 6 ? '; ...' : '';
    throw new Error(
      `Task test convention validation failed: ${preview}${suffix}. ` +
        'Re-run phase 8 so tasks use only template test patterns (integration + Playwright E2E).'
    );
  }

  log(phase.name, `Found ${tasks.length} tasks to implement`);
  saveConfig(runDir, config);

  // Dry-run mode
  if (opts.dryRun) {
    console.log(`  [dry-run] Phase 9: ${tasks.length} tasks to implement`);
    for (let i = 0; i < tasks.length; i++) {
      console.log(`  [dry-run]   Task ${i + 1}: ${tasks[i].id} — ${tasks[i].title}`);
    }
    return;
  }

  const resetDirtyWorkspaceToHead = (reason: string): void => {
    const before = gitStatusCheckpoint(config.workspace_path!);
    appendLog(runDir, `Phase 9 workspace reset requested (${reason}). Status before reset:\n${before}`);
    gitResetHard(config.workspace_path!, 'HEAD');
    const after = gitStatusCheckpoint(config.workspace_path!);
    appendLog(runDir, `Phase 9 workspace reset complete. Status after reset:\n${after}`);
  };

  // Record pre-implementation status
  const preStatus = gitStatusCheckpoint(config.workspace_path);
  appendLog(runDir, `Pre-implementation git status:\n${preStatus}`);
  if (hasGitChanges(config.workspace_path)) {
    log(phase.name, 'Detected uncommitted changes before Phase 9. Auto-resetting workspace to HEAD...');
    resetDirtyWorkspaceToHead('auto-clean before Phase 9 start');
    if (hasGitChanges(config.workspace_path)) {
      throw new Error(
        'Workspace still has uncommitted changes after auto-reset before Phase 9. Resolve git state and retry.'
      );
    }
  }

  log(phase.name, 'Running dependency preflight before task execution...');
  const dependencyPreflight = runWorkspaceDependencyInstall(
    config.workspace_path,
    config.timeout_ms ?? 300_000
  );
  appendLog(
    runDir,
    `Phase 9 dependency preflight (${dependencyPreflight.command}) ` +
      `${dependencyPreflight.success ? 'PASS' : 'FAIL'}:\n${dependencyPreflight.output}`
  );
  if (!dependencyPreflight.success) {
    throw new Error(
      `Phase 9 dependency preflight failed before task execution: ${dependencyPreflight.command}`
    );
  }

  // Skip already-completed tasks (task-level checkpointing)
  const startTask = config.last_completed_task || 0;
  if (startTask > 0) {
    log(phase.name, `Resuming from task ${startTask + 1} (${startTask} already completed)`);
  }
  if (startTask > tasks.length) {
    throw new Error(
      `Saved checkpoint last_completed_task=${startTask} exceeds current task queue length ${tasks.length}. ` +
      'Delete artifacts/09a_task_queue.json and rerun phase 8/9 to rebuild task queue.'
    );
  }

  try {
    // Execute each task
    for (let i = startTask; i < tasks.length; i++) {
      const task = tasks[i];
      log(phase.name, `Implementing task ${i + 1}/${tasks.length}: ${task.title}`);
      if (hasGitChanges(config.workspace_path)) {
        throw new Error(
          `Workspace is not clean before task ${i + 1}. Refusing to continue to avoid misattributed commits.`
        );
      }

      // Check budget before each task
      checkBudget(config, opts.budgetUsd, { runDir });

      const promptPath = path.join(PROMPTS_DIR, phase.promptFile!);
      const replacements = buildImplementationReplacements(config, artifactsDir, task);
      const fullPrompt = capPromptLength(
        buildPrompt(promptPath, replacements),
        TASK_PROMPT_CONTEXT_CHAR_LIMIT,
        `Phase 9 task ${task.id}`,
        runDir
      );
      const promptTokens = estimateTokens(fullPrompt);
      if (promptTokens > CONTEXT_WARNING_THRESHOLD) {
        appendLog(
          runDir,
          `Phase 9 task ${task.id} prompt remains large (~${promptTokens.toLocaleString()} tokens) after compaction.`
        );
      }

      // Run AI agent in the workspace directory with edit permissions
      const result = retryAgent(fullPrompt, {
        cwd: config.workspace_path,
        maxTurns: 20,
        permissions: 'read-write',
        engine: config.engine,
        claudeOutputFormat: config.claude_output_format,
        timeoutMs: config.timeout_ms,
      }, `9-task-${i + 1}`, runDir);

      // Track cost
      recordAgentUsage(config, '9', result, runDir, `Phase 9-task-${i + 1}`);
      logAgentDiagnostics(`Phase 9-task-${i + 1}`, result, runDir);

      const dynamicTasks = parseFollowUpTaskManifest(result.output, task);
      if (dynamicTasks.length > 0) {
        const existingIds = new Set(tasks.map((t) => t.id));
        const normalizedDynamicTasks = dynamicTasks.map((dynamicTask) => {
          const uniqueId = ensureUniqueTaskId(dynamicTask.id, existingIds);
          existingIds.add(uniqueId);
          const normalized: ImplementationTask = {
            ...dynamicTask,
            id: uniqueId,
            source: 'dynamic',
          };
          normalized.body = buildTaskBody(normalized);
          return normalized;
        });
        const dynamicTestConventionWarnings = validateTemplateTestConventions(normalizedDynamicTasks);
        if (dynamicTestConventionWarnings.length > 0) {
          appendLog(
            runDir,
            `Task ${task.id} produced invalid dynamic test patterns: ${dynamicTestConventionWarnings.join('; ')}`
          );
          const preview = dynamicTestConventionWarnings.slice(0, 4).join('; ');
          const suffix = dynamicTestConventionWarnings.length > 4 ? '; ...' : '';
          throw new Error(
            `Dynamic task test convention validation failed after ${task.id}: ${preview}${suffix}. ` +
              'Generated follow-up tasks must use only integration/E2E template test patterns.'
          );
        }
        tasks.splice(i + 1, 0, ...normalizedDynamicTasks);
        config.dynamic_tasks_added = (config.dynamic_tasks_added || 0) + normalizedDynamicTasks.length;
        saveTaskQueueArtifact(artifactsDir, tasks);
        appendDynamicBacklogArtifact(artifactsDir, task, normalizedDynamicTasks);
        appendLog(
          runDir,
          `Task ${task.id} added ${normalizedDynamicTasks.length} dynamic follow-up task(s): ` +
            normalizedDynamicTasks.map((t) => t.id).join(', ')
        );
      }

    if (!hasGitChanges(config.workspace_path!)) {
      const msg = `Task ${task.id} (${i + 1}/${tasks.length}) produced no git changes and cannot be marked complete.`;
      appendLog(runDir, msg);
      throw new Error(msg);
    }

    // Task-level quality gate before commit keeps breakages localized.
    let qualityResults = runWorkspaceQualityChecks(
      config.workspace_path!,
      config.timeout_ms ?? 300_000,
      { forceFullWorkspaceLintTypecheck: true }
    );
    writeTaskQualityArtifact(artifactsDir, task, i + 1, 'quality-initial', qualityResults);
    if (!qualityResults.allPassed) {
      for (let attempt = 1; attempt <= MAX_TASK_QUALITY_REPAIR_ATTEMPTS; attempt++) {
        const failedChecks = qualityResults.checks.filter((check) => !check.success);
        const failedNames = failedChecks.map((check) => check.name).join(', ');
        log(
          phase.name,
          `Task ${i + 1}/${tasks.length} quality checks failed (${failedNames}). Starting focused repair ${attempt}/${MAX_TASK_QUALITY_REPAIR_ATTEMPTS}...`
        );

        checkBudget(config, opts.budgetUsd, { runDir });
        const qualityRepairPrompt = buildTaskQualityRepairPrompt(
          task,
          i + 1,
          tasks.length,
          trimContextContent('Task quality report', qualityResults.report, 20_000),
          failedChecks
        );

        const qualityRepairResult = retryAgent(
          capPromptLength(
            qualityRepairPrompt,
            TASK_PROMPT_CONTEXT_CHAR_LIMIT,
            `Phase 9 task ${task.id} quality repair`,
            runDir
          ),
          {
            cwd: config.workspace_path,
            maxTurns: 12,
            permissions: 'read-write',
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
          },
          `9-task-${i + 1}-quality-repair-${attempt}`,
          runDir
        );
        recordAgentUsage(
          config,
          '9',
          qualityRepairResult,
          runDir,
          `Phase 9-task-${i + 1}-quality-repair-${attempt}`
        );
        logAgentDiagnostics(
          `Phase 9-task-${i + 1}-quality-repair-${attempt}`,
          qualityRepairResult,
          runDir
        );

        qualityResults = runWorkspaceQualityChecks(
          config.workspace_path!,
          config.timeout_ms ?? 300_000,
          { forceFullWorkspaceLintTypecheck: true }
        );
        writeTaskQualityArtifact(
          artifactsDir,
          task,
          i + 1,
          `quality-repair-${attempt}`,
          qualityResults
        );
        if (qualityResults.allPassed) break;
      }
    }

    if (!qualityResults.allPassed) {
      const failedNames = qualityResults.checks
        .filter((check) => !check.success)
        .map((check) => check.name)
        .join(', ');
      const msg =
        `Task ${i + 1}/${tasks.length} failed task-level quality checks after repair attempts: ${failedNames}.`;
      appendLog(runDir, msg);
      throw new Error(msg);
    }

    if (shouldRunTaskE2ESetupSmoke(task)) {
      log(
        phase.name,
        `Task ${i + 1}/${tasks.length} hits auth/routing surface; running Playwright setup smoke gate...`
      );
      const e2eSetupTimeoutMs = Math.max(config.timeout_ms ?? 0, PHASE9_E2E_SETUP_SMOKE_TIMEOUT_MS);
      let e2eSetupResults = runWorkspaceTests(
        config.workspace_path!,
        e2eSetupTimeoutMs,
        'e2e_setup'
      );
      writeTaskQualityArtifact(artifactsDir, task, i + 1, 'e2e-setup-initial', e2eSetupResults);

      if (!e2eSetupResults.allPassed) {
        for (let attempt = 1; attempt <= MAX_TASK_QUALITY_REPAIR_ATTEMPTS; attempt++) {
          const failedChecks = e2eSetupResults.checks.filter((check) => !check.success);
          const failedNames = failedChecks.map((check) => check.name).join(', ');
          log(
            phase.name,
            `Task ${i + 1}/${tasks.length} Playwright setup smoke failed (${failedNames}). Starting focused repair ${attempt}/${MAX_TASK_QUALITY_REPAIR_ATTEMPTS}...`
          );

          checkBudget(config, opts.budgetUsd, { runDir });
          const setupRepairPrompt = buildTaskE2ESetupRepairPrompt(
            task,
            i + 1,
            tasks.length,
            trimContextContent('Playwright setup smoke report', e2eSetupResults.report, 24_000),
            failedChecks
          );

          const setupRepairResult = retryAgent(
            capPromptLength(
              setupRepairPrompt,
              TASK_PROMPT_CONTEXT_CHAR_LIMIT,
              `Phase 9 task ${task.id} e2e setup repair`,
              runDir
            ),
            {
              cwd: config.workspace_path,
              maxTurns: 12,
              permissions: 'read-write',
              engine: config.engine,
              claudeOutputFormat: config.claude_output_format,
              timeoutMs: config.timeout_ms,
            },
            `9-task-${i + 1}-e2e-setup-repair-${attempt}`,
            runDir
          );
          recordAgentUsage(
            config,
            '9',
            setupRepairResult,
            runDir,
            `Phase 9-task-${i + 1}-e2e-setup-repair-${attempt}`
          );
          logAgentDiagnostics(
            `Phase 9-task-${i + 1}-e2e-setup-repair-${attempt}`,
            setupRepairResult,
            runDir
          );

          qualityResults = runWorkspaceQualityChecks(
            config.workspace_path!,
            config.timeout_ms ?? 300_000,
            { forceFullWorkspaceLintTypecheck: true }
          );
          writeTaskQualityArtifact(
            artifactsDir,
            task,
            i + 1,
            `quality-after-e2e-setup-repair-${attempt}`,
            qualityResults
          );

          e2eSetupResults = runWorkspaceTests(
            config.workspace_path!,
            e2eSetupTimeoutMs,
            'e2e_setup'
          );
          writeTaskQualityArtifact(
            artifactsDir,
            task,
            i + 1,
            `e2e-setup-repair-${attempt}`,
            e2eSetupResults
          );

          if (qualityResults.allPassed && e2eSetupResults.allPassed) break;
        }
      }

      if (!qualityResults.allPassed) {
        const failedNames = qualityResults.checks
          .filter((check) => !check.success)
          .map((check) => check.name)
          .join(', ');
        const msg =
          `Task ${i + 1}/${tasks.length} failed quality checks after E2E setup repairs: ${failedNames}.`;
        appendLog(runDir, msg);
        throw new Error(msg);
      }

      if (!e2eSetupResults.allPassed) {
        const failedNames = e2eSetupResults.checks
          .filter((check) => !check.success)
          .map((check) => check.name)
          .join(', ');
        const msg =
          `Task ${i + 1}/${tasks.length} failed Playwright setup smoke checks after repair attempts: ${failedNames}.`;
        appendLog(runDir, msg);
        throw new Error(msg);
      }
    }

    // Commit changes after each task for rollback safety
    const committed = gitCommitChanges(
      config.workspace_path!,
      `Pipeline Phase 9 - Task ${i + 1}/${tasks.length} (${task.id}): ${task.title}`
    );
    if (!committed) {
      const status = gitStatusCheckpoint(config.workspace_path!);
      const msg =
        `Task ${i + 1}/${tasks.length} made changes but commit failed. ` +
        `Resolve commit failure before resuming. Current status:\n${status}`;
      appendLog(runDir, msg);
      throw new Error(msg);
    }
    log(phase.name, `  Committed changes for task ${i + 1}`);

    // Update task checkpoint
    config.last_completed_task = i + 1;
    saveConfig(runDir, config);
    saveTaskQueueArtifact(artifactsDir, tasks);

    // Record status after each task
    const postStatus = gitStatusCheckpoint(config.workspace_path!);
    appendLog(
      runDir,
      `After task "${task.id}: ${task.title}" (source=${task.source}, raw cost: $${result.costUsd.toFixed(4)}):\n${postStatus}`
    );

    if (isMilestoneBoundary(tasks, i)) {
      const milestoneName = task.milestone || `Task ${task.id}`;
      log(phase.name, `Milestone quality gate: ${milestoneName}`);
      let milestoneQuality = runWorkspaceQualityChecks(
        config.workspace_path!,
        config.timeout_ms ?? 300_000,
        { forceFullWorkspace: true }
      );
      writeTaskQualityArtifact(
        artifactsDir,
        task,
        i + 1,
        `milestone-${sanitizeMilestoneLabel(milestoneName)}-initial`,
        milestoneQuality
      );

      if (!milestoneQuality.allPassed) {
        for (let attempt = 1; attempt <= MAX_TASK_QUALITY_REPAIR_ATTEMPTS; attempt++) {
          const failedChecks = milestoneQuality.checks.filter((check) => !check.success);
          const failedNames = failedChecks.map((check) => check.name).join(', ');
          log(
            phase.name,
            `Milestone gate failed (${failedNames}). Repair attempt ${attempt}/${MAX_TASK_QUALITY_REPAIR_ATTEMPTS}...`
          );
          checkBudget(config, opts.budgetUsd, { runDir });
          const milestoneRepairPrompt = buildMilestoneQualityRepairPrompt(
            milestoneName,
            trimContextContent('Milestone quality report', milestoneQuality.report, 24_000),
            failedChecks
          );
          const milestoneRepairResult = retryAgent(
            capPromptLength(
              milestoneRepairPrompt,
              TASK_PROMPT_CONTEXT_CHAR_LIMIT,
              `Phase 9 milestone repair ${milestoneName}`,
              runDir
            ),
            {
              cwd: config.workspace_path,
              maxTurns: 14,
              permissions: 'read-write',
              engine: config.engine,
              claudeOutputFormat: config.claude_output_format,
              timeoutMs: config.timeout_ms,
            },
            `9-milestone-${sanitizeMilestoneLabel(milestoneName)}-repair-${attempt}`,
            runDir
          );
          recordAgentUsage(
            config,
            '9',
            milestoneRepairResult,
            runDir,
            `Phase 9 milestone repair ${milestoneName} attempt ${attempt}`
          );
          logAgentDiagnostics(
            `Phase 9 milestone-${sanitizeMilestoneLabel(milestoneName)}-repair-${attempt}`,
            milestoneRepairResult,
            runDir
          );
          milestoneQuality = runWorkspaceQualityChecks(
            config.workspace_path!,
            config.timeout_ms ?? 300_000,
            { forceFullWorkspace: true }
          );
          writeTaskQualityArtifact(
            artifactsDir,
            task,
            i + 1,
            `milestone-${sanitizeMilestoneLabel(milestoneName)}-repair-${attempt}`,
            milestoneQuality
          );
          if (milestoneQuality.allPassed) break;
        }
      }

      if (!milestoneQuality.allPassed) {
        const failedNames = milestoneQuality.checks
          .filter((check) => !check.success)
          .map((check) => check.name)
          .join(', ');
        const msg = `Milestone quality gate failed for "${milestoneName}" after repairs: ${failedNames}.`;
        appendLog(runDir, msg);
        throw new Error(msg);
      }
    }

      log(phase.name, `Task ${i + 1}/${tasks.length} complete`);
    }

    // Record post-implementation status
    const finalDiff = gitDiffStat(config.workspace_path!);
    appendLog(runDir, `Post-implementation diff:\n${finalDiff}`);

    if (!config.completed_phases.includes('9')) {
      config.completed_phases.push('9');
    }
    config.current_phase = '9';
    appendLog(runDir, `Phase 9 (${phase.name}) completed`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(runDir, `Phase 9 error: ${message}`);
    if (hasGitChanges(config.workspace_path!)) {
      try {
        resetDirtyWorkspaceToHead('recovery after Phase 9 failure');
      } catch (resetError: unknown) {
        const resetMessage = resetError instanceof Error ? resetError.message : String(resetError);
        appendLog(runDir, `Phase 9 auto-reset failed: ${resetMessage}`);
      }
    }
    throw error;
  }
}

/**
 * Phase 10: Run tests in the workspace and save results as an artifact.
 * This feeds real test results into the Phase 12 audit.
 */
function runTestVerification(
  config: RunConfig,
  artifactsDir: string,
  runDir: string,
  opts: { dryRun?: boolean; budgetUsd?: number }
): void {
  const phase = PHASES.find((p) => p.id === '10')!;
  log(phase.name, 'Starting...');
  appendLog(runDir, `Phase 10 (${phase.name}) started`);
  validatePhasePrerequisites(config, artifactsDir, phase);

  if (!config.workspace_path || !fs.existsSync(config.workspace_path)) {
    throw new Error('Workspace not found for test verification.');
  }
  const workspacePath = config.workspace_path;
  const completedStageSet = new Set<Phase10Stage['id']>(config.phase10_completed_stages || []);

  if (opts.dryRun) {
    console.log('  [dry-run] Phase 10: Would run 10A integration + 10B e2e verification and repairs');
    return;
  }

  log(phase.name, 'Running staged verification (10A integration, then 10B e2e)...');
  const artifactPath = path.join(artifactsDir, '07b_test_results.md');
  const verificationBlocks: VerificationBlock[] = [];
  const persistVerificationArtifact = (): void => {
    fs.writeFileSync(artifactPath, renderVerificationArtifact(verificationBlocks) + '\n');
    log(phase.name, `Test results saved: ${artifactPath}`);
  };
  const cleanupVerificationArtifacts = (label: string): void => {
    const cleaned = cleanupWorkspaceVerificationArtifacts(workspacePath);
    if (cleaned.length === 0) return;
    const message = `Phase 10 ${label}: removed ephemeral test artifacts (${cleaned.join(', ')}).`;
    log(phase.name, message);
    appendLog(runDir, message);
  };

  const appendVerificationErrorBlock = (message: string): void => {
    const failureResult: ReturnType<typeof runWorkspaceTests> = {
      allPassed: false,
      checks: [
        {
          name: 'Verification Error',
          command: 'pipeline',
          success: false,
          output: message,
        },
      ],
      report: `## Verification Error (pipeline)\n\`\`\`\n${message}\n\`\`\``,
    };
    verificationBlocks.push({
      title: 'Pipeline Failure Details',
      result: failureResult,
    });
    persistVerificationArtifact();
  };

  cleanupVerificationArtifacts('preflight');
  if (hasGitChanges(workspacePath)) {
    throw new Error(
      'Workspace has uncommitted changes before Phase 10. Commit or reset pending edits before verification.'
    );
  }
  if (completedStageSet.size > 0) {
    const checkpointMessage =
      `Phase 10 stage checkpoint detected. Completed stage(s): ${Array.from(completedStageSet).join(', ')}.`;
    log(phase.name, checkpointMessage);
    appendLog(runDir, checkpointMessage);
  }

  const runStageVerification = (stage: Phase10Stage): void => {
    log(phase.name, `[${stage.id}] Starting ${stage.name} verification...`);
    let latestResults = runWorkspaceTests(workspacePath, stage.timeoutMs, stage.suite);
    verificationBlocks.push({
      title: `${stage.id} ${stage.name} - Initial Verification`,
      result: latestResults,
    });
    persistVerificationArtifact();
    cleanupVerificationArtifacts(`post-${stage.id} initial verification`);

    if (!latestResults.allPassed) {
      let maxRepairAttempts = MAX_TEST_REPAIR_ATTEMPTS;
      let previousFailureUnits = estimateRemainingFailureUnits(
        latestResults.checks.filter((check) => !check.success)
      );
      let previousPromptFailures: TestCheckResult[] | null = null;

      for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
        const failedChecks = latestResults.checks.filter((check) => !check.success);
        const failedCheckNames = failedChecks.map((check) => check.name);
        const failureDeltaSummary = previousPromptFailures
          ? summarizeFailureDelta(previousPromptFailures, failedChecks)
          : undefined;
        const priorFailureSummary = previousPromptFailures
          ? trimContextContent(
              'Prior failure inventory',
              extractFailureInventory(previousPromptFailures).markdown,
              6000
            )
          : undefined;
        log(
          phase.name,
          `[${stage.id}] Verification failed (${failedCheckNames.join(', ')}). Starting repair attempt ${attempt}/${maxRepairAttempts}...`
        );

        checkBudget(config, opts.budgetUsd, { runDir });
        const repairPrompt = capPromptLength(
          buildTestRepairPrompt(
            artifactsDir,
            failedChecks,
            renderVerificationArtifact(verificationBlocks),
            {
              stageLabel: `${stage.id} ${stage.name}`,
              attempt,
              maxAttempts: maxRepairAttempts,
              failureDeltaSummary,
              priorFailureSummary,
            }
          ),
          TEST_REPAIR_CONTEXT_CHAR_LIMIT,
          `Phase 10 ${stage.id} repair ${attempt}`,
          runDir
        );
        const repairResult = retryAgent(
          repairPrompt,
          {
            cwd: config.workspace_path,
            maxTurns: 20,
            permissions: 'read-write',
            engine: config.engine,
            claudeOutputFormat: config.claude_output_format,
            timeoutMs: config.timeout_ms,
          },
          `10-${stage.id.toLowerCase()}-repair-${attempt}`,
          runDir
        );
        recordAgentUsage(config, '10', repairResult, runDir, `Phase 10-${stage.id}-repair-${attempt}`);
        logAgentDiagnostics(`Phase 10-${stage.id}-repair-${attempt}`, repairResult, runDir);

        const committed = gitCommitChanges(
          workspacePath,
          `Pipeline Phase 10 - ${stage.id} verification repair attempt ${attempt}`
        );
        if (committed) {
          log(phase.name, `[${stage.id}] Committed verification repair attempt ${attempt}.`);
        } else if (hasGitChanges(workspacePath)) {
          throw new Error(
            `Phase 10 ${stage.id} repair attempt ${attempt} left uncommitted changes and could not be committed.`
          );
        }

        latestResults = runWorkspaceTests(workspacePath, stage.timeoutMs, stage.suite);
        verificationBlocks.push({
          title: `${stage.id} ${stage.name} - Repair Attempt ${attempt} Verification`,
          result: latestResults,
        });
        persistVerificationArtifact();
        cleanupVerificationArtifacts(`post-${stage.id} repair-${attempt} verification`);

        if (latestResults.allPassed) {
          break;
        }

        const remainingFailureUnits = estimateRemainingFailureUnits(
          latestResults.checks.filter((check) => !check.success)
        );
        if (
          attempt === maxRepairAttempts &&
          maxRepairAttempts < MAX_TEST_REPAIR_ATTEMPTS_CAP &&
          remainingFailureUnits > 0 &&
          remainingFailureUnits < previousFailureUnits
        ) {
          maxRepairAttempts += 1;
          appendLog(
            runDir,
            `Phase 10 ${stage.id} adaptive retry: extending repair budget to ${maxRepairAttempts} attempts (failure units ${previousFailureUnits} -> ${remainingFailureUnits}).`
          );
        }
        previousFailureUnits = remainingFailureUnits;
        previousPromptFailures = failedChecks;
      }
    }

    if (!latestResults.allPassed) {
      const failedChecks = latestResults.checks
        .filter((check) => !check.success)
        .map((check) => check.name);
      appendLog(runDir, `Phase 10 ${stage.id} failed after repair attempts: ${failedChecks.join(', ')}`);
      throw new Error(
        `Phase 10 ${stage.id} failed after repair attempts. Checks failed: ${failedChecks.join(', ')}`
      );
    }
  };

  try {
    const stagePlan: Phase10Stage[] = [
      {
        id: '10A',
        name: 'Integration Verification',
        suite: 'integration',
        timeoutMs: Math.max(config.timeout_ms || 0, 900_000),
      },
      {
        id: '10B',
        name: 'E2E Verification',
        suite: 'e2e',
        timeoutMs: Math.max(config.timeout_ms || 0, 900_000),
      },
    ];

    for (const stage of stagePlan) {
      if (completedStageSet.has(stage.id)) {
        const skipMessage =
          `[${stage.id}] Skipping ${stage.name}; checkpoint indicates this stage already passed.`;
        log(phase.name, skipMessage);
        appendLog(runDir, skipMessage);
        continue;
      }

      runStageVerification(stage);
      completedStageSet.add(stage.id);
      config.phase10_completed_stages = Array.from(completedStageSet);
      saveConfig(runDir, config);
      appendLog(runDir, `Phase 10 stage checkpoint saved: ${Array.from(completedStageSet).join(', ')}`);
    }

    // Commit any test-related changes (e.g., lockfile updates)
    gitCommitChanges(workspacePath, 'Pipeline Phase 10 - Post-implementation test verification');

    config.phase10_completed_stages = [];
    if (!config.completed_phases.includes('10')) {
      config.completed_phases.push('10');
    }
    config.current_phase = '10';
    appendLog(runDir, `Phase 10 (${phase.name}) completed`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(runDir, `Phase 10 error: ${message}`);
    appendVerificationErrorBlock(message);
    cleanupVerificationArtifacts('failure cleanup');
    if (hasGitChanges(workspacePath)) {
      const committed = gitCommitChanges(
        workspacePath,
        'Pipeline Phase 10 - Failed verification snapshot'
      );
      if (committed) {
        const commitMessage = 'Committed Phase 10 failure snapshot for iterative reruns.';
        log(phase.name, commitMessage);
        appendLog(runDir, commitMessage);
      } else if (hasGitChanges(workspacePath)) {
        appendLog(
          runDir,
          'Phase 10 failure left uncommitted workspace changes. Commit or reset before rerunning verification.'
        );
      }
    }
    config.phase10_completed_stages = Array.from(completedStageSet);
    saveConfig(runDir, config);
    appendLog(runDir, 'Phase 10 preserves repair commits and does not rollback on failure.');
    throw error;
  }
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
  if (config.engine === 'claude') {
    sections.push(`- **Claude Output Format**: ${config.claude_output_format || 'json'}`);
  }
  if (config.repo_url) sections.push(`- **Repo**: ${config.repo_url}`);
  if (config.workspace_path) sections.push(`- **Workspace**: ${config.workspace_path}`);
  sections.push(`- **Completed Phases**: ${config.completed_phases.join(', ')}`);
  if (typeof config.task_decomposition_events === 'number') {
    sections.push(`- **Task Decomposition Events**: ${config.task_decomposition_events}`);
  }
  if (typeof config.dynamic_tasks_added === 'number') {
    sections.push(`- **Dynamic Follow-up Tasks Added**: ${config.dynamic_tasks_added}`);
  }
  sections.push('');

  // Cost summary
  sections.push('## Cost Summary\n');
  sections.push(`**Effective Total (budget basis)**: $${(config.total_cost_usd || 0).toFixed(4)}`);
  sections.push(`- Actual reported: $${(config.total_actual_cost_usd || 0).toFixed(4)}`);
  sections.push(`- Estimated fallback: $${(config.total_estimated_cost_usd || 0).toFixed(4)}`);
  if ((config.total_input_tokens || 0) > 0 || (config.total_output_tokens || 0) > 0) {
    sections.push(
      `- Token usage: ${(config.total_input_tokens || 0).toLocaleString()} input / ${(config.total_output_tokens || 0).toLocaleString()} output`
    );
  }
  sections.push('');
  if (config.phase_costs) {
    sections.push('| Phase | Effective Cost | Actual | Estimated |');
    sections.push('|-------|----------------|--------|-----------|');
    const phaseIds = Array.from(
      new Set([
        ...Object.keys(config.phase_costs || {}),
        ...Object.keys(config.phase_costs_actual || {}),
        ...Object.keys(config.phase_costs_estimated || {}),
      ])
    );
    for (const phaseId of phaseIds) {
      const phaseName = PHASES.find((p) => p.id === phaseId)?.name || phaseId;
      const effective = config.phase_costs?.[phaseId] || 0;
      const actual = config.phase_costs_actual?.[phaseId] || 0;
      const estimated = config.phase_costs_estimated?.[phaseId] || 0;
      sections.push(
        `| ${phaseId} - ${phaseName} | $${effective.toFixed(4)} | $${actual.toFixed(4)} | $${estimated.toFixed(4)} |`
      );
    }
    sections.push('');
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
  let effectiveInteractive = true;

  if (args.resume) {
    // Resume existing run
    runDir = path.resolve(args.resume);
    ACTIVE_RUN_DIR = runDir;
    if (!fs.existsSync(runDir)) {
      console.error(`Run directory not found: ${runDir}`);
      process.exit(1);
    }
    config = loadConfig(runDir);
    ensureRunConfigDefaults(config);
    effectiveInteractive = args.interactive ?? config.interactive_mode ?? true;
    config.interactive_mode = effectiveInteractive;
    if (config.engine === 'claude' && !config.claude_output_format) {
      config.claude_output_format = 'json';
    }
    if (args.claudeOutputFormat) {
      config.claude_output_format = args.claudeOutputFormat;
    }
    artifactsDir = path.join(runDir, 'artifacts');
    log('Resume', `Resuming run: ${config.run_id}`);
    log('Resume', `Completed phases: ${config.completed_phases.join(', ')}`);
    if (config.engine === 'claude') {
      log('Resume', `Claude output format: ${config.claude_output_format || 'json'}`);
    }
    if (config.total_cost_usd) {
      log('Resume', `Cost so far: $${config.total_cost_usd.toFixed(4)}`);
    }
    log('Resume', `Run mode: ${effectiveInteractive ? 'interactive' : 'auto'}`);
    saveConfig(runDir, config);
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
    const selectedEngine: Engine = args.engine || 'claude';
    const runId = `${timestamp()}_${selectedEngine}_${slug}`;
    runDir = path.join(RUNS_DIR, runId);
    ACTIVE_RUN_DIR = runDir;
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
      engine: selectedEngine,
      claude_output_format:
        selectedEngine === 'claude' ? (args.claudeOutputFormat || 'json') : undefined,
      interactive_mode: args.interactive ?? true,
      timeout_ms: args.timeoutMs,
      current_phase: '-1',
      completed_phases: [],
      total_cost_usd: 0,
      phase_costs: {},
      total_actual_cost_usd: 0,
      total_estimated_cost_usd: 0,
      phase_costs_actual: {},
      phase_costs_estimated: {},
      total_input_tokens: 0,
      total_output_tokens: 0,
      task_decomposition_events: 0,
      dynamic_tasks_added: 0,
    };
    ensureRunConfigDefaults(config);
    effectiveInteractive = config.interactive_mode ?? true;

    saveConfig(runDir, config);
    log('Init', `New run created: ${runId}`);
    log('Init', `Run directory: ${runDir}`);
    log('Init', `Run mode: ${effectiveInteractive ? 'interactive' : 'auto'}`);
    if (config.engine === 'claude') {
      log('Init', `Claude output format: ${config.claude_output_format || 'json'}`);
    }
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
    if (effectiveInteractive && !args.dryRun && APPROVAL_GATES.has(phase.id)) {
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

    if (phase.id === '5') {
      if (args.dryRun) {
        console.log('  [dry-run] Phase 5: Would create GitHub repo and generate baseline');
      } else {
        runRepoBootstrap(config, artifactsDir, runDir);
      }
    } else if (phase.id === '9') {
      runImplementation(config, artifactsDir, runDir, {
        budgetUsd: args.budgetUsd,
        dryRun: args.dryRun,
      });
    } else if (phase.id === '10') {
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
  console.log(`Total effective cost: $${(config.total_cost_usd || 0).toFixed(4)}`);
  if ((config.total_actual_cost_usd || 0) > 0 || (config.total_estimated_cost_usd || 0) > 0) {
    console.log(
      `  (actual: $${(config.total_actual_cost_usd || 0).toFixed(4)}, estimated: $${(config.total_estimated_cost_usd || 0).toFixed(4)})`
    );
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack || '' : '';
  if (ACTIVE_RUN_DIR) {
    try {
      appendLog(ACTIVE_RUN_DIR, `Pipeline failed: ${message}`);
      if (stack) appendLog(ACTIVE_RUN_DIR, stack);
    } catch {
      // best effort
    }
  }
  console.error('\nPipeline failed:', message);
  process.exit(1);
});

function buildPhase11ReachabilityRepairPrompt(
  artifactsDir: string,
  uxArtifact: string,
  gateFailure: string,
  attempt: number,
  maxAttempts: number,
  priorNotes: string[]
): string {
  const workflows = trimContextContent('Workflows', readArtifact(artifactsDir, '2'), 10_000);
  const prd = trimContextContent('PRD', readArtifact(artifactsDir, '4'), 10_000);
  const techSpec = trimContextContent('Tech Spec', readArtifact(artifactsDir, '7'), 14_000);
  const taskBreakdown = trimContextContent('Task Breakdown', readArtifact(artifactsDir, '8'), 10_000);
  const testResults = trimContextContent('Test Results', readArtifact(artifactsDir, '10'), 12_000);

  return [
    'You are a senior engineer fixing UX reachability and branding defects identified in Phase 11.',
    '',
    'Your objective is to resolve actual product UX blockers so the Phase 11 reachability verdict can become pass/pass-with-caveats.',
    'Do not weaken tests, do not bypass flows, and do not add fake/mock-only UI paths.',
    '',
    '## Quality Gate Failure',
    `- ${gateFailure}`,
    '',
    '## Attempt',
    `- ${attempt}/${maxAttempts}`,
    '',
    ...(priorNotes.length > 0
      ? ['## Prior Remediation Notes', ...priorNotes.slice(-8).map((note) => `- ${note}`), '']
      : []),
    '## UX Reachability Findings',
    trimContextContent('Phase 11 artifact', uxArtifact, 24_000),
    '',
    '## Workflows',
    workflows,
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
    '## Latest Test Results',
    testResults,
    '',
    '## Instructions',
    '- Implement real UI reachability fixes for blockers (navigation links, role-appropriate CTAs, discoverable entry points).',
    '- If API exists but no UI path exists, wire the UI to that API with production-safe UX and error handling.',
    '- Keep auth/session/onboarding flow deterministic and loop-safe.',
    '- Remove remaining template/demo branding strings in user-facing paths relevant to findings.',
    '- Keep changes minimal and aligned with existing architecture and styles.',
    '- Run the relevant checks after edits and ensure they pass before finishing.',
    '- Output concise summary: root causes fixed, files changed, commands run, and expected impact on reachability verdict.',
  ].join('\n');
}

function buildPhase12AuditRepairPrompt(
  artifactsDir: string,
  auditArtifact: string,
  gateFailure: string,
  attempt: number,
  maxAttempts: number,
  priorNotes: string[]
): string {
  const workflows = trimContextContent('Workflows', readArtifact(artifactsDir, '2'), 10_000);
  const prd = trimContextContent('PRD', readArtifact(artifactsDir, '4'), 10_000);
  const techSpec = trimContextContent('Tech Spec', readArtifact(artifactsDir, '7'), 14_000);
  const taskBreakdown = trimContextContent('Task Breakdown', readArtifact(artifactsDir, '8'), 10_000);
  const testResults = trimContextContent('Test Results', readArtifact(artifactsDir, '10'), 16_000);
  const uxArtifact = trimContextContent(
    'UX Reachability Report',
    readArtifact(artifactsDir, '11'),
    16_000
  );

  return [
    'You are a senior engineer fixing launch-blocking issues identified by Phase 12 audit.',
    '',
    'Your objective is to resolve real product defects so Phase 12 can return "Ship readiness: Ready" or "Ready with caveats".',
    'Do not weaken checks, do not bypass tests, and do not hide findings by editing audit language without fixing code.',
    '',
    '## Quality Gate Failure',
    `- ${gateFailure}`,
    '',
    '## Attempt',
    `- ${attempt}/${maxAttempts}`,
    '',
    ...(priorNotes.length > 0
      ? ['## Prior Remediation Notes', ...priorNotes.slice(-10).map((note) => `- ${note}`), '']
      : []),
    '## Latest Audit Findings',
    trimContextContent('Phase 12 artifact', auditArtifact, 28_000),
    '',
    '## UX Reachability Findings',
    uxArtifact,
    '',
    '## Workflows',
    workflows,
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
    '## Latest Test Results',
    testResults,
    '',
    '## Instructions',
    '- Fix all critical findings first, then high findings that block ship-readiness.',
    '- For state-changing cookie-auth API routes, enforce CSRF via assertCsrf(request) before side effects.',
    '- For P0 reachability gaps, wire real in-product navigation/CTA paths (not URL-only).',
    '- Keep fixes cumulative and minimal; do not revert prior successful repair commits.',
    '- Do not introduce mock/placeholder production data.',
    '- Keep auth/onboarding flow deterministic and loop-safe.',
    '- Run relevant checks after edits and make sure they pass before finishing.',
    '- Output concise summary: root causes fixed, files changed, commands run, and expected impact on ship readiness.',
  ].join('\n');
}

function buildTaskQualityRepairPrompt(
  task: ImplementationTask,
  taskIndex: number,
  totalTasks: number,
  qualityReport: string,
  failedChecks: TestCheckResult[]
): string {
  const failingCheckList = failedChecks.map((check) => `- ${check.name}: \`${check.command}\``).join('\n');
  const failureEvidence = failedChecks
    .map((check) => {
      const tail = check.output.length > 3000 ? check.output.slice(-3000) : check.output;
      return [`### ${check.name}`, `Command: \`${check.command}\``, '```', tail || '(no output)', '```'].join('\n');
    })
    .join('\n\n');

  return [
    'You are fixing quality regressions introduced during a single implementation task in an in-progress pipeline run.',
    '',
    `Task ${taskIndex}/${totalTasks}: ${task.id} — ${task.title}`,
    '',
    '## Task Context',
    task.body,
    '',
    '## Failing Checks (must pass before this task can be committed)',
    failingCheckList || '- (none provided)',
    '',
    '## Failure Evidence',
    failureEvidence || '(no failure evidence provided)',
    '',
    '## Current Quality Report',
    qualityReport,
    '',
    '## Instructions',
    '- Fix only issues introduced by this task or direct fallout from these edits.',
    '- Do not modify product scope and do not rewrite unrelated modules.',
    '- Do not weaken lint/type/build constraints and do not bypass checks.',
    '- Prefer precise fixes (imports, types, null handling, API shape alignment) over broad refactors.',
    '- Do not introduce new test patterns: keep template testing to `packages/tests/src/*.test.ts(x)` plus Playwright tests/setup in `apps/web/e2e/*.spec.ts(x)` and `apps/web/e2e/*.setup.ts(x)`, and use root scripts `test:integration` / `test:e2e`.',
    '- Do not leave mock/fake/placeholder data in production files; wire real API/domain sources or mark explicit follow-up work if blocked.',
    '- For auth/session redirect logic, ensure guards prevent self-redirect and multi-hop loops.',
    '- After edits, re-run typecheck, lint, and build for the touched scope until all pass.',
    '- Output a concise summary with root cause, files changed, and final check status.',
  ].join('\n');
}

function buildTaskE2ESetupRepairPrompt(
  task: ImplementationTask,
  taskIndex: number,
  totalTasks: number,
  setupReport: string,
  failedChecks: TestCheckResult[]
): string {
  const failingCheckList = failedChecks.map((check) => `- ${check.name}: \`${check.command}\``).join('\n');
  const failureEvidence = failedChecks
    .map((check) => {
      const tail = check.output.length > 4500 ? check.output.slice(-4500) : check.output;
      return [`### ${check.name}`, `Command: \`${check.command}\``, '```', tail || '(no output)', '```'].join('\n');
    })
    .join('\n\n');

  return [
    'You are fixing Playwright setup-stage failures introduced during a single implementation task in an in-progress pipeline run.',
    '',
    `Task ${taskIndex}/${totalTasks}: ${task.id} — ${task.title}`,
    '',
    '## Task Context',
    task.body,
    '',
    '## Failing Setup Checks',
    failingCheckList || '- (none provided)',
    '',
    '## Failure Evidence',
    failureEvidence || '(no failure evidence provided)',
    '',
    '## Setup Smoke Report',
    setupReport,
    '',
    '## Instructions',
    '- Resolve root causes in the application/test setup; do not bypass, skip, or relax tests.',
    '- Preserve template test model: integration tests in `packages/tests/src/*.test.ts(x)` and Playwright in `apps/web/e2e/*.spec.ts(x)` and `apps/web/e2e/*.setup.ts(x)`.',
    '- Keep auth origin/host deterministic in tests: avoid localhost/127.0.0.1 rewrites and keep `APP_BASE_URL` + `TEST_BASE_URL` aligned.',
    '- If setup fails before regular specs run, prioritize fixing setup reliability first (auth seeding, deterministic login redirect, server readiness).',
    '- For redirect logic, ensure no self-redirect loops and ensure post-login destination can be reached deterministically.',
    '- Keep code changes minimal and production-safe; no mock-data hacks in production paths.',
    '- Re-run setup-focused checks until green, then ensure lint/type/build still pass.',
    '- Output concise summary: root cause, files changed, commands run, and final status.',
  ].join('\n');
}

function buildMilestoneQualityRepairPrompt(
  milestoneName: string,
  qualityReport: string,
  failedChecks: TestCheckResult[]
): string {
  const failingCheckList = failedChecks.map((check) => `- ${check.name}: \`${check.command}\``).join('\n');
  const failureEvidence = failedChecks
    .map((check) => {
      const tail = check.output.length > 3000 ? check.output.slice(-3000) : check.output;
      return [`### ${check.name}`, `Command: \`${check.command}\``, '```', tail || '(no output)', '```'].join('\n');
    })
    .join('\n\n');

  return [
    'You are fixing quality regressions detected at a milestone boundary in an in-progress pipeline run.',
    '',
    `Milestone: ${milestoneName}`,
    '',
    '## Failing Checks',
    failingCheckList || '- (none provided)',
    '',
    '## Failure Evidence',
    failureEvidence || '(no failure evidence provided)',
    '',
    '## Milestone Quality Report',
    qualityReport,
    '',
    '## Instructions',
    '- Fix only the issues necessary to make all failed checks pass.',
    '- Do not weaken lint/type/build rules and do not bypass checks.',
    '- Keep edits minimal, production-safe, and aligned with existing architecture.',
    '- Do not introduce new test patterns: keep template testing to `packages/tests/src/*.test.ts(x)` plus Playwright tests/setup in `apps/web/e2e/*.spec.ts(x)` and `apps/web/e2e/*.setup.ts(x)`, and use root scripts `test:integration` / `test:e2e`.',
    '- Remove or replace mock/fake/placeholder production data with real API/domain wiring.',
    '- If auth/session redirects are involved, ensure flow is loop-safe and reaches expected destination.',
    '- Re-run quality commands until all checks pass before finishing.',
    '- Output concise summary: root cause, files changed, and final status.',
  ].join('\n');
}
