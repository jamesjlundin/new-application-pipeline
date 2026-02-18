import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Run Configuration
// ---------------------------------------------------------------------------

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
  claude_output_format?: 'stream-json' | 'json';
  interactive_mode?: boolean;
  timeout_ms?: number;
  current_phase: string;
  completed_phases: string[];
  // Cost tracking
  total_cost_usd?: number;
  phase_costs?: Record<string, number>;
  total_actual_cost_usd?: number;
  total_estimated_cost_usd?: number;
  phase_costs_actual?: Record<string, number>;
  phase_costs_estimated?: Record<string, number>;
  total_input_tokens?: number;
  total_output_tokens?: number;
  // Task-level checkpointing for Phase 9
  last_completed_task?: number;
  task_decomposition_events?: number;
  dynamic_tasks_added?: number;
  // Stage-level checkpointing for Phase 10 (10A integration, 10B e2e)
  phase10_completed_stages?: Array<'10A' | '10B'>;
}

// ---------------------------------------------------------------------------
// Artifact & Phase Definitions
// ---------------------------------------------------------------------------

const ARTIFACT_FILES: Record<string, string> = {
  '0': '00_idea_intake.md',
  '1': '01_problem_framing.md',
  '2': '02_workflows.md',
  '3': '02b_design_theme.md',
  '4': '03_prd.md',
  '5': '03b_repo_baseline.md',
  '6': '04_feasibility_review.md',
  '7': '05_tech_spec.md',
  '8': '06_task_breakdown.md',
  '10': '07b_test_results.md',
  '11': '07c_ux_reachability.md',
  '12': '08_audit.md',
};

const VALID_PHASE_IDS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);

// ---------------------------------------------------------------------------
// Artifact Validation
// ---------------------------------------------------------------------------

