# Java Modernization Studio

An interactive GitHub Copilot **canvas** that turns the [GitHub Copilot App Modernization for Java](https://learn.microsoft.com/en-us/azure/developer/java/migration/migrate-github-copilot-app-modernization-for-java) CLI workflow into a visible, steerable dashboard — assess a legacy Java app, review and approve a remediation plan, work on assessed findings, and run validation gates, all grounded in the repo's real artifacts.

The Copilot App Modernization for Java tooling stays the engine. This canvas is the cockpit on top of it: it reads what the workflow produces and turns each step into an agent-driving button.

## What it does

- **Workflow status** — phase, remaining steps, next action, and expandable summary and execution history stay visible across views.
- **Readiness** — checks required JDK/build tools and optional tools before execution; access it from the global controls.
- **Assess** — configures scope and target Java, then shows severity-ordered findings with evidence and linked actions.
- **Plan** — reviews and approves `plan.md`, follows `progress.md`, and offers predefined tasks or repository Skills only for mapped, approved findings. Older plans without an assessment ID can be reviewed and linked to the current verified assessment without losing completed progress; they still require separate approval.
- **Validate** — runs build, unit tests, CVE, consistency, and completeness checks.
- **Autopilot** — optionally runs approved steps in order, with Stop always available while it is running.

Buttons dispatch grounded prompts to your Copilot agent; the canvas reflects the resulting artifacts. Code-changing actions require a current, approved plan and a matching assessed finding.

## Prerequisites

- **GitHub Copilot app** (the canvas host).
- **GitHub Copilot App Modernization for Java** tooling — the underlying workflow this canvas drives.
- **JDK 17+** and **Maven** (or a `./mvnw` wrapper) for the Java project you're modernizing.
- *Optional:* **Azure CLI** (`az`) for cloud-readiness and Azure migration tasks; **Docker** for container checks.

## Install

This is an in-repo canvas extension. Copy the `java-modernization-studio/` folder into one of:

- `~/.copilot/extensions/` — **user scope** (just you), or
- `.github/extensions/` — **project scope** (shared with your repo's team).

Then reload extensions (or restart the app) so Copilot discovers it. No build step is required — the Copilot CLI resolves `@github/copilot-sdk` automatically.

## Usage

Point the canvas at a Java repository and let the agent drive it:

```text
Open the Java Modernization Studio canvas for /path/to/my-java-app and run a readiness check.
```

The canvas resolves the target repo from its `repoPath` input, falling back to the session's working directory. From there:

1. **Readiness first** — resolve required tool blockers and re-check the environment.
2. **Assess** — select the module and Java target, then generate `.appmod/assessment.json`.
3. **Plan** — generate `plan.md` / `progress.md`, review the steps, and approve the current revision.
4. **Remediate** — work on approved steps linked to assessed findings, one at a time or in a confirmed batch.
5. **Validate and hand off** — run the quality gates, review `summary.md`, and open a PR when ready.

### Suggested agent instructions

```text
When a user modernizes a Java project with the Java Modernization Studio canvas:
1) Open the canvas pointed at the repo (repoPath) and run the Environment Doctor first.
2) Run an assessment for the selected scope and target; write findings with unique IDs to
   .appmod/assessment.json and a prioritized plan.md / progress.md.
   Start plan.md, progress.md, and summary.md with the exact first line <!-- appmod-cockpit --> so the
   canvas recognizes them as modernization artifacts. In both checklists, keep a stable
   <!-- appmod-step:<16-32 lowercase hex> --> per step and, when supported by a finding,
   <!-- appmod-finding:<encodeURIComponent(finding.id)> --> on that step. When a finding step
   uses a predefined task or repository Skill, also keep <!-- appmod-task:<task.id> --> or
   <!-- appmod-skill:<encodeURIComponent(folder)> --> on that step in both files.
3) Have the user review and approve the current plan before changing code. Work only on approved
   steps; run validation before handing off changes.
4) Keep plan.md / progress.md updated as - [ ] / - [x] checklists. Only write summary.md when the
   work is truly complete.
```

## How it stays grounded

The canvas renders **real repo state**, never invented status:

- Structured findings come from `.appmod/assessment.json`.
- Plan/progress/summary prefer `.appmod/` files, then trusted root files; marked `.github/modernize/` files are a fallback for native workflow output.
- To avoid mistaking an unrelated repo's `plan.md` for modernization output, root markdown is trusted **only** when `.appmod/` exists **or** the file's first line is the provenance marker `<!-- appmod-cockpit -->`.
- Stack detection reads `pom.xml` / Gradle / Dockerfile for context; it does not, by itself, authorize task execution. Finding IDs link to approved plan steps via the checklist markers above. Task and Skill actions require explicit markers on those steps, not matching titles. Existing plans can add links in the plan editor; saving a changed plan requires a fresh approval.

## Agent-callable actions

| Action | Description |
|---|---|
| `get_state` | Return the current modernization snapshot scanned from the repo (assessment, plan/progress, gates, tasks). |
| `refresh` | Re-scan the repo and push a fresh snapshot to the open canvas. |

## Development

The grounding/parsing logic is pure and unit-tested independently of the canvas runtime:

```bash
node --test test/cockpit.test.mjs
```

## License

MIT
