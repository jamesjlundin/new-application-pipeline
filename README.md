# New Application Pipeline

An artifact-driven pipeline for building new applications using AI coding agents. Takes an idea from concept through product design, technical planning, and implementation — generating a fully scaffolded repository from a template along the way.

The pipeline runs locally on your machine, orchestrating Claude Code or OpenAI Codex CLI to produce structured artifacts at each phase, then implements the application directly in the generated repo.

## Prerequisites

### Required

- **Node.js 20+** and **npm**
- **Git**
- **GitHub CLI (`gh`)** — used to create repos from templates and clone them
  ```bash
  brew install gh
  gh auth login
  ```
- **At least one AI coding agent CLI:**
  - **Claude Code** (default) — [Install instructions](https://docs.anthropic.com/en/docs/claude-code)
  - **OpenAI Codex CLI** (optional) — [Install instructions](https://github.com/openai/codex)

### Verify your setup

```bash
node --version    # v20+
gh --version      # 2.x
gh auth status    # logged in
claude --version  # or: codex --version
```

## Installation

```bash
git clone https://github.com/jamesjlundin/new-application-pipeline.git
cd new-application-pipeline
npm install
```

## Quick Start

```bash
npx ts-node tools/run-pipeline.ts "A task management app for remote teams"
```

This will:

1. Create a timestamped run directory under `runs/`
2. Generate product artifacts (idea intake, problem framing, workflows, PRD)
3. Pause for your approval before proceeding (interactive mode)
4. Create a new GitHub repo from the template and clone it as a sibling directory
5. Generate technical artifacts (feasibility review, tech spec, task breakdown) with the AI exploring the actual repo
6. Pause for your approval of the task breakdown
7. Implement each task directly in the repo, committing after each task
8. Run automated tests (typecheck, lint, build, test suite)
9. Run a validation audit
10. Generate a run report with cost breakdown

## Usage

```
npx ts-node tools/run-pipeline.ts [options] "<idea>"
```

### Parameters

| Parameter | Description | Default |
|---|---|---|
| `"<idea>"` | Your app idea as a quoted string (positional arg) | *required for new runs* |
| `--idea-file <path>` | Path to a Markdown/text file containing the app idea | — |
| `--repo-name <name>` | Explicit GitHub repo name | Slugified from the idea |
| `--owner <github-user>` | GitHub owner (user or org) for the new repo | Auto-detected from `gh auth` |
| `--template <owner/repo>` | GitHub template repo to scaffold from | `jamesjlundin/full-stack-web-and-mobile-template` |
| `--visibility <public\|private>` | Visibility of the created GitHub repo | `public` |
| `--engine <claude\|codex>` | Which AI coding agent CLI to use | `claude` |
| `--timeout <minutes>` | Timeout per phase in minutes | No timeout |
| `--budget <dollars>` | Maximum total spend across all phases | No limit |
| `--interactive` | Pause for approval at key phases (3, 3.5, 6) | Enabled by default |
| `--auto` | Skip all approval gates and run fully unattended | — |
| `--dry-run` | Assemble prompts and log diagnostics without calling agents | — |
| `--resume <run-dir>` | Resume an existing run from where it left off | — |
| `--from-phase <n>` | Start or resume from a specific phase number | Next incomplete phase |
| `--help` | Show help message | — |

### Examples

**Basic — start a new project from an idea:**

```bash
npx ts-node tools/run-pipeline.ts "A recipe sharing platform with meal planning"
```

**Load the idea from a Markdown file:**

```bash
npx ts-node tools/run-pipeline.ts --idea-file ideas/orphan-team-app.md
```

**Specify a repo name instead of auto-generating one:**

```bash
npx ts-node tools/run-pipeline.ts --repo-name meal-planner "A recipe sharing platform with meal planning"
```

**Create the repo under an organization:**

```bash
npx ts-node tools/run-pipeline.ts --owner my-org "A recipe sharing platform with meal planning"
```

**Use a different template repo:**

```bash
npx ts-node tools/run-pipeline.ts --template my-org/my-custom-template "A recipe sharing platform"
```

**Create a private repo:**

```bash
npx ts-node tools/run-pipeline.ts --visibility private "An internal HR dashboard"
```

**Use OpenAI Codex instead of Claude:**

```bash
npx ts-node tools/run-pipeline.ts --engine codex "A recipe sharing platform with meal planning"
```

**Set a 15-minute timeout per phase:**

```bash
npx ts-node tools/run-pipeline.ts --timeout 15 "A recipe sharing platform with meal planning"
```

**Resume a run that was interrupted:**

```bash
npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_a-recipe-sharing-platform
```

**Resume from a specific phase (e.g., re-run the tech spec):**

```bash
npx ts-node tools/run-pipeline.ts --resume runs/2026-02-07_a-recipe-sharing-platform --from-phase 5
```

**Set a $10 budget cap across all phases:**

```bash
npx ts-node tools/run-pipeline.ts --budget 10 "A recipe sharing platform with meal planning"
```

**Run fully unattended (no approval pauses):**

```bash
npx ts-node tools/run-pipeline.ts --auto "A recipe sharing platform with meal planning"
```

**Full automation + private repo (no human intervention):**

```bash
npx ts-node tools/run-pipeline.ts \
  --visibility private \
  --auto \
  --engine codex \
  --budget 25 \
  "An internal operations dashboard for support teams"
```

**Opposite mode: fully interactive + public repo (approval at each gate):**

```bash
npx ts-node tools/run-pipeline.ts \
  --visibility public \
  --interactive \
  --engine claude \
  "A community events mobile and web app"
```

**Dry run — assemble all prompts without calling agents:**

```bash
npx ts-node tools/run-pipeline.ts --dry-run "A recipe sharing platform with meal planning"
```

**Combine multiple options:**

```bash
npx ts-node tools/run-pipeline.ts \
  --repo-name meal-planner \
  --visibility private \
  --engine codex \
  --timeout 20 \
  --budget 25 \
  "A recipe sharing platform with meal planning"
```

## How It Works

The pipeline runs through 12 phases sequentially. Each phase produces a Markdown artifact that feeds into subsequent phases.

### Pipeline Phases

| Phase | Name | What Happens |
|---|---|---|
| 0 | Idea Intake | Structures the raw idea into a formal intake document |
| 1 | Problem Framing | Deep analysis of the problem space, user personas, and competitive landscape |
| 2 | Workflows | User flows, screen inventory, interaction patterns, and information architecture |
| 2.5 | Design & Theme | Defines visual direction, color/typography systems, and implementable theme tokens |
| 3 | PRD | Full product requirements document with user stories and acceptance criteria |
| 3.5 | Repo Bootstrap | Creates a GitHub repo from the template, clones it, and captures a baseline snapshot |
| 4 | Feasibility Review | AI explores the repo and assesses what the template provides vs. what must be built |
| 5 | Tech Spec | Detailed technical design referencing actual files and patterns in the repo |
| 6 | Task Breakdown | Ordered implementation tasks with file targets, acceptance criteria, and dependencies |
| 7 | Implementation | AI implements each task directly in the repo, committing after each task |
| 7.5 | Test & Verify | Installs dependencies, runs typecheck/lint/build/tests, and auto-attempts repair if checks fail |
| 8 | Audit | Validates the implementation against the PRD, tech spec, and quality standards |

**Phases 0-3 (including phase 2.5)** are artifact generation phases — the AI runs with read-only permissions and produces the next artifact from prior outputs (with web research enabled for grounding).

**Phase 3.5** is deterministic — it uses `gh` to create the repo and captures the file tree and config files.

**Phases 4-6, 8** run the AI *inside the cloned repo* with read-only tools (`Read`, `Glob`, `Grep`). Phases 4 and 5 also get web search to research libraries, APIs, and domain knowledge. The AI explores the codebase firsthand rather than working from an inlined snapshot.

**Phase 7** runs the AI *inside the cloned repo* with full tools (`Edit`, `Write`, `Bash`, `Read`, `Glob`, `Grep`) to implement each task from the breakdown. Each task is committed to git individually. If the run is interrupted, it resumes from the last completed task.

**Phase 7.5** is deterministic with bounded repair attempts — it runs dependency install + typecheck/lint/build/tests, writes a verification artifact, and if checks fail it runs up to two AI repair passes that re-test automatically before failing.

### Interactive Mode

By default, the pipeline runs in **interactive mode** and pauses for your approval at three gates:

- **Phase 3 (PRD)** — Review the product requirements before creating the repo
- **Phase 3.5 (Repo Bootstrap)** — Confirm the repo name and settings before creation
- **Phase 6 (Task Breakdown)** — Review the implementation plan before coding begins

At each gate, you can approve, skip, or abort the run. Use `--auto` to bypass all gates for fully unattended runs.

## Directory Structure

```
new-application-pipeline/
  prompts/                          # Prompt templates for each phase
    00_idea_intake.md
    01_problem_framing.md
    02_workflows.md
    02b_design_theme.md
    03_prd.md
    04_feasibility_review.md
    05_tech_spec.md
    06_task_breakdown.md
    07_implementation.md
    08_audit.md
    template_context.md             # Description of what the template repo provides
  tools/
    run-pipeline.ts                 # Main orchestrator
    lib/
      agent.ts                      # AI agent CLI wrapper (Claude + Codex)
      git.ts                        # GitHub repo creation and git operations
      workspace.ts                  # Repo baseline summarization
      validate.ts                   # Config, artifact, and CLI input validation
  Dockerfile                        # Container image for running the pipeline
  .dockerignore                     # Docker build context exclusions
  .env.example                      # Environment variable reference
  runs/                             # Created at runtime, gitignored
    2026-02-07_my-app-slug/
      config.json                   # Run configuration, state, and cost tracking
      artifacts/                    # Generated artifacts (one per phase)
      logs/                         # Pipeline execution logs
      report.md                     # Run report generated at completion
```

The generated application repo is created as a **sibling directory** to this pipeline repo:

```
~/Workspace/
  new-application-pipeline/         # This repo
  my-new-app/                       # Generated app repo (created by the pipeline)
```

## Observability

While each phase runs, the pipeline parses the agent's structured JSON stream (Claude's `stream-json` or Codex's `--json`) and logs:

- **Prompt size** — byte count and approximate token count before each AI call
- **Engine and command** — which CLI and flags are being used
- **Timeout** — the configured timeout (or "none")
- **Heartbeat** — a status line every 30 seconds showing current turn, last tool used, and text output size
- **Stderr streaming** — the AI agent's stderr output (progress, debug info) streams to your console in real time
- **Completion summary** — elapsed time, output size, turn count, cost, and token usage

Example output:

```
============================================================
  Phase 4: Feasibility Review
============================================================

[2026-02-07T10:30:00.000Z] [Feasibility Review] Starting...
[2026-02-07T10:30:00.000Z] [Feasibility Review] Calling claude... (running in /Users/you/Workspace/my-app)
  [agent] Engine: claude | Prompt: 12.3KB (~3,075 tokens)
  [agent] Timeout: none | Cmd: claude -p --output-format stream-json --verbose
  [agent 0m30s] Turn 3/15 | Read(schema.ts) | 0B text output
  [agent 1m0s] Turn 6/15 | Grep(createTable) | 2.1KB text output
  [agent 1m30s] Turn 8/15 | Glob(**/*.ts) | 8.4KB text output
  [agent] Turns: 8 | Cost: $0.0341 | Tokens: 3,420 in / 2,150 out
  [agent] Completed in 1m53s | Output: 14.2KB
[2026-02-07T10:31:53.000Z] [Feasibility Review] Artifact saved: runs/.../artifacts/04_feasibility_review.md
```

## Cost Tracking and Budget

The pipeline tracks AI API costs across every phase. After each phase completes, it logs:

- Per-phase cost and token usage (input/output)
- Cumulative cost across the run so far

Use `--budget <dollars>` to set a hard spending limit. If the cumulative cost exceeds your budget after any phase, the pipeline stops and saves its state so you can resume later.

Cost data is persisted in `config.json` under `total_cost_usd` and `phase_costs`, so resumed runs continue tracking from where they left off.

## Retry Logic

If an agent call fails due to a transient error (network issues, API timeouts, rate limits), the pipeline automatically retries with exponential backoff:

- **Attempt 1**: Wait 30 seconds, then retry
- **Attempt 2**: Wait 60 seconds, then retry
- **Attempt 3**: Wait 120 seconds, then retry

After 3 failed retries, the pipeline stops with an error. Permanent errors (invalid config, missing files) are not retried.

## Artifact Validation

After each phase produces an artifact, the pipeline validates it before proceeding:

- **Size checks** — Flags artifacts that are suspiciously small (possible error message) or excessively large (may cause context window issues)
- **Required sections** — Verifies expected headings are present (e.g., PRD must contain "User Stories", "Functional Requirements")
- **Meta-commentary detection** — Checks for leaked AI preamble like "Sure, here is..." or "Let me know if..."
- **Artifact cleaning** — Strips preamble text before the first heading and trailing AI commentary

Validation warnings are logged but don't halt the pipeline, so you can review them in the run logs.

## Docker

A Dockerfile is provided for containerized runs:

```bash
docker build -t new-application-pipeline .

docker run --rm \
  -e ANTHROPIC_API_KEY=your-key \
  -e GH_TOKEN=your-github-token \
  -v $(pwd)/runs:/app/runs \
  new-application-pipeline \
  "A task management app for remote teams"
```

See `.env.example` for the full list of environment variables.

## Security

The pipeline includes several security hardening measures:

- **Command injection prevention** — All shell commands use `execFileSync` with argument arrays instead of string interpolation
- **Secure temp files** — Prompt and wrapper files are written to random-named temp directories with `0o600` permissions and cleaned up after use
- **CLI input validation** — Repo names, owners, and template repos are validated against safe-character patterns before use
- **Artifact boundary markers** — Injected artifacts are wrapped in `<artifact phase="N">` tags to prevent prompt confusion across phase boundaries
- **Context window estimation** — Warns when assembled prompts approach 80K tokens to prevent silent truncation
- **Tiered agent permissions** — Analysis phases get read-only tools; only implementation (Phase 7) gets write access

## Customization

### Using a different template

The pipeline is designed around the `jamesjlundin/full-stack-web-and-mobile-template` but works with any GitHub template repo. If you use a different template, update `prompts/template_context.md` to describe what your template provides so the AI knows what already exists and doesn't duplicate work.

### Modifying prompts

All prompt templates live in `prompts/`. Each uses `{{PLACEHOLDER}}` syntax for variable injection. You can edit these to change the AI's behavior, add sections, or adjust the level of detail.

Available placeholders:

| Placeholder | Content |
|---|---|
| `{{IDEA}}` | The raw idea text |
| `{{TEMPLATE_CONTEXT}}` | Contents of `prompts/template_context.md` |
| `{{ARTIFACT_00}}`, `{{ARTIFACT_01}}`, `{{ARTIFACT_02}}`, `{{ARTIFACT_025}}`, `{{ARTIFACT_03}}` through `{{ARTIFACT_06}}` | Output from the corresponding phase |
| `{{ARTIFACT_03B}}` | Repo baseline snapshot from phase 3.5 |
| `{{ARTIFACT_07B}}` | Test and verification results from phase 7.5 |
| `{{GIT_DIFF}}` | Git diff stats from the workspace |
| `{{TEST_RESULTS}}` | Test execution results |
| `{{TASK}}` | Individual task content (phase 7 only) |

## License

MIT
