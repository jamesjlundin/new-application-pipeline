# New Application Pipeline

## Cost Warning
- This pipeline can consume meaningful AI spend because it runs many multi-turn phases (research, planning, implementation, repair, audit).
- Use `--budget` on every run, and prefer subscription plans for both Claude Code and Codex if you run this frequently.
- You are also creating/cloning GitHub repos, so be intentional with run frequency and retries.
- For Codex runs, when exact USD cost is unavailable, the pipeline now tracks a fallback estimate from token usage (`CODEX_EST_INPUT_USD_PER_1M`, `CODEX_EST_OUTPUT_USD_PER_1M`).

## What This Is
This repo is a local orchestrator that turns an app idea into a production-style implementation pipeline. It generates a sequence of artifacts (problem framing, workflows, PRD, feasibility review, tech spec, task breakdown), bootstraps a repo from your template, implements tasks, verifies with tests, and audits the result.

It is designed for iterative use: you can run fully automated (`--auto`) or gated (`--interactive`), resume interrupted runs, restart from specific phases, and track cumulative spend. It supports both Claude Code and OpenAI Codex CLIs, using whichever one you select per run.

## Pipeline Diagram
```text
Idea Input
  |
  v
[0] Idea Intake
  -> [1] Problem Framing
  -> [2] Workflows
  -> [3] Design & Theme
  -> [4] PRD
  -> [5] Repo Bootstrap (create + clone template repo)
  -> [6] Feasibility Review (inside repo)
  -> [7] Tech Spec (inside repo)
  -> [8] Task Breakdown (inside repo)
  -> [9] Implementation (task-by-task commits)
  -> [10] Test & Verify (auto repair attempts)
  -> [11] UX Reachability (journey discoverability + branding checks)
  -> [12] Audit
  -> report.md
```

## Prerequisites
- Node.js 20+
- Git
- GitHub CLI (`gh`) authenticated
- At least one agent CLI authenticated:
  - `claude` (Claude Code)
  - `codex` (OpenAI Codex CLI)

## Usage
```bash
npx ts-node tools/run-pipeline.ts [options] "<idea>"
```

Use either a quoted idea string or `--idea-file`, not both.

## Arguments
| Argument | Description | Default |
|---|---|---|
| `"<idea>"` | App idea as positional string | required for new run unless `--idea-file` |
| `--idea-file <path>` | Load idea from markdown/text file | — |
| `--resume <run-dir>` | Resume existing run directory | — |
| `--from-phase <id>` | Start/resume from specific phase (`0`, `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`) | next incomplete |
| `--repo-name <name>` | GitHub repo name to create | slug from idea |
| `--owner <github-user-or-org>` | GitHub owner for created repo | auto-detected from `gh` |
| `--template <owner/repo>` | GitHub template repo | `jamesjlundin/full-stack-web-and-mobile-template` |
| `--visibility <public\|private>` | Created repo visibility | `public` |
| `--engine <claude\|codex>` | Agent engine | `claude` |
| `--timeout <minutes>` | Per-agent call timeout | none |
| `--budget <usd>` | Hard cap for cumulative AI cost | none |
| `--interactive` | Pause at approval gates | on |
| `--auto` | Run unattended (no approval pauses) | off |
| `--dry-run` | Build prompts and phase plan without calling agents | off |
| `--help` | Show help | — |

## Example Commands
### 1) New run from a file (Codex, private, unattended)
```bash
npx ts-node tools/run-pipeline.ts \
  --idea-file ideas/orphan-team.md \
  --engine codex \
  --visibility private \
  --auto \
  --repo-name codex-orphan-test \
  --owner jamesjlundin \
  --template jamesjlundin/full-stack-web-and-mobile-template \
  --timeout 20 \
  --budget 25
```

### 2) New run from inline idea (Claude, interactive)
```bash
npx ts-node tools/run-pipeline.ts \
  --engine claude \
  --visibility public \
  --interactive \
  --repo-name claude-recipe-test \
  "A recipe planning app for families"
```

### 3) Dry-run (no agent calls)
```bash
npx ts-node tools/run-pipeline.ts \
  --dry-run \
  --owner jamesjlundin \
  "A lightweight CRM for freelancers"
```

