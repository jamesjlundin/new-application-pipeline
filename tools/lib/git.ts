import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
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

export type WorkspaceTestSuite = 'all' | 'integration' | 'e2e' | 'e2e_setup';

export interface QualityCheckOptions {
  forceFullWorkspace?: boolean;
  forceFullWorkspaceLintTypecheck?: boolean;
  includeTests?: boolean;
}

type PackageManager = 'npm' | 'pnpm';
const COLLISION_PRONE_DOCKER_PORTS = [5432, 6379, 8079, 8082];
const PIPELINE_E2E_BASE_URL = 'http://localhost:3000';
const MOCK_DATA_GUARD_ROOTS = ['apps/web/app', 'apps/web/components', 'apps/web/server', 'apps/web/lib'];
const MOCK_DATA_GUARD_MAX_FINDINGS = 40;
const CSRF_GUARD_MAX_FINDINGS = 40;
const TEST_VERIFICATION_EPHEMERAL_PATHS = [
  '.playwright',
  'apps/web/.playwright',
  'apps/web/test-results',
  'apps/web/playwright-report',
  'apps/web/blob-report',
];
const MOCK_DATA_GUARD_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\b(?:mock|fake|stub|placeholder)\s+data\b/i,
    reason: 'mock/placeholder data marker',
  },
  {
    pattern: /\b(?:TODO|FIXME)\b.*\b(?:mock|fake|stub|placeholder)\b/i,
    reason: 'TODO/FIXME indicates unresolved mock/placeholder usage',
  },
  {
    pattern: /\breturn\s+\[\s*\{[^}]*\}\s*\]\s*;?\s*\/\/\s*(?:mock|fake|stub|placeholder)\b/i,
    reason: 'hardcoded collection marked as mock/placeholder',
  },
];
const CSRF_MUTATION_METHOD_EXPORT_PATTERN = /\bexport\s+const\s+(POST|PATCH|PUT|DELETE)\b/g;
const CSRF_COOKIE_AUTH_HINT_PATTERNS = [/\bwithUserRateLimit\s*\(/, /\bgetCurrentUser\s*\(/];

function detectPackageManager(workspacePath: string): PackageManager {
  if (fs.existsSync(path.join(workspacePath, 'pnpm-lock.yaml'))) return 'pnpm';
  return 'npm';
}

function commandExistsInWorkspace(workspacePath: string, command: string): boolean {
  try {
    execSync(`sh -c 'command -v ${command} >/dev/null 2>&1'`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 20_000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function dependencyInstallCommand(packageManager: PackageManager): string {
  return packageManager === 'pnpm' ? 'CI=true pnpm install --frozen-lockfile' : 'npm ci';
}

function envInitCommand(packageManager: PackageManager): string {
  return packageManager === 'pnpm'
    ? 'pnpm run --if-present env:init'
    : 'npm run env:init --if-present';
}

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = content.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadWorkspaceEnvOverrides(workspacePath: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const envFiles = [
    '.env',
    '.env.local',
    'packages/tests/.env',
    'packages/tests/.env.local',
  ];

  for (const envFile of envFiles) {
    const envPath = path.join(workspacePath, envFile);
    if (!fs.existsSync(envPath)) continue;
    try {
      const raw = fs.readFileSync(envPath, 'utf-8');
      const parsed = parseEnvFile(raw);
      for (const [key, value] of Object.entries(parsed)) {
        merged[key] = value;
      }
    } catch {
      // best effort: continue even if one env file cannot be read/parsed
    }
  }

  return merged;
}

function normalizeTestBaseUrl(input: string | undefined, fallback: string = PIPELINE_E2E_BASE_URL): string {
  const raw = (input || '').trim();
  const candidate = raw || fallback;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`;
    const parsed = new URL(withScheme);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
      parsed.hostname = 'localhost';
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export function cleanupWorkspaceVerificationArtifacts(workspacePath: string): string[] {
  const cleaned: string[] = [];
  for (const relPath of TEST_VERIFICATION_EPHEMERAL_PATHS) {
    const absolutePath = path.join(workspacePath, relPath);
    if (!fs.existsSync(absolutePath)) continue;
    try {
      fs.rmSync(absolutePath, { recursive: true, force: true });
      cleaned.push(relPath);
    } catch {
      // best effort cleanup; keep going if one path cannot be removed
    }
  }
  return cleaned;
}

function formatCheckSection(check: TestCheckResult): string {
  return `## ${check.name} (${check.command})\n\`\`\`\n${check.output}\n\`\`\``;
}

export function runWorkspaceDependencyInstall(
  workspacePath: string,
  timeoutMs: number = 300_000,
  tailLimit: number = 5000
): TestCheckResult {
  const packageManager = detectPackageManager(workspacePath);
  const command = dependencyInstallCommand(packageManager);

  if (packageManager === 'pnpm' && !commandExistsInWorkspace(workspacePath, 'pnpm')) {
    return {
      name: 'Dependency Install',
      command,
      success: false,
      output: 'pnpm is required but is not installed on PATH.',
    };
  }

  try {
    const output = execSync(`${command} 2>&1`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true' },
    });
    const trimmed = (output || '').trim();
    const finalOutput = trimmed.length > tailLimit ? trimmed.slice(-tailLimit) : trimmed;
    return {
      name: 'Dependency Install',
      command,
      success: true,
      output: finalOutput || 'No output',
    };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const raw = `${e.stdout || ''}\n${e.stderr || ''}`.trim() || e.message || 'unknown error';
    const finalOutput = raw.length > tailLimit ? raw.slice(-tailLimit) : raw;
    return {
      name: 'Dependency Install',
      command,
      success: false,
      output: finalOutput,
    };
  }
}

export function runWorkspaceEnvInit(
  workspacePath: string,
  timeoutMs: number = 300_000,
  tailLimit: number = 5000
): TestCheckResult {
  const packageManager = detectPackageManager(workspacePath);
  const command = envInitCommand(packageManager);

  if (packageManager === 'pnpm' && !commandExistsInWorkspace(workspacePath, 'pnpm')) {
    return {
      name: 'Environment Init',
      command,
      success: false,
      output: 'pnpm is required but is not installed on PATH.',
    };
  }

  try {
    const output = execSync(`${command} 2>&1`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: 'pipe',
      env: { ...process.env, CI: 'true' },
    });
    const trimmed = (output || '').trim();
    const finalOutput = trimmed.length > tailLimit ? trimmed.slice(-tailLimit) : trimmed;
    return {
      name: 'Environment Init',
      command,
      success: true,
      output: finalOutput || 'No output',
    };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const raw = `${e.stdout || ''}\n${e.stderr || ''}`.trim() || e.message || 'unknown error';
    const finalOutput = raw.length > tailLimit ? raw.slice(-tailLimit) : raw;
    return {
      name: 'Environment Init',
      command,
      success: false,
      output: finalOutput,
    };
  }
}

function scriptCommand(packageManager: PackageManager, script: 'typecheck' | 'lint' | 'build' | 'test'): string {
  if (packageManager === 'pnpm') {
    if (script === 'test') {
      return `sh -c 'set -eu; ${integrationResetCommand(packageManager)}; ${integrationBootstrapCommand(
        packageManager
      )}; ${e2eTestCommand(packageManager)}'`;
    }
    // pnpm expects --if-present before script name.
    return `pnpm run --if-present ${script}`;
  }

  if (script === 'test') {
    return `sh -c 'set -eu; ${integrationResetCommand(packageManager)}; ${integrationBootstrapCommand(
      packageManager
    )}; ${e2eTestCommand(packageManager)}'`;
  }
  return `npm run ${script} --if-present`;
}

function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('p')) continue;
    const pid = Number.parseInt(trimmed.slice(1), 10);
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

function getProcessCwd(pid: number, workspacePath: string): string | null {
  try {
    const output = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: 'pipe',
    });
    const cwdLine = output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : null;
  } catch {
    return null;
  }
}

