// server.mjs — Per-instance loopback HTTP server + action dispatch for the cockpit.
// Decoupled from the SDK: agent messaging is injected as `sendPrompt`, so this
// module can be exercised by tests without a live session.

import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { scanRepo, parseChecklist, withAssessmentId } from "./scan.mjs";
import { renderHtml } from "./renderer.mjs";
import { buildPrompt, ACTION_LABELS } from "./prompts.mjs";
import { PREDEFINED_TASKS } from "./catalog.mjs";
import { runDoctor } from "./doctor.mjs";
import { makeRun, runAutopilot, AUTOPILOT_MAX_STEPS } from "./autopilot.mjs";

const EXECUTION_ACTIONS = new Set([
    "run_task", "run_skill", "run_cve", "generate_tests", "run_build_tests",
    "run_consistency", "run_completeness", "work_step", "auto_step", "fix_finding", "open_pr",
]);
const MUTATING_ACTIONS = new Set([
    "run_task", "run_skill", "generate_tests", "work_step", "auto_step", "fix_finding", "open_pr", "create_skill",
]);
const DISPLAY_PROMPTS = {
    start_assessment: "Assess the selected Java project.",
    generate_plan: "Create the modernization plan.",
    run_task: "Run the selected modernization task.",
    run_skill: "Run the selected modernization skill.",
    run_cve: "Scan for dependency vulnerabilities.",
    generate_tests: "Generate unit tests for the Java project.",
    run_build_tests: "Build the Java project and run its tests.",
    run_consistency: "Check that modernization preserved behavior.",
    run_completeness: "Review the modernization plan for missing work.",
    create_skill: "Create a reusable modernization skill.",
    open_pr: "Prepare the modernization pull request.",
    fix_finding: "Resolve the selected assessment finding.",
    explain_finding: "Explain the selected assessment finding and options.",
    work_step: "Work on the selected modernization plan step.",
    auto_step: "Work on the next modernization plan step.",
    fix_env: "Check the development tool setup.",
};
const activeAssessmentRepos = new Set();
const activePlanWrites = new Set();

