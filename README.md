# New Application Pipeline

## Cost Warning
- This pipeline can consume meaningful AI spend because it runs many multi-turn phases (research, planning, implementation, repair, audit).
- Use `--budget` on every run, and prefer subscription plans for both Claude Code and Codex if you run this frequently.
- You are also creating/cloning GitHub repos, so be intentional with run frequency and retries.

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
  -> [2.5] Design & Theme
  -> [3] PRD
  -> [3.5] Repo Bootstrap (create + clone template repo)
  -> [4] Feasibility Review (inside repo)
  -> [5] Tech Spec (inside repo)
  -> [6] Task Breakdown (inside repo)
  -> [7] Implementation (task-by-task commits)
  -> [7.5] Test & Verify (auto repair attempts)
  -> [8] Audit
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
| `--from-phase <id>` | Start/resume from specific phase (`0`, `1`, `2`, `2.5`, `3`, `3.5`, `4`, `5`, `6`, `7`, `7.5`, `8`) | next incomplete |
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
  --resume runs/2026-02-09_my-run-id
```

### Continue the same run from a specific phase
```bash
npx ts-node tools/run-pipeline.ts \
  --resume runs/2026-02-09_my-run-id \
  --from-phase 7
```

### Re-run only audit phase on an existing run
```bash
npx ts-node tools/run-pipeline.ts \
  --resume runs/2026-02-09_my-run-id \
  --from-phase 8
```

Notes:
- Phase `7` has task-level checkpointing; if interrupted mid-implementation it resumes from the last completed task.
- `--resume` runs use the saved `config.json` from that run directory.

## Output Locations
- Run state and artifacts: `runs/<run-id>/`
- Per-phase artifacts: `runs/<run-id>/artifacts/`
- Logs: `runs/<run-id>/logs/pipeline.log`
- Final summary: `runs/<run-id>/report.md`
- Generated app repo: sibling directory to this repo (based on `--repo-name`)