function runWorkspacePortCleanup(
  workspacePath: string,
  ports: number[]
): TestCheckResult {
  const command = `lsof -nP -iTCP:<port> -sTCP:LISTEN ; kill workspace listeners (${ports.join(', ')})`;

  if (!commandExistsInWorkspace(workspacePath, 'lsof')) {
    return {
      name: 'App Port Cleanup',
      command,
      success: true,
      output: 'Skipped: lsof not available on PATH.',
    };
  }

  const workspaceRoot = fs.realpathSync(workspacePath);
  const candidates = new Set<number>();
  const details: string[] = [];

  try {
    for (const port of ports) {
      const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: 'pipe',
      });
      const pids = parseLsofPids(output);
      for (const pid of pids) {
        const cwd = getProcessCwd(pid, workspacePath);
        if (!cwd) continue;
        const resolvedCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
        if (!isPathWithin(workspaceRoot, resolvedCwd)) continue;
        candidates.add(pid);
        details.push(`port ${port}: pid ${pid} cwd=${resolvedCwd}`);
      }
    }
  } catch {
    // Ignore lsof failures per-port; we'll report based on discovered candidates.
  }

  if (candidates.size === 0) {
    return {
      name: 'App Port Cleanup',
      command,
      success: true,
      output: `No workspace-owned listeners found on ports: ${ports.join(', ')}`,
    };
  }

  const failed: number[] = [];
  const terminated: number[] = [];
  const killed: number[] = [];
  for (const pid of candidates) {
    try {
      process.kill(pid, 'SIGTERM');
      terminated.push(pid);
    } catch {
      failed.push(pid);
    }
  }

  const stillRunning: number[] = [];
  for (const pid of terminated) {
    try {
      process.kill(pid, 0);
      stillRunning.push(pid);
    } catch {
      // Process no longer exists.
    }
  }

  for (const pid of stillRunning) {
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      if (!failed.includes(pid)) {
        failed.push(pid);
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Workspace listeners discovered: ${candidates.size}`);
  if (details.length > 0) lines.push(...details);
  lines.push(`SIGTERM sent to: ${terminated.join(', ') || '(none)'}`);
  if (killed.length > 0) {
    lines.push(`SIGKILL sent to: ${killed.join(', ')}`);
  }
  if (failed.length > 0) {
    lines.push(`Failed to terminate: ${failed.join(', ')}`);
  }

  return {
    name: 'App Port Cleanup',
    command,
    success: failed.length === 0,
    output: lines.join('\n'),
  };
}

function integrationBootstrapCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return [
      'if [ -d packages/db ]; then',
      '  pnpm -C packages/db run --if-present migrate:apply;',
      '  pnpm -C packages/db run --if-present validate:orphanwire-constraints;',
      'fi',
      'if [ -f apps/web/package.json ]; then',
      '  LOG_FILE="${WEB_LOG_FILE:-/tmp/acme-web-test.log}";',
      '  : > "$LOG_FILE";',
      '  if [ ! -f apps/web/.next/BUILD_ID ]; then',
      '    pnpm -C apps/web build;',
      '  fi;',
      '  pnpm -C apps/web start > "$LOG_FILE" 2>&1 &',
      '  WEB_PID=$!;',
      '  cleanup_web() {',
      '    if [ -z "${WEB_PID:-}" ]; then',
      '      return;',
      '    fi;',
      '    kill "$WEB_PID" >/dev/null 2>&1 || true;',
      '    for _ in 1 2 3 4 5 6 7 8 9 10; do',
      '      if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then',
      '        return;',
      '      fi;',
      '      sleep 0.5;',
      '    done;',
      '    kill -9 "$WEB_PID" >/dev/null 2>&1 || true;',
      '  };',
      '  trap "cleanup_web" EXIT INT TERM;',
      '  if ! pnpm exec wait-on http://localhost:3000/api/health --timeout 60000 >/dev/null 2>&1; then',
      '    echo "Integration bootstrap failed: http://localhost:3000/api/health did not become ready." >&2;',
      '    tail -n 120 "$LOG_FILE" >&2 || true;',
      '    exit 1;',
      '  fi;',
      'fi',
      'pnpm run --if-present test:integration',
    ].join('\n');
  }
  return [
    'if [ -d packages/db ]; then',
    '  npm --prefix packages/db run migrate:apply --if-present;',
    '  npm --prefix packages/db run validate:orphanwire-constraints --if-present;',
    'fi',
    'if [ -f apps/web/package.json ]; then',
    '  LOG_FILE="${WEB_LOG_FILE:-/tmp/acme-web-test.log}";',
    '  : > "$LOG_FILE";',
    '  if [ ! -f apps/web/.next/BUILD_ID ]; then',
    '    npm --prefix apps/web run build --if-present;',
    '  fi;',
    '  npm --prefix apps/web run start --if-present > "$LOG_FILE" 2>&1 &',
    '  WEB_PID=$!;',
    '  cleanup_web() {',
    '    if [ -z "${WEB_PID:-}" ]; then',
    '      return;',
    '    fi;',
    '    kill "$WEB_PID" >/dev/null 2>&1 || true;',
    '    for _ in 1 2 3 4 5 6 7 8 9 10; do',
    '      if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then',
    '        return;',
    '      fi;',
    '      sleep 0.5;',
    '    done;',
    '    kill -9 "$WEB_PID" >/dev/null 2>&1 || true;',
    '  };',
    '  trap "cleanup_web" EXIT INT TERM;',
    '  if ! npx wait-on http://localhost:3000/api/health --timeout 60000 >/dev/null 2>&1; then',
    '    echo "Integration bootstrap failed: http://localhost:3000/api/health did not become ready." >&2;',
    '    tail -n 120 "$LOG_FILE" >&2 || true;',
    '    exit 1;',
    '  fi;',
    'fi',
    'npm run test:integration --if-present',
  ].join('\n');
}

function e2eBootstrapCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return [
      'pnpm run --if-present db:ensure',
      'if [ -d packages/db ]; then',
      '  pnpm -C packages/db run --if-present migrate:apply;',
      'fi',
      'if [ -f apps/web/package.json ]; then',
      '  LOG_FILE="${WEB_LOG_FILE:-/tmp/acme-web-test.log}";',
      '  : > "$LOG_FILE";',
      '  if [ ! -f apps/web/.next/BUILD_ID ]; then',
      '    pnpm -C apps/web build;',
      '  fi;',
      '  pnpm -C apps/web start > "$LOG_FILE" 2>&1 &',
      '  WEB_PID=$!;',
      '  cleanup_web() {',
      '    if [ -z "${WEB_PID:-}" ]; then',
      '      return;',
      '    fi;',
      '    kill "$WEB_PID" >/dev/null 2>&1 || true;',
      '    for _ in 1 2 3 4 5 6 7 8 9 10; do',
      '      if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then',
      '        return;',
      '      fi;',
      '      sleep 0.5;',
      '    done;',
      '    kill -9 "$WEB_PID" >/dev/null 2>&1 || true;',
      '  };',
      '  trap "cleanup_web" EXIT INT TERM;',
      '  if ! pnpm exec wait-on http://localhost:3000/api/health --timeout 60000 >/dev/null 2>&1; then',
      '    echo "E2E bootstrap failed: http://localhost:3000/api/health did not become ready." >&2;',
      '    tail -n 120 "$LOG_FILE" >&2 || true;',
      '    exit 1;',
      '  fi;',
      '  cleanup_web;',
      'fi',
    ].join('\n');
  }
  return [
    'npm run db:ensure --if-present',
    'if [ -d packages/db ]; then',
    '  npm --prefix packages/db run migrate:apply --if-present;',
    'fi',
    'if [ -f apps/web/package.json ]; then',
    '  LOG_FILE="${WEB_LOG_FILE:-/tmp/acme-web-test.log}";',
    '  : > "$LOG_FILE";',
    '  if [ ! -f apps/web/.next/BUILD_ID ]; then',
    '    npm --prefix apps/web run build --if-present;',
    '  fi;',
    '  npm --prefix apps/web run start --if-present > "$LOG_FILE" 2>&1 &',
    '  WEB_PID=$!;',
    '  cleanup_web() {',
    '    if [ -z "${WEB_PID:-}" ]; then',
    '      return;',
    '    fi;',
    '    kill "$WEB_PID" >/dev/null 2>&1 || true;',
    '    for _ in 1 2 3 4 5 6 7 8 9 10; do',
    '      if ! kill -0 "$WEB_PID" >/dev/null 2>&1; then',
    '        return;',
    '      fi;',
    '      sleep 0.5;',
    '    done;',
    '    kill -9 "$WEB_PID" >/dev/null 2>&1 || true;',
    '  };',
    '  trap "cleanup_web" EXIT INT TERM;',
    '  if ! npx wait-on http://localhost:3000/api/health --timeout 60000 >/dev/null 2>&1; then',
    '    echo "E2E bootstrap failed: http://localhost:3000/api/health did not become ready." >&2;',
    '    tail -n 120 "$LOG_FILE" >&2 || true;',
    '    exit 1;',
    '  fi;',
    '  cleanup_web;',
    'fi',
  ].join('\n');
}

function e2eSetupCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return [
      "sh -c 'set -eu;",
      'if [ -f apps/web/playwright.config.ts ] || [ -f apps/web/playwright.config.mts ] || [ -f apps/web/playwright.config.cts ] || [ -f apps/web/playwright.config.js ] || [ -f apps/web/playwright.config.mjs ] || [ -f apps/web/playwright.config.cjs ]; then',
      '  pnpm -C apps/web exec playwright test --project=setup;',
      'else',
      '  echo \"No Playwright config found under apps/web; skipping setup project.\";',
      "fi'",
    ].join(' ');
  }
  return [
    "sh -c 'set -eu;",
    'if [ -f apps/web/playwright.config.ts ] || [ -f apps/web/playwright.config.mts ] || [ -f apps/web/playwright.config.cts ] || [ -f apps/web/playwright.config.js ] || [ -f apps/web/playwright.config.mjs ] || [ -f apps/web/playwright.config.cjs ]; then',
    '  npm --prefix apps/web exec playwright test --project=setup;',
    'else',
    '  echo \"No Playwright config found under apps/web; skipping setup project.\";',
    "fi'",
  ].join(' ');
}

function e2eTestCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return 'pnpm run --if-present test:e2e';
  }
  return 'npm run test:e2e --if-present';
}

function runE2EOriginParityGuardCheck(
  workspacePath: string,
  testEnvOverrides: NodeJS.ProcessEnv
): TestCheckResult {
  const command =
    'validate APP_BASE_URL/TEST_BASE_URL parity and reject localhost-to-127.0.0.1 Playwright rewrites';
  const appBaseUrl = normalizeTestBaseUrl(testEnvOverrides.APP_BASE_URL);
  const testBaseUrl = normalizeTestBaseUrl(testEnvOverrides.TEST_BASE_URL);
  const issues: string[] = [];

  const appHost = (() => {
    try {
      return new URL(appBaseUrl).host;
    } catch {
      return '(invalid APP_BASE_URL)';
    }
  })();
  const testHost = (() => {
    try {
      return new URL(testBaseUrl).host;
    } catch {
      return '(invalid TEST_BASE_URL)';
    }
  })();

  if (appHost !== testHost) {
    issues.push(`APP_BASE_URL host (${appHost}) does not match TEST_BASE_URL host (${testHost}).`);
  }

  const playwrightConfigCandidates = [
    'apps/web/playwright.config.ts',
    'apps/web/playwright.config.mts',
    'apps/web/playwright.config.cts',
    'apps/web/playwright.config.js',
    'apps/web/playwright.config.mjs',
    'apps/web/playwright.config.cjs',
  ];
  const suspiciousRewritePattern =
    /replace\s*\([^)]*localhost[^)]*127\.0\.0\.1[^)]*\)|replace\s*\([^)]*127\.0\.0\.1[^)]*localhost[^)]*\)/i;
  for (const relativePath of playwrightConfigCandidates) {
    const absolutePath = path.join(workspacePath, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      if (suspiciousRewritePattern.test(content)) {
        issues.push(
          `${relativePath} rewrites localhost/127.0.0.1. This often causes Better Auth "Invalid origin" failures.`
        );
      }
    } catch {
      // best effort
    }
  }

  if (issues.length > 0) {
    return {
      name: 'E2E Origin Parity Guard',
      command,
      success: false,
      output: [
        `APP_BASE_URL=${appBaseUrl}`,
        `TEST_BASE_URL=${testBaseUrl}`,
        ...issues.map((issue) => `- ${issue}`),
      ].join('\n'),
    };
  }

  return {
    name: 'E2E Origin Parity Guard',
    command,
    success: true,
    output: `APP_BASE_URL=${appBaseUrl}\nTEST_BASE_URL=${testBaseUrl}`,
  };
}

function playwrightInstallCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return [
      "sh -c 'set -eu;",
      'if [ -f apps/web/package.json ]; then',
      '  pnpm -C apps/web exec playwright install chromium webkit;',
      'else',
      '  echo \"apps/web/package.json not found; skipping Playwright browser install.\";',
      "fi'",
    ].join(' ');
  }
  return [
    "sh -c 'set -eu;",
    'if [ -f apps/web/package.json ]; then',
    '  npm --prefix apps/web exec playwright install chromium webkit;',
    'else',
    '  echo \"apps/web/package.json not found; skipping Playwright browser install.\";',
    "fi'",
  ].join(' ');
}

function integrationResetCommand(packageManager: PackageManager): string {
  if (packageManager === 'pnpm') {
    return 'pnpm run --if-present db:down && pnpm run --if-present db:up';
  }
  return 'npm run db:down --if-present && npm run db:up --if-present';
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function shouldScanForMockData(relativePath: string): boolean {
  const normalized = normalizeRelPath(relativePath);
  const inGuardRoot = MOCK_DATA_GUARD_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );
  if (!inGuardRoot) return false;
  if (!/\.[cm]?[tj]sx?$/i.test(normalized)) return false;
  if (/\.(?:test|spec|stories)\.[cm]?[tj]sx?$/i.test(normalized)) return false;
  if (
    normalized.includes('/__tests__/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/test/') ||
    normalized.includes('/e2e/') ||
    normalized.includes('/mocks/') ||
    normalized.includes('/fixtures/') ||
    normalized.includes('/stories/') ||
    normalized.includes('/storybook/')
  ) {
    return false;
  }
  return true;
}

function collectFilesRecursively(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const files: string[] = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function collectMockDataCandidateFiles(
  workspacePath: string,
  changedPaths: string[],
  forceFullWorkspace: boolean
): string[] {
  if (!forceFullWorkspace && changedPaths.length > 0) {
    return Array.from(
      new Set(
        changedPaths
          .map((entry) => normalizeRelPath(entry))
          .filter((entry) => shouldScanForMockData(entry))
      )
    ).sort();
  }

  const discovered: string[] = [];
  for (const guardRoot of MOCK_DATA_GUARD_ROOTS) {
    const absRoot = path.join(workspacePath, guardRoot);
    for (const absPath of collectFilesRecursively(absRoot)) {
      const relPath = normalizeRelPath(path.relative(workspacePath, absPath));
      if (shouldScanForMockData(relPath)) {
        discovered.push(relPath);
      }
    }
  }

  return Array.from(new Set(discovered)).sort();
}

function runMockDataGuardCheck(
  workspacePath: string,
  changedPaths: string[],
  forceFullWorkspace: boolean
): TestCheckResult {
  const command = 'static scan: production source must not include mock/fake/placeholder data markers';
  const filesToScan = collectMockDataCandidateFiles(workspacePath, changedPaths, forceFullWorkspace);
  if (filesToScan.length === 0) {
    return {
      name: 'Mock Data Guard',
      command,
      success: true,
      output: 'No applicable production source files found for mock-data scan.',
    };
  }

  const findings: string[] = [];
  let truncated = false;
  for (const relPath of filesToScan) {
    if (findings.length >= MOCK_DATA_GUARD_MAX_FINDINGS) {
      truncated = true;
      break;
    }

    const absPath = path.join(workspacePath, relPath);
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const marker of MOCK_DATA_GUARD_PATTERNS) {
        if (!marker.pattern.test(line)) continue;
        findings.push(`${relPath}:${i + 1} (${marker.reason})`);
        if (findings.length >= MOCK_DATA_GUARD_MAX_FINDINGS) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }

  if (findings.length > 0) {
    const lines: string[] = [
      'Potential mock/placeholder data markers found in production source files.',
      'Replace placeholder data with real API/domain wiring before task completion.',
      '',
      ...findings,
    ];
    if (truncated) {
      lines.push('', `Output truncated at ${MOCK_DATA_GUARD_MAX_FINDINGS} finding(s).`);
    }
    return {
      name: 'Mock Data Guard',
      command,
      success: false,
      output: lines.join('\n'),
    };
  }

  return {
    name: 'Mock Data Guard',
    command,
    success: true,
    output: `Scanned ${filesToScan.length} production source file(s). No mock-data markers found.`,
  };
}

function shouldScanForCsrfGuard(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized.startsWith('apps/web/app/api/')) return false;
  if (!/\/route\.[cm]?[tj]sx?$/i.test(normalized)) return false;
  if (normalized.startsWith('apps/web/app/api/auth/')) return false;
  if (normalized.includes('/api/_lib/')) return false;
  return true;
}

function collectCsrfGuardCandidateFiles(changedPaths: string[]): string[] {
  if (changedPaths.length === 0) return [];
  return Array.from(
    new Set(
      changedPaths
        .map((entry) => normalizeRelPath(entry))
        .filter((entry) => shouldScanForCsrfGuard(entry))
    )
  ).sort();
}

function runCsrfMutationGuardCheck(workspacePath: string, changedPaths: string[]): TestCheckResult {
  const command =
    'static scan: changed cookie-auth mutating API routes must call assertCsrf(request)';
  const filesToScan = collectCsrfGuardCandidateFiles(changedPaths);
  if (filesToScan.length === 0) {
    return {
      name: 'CSRF Mutation Guard',
      command,
      success: true,
      output: 'No changed API route files matched CSRF guard scope.',
    };
  }

  const findings: string[] = [];
  let truncated = false;
  for (const relPath of filesToScan) {
    if (findings.length >= CSRF_GUARD_MAX_FINDINGS) {
      truncated = true;
      break;
    }

    const absPath = path.join(workspacePath, relPath);
    let content = '';
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const methods = new Set<string>();
    CSRF_MUTATION_METHOD_EXPORT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = CSRF_MUTATION_METHOD_EXPORT_PATTERN.exec(content)) !== null) {
      if (match[1]) methods.add(match[1].toUpperCase());
    }
    if (methods.size === 0) continue;

    const isLikelyCookieAuth = CSRF_COOKIE_AUTH_HINT_PATTERNS.some((pattern) => pattern.test(content));
    if (!isLikelyCookieAuth) continue;

    const hasAssertCsrfCall = /\bassertCsrf\s*\(\s*request\s*\)/.test(content);
    if (hasAssertCsrfCall) continue;

    findings.push(`${relPath} (mutating exports: ${Array.from(methods).sort().join(', ')})`);
  }

  if (findings.length > 0) {
    const lines: string[] = [
      'Potential CSRF guard gap detected in changed API route files.',
      'These files export mutating methods and appear to use cookie-auth context but do not call assertCsrf(request).',
      '',
      ...findings,
      '',
      'Recommended fix: import and call assertCsrf(request) near the top of each mutating handler before side effects.',
    ];
    if (truncated) {
      lines.push('', `Output truncated at ${CSRF_GUARD_MAX_FINDINGS} finding(s).`);
    }
    return {
      name: 'CSRF Mutation Guard',
      command,
      success: false,
      output: lines.join('\n'),
    };
  }

  return {
    name: 'CSRF Mutation Guard',
    command,
    success: true,
    output: `Scanned ${filesToScan.length} changed API route file(s). No CSRF guard gaps detected.`,
  };
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
    return getGitStatusPorcelain(workspacePath) || '(clean working directory)';
  } catch {
    return '(failed to get git status)';
  }
}

function getGitStatusPorcelain(workspacePath: string): string {
  return execSync('git status --porcelain', {
    cwd: workspacePath,
    encoding: 'utf-8',
  }).trim();
}

export function hasGitChanges(workspacePath: string): boolean {
  try {
    return getGitStatusPorcelain(workspacePath).length > 0;
  } catch {
    return false;
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

export function getGitHeadSha(workspacePath: string): string {
  return execSync('git rev-parse HEAD', {
    cwd: workspacePath,
    encoding: 'utf-8',
  }).trim();
}

export function gitResetHard(workspacePath: string, ref: string): void {
  execFileSync('git', ['reset', '--hard', ref], {
    cwd: workspacePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  execFileSync('git', ['clean', '-fd'], {
    cwd: workspacePath,
    encoding: 'utf-8',
    stdio: 'pipe',
  });
}

/**
 * Commits all changes in the workspace with a descriptive message.
 * Returns true if a commit was made, false if there was nothing to commit.
 */
export function gitCommitChanges(workspacePath: string, message: string): boolean {
  try {
    const status = getGitStatusPorcelain(workspacePath);

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
  timeoutMs: number = 300_000,
  suite: WorkspaceTestSuite = 'all'
): WorkspaceTestResult {
  const sections: string[] = [];
  const checks: TestCheckResult[] = [];
  const packageManager = detectPackageManager(workspacePath);
  const includeIntegration = suite === 'all' || suite === 'integration';
  const includeE2E = suite === 'all' || suite === 'e2e';
  const includeE2ESetup = suite === 'all' || suite === 'e2e' || suite === 'e2e_setup';

  function commandExists(command: string): boolean {
    return commandExistsInWorkspace(workspacePath, command);
  }

  interface RunCheckOptions {
    allowEmptyOutput?: boolean;
    forbidOutputPatterns?: RegExp[];
    emptyOutputMessage?: string;
    env?: NodeJS.ProcessEnv;
    extraFailureLogs?: string[];
    timeoutMs?: number;
  }

  function runCheck(
    name: string,
    command: string,
    tailLimit: number = 4000,
    options: RunCheckOptions = {}
  ): TestCheckResult {
    try {
      const output = execSync(`${command} 2>&1`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: options.timeoutMs ?? timeoutMs,
        stdio: 'pipe',
        env: { ...process.env, ...(options.env || {}) },
      });
      const trimmed = (output || '').trim();
      const finalOutput = trimmed.length > tailLimit ? trimmed.slice(-tailLimit) : trimmed;
      const hasForbiddenOutput =
        options.forbidOutputPatterns?.some((pattern) => pattern.test(trimmed)) ?? false;
      const hasEmptyOutput = trimmed.length === 0;
      const shouldFailOnEmptyOutput = options.allowEmptyOutput === false;
      const success = !hasForbiddenOutput && !(hasEmptyOutput && shouldFailOnEmptyOutput);
      const message = hasEmptyOutput
        ? options.emptyOutputMessage || 'No output'
        : finalOutput || 'No output';

      let failureReason = '';
      if (hasForbiddenOutput) {
        failureReason = 'Output indicates tests may have been skipped or not discovered.';
      } else if (hasEmptyOutput && shouldFailOnEmptyOutput) {
        failureReason =
          options.emptyOutputMessage ||
          'Command succeeded but produced no output. This is treated as failure to avoid false positives.';
      }

      const finalMessage = success ? message : `${message}\n${failureReason}`.trim();

      const check: TestCheckResult = {
        name,
        command,
        success,
        output: finalMessage,
      };
      checks.push(check);
      sections.push(
        `## ${name} (${command})\n\`\`\`\n${finalMessage}\n\`\`\``
      );
      return check;
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const rawErrorMessage = (e.message || '').trim();
      const rawStdout = (e.stdout || '').trim();
      const rawStderr = (e.stderr || '').trim();
      const raw = [rawErrorMessage ? `Command error: ${rawErrorMessage}` : '', rawStdout, rawStderr]
        .filter(Boolean)
        .join('\n')
        .trim() || 'unknown error';
      const extraLogs: string[] = [];
      if (options.extraFailureLogs) {
        for (const filePath of options.extraFailureLogs) {
          if (!fs.existsSync(filePath)) continue;
          try {
            const rawFile = fs.readFileSync(filePath, 'utf-8');
            const lines = rawFile.split('\n');
            const tail = lines.slice(-80).join('\n').trim();
            if (tail) {
              extraLogs.push(`\n--- ${filePath} (tail) ---\n${tail}`);
            }
          } catch {
            // best effort
          }
        }
      }
      const withLogs = [raw, ...extraLogs].filter(Boolean).join('\n');
      let finalOutput = withLogs;
      if (withLogs.length > tailLimit) {
        const headChars = Math.max(1200, Math.floor(tailLimit * 0.35));
        const tailChars = Math.max(1800, tailLimit - headChars - 180);
        finalOutput = [
          withLogs.slice(0, headChars),
          `\n\n--- output truncated (${withLogs.length} chars total) ---\n\n`,
          withLogs.slice(-tailChars),
        ].join('');
      }
      const check: TestCheckResult = {
        name,
        command,
        success: false,
        output: finalOutput,
      };
      checks.push(check);
      sections.push(`## ${name} (${command})\n\`\`\`\n${finalOutput}\n\`\`\``);
      return check;
    }
  }

  function runDockerPortCleanup(): void {
    const checkName = 'Docker Port Cleanup';
    const checkCommand =
      'docker ps --filter publish=<port> ; docker rm -f <container_ids> (' +
      COLLISION_PRONE_DOCKER_PORTS.join(', ') +
      ')';

    if (!commandExists('docker')) {
      const output = 'docker is required for auto-cleanup but is not installed on PATH.';
      checks.push({
        name: checkName,
        command: checkCommand,
        success: false,
        output,
      });
      sections.push('## ' + checkName + ' (' + checkCommand + ')\n~~~\n' + output + '\n~~~');
      return;
    }

    try {
      const containerIds = new Set<string>();
      const collisions: string[] = [];

      for (const port of COLLISION_PRONE_DOCKER_PORTS) {
        const output = execSync(
          'docker ps --filter publish=' + port + ' --format "{{.ID}}\\t{{.Names}}\\t{{.Ports}}"',
          {
            cwd: workspacePath,
            encoding: 'utf-8',
            timeout: 20_000,
            stdio: 'pipe',
          }
        ).trim();

        if (!output) continue;

        const lines = output
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        for (const line of lines) {
          const [id, name, ports] = line.split('\t');
          if (id) {
            containerIds.add(id);
            collisions.push('port ' + port + ': ' + (name || id) + ' (' + (ports || 'ports unavailable') + ')');
          }
        }
      }

      if (containerIds.size === 0) {
        const output =
          'No running Docker containers are publishing guarded ports (' +
          COLLISION_PRONE_DOCKER_PORTS.join(', ') +
          ').';
        checks.push({
          name: checkName,
          command: checkCommand,
          success: true,
          output,
        });
        sections.push('## ' + checkName + ' (' + checkCommand + ')\n~~~\n' + output + '\n~~~');
        return;
      }

      const ids = Array.from(containerIds);
      const rmOutput = execFileSync('docker', ['rm', '-f', ...ids], {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 60_000,
        stdio: 'pipe',
      }).trim();

      const output = [
        'Removed ' +
          ids.length +
          ' running container(s) that would collide with guarded ports (' +
          COLLISION_PRONE_DOCKER_PORTS.join(', ') +
          ').',
        '',
        'Detected collisions:',
        ...collisions.map((line) => '- ' + line),
        '',
        rmOutput || '(docker rm -f returned no output)',
      ].join('\n');
      checks.push({
        name: checkName,
        command: checkCommand,
        success: true,
        output,
      });
      sections.push('## ' + checkName + ' (' + checkCommand + ')\n~~~\n' + output + '\n~~~');
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const output = (e.stdout || '') + '\n' + (e.stderr || '');
      const finalOutput = output.trim() || e.message || 'unknown error';
      checks.push({
        name: checkName,
        command: checkCommand,
        success: false,
        output: finalOutput,
      });
      sections.push('## ' + checkName + ' (' + checkCommand + ')\n~~~\n' + finalOutput + '\n~~~');
    }
  }

  runDockerPortCleanup();

  const appPortCleanup = runWorkspacePortCleanup(workspacePath, [3000]);
  checks.push(appPortCleanup);
  sections.push(formatCheckSection(appPortCleanup));

  const dependencyInstall = runWorkspaceDependencyInstall(workspacePath, timeoutMs, 5000);
  checks.push(dependencyInstall);
  sections.push(formatCheckSection(dependencyInstall));

  const envInit = runWorkspaceEnvInit(workspacePath, timeoutMs, 5000);
  checks.push(envInit);
  sections.push(formatCheckSection(envInit));

  const workspaceEnv = loadWorkspaceEnvOverrides(workspacePath);
  const canonicalBaseUrl = normalizeTestBaseUrl(
    process.env.TEST_BASE_URL ||
      process.env.APP_BASE_URL ||
      workspaceEnv.TEST_BASE_URL ||
      workspaceEnv.APP_BASE_URL ||
      PIPELINE_E2E_BASE_URL
  );
  const testEnvOverrides: NodeJS.ProcessEnv = {
    CI: 'true',
    ALLOW_DEV_TOKENS: 'true',
    DISABLE_RATE_LIMIT: 'true',
    DATABASE_URL:
      process.env.DATABASE_URL ||
      workspaceEnv.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/acme',
    DATABASE_URL_UNPOOLED:
      process.env.DATABASE_URL_UNPOOLED ||
      workspaceEnv.DATABASE_URL_UNPOOLED ||
      workspaceEnv.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/acme',
    APP_BASE_URL: canonicalBaseUrl,
    TEST_BASE_URL: canonicalBaseUrl,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET || 'pipeline_phase10_test_secret_abcdefghijklmnopqrstuvwxyz',
    CRON_SECRET: process.env.CRON_SECRET || 'pipeline_phase10_cron_secret_abcdefghijklmnopqrstuvwxyz',
  };

  const e2eFamilySuite = suite === 'e2e' || suite === 'e2e_setup';
  const integrationCommand = `sh -c 'set -eu; ${integrationResetCommand(packageManager)}; ${integrationBootstrapCommand(
    packageManager
  )}'`;
  const e2eBootstrap = `sh -c 'set -eu; ${e2eBootstrapCommand(packageManager)}'`;
  const playwrightInstall = playwrightInstallCommand(packageManager);
  const playwrightSetup = e2eSetupCommand(packageManager);
  const e2eCommand = e2eTestCommand(packageManager);
  let buildResult: TestCheckResult | null = null;
  let mockDataGuard: TestCheckResult | null = null;

  if (!e2eFamilySuite) {
    runCheck('TypeScript Typecheck', scriptCommand(packageManager, 'typecheck'));
    runCheck('Lint', scriptCommand(packageManager, 'lint'));
    mockDataGuard = runMockDataGuardCheck(workspacePath, [], true);
    checks.push(mockDataGuard);
    sections.push(formatCheckSection(mockDataGuard));
    buildResult = runCheck('Build', scriptCommand(packageManager, 'build'), 4000, {
      env: testEnvOverrides,
    });
  }

  if (!e2eFamilySuite && buildResult && mockDataGuard && (!buildResult.success || !mockDataGuard.success)) {
    const skipReasons = [
      !buildResult.success
        ? 'Build failed. Integration tests require a successful production build before `next start` can pass health checks.'
        : '',
      !mockDataGuard.success
        ? 'Mock Data Guard failed. Integration tests are skipped until placeholder/mock data markers are removed from production source.'
        : '',
    ].filter(Boolean);
    const output = `Skipped because ${skipReasons.join(' ')}`;
    if (includeIntegration) {
      const integrationCheck: TestCheckResult = {
        name: 'Integration Tests',
        command: integrationCommand,
        success: false,
        output,
      };
      checks.push(integrationCheck);
      sections.push(`## Integration Tests (${integrationCheck.command})\n\`\`\`\n${output}\n\`\`\``);
    }
    if (includeE2ESetup || includeE2E) {
      const playwrightInstallCheck: TestCheckResult = {
        name: 'Playwright Browser Install',
        command: playwrightInstall,
        success: false,
        output: `Skipped because ${skipReasons.join(' ')}`,
      };
      checks.push(playwrightInstallCheck);
      sections.push(
        `## Playwright Browser Install (${playwrightInstallCheck.command})\n\`\`\`\n${playwrightInstallCheck.output}\n\`\`\``
      );

      const e2eBootstrapCheck: TestCheckResult = {
        name: 'E2E Bootstrap',
        command: e2eBootstrap,
        success: false,
        output: `Skipped because ${skipReasons.join(' ')}`,
      };
      checks.push(e2eBootstrapCheck);
      sections.push(`## E2E Bootstrap (${e2eBootstrapCheck.command})\n\`\`\`\n${e2eBootstrapCheck.output}\n\`\`\``);

      const parityGuardCheck: TestCheckResult = {
        name: 'E2E Origin Parity Guard',
        command:
          'validate APP_BASE_URL/TEST_BASE_URL parity and reject localhost-to-127.0.0.1 Playwright rewrites',
        success: false,
        output: `Skipped because ${skipReasons.join(' ')}`,
      };
      checks.push(parityGuardCheck);
      sections.push(`## E2E Origin Parity Guard (${parityGuardCheck.command})\n\`\`\`\n${parityGuardCheck.output}\n\`\`\``);

      const e2eSetupCheck: TestCheckResult = {
        name: 'Playwright Setup Project',
        command: playwrightSetup,
        success: false,
        output: `Skipped because ${skipReasons.join(' ')}`,
      };
      checks.push(e2eSetupCheck);
      sections.push(`## Playwright Setup Project (${e2eSetupCheck.command})\n\`\`\`\n${e2eSetupCheck.output}\n\`\`\``);
    }

    if (includeE2E) {
      const e2eCheck: TestCheckResult = {
        name: 'Playwright E2E Tests',
        command: e2eCommand,
        success: false,
        output: `Skipped because ${skipReasons.join(' ')}`,
      };
      checks.push(e2eCheck);
      sections.push(`## Playwright E2E Tests (${e2eCheck.command})\n\`\`\`\n${e2eCheck.output}\n\`\`\``);
    }
  } else {
    // Integration runs inside a single shell; `env` here is inherited by all child processes,
    // including `pnpm -C apps/web start`, so server-side rate limiting is disabled for tests.
    if (includeIntegration) {
      runCheck('Integration Tests', integrationCommand, 16000, {
        allowEmptyOutput: false,
        emptyOutputMessage: 'No output from test command. This likely means tests were skipped.',
        env: testEnvOverrides,
        timeoutMs: Math.max(timeoutMs, 900_000),
        forbidOutputPatterns: [
          /missing script: test/i,
          /no test specified/i,
          /no tests found/i,
          /did not find any tests/i,
          /\b0 passed\b/i,
          /0 passing/i,
        ],
        extraFailureLogs: ['/tmp/acme-web-test.log'],
      });
    }

    if (includeE2ESetup || includeE2E) {
      runCheck('Playwright Browser Install', playwrightInstall, 8000, {
        env: testEnvOverrides,
        timeoutMs: Math.max(timeoutMs, 900_000),
      });

      runCheck('E2E Bootstrap', e2eBootstrap, 12000, {
        env: testEnvOverrides,
        timeoutMs: Math.max(timeoutMs, 900_000),
        extraFailureLogs: ['/tmp/acme-web-test.log'],
      });

      const parityGuard = runE2EOriginParityGuardCheck(workspacePath, testEnvOverrides);
      checks.push(parityGuard);
      sections.push(formatCheckSection(parityGuard));

      runCheck('Playwright Setup Project', playwrightSetup, 16000, {
        allowEmptyOutput: false,
        emptyOutputMessage:
          'No output from Playwright setup project. This likely means setup tests were skipped.',
        env: testEnvOverrides,
        timeoutMs: Math.max(timeoutMs, 900_000),
        forbidOutputPatterns: [
          /project\(s\) \"setup\" not found/i,
          /missing script: test:e2e/i,
          /no tests found/i,
          /did not find any tests/i,
        ],
      });
    }

    if (includeE2E) {
      runCheck('Playwright E2E Tests', e2eCommand, 16000, {
        allowEmptyOutput: false,
        emptyOutputMessage: 'No output from test:e2e command. This likely means tests were skipped.',
        env: testEnvOverrides,
        timeoutMs: Math.max(timeoutMs, 900_000),
        forbidOutputPatterns: [
          /missing script: test:e2e/i,
          /no tests found/i,
          /did not find any tests/i,
          /\b0 passed\b/i,
          /0 passing/i,
        ],
      });
    }
  }

  return {
    report: sections.join('\n\n') || '(no test results available)',
    checks,
    allPassed: checks.every((c) => c.success),
  };
}

