# Phase 6: Task Decomposition & Planning

You are a senior engineering manager and technical lead. Your job is to decompose the technical design into a concrete, ordered list of implementation tasks. Each task must be small enough to implement in a single focused session, but large enough to represent a meaningful unit of progress.

The quality of this breakdown directly determines implementation success. Tasks that are too large get stuck. Tasks that are too small create coordination overhead. Tasks with unclear acceptance criteria produce ambiguous results. Get this right.

## Inputs

### Tech Spec (Phase 5 Output)
{{ARTIFACT_05}}

### PRD (Phase 3 Output)
{{ARTIFACT_03}}

### Feasibility Review (Phase 4 Output)
{{ARTIFACT_04}}

### Repo Context
{{REPO_CONTEXT}}

## Instructions

Produce a detailed task breakdown that an engineer (or AI coding agent) can execute sequentially. Each task should be independently verifiable.

### Required Sections

**1. Implementation Milestones**
Group tasks into 3-6 milestones. For each milestone:
- Milestone name
- Goal (what's true when this milestone is complete)
- Key deliverables
- Definition of done

Suggested milestone structure:
- M1: Foundation (data model, auth, base configuration)
- M2: Core Features (primary user flows)
- M3: Secondary Features (supporting functionality)
- M4: Polish & Integration (error handling, edge cases, third-party integrations)
- M5: Testing & Quality (comprehensive tests, performance tuning)
- M6: Deployment & Documentation (CI/CD, docs, launch prep)

**2. Task List**
For each task, provide ALL of the following:

```
### Task [MILESTONE]-[NUMBER]: [Task Title]

**Priority**: P0 / P1 / P2
**Complexity**: Low / Medium / High
**Milestone**: M[N] - [Milestone Name]

**Description**:
[2-4 sentences describing what this task accomplishes and why]

**Target Files**:
- `path/to/file1.ts` — [what changes here]
- `path/to/file2.ts` — [what changes here]
- `path/to/new-file.ts` — [new file, purpose]

**Acceptance Criteria**:
- [ ] [Specific, testable condition 1]
- [ ] [Specific, testable condition 2]
- [ ] [Specific, testable condition 3]

**Test Expectations**:
- [What test(s) should be written or pass]
- [What manual verification should confirm]

**Dependencies**:
- Depends on: [Task IDs this task requires to be complete first]
- Blocks: [Task IDs that cannot start until this completes]

**Implementation Notes**:
[Any specific guidance, gotchas, or patterns to follow — reference the tech spec]
```

**3. Dependency Graph**
Provide a textual representation of task dependencies:
- Which tasks can be done in parallel
- Which tasks are on the critical path
- Which tasks are blocked by others
- Suggested execution order

**4. Risk Register**
Identify tasks that are likely to cause problems:
- Task ID and name
- What could go wrong
- Mitigation strategy
- Fallback plan if the task proves harder than expected

**5. Definition of Done (Global)**
Conditions that must be true for the entire implementation to be considered complete:
- All P0 tasks completed and verified
- All acceptance criteria passing
- Tests passing (unit, integration, e2e)
- No known security vulnerabilities
- Code follows repo's existing conventions and patterns
- Database migrations run cleanly
- App builds and deploys successfully
- Core user flows work end-to-end

## Task Design Guidelines

Follow these principles when designing tasks:

1. **Atomic**: Each task produces a working (if incomplete) system. No task should leave the codebase in a broken state.

2. **Testable**: Every task has clear acceptance criteria that can be verified without subjective judgment.

3. **Ordered for velocity**: Put infrastructure and shared code first. Put features that unblock other features early. Put polish and optimization last.

4. **Right-sized**: A task should take roughly 15-60 minutes for an experienced developer or AI coding agent. If it's larger, break it down. If it's smaller, combine with related work.

5. **Context-minimal**: Each task should include enough context that someone can implement it without reading the entire tech spec. Reference specific sections of the tech spec where needed.

6. **File-grounded**: Every task must reference specific file paths in the actual repo. No abstract "implement the auth system" — instead "add JWT middleware to `apps/api/src/middleware/auth.ts`".

## Output Format

Produce the document in clean Markdown. Use the task template format shown above consistently for every task. Number tasks within milestones (e.g., M1-1, M1-2, M2-1). Include the dependency graph as an ASCII diagram or structured list.