export function validateArtifactsExist(artifactsDir: string, phases: string[]): void {
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

// Expected sections per phase for output validation
const REQUIRED_SECTIONS: Record<string, string[]> = {
  '0': ['App Name', 'One-Line Description', 'Problem Statement', 'Target Users', 'Core Features'],
  '1': ['Problem Decomposition', 'User Personas', 'Pain Points', 'Core Value Proposition'],
  '2': ['Information Architecture', 'Primary User Flows', 'Screen Inventory', 'Navigation Reachability Matrix'],
  '3': ['Visual Direction', 'Color System', 'Typography System', 'Theme Tokens'],
  '4': ['Executive Summary', 'User Stories', 'Functional Requirements', 'Non-Functional Requirements', 'Navigation & Reachability Requirements'],
  '6': ['Template Fit Assessment', 'Technical Risks', 'Go / No-Go'],
  '7': ['Architecture Overview', 'Data Model', 'API Design', 'Route-to-Screen Traceability Matrix', 'Security Considerations'],
  '8': ['Implementation Milestones', 'Task List', 'Routing Coverage Matrix', 'Navigation Reachability Task Matrix', 'Template Demo Removal & Rebranding', 'Dependency Graph'],
  '11': ['Journey Coverage Summary', 'Discoverability Findings', 'Branding Findings', 'Reachability Verdict'],
  '12': ['Requirements Coverage', 'Discoverability & Branding Coverage', 'Security Review', 'Overall Assessment'],
};

function hasRequiredSection(content: string, section: string): boolean {
  const lowered = content.toLowerCase();
  if (lowered.includes(section.toLowerCase())) {
    return true;
  }

  // Accept common heading spelling variants to reduce false negatives.
  if (section === 'Non-Functional Requirements') {
    return /non[-\s]?functional requirements/i.test(content);
  }
  if (section === 'Go / No-Go') {
    return /go\s*\/?\s*no[-\s]?go/i.test(content);
  }

  return false;
}

export function validateArtifactContent(phaseId: string, content: string): string[] {
  const warnings: string[] = [];
  const trimmed = content.trim();

  // Minimum size check
  if (trimmed.length < 500) {
    warnings.push(`Artifact for phase ${phaseId} is suspiciously small (${content.length} chars). May be an error message rather than a real artifact.`);
  }

  // Maximum size check
  if (content.length > 1_000_000) {
    warnings.push(`Artifact for phase ${phaseId} is very large (${(content.length / 1024).toFixed(0)}KB). This may cause context window issues in downstream phases.`);
  }

  // Check for AI meta-commentary that leaked into the artifact
  const metaPatterns = [
    /^(I need|I'll|Let me|Here is|Here's|I would|I want to|I don't have)/im,
    /^(Sure|Certainly|Of course|Absolutely)[,!.]/im,
    /permission to (save|write|create)/i,
  ];
  for (const pattern of metaPatterns) {
    if (pattern.test(trimmed.slice(0, 350))) {
      warnings.push(`Phase ${phaseId}: Artifact appears to start with AI meta-commentary. Content may need cleaning.`);
      break;
    }
  }

  // Ensure artifact has markdown structure
  const hasHeading = /^#{1,3}\s/m.test(trimmed);
  if (!hasHeading) {
    warnings.push(`Phase ${phaseId}: Artifact contains no markdown headings.`);
  }

  // Heuristic truncation check: abruptly cut trailing token
  if (
    trimmed.length > 0 &&
    /[a-zA-Z0-9]$/.test(trimmed) &&
    !/[.!?`)"'\]}:;]$/.test(trimmed)
  ) {
    warnings.push(`Phase ${phaseId}: Artifact appears truncated at the end.`);
  }

  // Check required sections
  const required = REQUIRED_SECTIONS[phaseId];
  if (required) {
    for (const section of required) {
      if (!hasRequiredSection(content, section)) {
        warnings.push(`Phase ${phaseId}: Missing expected section "${section}"`);
      }
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// CLI Input Validation
// ---------------------------------------------------------------------------

const SAFE_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const SAFE_REPO_NAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,98}[a-zA-Z0-9])?$/;

export function validateCliInput(name: string, value: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name}: "${value}". Must match pattern: ${pattern}`);
  }
}

export function validateOwner(value: string): void {
  validateCliInput('owner', value, SAFE_OWNER_PATTERN);
}

export function validateRepoName(value: string): void {
  validateCliInput('repo-name', value, SAFE_REPO_NAME_PATTERN);
  if (value.includes('..')) {
    throw new Error(`Invalid repo-name: "${value}". Consecutive dots are not allowed.`);
  }
}

export function validateTemplateRepo(value: string): void {
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid template: "${value}". Expected format "owner/repo".`);
  }
  validateOwner(parts[0]);
  validateRepoName(parts[1]);
}

export function validateVisibility(value: string): asserts value is 'public' | 'private' {
  if (value !== 'public' && value !== 'private') {
    throw new Error(`Invalid visibility: "${value}". Must be "public" or "private".`);
  }
}

export function validateEngine(value: string): asserts value is 'claude' | 'codex' {
  if (value !== 'claude' && value !== 'codex') {
    throw new Error(`Invalid engine: "${value}". Must be "claude" or "codex".`);
  }
}

export function validatePhaseId(value: string): void {
  if (!VALID_PHASE_IDS.has(value)) {
    throw new Error(`Invalid phase ID: "${value}". Valid phases: ${[...VALID_PHASE_IDS].join(', ')}`);
  }
}

export function validateTimeout(value: number): void {
  if (isNaN(value) || value <= 0) {
    throw new Error(`Invalid timeout: must be a positive number of minutes.`);
  }
  if (value > 180) {
    throw new Error(`Invalid timeout: ${value} minutes exceeds maximum of 180 minutes.`);
  }
}

export function validateBudget(value: number): void {
  if (isNaN(value) || value <= 0) {
    throw new Error(`Invalid budget: must be a positive dollar amount.`);
  }
}

// ---------------------------------------------------------------------------
// Config Persistence
// ---------------------------------------------------------------------------

export function validateConfig(config: RunConfig): void {
  const errors: string[] = [];

  if (!config.run_id) errors.push('run_id is required');
  if (!config.idea) errors.push('idea is required');
  if (!config.repo_owner) errors.push('repo_owner is required');
  if (!config.template_repo) errors.push('template_repo is required');

  if (config.visibility && !['public', 'private'].includes(config.visibility)) {
    errors.push('visibility must be "public" or "private"');
  }

  if (config.engine && !['claude', 'codex'].includes(config.engine)) {
    errors.push('engine must be "claude" or "codex"');
  }

  if (
    config.claude_output_format &&
    !['stream-json', 'json'].includes(config.claude_output_format)
  ) {
    errors.push('claude_output_format must be "stream-json" or "json"');
  }

  try {
    validateOwner(config.repo_owner);
  } catch (error) {
    errors.push((error as Error).message);
  }

  try {
    validateTemplateRepo(config.template_repo);
  } catch (error) {
    errors.push((error as Error).message);
  }

  if (config.repo_name) {
    try {
      validateRepoName(config.repo_name);
    } catch (error) {
      errors.push((error as Error).message);
    }
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

  // Backward compatibility: convert number phase IDs to strings
  if (config.completed_phases && config.completed_phases.some((p: unknown) => typeof p === 'number')) {
    config.completed_phases = (config.completed_phases as unknown as (number | string)[]).map((p) => String(p));
  }
  if (typeof config.current_phase === 'number') {
    config.current_phase = String(config.current_phase);
  }

  validateConfig(config);
  return config;
}

export function saveConfig(runDir: string, config: RunConfig): void {
  const configPath = path.join(runDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function readArtifact(artifactsDir: string, phase: string): string {
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