/**
 * Runs quality checks intended for task-level validation during implementation.
 * Uses scoped turbo filters when changed paths map cleanly to known workspaces,
 * otherwise falls back to full workspace checks.
 */
export function runWorkspaceQualityChecks(
  workspacePath: string,
  timeoutMs: number = 300_000,
  options: QualityCheckOptions = {}
): WorkspaceTestResult {
  const sections: string[] = [];
  const checks: TestCheckResult[] = [];
  const packageManager = detectPackageManager(workspacePath);
  const forceFullWorkspace = options.forceFullWorkspace === true;
  const forceFullWorkspaceLintTypecheck = options.forceFullWorkspaceLintTypecheck === true;

  function parseChangedPaths(status: string): string[] {
    if (!status.trim()) return [];
    const paths: string[] = [];
    for (const rawLine of status.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      const payload = line.slice(3).trim();
      if (!payload) continue;
      const renameParts = payload.split(' -> ');
      const normalized = renameParts[renameParts.length - 1].trim();
      if (normalized) paths.push(normalized);
    }
    return paths;
  }

  function inferScopes(changedPaths: string[]): { scopes: string[]; isScoped: boolean } {
    if (changedPaths.length === 0) {
      return { scopes: [], isScoped: false };
    }

    const scopes = new Set<string>();
    for (const filePath of changedPaths) {
      if (filePath.startsWith('apps/web/')) {
        scopes.add('@acme/web');
        continue;
      }
      if (filePath.startsWith('apps/mobile/')) {
        scopes.add('mobile');
        continue;
      }

      const pkgMatch = filePath.match(/^packages\/([^/]+)\//);
      if (pkgMatch?.[1]) {
        scopes.add(`@acme/${pkgMatch[1]}`);
        continue;
      }

      return { scopes: [], isScoped: false };
    }

    return scopes.size > 0
      ? { scopes: Array.from(scopes).sort(), isScoped: true }
      : { scopes: [], isScoped: false };
  }

  function appendCheck(check: TestCheckResult): void {
    checks.push(check);
    sections.push(formatCheckSection(check));
  }

  function runCheck(name: string, command: string, tailLimit: number = 4000): TestCheckResult {
    try {
      const output = execSync(`${command} 2>&1`, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: 'pipe',
      });
      const trimmed = (output || '').trim();
      const finalOutput = trimmed.length > tailLimit ? trimmed.slice(-tailLimit) : trimmed;
      const check: TestCheckResult = {
        name,
        command,
        success: true,
        output: finalOutput || 'No output',
      };
      appendCheck(check);
      return check;
    } catch (error: unknown) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      const raw = `${e.stdout || ''}\n${e.stderr || ''}`.trim() || e.message || 'unknown error';
      const finalOutput = raw.length > tailLimit ? raw.slice(-tailLimit) : raw;
      const check: TestCheckResult = {
        name,
        command,
        success: false,
        output: finalOutput,
      };
      appendCheck(check);
      return check;
    }
  }

  function dependencyDescriptorsChanged(changedPaths: string[]): boolean {
    return changedPaths.some((changedPath) => {
      if (changedPath === 'pnpm-lock.yaml' || changedPath === 'package-lock.json') {
        return true;
      }
      return /(^|\/)package\.json$/.test(changedPath);
    });
  }

  const changedPaths = parseChangedPaths(getGitStatusPorcelain(workspacePath));
  const scopeInfo = forceFullWorkspace
    ? { scopes: [] as string[], isScoped: false }
    : inferScopes(changedPaths);
  const dependencyReasons: string[] = [];
  const nodeModulesPath = path.join(workspacePath, 'node_modules');
  if (!fs.existsSync(nodeModulesPath)) {
    dependencyReasons.push('node_modules directory is missing');
  }
  if (dependencyDescriptorsChanged(changedPaths)) {
    dependencyReasons.push('dependency descriptor changes detected in git status');
  }
  if (packageManager === 'pnpm') {
    const turboBinPath = path.join(nodeModulesPath, '.bin', 'turbo');
    if (!fs.existsSync(turboBinPath)) {
      dependencyReasons.push('turbo binary is missing from node_modules/.bin');
    }
  }
  const needsDependencyInstall = dependencyReasons.length > 0;

  if (scopeInfo.isScoped && !forceFullWorkspaceLintTypecheck) {
    sections.push(`## Scope\n\`\`\`\nScoped checks for: ${scopeInfo.scopes.join(', ')}\n\`\`\``);
  } else if (scopeInfo.isScoped && forceFullWorkspaceLintTypecheck) {
    sections.push(
      `## Scope\n\`\`\`\nChanged scope detected (${scopeInfo.scopes.join(
        ', '
      )}), but running full-workspace typecheck/lint to prevent cross-task accumulation.\nBuild remains scoped when possible.\n\`\`\``
    );
  } else {
    sections.push('## Scope\n```\nRunning full-workspace quality checks.\n```');
  }

  const canUseScopedTurbo =
    packageManager === 'pnpm' &&
    commandExistsInWorkspace(workspacePath, 'pnpm') &&
    scopeInfo.isScoped &&
    scopeInfo.scopes.length > 0 &&
    !forceFullWorkspace;

  const filterArgs = scopeInfo.scopes.map((scope) => `--filter=${scope}`).join(' ');
  const useScopedLintTypecheck = canUseScopedTurbo && !forceFullWorkspaceLintTypecheck;
  const typecheckCommand = useScopedLintTypecheck
    ? `pnpm exec turbo run typecheck ${filterArgs}`
    : scriptCommand(packageManager, 'typecheck');
  const lintCommand = useScopedLintTypecheck
    ? `pnpm exec turbo run lint ${filterArgs}`
    : scriptCommand(packageManager, 'lint');
  const buildCommand = canUseScopedTurbo
    ? `pnpm exec turbo run build ${filterArgs}`
    : scriptCommand(packageManager, 'build');

  if (needsDependencyInstall) {
    sections.push(
      `## Dependency Install Preflight\n\`\`\`\nRunning dependency install before quality checks because:\n- ${dependencyReasons.join('\n- ')}\n\`\`\``
    );
    const dependencyInstall = runWorkspaceDependencyInstall(workspacePath, timeoutMs, 5000);
    appendCheck(dependencyInstall);

    if (!dependencyInstall.success) {
      const skipMessage = 'Skipped because dependency install failed.';
      appendCheck({
        name: 'TypeScript Typecheck',
        command: typecheckCommand,
        success: false,
        output: skipMessage,
      });
      appendCheck({
        name: 'Lint',
        command: lintCommand,
        success: false,
        output: skipMessage,
      });
      appendCheck({
        name: 'Build',
        command: buildCommand,
        success: false,
        output: skipMessage,
      });
      appendCheck({
        name: 'Mock Data Guard',
        command: 'static scan: production source must not include mock/fake/placeholder data markers',
        success: false,
        output: skipMessage,
      });
      appendCheck({
        name: 'CSRF Mutation Guard',
        command: 'static scan: changed cookie-auth mutating API routes must call assertCsrf(request)',
        success: false,
        output: skipMessage,
      });
      if (options.includeTests) {
        appendCheck({
          name: 'Tests',
          command: scriptCommand(packageManager, 'test'),
          success: false,
          output: skipMessage,
        });
      }

      return {
        report: sections.join('\n\n') || '(no quality results available)',
        checks,
        allPassed: checks.every((c) => c.success),
      };
    }
  } else {
    sections.push('## Dependency Install Preflight\n```\nSkipped: dependencies already present and unchanged.\n```');
  }

  runCheck('TypeScript Typecheck', typecheckCommand);
  runCheck('Lint', lintCommand);
  appendCheck(runMockDataGuardCheck(workspacePath, changedPaths, forceFullWorkspace));
  appendCheck(runCsrfMutationGuardCheck(workspacePath, changedPaths));
  runCheck('Build', buildCommand);

  if (options.includeTests) {
    runCheck('Tests', scriptCommand(packageManager, 'test'), 8000);
  }

  return {
    report: sections.join('\n\n') || '(no quality results available)',
    checks,
    allPassed: checks.every((c) => c.success),
  };
}