function insideRepo(root, file) {
    const path = relative(root, file);
    return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function actionMatchesPlan(kind, payload, state) {
    const progress = state.progress?.steps || [];
    const available = state.plan.steps.filter((step) => {
        const linked = progress.find((item) => step.id && item.id === step.id) ||
            progress.find((item) => item.title === step.title && (item.section || "") === (step.section || ""));
        return (linked?.status || step.status) !== "done";
    });
    const mapped = (step) => step.id && state.reportStatus === "ready" && state.report?.findings.some((finding) =>
        finding.planSteps?.some((item) => item.id === step.id && item.status !== "done"));
    const input = payload || {};
    if (kind === "work_step" || kind === "auto_step") {
        return available.some((step) => step.title === input.title && (step.section || "") === (input.section || ""));
    }
    if (kind === "fix_finding") return !!state.report?.findings.some((finding) =>
        finding.id === input.findingId && finding.planSteps?.some((step) =>
            step.id && step.id === input.stepId && step.status !== "done"));
    if (kind === "run_task") {
        const task = PREDEFINED_TASKS.find((item) => item.id === input.taskId);
        return !!task && available.some((step) => mapped(step) && step.taskId === task.id);
    }
    if (kind === "run_skill") {
        return state.skills?.some((skill) => skill.folder === input.folder) &&
            available.some((step) => mapped(step) && step.skillFolder === input.folder);
    }
    if (kind === "generate_tests") return available.some((step) => /\b(generate|add|write|create)\b.*\btests?\b/i.test(step.title));
    if (kind === "create_skill") return available.some((step) => /\b(create|add|write)\b.*\bskill\b/i.test(step.title));
    return kind === "open_pr";
}

function reconcileProgress(markdown, oldSteps, nextSteps) {
    const oldById = new Map(oldSteps.map((step) => [step.id, step]));
    const oldByKey = new Map(oldSteps.map((step) => [(step.section || "") + "::" + step.title, step]));
    const nextById = new Map(nextSteps.map((step) => [step.id, step]));
    const progressSteps = parseChecklist(markdown);
    let ordinal = 0;
    const seen = new Set();
    const updated = markdown.split(/\r?\n/).map((line) => {
        if (!/^\s*[-*]\s+\[[ xX/~\-]\]\s+\S/.test(line)) return line;
        const step = progressSteps[ordinal++];
        const id = step.id || oldByKey.get((step.section || "") + "::" + step.title)?.id;
        if (!id || !oldById.has(id)) return line;
        if (!nextById.has(id)) return /^\s*[-*]\s+\[[ xX/~\-]\]/.test(line) ? null : line;
        seen.add(id);
        const match = line.match(/^(\s*[-*]\s+\[[ xX/~\-]\]\s+)(.*)$/);
        const detail = match[2].replace(/\s*<!--\s*appmod-(?:step:[a-f0-9]{16,32}|finding:[^\s<>]+|task:[^\s<>]+|skill:[^\s<>]+)\s*-->/gi, "").trim();
        const nextStep = nextById.get(id);
        const title = detail === oldById.get(id).title ? nextStep.title : detail;
        const findingMarkers = (nextStep.findingIds || []).map((findingId) => " <!-- appmod-finding:" + encodeURIComponent(findingId) + " -->").join("");
        const executionMarkers = (nextStep.taskId ? " <!-- appmod-task:" + nextStep.taskId + " -->" : "") +
            (nextStep.skillFolder ? " <!-- appmod-skill:" + encodeURIComponent(nextStep.skillFolder) + " -->" : "");
        return match[1] + title + " <!-- appmod-step:" + id + " -->" + findingMarkers + executionMarkers;
    }).filter((line) => line !== null).join("\n");
    const additions = nextSteps.filter((step) => !seen.has(step.id));
    if (!additions.length) return updated;
    let section = null;
    const extra = [];
    for (const step of additions) {
        if (section !== step.section) {
            section = step.section;
            extra.push("## " + (section || "Steps"));
        }
        const findingMarkers = (step.findingIds || []).map((findingId) => " <!-- appmod-finding:" + encodeURIComponent(findingId) + " -->").join("");
        const executionMarkers = (step.taskId ? " <!-- appmod-task:" + step.taskId + " -->" : "") +
            (step.skillFolder ? " <!-- appmod-skill:" + encodeURIComponent(step.skillFolder) + " -->" : "");
        extra.push("- [ ] " + step.title + " <!-- appmod-step:" + step.id + " -->" + findingMarkers + executionMarkers);
    }
    return updated.trimEnd() + "\n\n" + extra.join("\n") + "\n";
}

function withAssessmentContext(prompt, config) {
    if (!prompt || !config) return prompt;
    return prompt + "\n\nUse assessment request " + config.id + " for module " + config.module +
        ", target Java " + config.targetJava + " on " + config.cloud +
        ". Keep plan.md and progress.md linked to this request; pause if the settings change.";
}

async function validateAssessmentOptions(repoPath, payload) {
    const options = payload || {};
    const targetJava = options.targetJava === undefined ? 21 : options.targetJava;
    const cloud = options.cloud === undefined ? "Azure" : options.cloud;
    const module = options.module === undefined ? "." : options.module;
    if (![17, 21].includes(targetJava) || cloud !== "Azure") {
        return { ok: false, error: "Unsupported assessment target." };
    }
    if (typeof module !== "string" || !module || isAbsolute(module) || !repoPath) {
        return { ok: false, error: "Invalid assessment module." };
    }
    try {
        const root = await realpath(repoPath);
        const folder = await realpath(join(root, module));
        const relativeModule = relative(root, folder);
        if (relativeModule === ".." || relativeModule.startsWith(".." + sep) || isAbsolute(relativeModule) || !(await stat(folder)).isDirectory()) {
            return { ok: false, error: "Assessment module must be a directory inside the repo." };
        }
        if (relativeModule) {
            const buildFiles = ["pom.xml", "build.gradle", "build.gradle.kts", "build.xml"];
            const hasBuildFile = await Promise.all(buildFiles.map(async (name) => {
                try { return (await stat(join(folder, name))).isFile(); } catch { return false; }
            }));
            if (!hasBuildFile.some(Boolean)) return { ok: false, error: "Assessment module has no supported build file." };
        }
        return { ok: true, root, options: { module: relativeModule || ".", targetJava, cloud } };
    } catch {
        return { ok: false, error: "Assessment module is not available." };
    }
}

async function persistedAssessmentError(repoPath, state) {
    if (state?.assessmentConfigStatus === "invalid") return "Saved assessment settings are invalid. Re-run the assessment.";
    if (!state?.assessmentConfig) return null;
    const validated = await validateAssessmentOptions(repoPath, state.assessmentConfig);
    if (!validated.ok || validated.options.module !== state.assessmentConfig.module) {
        return "Saved assessment module is no longer valid. Re-run the assessment.";
    }
    return null;
}

/** Resolve which repo path an open/action context refers to, by precedence. */
export function resolveRepoPath(ctx, lastWorkingDir) {
    const fromInput =
        ctx && ctx.input && typeof ctx.input.repoPath === "string" ? ctx.input.repoPath : null;
    const fromSession =
        ctx && ctx.session && ctx.session.workingDirectory ? ctx.session.workingDirectory : null;
    // No process.cwd() fallback: that resolves to the extension's own directory,
    // not the user's repo, and would make the cockpit scan unrelated files. When
    // nothing resolves we return null and the UI shows a "repo not available"
    // state instead of plausible-but-wrong data.
    return fromInput || fromSession || lastWorkingDir || null;
}

/**
 * Scan the repo and attach the environment readiness report. Tool probing is
 * expensive (spawns several processes), so the doctor result is cached on the
 * instance record and only recomputed on first build or an explicit recheck —
 * not on every per-turn refresh. Probing only runs when `rec.runDoctor` is wired
 * (real instances), so unit tests stay fast and deterministic.
 */
export async function buildState(rec, { recheckEnv = false } = {}) {
    const state = await scanRepo(rec.repoPath);
    if (state && state.ok && typeof rec.runDoctor === "function") {
        const pending = rec.doctorPromise;
        if (pending) await pending;
        if (recheckEnv || (!pending && rec.doctor == null)) {
            const probe = (async () => {
                try {
                    rec.doctor = await rec.runDoctor(state);
                    rec.needsEnvRecheck = false;
                } catch {
                    rec.doctor = rec.doctor || null;
                }
            })();
            rec.doctorPromise = probe;
            try { await probe; }
            finally {
                if (rec.doctorPromise === probe) rec.doctorPromise = null;
            }
        }
        state.doctor = rec.doctor;
    } else if (state && state.ok) {
        state.doctor = rec.doctor || null;
    }
    if (state && state.ok) state.autopilot = rec.autopilot || null;
    return state;
}

/** Write an SSE payload to every connected client of an instance. */
export function broadcast(rec, payload) {
    const data = "data: " + JSON.stringify(payload) + "\n\n";
    for (const res of rec.sseClients) {
        try {
            res.write(data);
        } catch {
            // Client disconnected uncleanly: drop it so we don't keep throwing on
            // every future broadcast (dead clients would otherwise leak in the Set).
            rec.sseClients.delete(res);
        }
    }
}

/** Re-scan the repo and push the fresh snapshot to connected clients. */
export async function pushState(rec, log, opts) {
    let state;
    try {
        state = await buildState(rec, opts);
    } catch (e) {
        if (log) log("appmod-cockpit scan failed: " + e.message, { level: "error" });
        return null;
    }
    broadcast(rec, { type: "state", state });
    return state;
}

export async function refreshAfterTurn(rec, log) {
    return pushState(rec, log, { recheckEnv: rec.needsEnvRecheck || rec.doctor?.overall === "blocked" });
}

/** Clamp a requested step budget into a sane range. */
function clampSteps(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return AUTOPILOT_MAX_STEPS;
    return Math.max(1, Math.min(50, Math.round(v)));
}

/**
 * Kick off an Autopilot run for this instance. Returns immediately; the run loop
 * streams progress to connected clients over SSE. The run promise is parked on
 * the record so it is not garbage-collected mid-flight.
 * @param {object} rec instance record
 * @param {object} payload { scope?: "phase"|"all"|"recommendations", maxSteps? }
 * @param {{ runTurn:(p:string)=>Promise<any>, log?:Function }} deps
 */
export async function startAutopilot(rec, payload, deps) {
    if (rec.autopilot && rec.autopilot.running) {
        return { ok: false, error: "Autopilot is already running." };
    }
    if (!deps || typeof deps.runTurn !== "function") {
        return { ok: false, error: "This session can't drive Autopilot." };
    }
    const p = payload || {};
    const start = await buildState(rec, { recheckEnv: true });
    if (!start || !start.ok) {
        return { ok: false, error: "Can't read the repo to start Autopilot." };
    }
    const settingsError = await persistedAssessmentError(rec.repoPath, start);
    if (settingsError) return { ok: false, error: settingsError };
    if (start.assessmentConfig && (start.reportConfigStatus !== "current" || start.planConfigStatus !== "current")) {
        return { ok: false, error: "The assessment or plan needs review for the selected settings before execution." };
    }
    if ((typeof rec.runDoctor === "function" && !start.doctor) || start.doctor?.overall === "blocked") {
        return { ok: false, error: "Your environment isn't ready. Open Readiness and install the missing tools first." };
    }
    if (start.planApprovalStatus !== "approved") {
        return { ok: false, error: "Approve the current plan in Plan before starting Autopilot." };
    }
    const scope = ["all", "recommendations"].includes(p.scope) ? p.scope : "phase";
    const recommendationStepIds = scope === "recommendations" ? [...new Set((start.report?.findings || [])
        .flatMap((finding) => finding.planSteps?.filter((step) => step.id && step.status !== "done").map((step) => step.id) || []))] : [];
    if (scope === "recommendations" && !recommendationStepIds.length) {
        return { ok: false, error: "No pending assessed recommendations match the approved plan." };
    }
    const startRank = start.ordering ? start.ordering.activeRank : null;
    const run = makeRun({ scope, maxSteps: clampSteps(p.maxSteps), startRank, recommendationStepIds });
    rec.autopilot = run;
    broadcast(rec, { type: "autopilot", autopilot: run });

    const expectedId = start.assessmentConfig?.id || null;
    const approvedHash = start.plan.contentHash;
    const reportRevision = start.reportRevision;
    const runDeps = {
        snapshot: async () => {
            const state = await buildState(rec);
            if (!state?.ok || state.assessmentConfigStatus === "invalid" ||
                (state.assessmentConfig?.id || null) !== expectedId ||
                (expectedId && (state.reportConfigStatus !== "current" || state.planConfigStatus !== "current")) ||
                state.planApprovalStatus !== "approved" || state.plan.contentHash !== approvedHash ||
                (scope === "recommendations" && state.reportRevision !== reportRevision)) {
                throw new Error("Assessment settings or approved plan changed during Autopilot. Review before resuming.");
            }
            return state;
        },
        runTurn: deps.runTurn,
        buildStepPrompt: (step) => {
            const prompt = buildPrompt("auto_step", { title: step.title, section: step.section }, rec.repoPath);
            const findings = scope === "recommendations" ? start.report.findings.filter((finding) =>
                finding.planSteps?.some((item) => item.id === step.id)) : [];
            const evidence = findings.map((finding) => "- " + finding.id + ": " + finding.title +
                (finding.files.length ? " (" + finding.files.join(", ") + ")" : "")).join("\n");
            return withAssessmentContext(prompt + (evidence ? "\n\nWork only on these approved assessed findings:\n" + evidence : ""), start.assessmentConfig);
        },
        onProgress: (r, state) => {
            if (state) broadcast(rec, { type: "state", state });
            else broadcast(rec, { type: "autopilot", autopilot: r });
        },
        log: deps.log,
    };
    rec.autopilotPromise = runAutopilot(run, runDeps)
        .then(() => pushState(rec, deps.log))
        .catch((e) => {
            if (deps.log) deps.log("Autopilot run failed: " + e.message, { level: "error" });
        });
    return { ok: true, message: "Autopilot started", autopilot: run };
}

/**
 * Handle a cockpit action.
 * @param {object} rec instance record ({ repoPath, sseClients, ... })
 * @param {string} kind action kind
 * @param {object} payload action payload
 * @param {{ sendPrompt:(p:string, displayPrompt:string)=>Promise<void>, runTurn?:Function, log?:Function }} deps
 */
export async function dispatchAction(rec, kind, payload, deps) {
    if (kind === "refresh") {
        const state = await pushState(rec, deps && deps.log, { recheckEnv: true });
        return { ok: true, message: "Refreshed", state };
    }
    if (kind === "recheck_env") {
        const state = await pushState(rec, deps && deps.log, { recheckEnv: true });
        return { ok: true, message: "Re-checked environment", state };
    }
    if (kind === "approve_plan") {
        if (!rec.repoPath || rec.autopilot?.running) return { ok: false, error: "The plan cannot be approved while Autopilot is running or the repo is unavailable." };
        let root;
        try { root = await realpath(rec.repoPath); } catch { return { ok: false, error: "Repository not available." }; }
        if (activePlanWrites.has(root)) return { ok: false, error: "A plan update is already in progress." };
        activePlanWrites.add(root);
        try {
            const state = await buildState(rec);
            const settingsError = await persistedAssessmentError(root, state);
            if (settingsError) return { ok: false, error: settingsError };
            if (!state?.plan?.exists || !state.plan.steps.length || !state.assessmentConfig ||
                state.reportConfigStatus !== "current" || state.planConfigStatus !== "current") {
                return { ok: false, error: "Review a plan linked to the current assessment before approving." };
            }
            if (!payload || payload.revision !== state.plan.revision) return { ok: false, error: "The plan changed since you opened it. Refresh and review it again." };
            const planFile = await realpath(join(root, state.plan.path));
            if (!insideRepo(root, planFile)) {
                return { ok: false, error: "The plan must be inside the repository." };
            }
            const config = state.assessmentConfig;
            const approval = {
                assessmentId: config.id,
                scope: { module: config.module, targetJava: config.targetJava, cloud: config.cloud },
                planPath: state.plan.path,
                planHash: state.plan.contentHash,
                approvedAt: new Date().toISOString(),
            };
            await writeFile(join(root, ".appmod", "plan-approval.json"), JSON.stringify(approval, null, 2) + "\n");
            const updated = await pushState(rec, deps && deps.log);
            if (updated?.planApprovalStatus !== "approved") return { ok: false, error: "The plan changed during approval. Review the current version." };
            return { ok: true, message: "Plan approved", state: updated };
        } catch (e) {
            return { ok: false, error: "Could not approve the plan: " + e.message };
        } finally {
            activePlanWrites.delete(root);
        }
    }
    if (kind === "save_plan") {
        if (!rec.repoPath || rec.autopilot?.running) return { ok: false, error: "Stop Autopilot before editing the plan." };
        let root;
        try { root = await realpath(rec.repoPath); } catch { return { ok: false, error: "Repository not available." }; }
        if (activePlanWrites.has(root)) return { ok: false, error: "A plan update is already in progress." };
        activePlanWrites.add(root);
        try {
            const state = await buildState(rec);
            const settingsError = await persistedAssessmentError(root, state);
            if (settingsError) return { ok: false, error: settingsError };
            if (!state?.plan?.exists || !state.assessmentConfig || state.reportConfigStatus !== "current") {
                return { ok: false, error: "Generate a plan linked to the current assessment before editing." };
            }
            const adopting = state.planConfigStatus !== "current";
            if (adopting && (!state.plan.adoptable || payload?.adopt !== true ||
                payload.assessmentId !== state.assessmentConfig.id || payload.reportRevision !== state.reportRevision ||
                payload.progressRevision !== state.progress.revision)) {
                return { ok: false, error: "Review the current assessment, plan and progress before linking this legacy plan." };
            }
            if (payload?.revision !== state.plan.revision) return { ok: false, error: "The plan changed since you opened it. Refresh and review it again." };
            const markdown = payload.markdown;
            const config = state.assessmentConfig;
            const header = typeof markdown === "string" ? markdown.split(/\r?\n/, 3) : [];
            if (typeof markdown !== "string" || markdown.length > 128 * 1024 ||
                header.length < 3 || header[0] !== "<!-- appmod-cockpit -->" ||
                header[1] !== "<!-- appmod-assessment-id:" + config.id + " -->") {
                return { ok: false, error: "Keep the plan provenance and current assessment ID at the top of the file." };
            }
            const oldSteps = parseChecklist(state.plan.editableMarkdown);
            const nextSteps = parseChecklist(markdown);
            const ids = nextSteps.map((step) => step.id);
            if (!oldSteps.length || !nextSteps.length || ids.some((id) => !id) || new Set(ids).size !== ids.length) {
                return { ok: false, error: "The plan needs unique step IDs and at least one checklist step." };
            }
            const oldByKey = new Map(oldSteps.map((step) => [(step.section || "") + "::" + step.title, step]));
            const priorDone = state.progress.exists ? state.progress.steps.filter((step) => step.status === "done") : [];
            if (priorDone.some((step) => !ids.includes(step.id || oldByKey.get((step.section || "") + "::" + step.title)?.id))) {
                return { ok: false, error: "Completed steps must keep their IDs in the revised plan." };
            }
            const planFile = await realpath(join(root, state.plan.path));
            if (!insideRepo(root, planFile)) return { ok: false, error: "The plan must be inside the repository." };
            const progressFile = state.progress.path ? await realpath(join(root, state.progress.path)) : null;
            if (progressFile && !insideRepo(root, progressFile)) return { ok: false, error: "Progress must be inside the repository." };
            const previousProgress = progressFile ? await readFile(progressFile, "utf8") : null;
            if ((await readFile(planFile, "utf8")) !== state.plan.markdown ||
                (previousProgress == null ? null : createHash("sha256").update(previousProgress).digest("hex")) !== state.progress.revision) {
                return { ok: false, error: "The plan or progress changed while saving. Refresh and review it again." };
            }
            if (adopting && createHash("sha256").update(await readFile(join(root, state.reportPath), "utf8")).digest("hex") !== state.reportRevision) {
                return { ok: false, error: "The assessment report changed while saving. Refresh and review it again." };
            }
            const reconciledProgress = previousProgress == null ? null : reconcileProgress(previousProgress, oldSteps, nextSteps);
            const updatedProgress = adopting && reconciledProgress != null ? withAssessmentId(reconciledProgress, config.id) : reconciledProgress;
            await writeFile(planFile, markdown);
            try {
                if (progressFile) await writeFile(progressFile, updatedProgress);
                if (adopting) await rm(join(root, ".appmod", "plan-approval.json"), { force: true });
            } catch (error) {
                if (progressFile) await writeFile(progressFile, previousProgress);
                await writeFile(planFile, state.plan.markdown);
                throw error;
            }
            const updated = await pushState(rec, deps && deps.log);
            return { ok: true, message: "Plan saved; approval required", state: updated };
        } catch (e) {
            return { ok: false, error: "Could not save the plan: " + e.message };
        } finally {
            activePlanWrites.delete(root);
        }
    }
    if (kind === "autopilot_start") {
        return await startAutopilot(rec, payload, deps);
    }
    if (kind === "autopilot_stop") {
        if (rec.autopilot && rec.autopilot.running) {
            rec.autopilot.cancelled = true;
            broadcast(rec, { type: "autopilot", autopilot: rec.autopilot });
            return { ok: true, message: "Stopping after the current step finishes…" };
        }
        return { ok: false, error: "Autopilot isn't running." };
    }
    if (kind === "autopilot_dismiss") {
        if (rec.autopilot && !rec.autopilot.running) {
            rec.autopilot = null;
            await pushState(rec, deps && deps.log);
        }
        return { ok: true, message: "Dismissed" };
    }
    let assessmentConfig = null;
    let assessmentRoot = null;
    const releaseAssessment = () => {
        if (assessmentRoot) activeAssessmentRepos.delete(assessmentRoot);
        if (kind === "start_assessment") rec.assessmentPending = false;
    };
    if (kind === "start_assessment") {
        if (rec.assessmentPending) return { ok: false, error: "An assessment request is already being sent." };
        rec.assessmentPending = true;
        const validated = await validateAssessmentOptions(rec.repoPath, payload);
        if (!validated.ok) {
            releaseAssessment();
            return validated;
        }
        if (activeAssessmentRepos.has(validated.root)) {
            releaseAssessment();
            return { ok: false, error: "An assessment request for this repository is already being sent." };
        }
        assessmentRoot = validated.root;
        activeAssessmentRepos.add(assessmentRoot);
        assessmentConfig = { ...validated.options, id: randomUUID(), requestedAt: new Date().toISOString() };
        payload = assessmentConfig;
    }
    if (kind === "generate_plan") {
        const state = await buildState(rec);
        const settingsError = await persistedAssessmentError(rec.repoPath, state);
        if (settingsError) return { ok: false, error: settingsError };
        if (!state?.assessmentConfig || state.reportConfigStatus !== "current") {
            return { ok: false, error: "Run an assessment for the selected settings before generating a plan." };
        }
        payload = state.assessmentConfig;
    }
    if (kind === "explain_finding") {
        const state = await buildState(rec);
        const matches = state?.reportStatus === "ready" ? state.report.findings.filter((finding) => finding.id === payload?.findingId) : [];
        if (matches.length !== 1) return { ok: false, error: "Select a current assessment finding to explain." };
        const finding = matches[0];
        payload = { title: finding.title, detail: finding.detail, impact: finding.impact,
            recommendation: finding.recommendation, files: finding.files };
    }
    let executionConfig = null;
    if (EXECUTION_ACTIONS.has(kind) || MUTATING_ACTIONS.has(kind)) {
        const state = await buildState(rec, { recheckEnv: true });
        const settingsError = await persistedAssessmentError(rec.repoPath, state);
        if (settingsError) return { ok: false, error: settingsError };
        if (state?.assessmentConfig && (state.reportConfigStatus !== "current" || state.planConfigStatus !== "current")) {
            return { ok: false, error: "The assessment or plan needs review for the selected settings before execution." };
        }
        if ((typeof rec.runDoctor === "function" || rec.doctor) && (!state?.ok || !state.doctor || state.doctor.overall === "blocked")) {
            return { ok: false, error: "Environment readiness is blocked or unavailable. Resolve the required tools and re-check before execution." };
        }
        if (MUTATING_ACTIONS.has(kind) && state?.planApprovalStatus !== "approved") {
            return { ok: false, error: "Approve the current plan in Plan before making changes." };
        }
        if (MUTATING_ACTIONS.has(kind) && !actionMatchesPlan(kind, payload, state)) {
            return { ok: false, error: "This action is not a pending step in the approved plan. Review the plan before execution." };
        }
        if (kind === "fix_finding") {
            const finding = state.report.findings.find((item) => item.id === payload.findingId);
            const step = finding.planSteps.find((item) => item.id === payload.stepId);
            payload = { findingId: finding.id, title: finding.title, detail: finding.detail, severity: finding.severity,
                impact: finding.impact, recommendation: finding.recommendation, files: finding.files, evidence: finding.evidence,
                stepTitle: step.title, section: step.section };
        }
        executionConfig = state?.assessmentConfig;
    }
    const prompt = withAssessmentContext(buildPrompt(kind, payload, rec.repoPath), executionConfig);
    if (!prompt) {
        releaseAssessment();
        return { ok: false, error: "Unknown action: " + kind };
    }
    if (!deps || typeof deps.sendPrompt !== "function") {
        releaseAssessment();
        return { ok: false, error: "Session not ready" };
    }
    const label = ACTION_LABELS[kind] || kind;
    let previousConfig;
    let configPath;
    let configWritten = false;
    try {
        if (assessmentConfig) {
            const folder = join(rec.repoPath, ".appmod");
            configPath = join(folder, "assessment-config.json");
            await mkdir(folder, { recursive: true });
            previousConfig = await readFile(configPath, "utf8").catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            await writeFile(configPath, JSON.stringify(assessmentConfig, null, 2) + "\n");
            configWritten = true;
        }
        await deps.sendPrompt(prompt, DISPLAY_PROMPTS[kind]);
        if (kind === "fix_env") rec.needsEnvRecheck = true;
        if (deps.log) {
            try { deps.log("Java Modernization Studio → " + label, { ephemeral: true }); } catch {}
        }
        return { ok: true, label, message: "Sent to the agent: " + label };
    } catch (e) {
        if (configWritten) {
            try {
                if (previousConfig === null) await rm(configPath);
                else await writeFile(configPath, previousConfig);
            } catch (restoreError) {
                return { ok: false, error: e.message + "; could not restore assessment settings: " + restoreError.message };
            }
        }
        return { ok: false, error: e.message };
    } finally {
        releaseAssessment();
    }
}

// Cap the request body the /action endpoint will buffer. Actions carry tiny JSON
// payloads; anything large is a bug or abuse, so we reject rather than buffer it.
const MAX_BODY_BYTES = 256 * 1024;

function readBody(req, max = MAX_BODY_BYTES) {
    return new Promise((resolve) => {
        let data = "";
        let size = 0;
        let done = false;
        req.on("data", (c) => {
            if (done) return;
            size += c.length;
            if (size > max) {
                done = true;
                resolve({ body: "", tooLarge: true });
                if (typeof req.destroy === "function") req.destroy();
                return;
            }
            data += c;
        });
        req.on("end", () => {
            if (!done) {
                done = true;
                resolve({ body: data, tooLarge: false });
            }
        });
        req.on("error", () => {
            if (!done) {
                done = true;
                resolve({ body: "", tooLarge: false });
            }
        });
    });
}

/**
 * Build the request handler for an instance. Exposed for tests so routes can be
 * exercised without binding a socket.
 */
export function makeHandler(rec, { instanceId, initialTab, sendPrompt, runTurn, log }) {
    return async function handler(req, res) {
        const url = new URL(req.url, "http://127.0.0.1");
        try {
            // Per-instance secret: real instances (createInstanceServer) mint a token
            // that the host embeds in the iframe URL. Reject any loopback request that
            // doesn't present it, so other local processes can't read repo state or
            // dispatch agent actions just by guessing the random port. When no token is
            // set (direct makeHandler unit tests) the guard is a no-op.
            if (rec.token) {
                const provided = url.searchParams.get("token");
                if (provided !== rec.token) {
                    res.statusCode = 403;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "forbidden" }));
                    return;
                }
            }
            if (req.method === "GET" && url.pathname === "/") {
                res.setHeader("Content-Type", "text/html; charset=utf-8");
                res.end(renderHtml({ instanceId, initialTab, token: rec.token }));
                return;
            }
            if (req.method === "GET" && url.pathname === "/state") {
                const state = await buildState(rec, { recheckEnv: url.searchParams.get("recheckEnv") === "1" });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(state));
                return;
            }
            if (req.method === "GET" && url.pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });
                res.write("retry: 3000\n\n");
                rec.sseClients.add(res);
                req.on("close", () => rec.sseClients.delete(res));
                return;
            }
            if (req.method === "POST" && url.pathname === "/action") {
                const { body, tooLarge } = await readBody(req);
                if (tooLarge) {
                    res.statusCode = 413;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "request body too large" }));
                    return;
                }
                let parsed;
                try {
                    parsed = JSON.parse(body || "{}");
                } catch {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
                    return;
                }
                if (!parsed || typeof parsed.kind !== "string" || !parsed.kind) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "missing or invalid 'kind'" }));
                    return;
                }
                const result = await dispatchAction(rec, parsed.kind, parsed.payload, { sendPrompt, runTurn, log });
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(result));
                return;
            }
            res.statusCode = 404;
            res.end("not found");
        } catch (e) {
            if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
            }
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    };
}