## Resume / Continue From Phase
### Continue the same run from next incomplete phase
```bash
npx ts-node tools/run-pipeline.ts \
  --resume runs/2026-02-09_claude_my-run-id
```

### Continue the same run from a specific phase
```bash
npx ts-node tools/run-pipeline.ts \
  --resume runs/2026-02-09_codex_my-run-id \
  --from-phase 9
```

### Re-run only audit phase on an existing run
```bash
npx ts-node tools/run-pipeline.ts \
  --resume runs/2026-02-09_claude_my-run-id \
  --from-phase 12
```

Notes:
- Phase `9` has task-level checkpointing; if interrupted mid-implementation it resumes from the last completed task.
- Phase `9` now auto-cleans uncommitted workspace changes by resetting to `HEAD` at phase start and after failures, so retries/resumes do not require manual cleanup.
- Phase `10` now runs an environment initialization preflight (`env:init`, when available) before verification checks so required runtime secrets/config are generated prior to test execution.
- Phase `10` now clears workspace-owned listeners on port `3000` before verification to avoid stale app servers polluting test runs.
- Phase `10` test execution forces `DISABLE_RATE_LIMIT=true` (plus test-safe auth/cron env defaults) to prevent CI/test runs from failing due to application rate limits or missing secrets.
- Phase `10` verification now follows CI-style template checks: integration bootstrap (`db:down`/`db:up`, DB migrations/constraint validation when available, app server start, health wait, then `test:integration`) plus Playwright via `test:e2e`.
- Phase `9` now validates task manifests against template test conventions and fails fast if tasks introduce non-canonical test patterns (for this template, only integration tests in `packages/tests/src/*.test.ts(x)` and Playwright files in `apps/web/e2e/*.spec.ts(x)` / `apps/web/e2e/*.setup.ts(x)`).
- Phase `9` task-level quality checks now run full-workspace `typecheck` + `lint` on every task (with scoped build where possible) to prevent lint/type regressions from accumulating across tasks.
- Phase `9` and `10` now include a `Mock Data Guard` static scan for production source files (`apps/web/app`, `apps/web/components`, `apps/web/server`, `apps/web/lib`) that fails on explicit mock/fake/placeholder data markers.
- Phase `10` integration bootstrap command generation was hardened to use newline-separated shell statements, preventing `fi if` syntax errors in verification runs.
- `--resume` runs use the saved `config.json` from that run directory.
- New runs are named `YYYY-MM-DD_<engine>_<idea-slug>` to prevent Claude/Codex naming collisions.

## Output Locations
- Run state and artifacts: `runs/<run-id>/`
- Per-phase artifacts: `runs/<run-id>/artifacts/`
- Logs: `runs/<run-id>/logs/pipeline.log`
- Final summary: `runs/<run-id>/report.md`
- Generated app repo: sibling directory to this repo (based on `--repo-name`)
- Phase 9 task queue + diagnostics:
  - `runs/<run-id>/artifacts/09a_task_queue.json`
  - `runs/<run-id>/artifacts/09a_task_plan_summary.md`
  - `runs/<run-id>/artifacts/09_dynamic_backlog.md` (if follow-up tasks are added)
  - `runs/<run-id>/artifacts/09_quality/` (task/milestone quality gate reports)

## Phase 9 Dependency Preflight (Regression Scenario)
Phase 9 now runs a dependency preflight before task execution, and task-level quality checks will also run a dependency install preflight when needed (for example: missing `node_modules`, missing `node_modules/.bin/turbo`, or dependency descriptor changes like `package.json` / lockfiles).

Quick regression scenario:
1. Start from a fresh generated repo (or remove `node_modules` in a throwaway copy).
2. Resume/run Phase 9.
3. Confirm `runs/<run-id>/logs/pipeline.log` includes a Phase 9 dependency preflight entry.
4. Confirm `runs/<run-id>/artifacts/09_quality/*.md` includes a `Dependency Install` check before typecheck/lint/build when dependencies are missing/changed.
5. Confirm failures are reported as dependency-install failures (with typecheck/lint/build marked skipped), rather than opaque `turbo: command not found` cascades.
