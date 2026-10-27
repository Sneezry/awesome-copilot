// prompts.mjs — Maps each cockpit button action to a crafted agent instruction.
// Pure (no I/O, no session) so it can be unit-tested in isolation.

import { PREDEFINED_TASKS } from "./catalog.mjs";

export const APPMOD_PREAMBLE =
    "You are running the GitHub Copilot App Modernization for Java workflow. " +
    "Use Assessment in user-facing chat, document headings and summaries; reserve internal product/tool names for tool calls and unedited third-party logs. " +
    "Keep plan.md and progress.md up to date as a checklist (use - [ ] / - [x]) and, when the work is complete, write summary.md. " +
    "Start each of these files (plan.md, progress.md, summary.md) with the exact line <!-- appmod-cockpit --> as the very first line so the cockpit recognizes them as modernization artifacts.";

const FINDING_STEP_MARKERS =
    "Put a distinct, stable <!-- appmod-step:<16-32 lowercase hex> --> on every checklist item in plan.md and progress.md. " +
    "Use the same step ID in both files and preserve it when editing or checking off a step. " +
    "For a step addressing a verified finding, add <!-- appmod-finding:<encoded finding.id> --> on the same checklist item in both files, " +
    "one marker per associated finding. Copy the exact id from .appmod/assessment.json and encode it with encodeURIComponent " +
    "(for example, service:removed-api/1 becomes service%3Aremoved-api%2F1). Do not invent finding IDs or link unrelated validation steps. " +
    "When a verified finding's step uses a predefined task, add <!-- appmod-task:<task.id> --> to that item in both files; " +
    "use only these task IDs: " + PREDEFINED_TASKS.map((task) => task.id + " (" + task.name + ")").join(", ") + ". " +
    "When a step uses an existing repository skill under .github/skills/<folder>/SKILL.md, add " +
    "<!-- appmod-skill:<encoded folder> --> to that item in both files, encoding the exact folder with encodeURIComponent. " +
    "Only link relevant tasks or existing skills, and keep these markers when renaming steps. ";

export const ACTION_LABELS = {
    start_assessment: "Assessment",
    generate_plan: "Generate plan",
    run_task: "Run task",
    run_skill: "Run skill",
    run_cve: "CVE scan",
    generate_tests: "Generate tests",
    run_build_tests: "Build & tests",
    run_consistency: "Consistency check",
    run_completeness: "Completeness check",
    create_skill: "Create skill",
    open_pr: "Open PR",
    fix_finding: "Resolve finding",
    explain_finding: "Explain finding",
    work_step: "Work on step",
    fix_env: "Environment setup",
};

/**
 * Build the agent prompt for a cockpit action.
 * @returns {string|null} prompt text, or null for unknown actions / unknown task ids.
 */