/**
 * Start a loopback server for one canvas instance.
 * @returns {Promise<object>} rec with { server, url, repoPath, sseClients }
 */
export async function createInstanceServer({ instanceId, repoPath, initialTab, sendPrompt, runTurn, log, runDoctor: runDoctorImpl }) {
    const rec = { server: null, url: "", repoPath, sseClients: new Set(), doctor: null, autopilot: null, token: randomBytes(16).toString("hex") };
    // Wire the environment doctor (injectable for tests); real instances probe the
    // local toolchain, cached and only recomputed on explicit recheck.
    rec.runDoctor = typeof runDoctorImpl === "function" ? runDoctorImpl : (scan) => runDoctor(scan, {});
    const handler = makeHandler(rec, { instanceId, initialTab, sendPrompt, runTurn, log });
    const server = createServer((req, res) => {
        // The handler is async: if it rejects, surface a 500 and log it rather than
        // letting it become an unhandled rejection that can crash the extension.
        handler(req, res).catch((err) => {
            if (log) log("Java Modernization Studio server error: " + (err && err.message ? err.message : err), { level: "error" });
            try {
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: "internal error" }));
                } else {
                    res.end();
                }
            } catch {
                /* response already torn down */
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    rec.server = server;
    rec.url = "http://127.0.0.1:" + port + "/?token=" + rec.token;
    return rec;
}
