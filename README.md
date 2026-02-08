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
3. Create a new GitHub repo from the template and clone it as a sibling directory
4. Generate technical artifacts (feasibility review, tech spec, task breakdown) with the AI exploring the actual repo
5. Implement each task directly in the repo
6. Run a validation audit

## Usage

```
npx ts-node tools/run-pipeline.ts [options] "<idea>"
```

### Parameters

| Parameter | Description | Default |
|---|---|---|
| `"<idea>"` | Your app idea as a quoted string (positional arg) | *required for new runs* |
| `--repo-name <name>` | Explicit GitHub repo name | Slugified from the idea |
| `--owner <github-user>` | GitHub owner (user or org) for the new repo | Auto-detected from `gh auth` |
| `--template <owner/repo>` | GitHub template repo to scaffold from | `jamesjlundin/full-stack-web-and-mobile-template` |
| `--visibility <public\|private>` | Visibility of the created GitHub repo | `public` |
| `--engine <claude\|codex>` | Which AI coding agent CLI to use | `claude` |
| `--timeout <minutes>` | Timeout per phase in minutes | No timeout |
| `--resume <run-dir>` | Resume an existing run from where it left off | — |
| `--from-phase <n>` | Start or resume from a specific phase number | Next incomplete phase |
| `--help` | Show help message | — |

### Examples

**Basic — start a new project from an idea:**

```bash
npx ts-node tools/run-pipeline.ts "A recipe sharing platform with meal planning"
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

**Combine multiple options:**

```bash
npx ts-node tools/run-pipeline.ts \
  --repo-name meal-planner \
  --visibility private \
  --engine codex \
  --timeout 20 \
  "A recipe sharing platform with meal planning"
```

## How It Works

The pipeline runs through 9 phases sequentially. Each phase produces a Markdown artifact that feeds into subsequent phases.

### Pipeline Phases

| Phase | Name | What Happens |
|---|---|---|
| 0 | Idea Intake | Structures the raw idea into a formal intake document |
| 1 | Problem Framing | Deep analysis of the problem space, user personas, and competitive landscape |
| 2 | Workflows | User flows, screen inventory, interaction patterns, and information architecture |
| 3 | PRD | Full product requirements document with user stories and acceptance criteria |
| 3.5 | Repo Bootstrap | Creates a GitHub repo from the template, clones it, and captures a baseline snapshot |
| 4 | Feasibility Review | AI explores the repo and assesses what the template provides vs. what must be built |
| 5 | Tech Spec | Detailed technical design referencing actual files and patterns in the repo |
| 6 | Task Breakdown | Ordered implementation tasks with file targets, acceptance criteria, and dependencies |
| 7 | Implementation | AI implements each task directly in the repo with full edit access |
| 8 | Audit | Validates the implementation against the PRD, tech spec, and quality standards |

**Phases 0-3** are pure text generation — the AI receives previous artifacts and produces the next one.

**Phase 3.5** is deterministic — it uses `gh` to create the repo and captures the file tree and config files.

**Phases 4-6, 8** run the AI *inside the cloned repo* with read-only tools (`Read`, `Glob`, `Grep`). The AI explores the codebase firsthand rather than working from an inlined snapshot.

**Phase 7** runs the AI *inside the cloned repo* with full tools (`Edit`, `Write`, `Bash`, `Read`, `Glob`, `Grep`) to implement each task from the breakdown.

## Directory Structure

```
new-application-pipeline/
  prompts/                          # Prompt templates for each phase
    00_idea_intake.md
    01_problem_framing.md
    02_workflows.md
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
      claude.ts                     # AI agent CLI wrapper (Claude + Codex)
      git.ts                        # GitHub repo creation and git operations
      workspace.ts                  # Repo baseline summarization
      validate.ts                   # Config and artifact validation
  runs/                             # Created at runtime, gitignored
    2026-02-07_my-app-slug/
      config.json                   # Run configuration and state
      artifacts/                    # Generated artifacts (one per phase)
      logs/                         # Pipeline execution logs
```

The generated application repo is created as a **sibling directory** to this pipeline repo:

```
~/Workspace/
  new-application-pipeline/         # This repo
  my-new-app/                       # Generated app repo (created by the pipeline)
```

## Observability

While each phase runs, the pipeline logs:

- **Prompt size** — byte count and approximate token count before each AI call
- **Engine and command** — which CLI and flags are being used
- **Timeout** — the configured timeout (or "none")
- **Heartbeat** — a status line every 30 seconds showing elapsed time and output size
- **Stderr streaming** — the AI agent's stderr output (progress, debug info) streams to your console in real time
- **Completion summary** — elapsed time and output size when the phase finishes

Example output:

```
============================================================
  Phase 4: Feasibility Review
============================================================

[2026-02-07T10:30:00.000Z] [Feasibility Review] Starting...
[2026-02-07T10:30:00.000Z] [Feasibility Review] Calling claude... (running in /Users/you/Workspace/my-app)
  [agent] Engine: claude | Prompt: 12.3KB (~3,075 tokens)
  [agent] Timeout: none | Cmd: claude -p --output-format text --verbose
  [agent 0m30s] Still running... (2.1KB output so far)
  [agent 1m0s] Still running... (8.4KB output so far)
  [agent] Completed in 1m23s | Output: 14.2KB
[2026-02-07T10:31:23.000Z] [Feasibility Review] Artifact saved: runs/.../artifacts/04_feasibility_review.md
```

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
| `{{ARTIFACT_00}}` through `{{ARTIFACT_06}}` | Output from the corresponding phase |
| `{{ARTIFACT_03B}}` | Repo baseline snapshot from phase 3.5 |
| `{{GIT_DIFF}}` | Git diff stats from the workspace |
| `{{TEST_RESULTS}}` | Test execution results |
| `{{TASK}}` | Individual task content (phase 7 only) |

## License

MIT