export function buildPrompt(kind, payload, repoPath) {
    const p = payload || {};
    switch (kind) {
        case "start_assessment":
            return (
                APPMOD_PREAMBLE +
                "\n\nRun an App Modernization assessment of this Java project at " + repoPath + ". " +
                "Assess module " + (p.module || ".") + " (relative to the repo root), targeting Java " + (p.targetJava || 21) +
                " on " + (p.cloud || "Azure") + ". Do not silently substitute another target or assess unrelated modules. " +
                (p.id ? "Use assessment request ID " + p.id + ". Write <!-- appmod-assessment-id:" + p.id +
                    " --> as the second line of plan.md and progress.md. " : "") +
                "Report the current Java runtime, build tool, framework versions, outdated/vulnerable dependencies, " +
                "and cloud-readiness issues for Azure. Summarize findings and write a prioritized plan.md with a matching progress.md checklist of remediation steps. " +
                FINDING_STEP_MARKERS + "Do not change code yet." +
                "\n\nAlso write the findings as structured JSON to .appmod/assessment.json so the cockpit can render them. Use this shape:\n" +
                "{\n" +
                '  "assessmentId": ' + JSON.stringify(p.id || "") + ',\n' +
                '  "assessmentConfig": ' + JSON.stringify({ module: p.module || ".", targetJava: p.targetJava || 21, cloud: p.cloud || "Azure" }) + ',\n' +
                '  "generatedAt": "<ISO 8601 timestamp>",\n' +
                '  "headline": "<one-line stack summary>",\n' +
                '  "summary": "<2-3 sentence plain-language verdict>",\n' +
                '  "stack": { "buildTool": "", "java": "", "framework": "", "database": "", "container": "" },\n' +
                '  "findings": [\n' +
                '    { "id": "kebab-id", "severity": "P0|P1|P2|P3", "title": "", "detail": "", "impact": "", "recommendation": "", "files": ["path"],\n' +
                '      "evidence": [{ "file": "path", "line": 1, "detail": "verified observation" }],\n' +
                '      "action": { "kind": "run_task|generate_plan|run_cve|generate_tests|fix_finding", "payload": {}, "label": "" } }\n' +
                "  ],\n" +
                '  "strengths": ["<things already done well>"]\n' +
                "}\n" +
                "Order findings by severity (P0 first). Include only verified evidence and real file locations; omit fields you cannot substantiate. For action.kind, use run_task with payload {\"taskId\":\"...\"} when a Microsoft predefined task fits, " +
                "generate_plan/run_cve/generate_tests when those fit, otherwise use fix_finding (the cockpit turns it into a 'Help me fix this' button). Omit action only if there is genuinely nothing to do."
            );
        case "generate_plan":
            return (
                APPMOD_PREAMBLE +
                "\n\nCreate a step-by-step modernization plan to upgrade this project to Java " + (p.targetJava || 21) + ". " +
                (p.id ? "Use assessment request ID " + p.id + " for module " + (p.module || ".") + " on " + (p.cloud || "Azure") +
                    ". Add <!-- appmod-assessment-id:" + p.id + " --> as the second line of plan.md and progress.md. " : "") +
                "Cover build-file changes, removed/replaced APIs, dependency upgrades, and required test updates. " +
                "Read the current .appmod/assessment.json for finding IDs. Write the plan as a checklist in plan.md and create a pending progress.md mirroring those steps. " +
                FINDING_STEP_MARKERS + "Do not change code yet."
            );
        case "run_task": {
            const t = PREDEFINED_TASKS.find((x) => x.id === p.taskId);
            if (!t) return null;
            return (
                APPMOD_PREAMBLE +
                "\n\nApply the App Modernization predefined task \"" + t.name + "\": " + t.summary + "\n" +
                "Steps: (1) record the plan in plan.md and progress.md; (2) check out a migration branch; " +
                "(3) make the code changes for this task; (4) validate by building, running unit tests, and a CVE check; " +
                "(5) write a summary.md of what changed. Pause for my confirmation before committing."
            );
        }
        case "run_skill":
            if (!p.folder) return null;
            return (
                APPMOD_PREAMBLE +
                "\n\nRun the custom modernization skill in .github/skills/" + p.folder + "/SKILL.md. " +
                "Follow its instructions and referenced resources exactly, updating plan.md and progress.md as you go, " +
                "and write summary.md when finished."
            );
        case "run_cve":
            return "Check this Java project for known CVE issues using #appmod-validate-cves-for-java and report which dependencies need upgrading, then update progress.md.";
        case "generate_tests":
            return "Generate unit tests for this Java project using #appmod-generate-tests-for-java, then run them and record the result in progress.md.";
        case "run_build_tests":
            return "Build this project and run its unit tests. Report failures with root-cause analysis and update the Build and Unit Tests entries in progress.md.";
        case "run_consistency":
            return "Run a consistency check comparing the modernized code against the original behavior (APIs, SQL, wire format). List any behavioral differences and update progress.md.";
        case "run_completeness":
            return "Run a completeness check: verify every step in plan.md has been implemented. List anything missing and update progress.md.";
        case "create_skill":
            return (
                "Help me create a custom App Modernization skill. Create .github/skills/<skill-name>/SKILL.md with Skill Name, " +
                "Description, and Content sections following the Agent Skills specification, plus any resource files it references. Ask me what migration this skill should capture."
            );
        case "open_pr":
            return "Summarize the modernization changes on the current branch and open a pull request with a clear title and a body that lists the plan steps completed and validation results.";
        case "work_step": {
            const title = (p.title || "").trim();
            if (!title) return null;
            const phase = p.section ? " (phase: " + p.section + ")" : "";
            return (
                APPMOD_PREAMBLE +
                "\n\nWork on this single step from the modernization checklist" + phase + ":\n\"" + title + "\"\n\n" +
                "Do just this step: tell me what you'll change, make the code/config changes, then check it off in progress.md " +
                "(change its - [ ] to - [x]) and add a one-line note of what changed. If the step needs a decision from me or is " +
                "ambiguous, ask before proceeding. Pause for my confirmation before committing."
            );
        }
        case "auto_step": {
            const title = (p.title || "").trim();
            if (!title) return null;
            const phase = p.section ? " (phase: " + p.section + ")" : "";
            return (
                APPMOD_PREAMBLE +
                "\n\nYou are running in AUTOPILOT, working the modernization checklist on your own. " +
                "Do exactly ONE step now" + phase + ":\n\"" + title + "\"\n\n" +
                "For this single step: briefly state what you will change, make the necessary code/config changes, " +
                "then check it off in progress.md (change its - [ ] to - [x]) and add a one-line note of what changed. " +
                "Do NOT commit, and do NOT start any other step. " +
                "If this step genuinely needs a decision from me, or is blocked or ambiguous, do NOT guess: leave it unchecked, " +
                "add a short note in progress.md describing exactly what you need, and stop so I can take over."
            );
        }
        case "fix_finding": {
            const title = (p.title || "").trim();
            if (!title) return null;
            const detail = (p.detail || "").trim();
            const files = Array.isArray(p.files) && p.files.length ? "\nAffected files: " + p.files.join(", ") + "." : "";
            const impact = p.impact ? "\nImpact: " + p.impact : "";
            const recommendation = p.recommendation ? "\nSuggested action: " + p.recommendation : "";
            const evidence = Array.isArray(p.evidence) && p.evidence.length ? "\nEvidence:\n" + p.evidence.map((item) =>
                "- " + (item.file || "") + (item.line ? ":" + item.line : "") + " " + (item.detail || "")
            ).join("\n") : "";
            const step = p.stepTitle ? "\nApproved plan step: " + p.stepTitle + (p.section ? " (" + p.section + ")" : "") + "." : "";
            const sev = p.severity ? " (" + p.severity + ")" : "";
            return (
                APPMOD_PREAMBLE +
                "\n\nHelp me resolve this App Modernization assessment finding" + sev + ":\n" +
                title + (detail ? " — " + detail : "") + "." + files + impact + recommendation + evidence + step +
                "\n\nExplain the fix, work only on the approved plan step, and update its matching checklist item in progress.md. " +
                "Pause for my confirmation before committing."
            );
        }
        case "explain_finding": {
            const title = (p.title || "").trim();
            if (!title) return null;
            return "Explain this assessment finding and its impact in plain language: " + title +
                (p.detail ? "\nAssessment detail: " + p.detail : "") +
                (p.impact ? "\nImpact: " + p.impact : "") +
                (p.recommendation ? "\nSuggested action: " + p.recommendation : "") +
                (p.files?.length ? "\nAffected files: " + p.files.join(", ") : "") +
                "\nDescribe reasonable options, tradeoffs, and what decision is needed from me. Do not edit any files or invoke code-changing tools.";
        }
        case "fix_env": {
            const tool = (p.tool || "").trim();
            if (!tool) return null;
            const detail = p.detail ? "\nWhat the readiness check found: " + p.detail + "." : "";
            const fix = p.fix ? "\nSuggested fix: " + p.fix : "";
            return (
                "I'm preparing my local environment for the GitHub Copilot App Modernization for Java workflow.\n" +
                "The readiness check flagged a missing or misconfigured tool: " + tool + "." + detail + fix +
                "\n\nCheck for a usable existing installation or project wrapper first. Determine the OS, required version, and safest setup method. " +
                "Explain the exact changes and ask for my explicit approval before any installation, PATH change, or shell configuration edit. " +
                "After approval, use available tools to install or configure " + tool + " yourself, then verify its version and PATH against this project's requirements. " +
                "If execution is unavailable, explain why and give manual steps; do not claim the setup is done. " +
                "Re-check readiness afterward. This is environment setup only — do not modify my application code."
            );
        }
        default:
            return null;
    }
}
