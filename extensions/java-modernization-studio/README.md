# Java Modernization Studio

An interactive GitHub Copilot **canvas** that turns the [GitHub Copilot App Modernization for Java](https://learn.microsoft.com/en-us/azure/developer/java/migration/migrate-github-copilot-app-modernization-for-java) CLI workflow into a visible, steerable dashboard — assess a legacy Java app, review and approve a remediation plan, work on assessed findings, and run validation gates, all grounded in the repo's real artifacts.

The Copilot App Modernization for Java tooling stays the engine. This canvas is the cockpit on top of it: it reads what the workflow produces and turns each step into an agent-driving button.

## What it does

- **Workflow status** — phase, remaining steps, next action, progress bar, and agent activity appear above the tabs across views; reopening the canvas re-reads the saved progress. Expandable summary and execution history remain accessible.
- **Readiness** — checks required JDK/build tools and optional tools before execution; access it from the global controls.
- **Assess** — configures scope and target Java, then shows severity-ordered findings with evidence and linked actions.
- **Plan** — reviews and approves `plan.md`, follows `progress.md`, and offers predefined tasks or repository Skills only for mapped, approved findings. Older plans without an assessment ID can be reviewed and linked to the current verified assessment without losing completed progress; they still require separate approval.
- **Validate** — runs build, unit tests, CVE, consistency, and completeness checks. An unchecked completeness step with recorded notes shows **Needs follow-up** and its outstanding work; the gate tracks completion, not whether the check has run.
- **Autopilot** — optionally runs approved steps in order, with Stop always available while it is running.

Buttons dispatch grounded prompts to your Copilot agent; the canvas reflects the resulting artifacts. Code-changing actions require a current, approved plan and a matching assessed finding.

**Known host limitation:** The current GitHub Copilot app may show the full agent prompt in chat even when this extension supplies a shorter `displayPrompt`. Do not put secrets in assessment requests; a short message in the canvas does not imply the detailed prompt is hidden from the chat timeline.

## Prerequisites

- **GitHub Copilot app** (the canvas host).
- **Modernize CLI** (`modernize assess`) for assessments. Configure any App Modernization MCP tools needed for validation separately in the active agent session; installing this canvas does not install the CLI or register the MCP server. Readiness checks do not verify either one's availability.
- **JDK 17+** and the project's build tool (**Maven**, **Gradle**, or **Ant**; Maven/Gradle wrappers are supported) for the Java project you're modernizing.
- *Optional:* **Azure CLI** (`az`) for cloud-readiness and Azure migration tasks; **Docker** for container checks.

## Install

This is an in-repo canvas extension. Copy the `java-modernization-studio/` folder into one of:

- `~/.copilot/extensions/` — **user scope** (just you), or
- `.github/extensions/` — **project scope** (shared with your repo's team).

Then reload extensions (or restart the app) so Copilot discovers it. No build step is required — the Copilot CLI resolves `@github/copilot-sdk` automatically.

## Usage

With the extension installed and an active Java repository, start with a natural request:

```text
Modernize my Java application.
```

The extension uses the session's current working directory to open Readiness for a detected Java project. If the repository is not identifiable, select one before proceeding; it will not silently choose another project. You can also open a specific repository explicitly:

```text
Open the Java Modernization Studio canvas for /path/to/my-java-app and run a readiness check.
```

The canvas resolves the target repo from its `repoPath` input, falling back to the session's current working directory (not its session-artifact directory). Natural-language routing requires prompt hooks and canvas rendering; if only intent routing is unavailable, you can still open the canvas explicitly in a canvas-capable host. From there:

Progress is stored in the repository's `progress.md` (or `.appmod/progress.md` when present), not in a canvas panel. If the app shows a stale panel after a restart, reopen the canvas for the same `repoPath` and select **Refresh**; automatic panel reconnection is not yet verified.

1. **Readiness first** — resolve required tool blockers and re-check the environment.
2. **Assess** — select the module and Java target, then generate `.appmod/assessment.json`.
3. **Plan** — generate `plan.md` / `progress.md`, review the steps, and approve the current revision.
4. **Remediate** — work on approved steps linked to assessed findings, one at a time or in a confirmed batch.
5. **Validate and hand off** — run the quality gates, review `summary.md`, and open a PR when ready.

### CLI-backed assessment settings

Assess writes the selected module, Java 17/21 target, Azure target, and request ID to `.appmod/assessment-config.json`. It also generates a request-specific `.appmod/assessment-cli-<id>.yaml` for `modernize assess --assess-config`. This **CLI YAML is nested**: Java options (`assessmentDomains`, `targetRuntime`, `targetComputeServices`, `targetOS`) go under `java:`, while CVE options go under `security:`. The Azure selection requests assessments for App Service, AKS, and Container Apps on Linux and Windows; the generated settings request Java upgrade, cloud readiness, and security domains with issue-only analysis and a direct-dependency, high-severity CVE scan. Do not substitute a flat plugin config or a legacy project YAML for this file.

The agent is instructed to assess a clean copy of the selected source/module to exclude old generated reports, and store the native CLI output under `.appmod/native-assessment/<id>/`. The unmodified native `report.json` must also be copied to the root of that directory. The canvas checks its completed status, start time relative to the request, Java runtime, domains, Azure services, operating systems, scan mode, and CVE threshold before a matching `.appmod/assessment.json` can be treated as **current** or its plan approved. The native report does **not** independently confirm the requested `cveScanScope: direct`; verify each CVE against resolved dependency versions and applicability. Missing or mismatched native evidence leaves the report unverified; re-run Assess rather than approving a plan based only on a matching request ID.

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

- Structured findings come from `.appmod/assessment.json`. Completed native reports in `.github/modernize/assessment/report.json` or `.github/modernize/reports/report-*/report.json` are displayed read-only; they do not authorize plan execution.
- A native report without assessment settings linked to this canvas can be reviewed, but the next step is a scoped assessment before generating or approving a plan.
- Plan/progress/summary prefer `.appmod/` files, then trusted root files; marked `.github/modernize/` files are a fallback for native workflow output.
- To avoid mistaking an unrelated repo's `plan.md` for modernization output, root markdown is trusted **only** when `.appmod/` exists **or** the file's first line is the provenance marker `<!-- appmod-cockpit -->`.
- Stack detection reads `pom.xml` / Gradle / Dockerfile for context; it does not, by itself, authorize task execution. Finding IDs link to approved plan steps via the checklist markers above. Task and Skill actions require explicit markers on those steps, not matching titles. Existing plans can add links in the plan editor; saving a changed plan requires a fresh approval.

## Agent-callable actions

| Action | Description |
|---|---|
| `get_state` | Return the current modernization snapshot, including cached environment readiness, from the open canvas. |
| `refresh` | Re-scan the repo, re-check environment readiness and push the fresh snapshot to the open canvas. |

## Development

The grounding/parsing logic is pure and unit-tested independently of the canvas runtime:

```bash
node --test test/cockpit.test.mjs
```

## License

MIT
