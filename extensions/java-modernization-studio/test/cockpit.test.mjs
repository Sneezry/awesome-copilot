// cockpit.test.mjs — Test suite for the Java Modernization Studio canvas.
// Run with:  node --test test/cockpit.test.mjs
//
// Covers the testable modules (scan, catalog, prompts, renderer, server). It does
// NOT import extension.mjs, which calls joinSession() at module load and needs a
// live CLI session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { parseChecklist, scanRepo } from "../scan.mjs";
import { PREDEFINED_TASKS, catalogWithRelevance, VALIDATION_GATES } from "../catalog.mjs";
import { buildPrompt, ACTION_LABELS } from "../prompts.mjs";
import { renderHtml } from "../renderer.mjs";
import {
    buildDoctorReport,
    parseToolVersion,
    probeOne,
    runDoctor,
    makeExec,
    augmentedEnv,
    discoverJavaHome,
    parseJavaHomeFromRc,
    TOOL_PROBES,
} from "../doctor.mjs";
import {
    resolveRepoPath,
    broadcast,
    buildState,
    pushState,
    refreshAfterTurn,
    dispatchAction,
    makeHandler,
    createInstanceServer,
} from "../server.mjs";
import {
    selectNextStep,
    stepKey,
    isStepDone,
    makeRun,
    runAutopilot,
} from "../autopilot.mjs";

// ---- helpers ----------------------------------------------------------------

// Minimal provenance: a .appmod/ artifact tells the scanner this repo is actively
// running the modernization workflow, so root plan/progress/summary are trusted as
// workflow state (vs. unrelated files that merely share those names).
const PROV = { ".appmod/assessment.json": "{}" };

async function makeRepo(files = {}) {
    const dir = await mkdtemp(join(tmpdir(), "appmod-test-"));
    for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
    }
    return dir;
}

async function withRepo(files, fn) {
    const dir = await makeRepo(files);
    try {
        return await fn(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function git(dir, ...args) {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function fakeRes() {
    return {
        statusCode: 200,
        headers: {},
        body: "",
        ended: false,
        setHeader(k, v) {
            this.headers[String(k).toLowerCase()] = v;
        },
        writeHead(code, hdrs) {
            this.statusCode = code;
            if (hdrs) for (const k of Object.keys(hdrs)) this.headers[k.toLowerCase()] = hdrs[k];
        },
        write(s) {
            this.body += s;
        },
        end(s) {
            if (s !== undefined) this.body += s;
            this.ended = true;
        },
    };
}

// Drive makeHandler with a fake POST request stream.
async function invokePost(handler, path, payloadObj) {
    const req = new EventEmitter();
    req.method = "POST";
    req.url = path;
    const res = fakeRes();
    const pending = handler(req, res);
    req.emit("data", JSON.stringify(payloadObj));
    req.emit("end");
    await pending;
    return res;
}

async function invokeGet(handler, path) {
    const req = new EventEmitter();
    req.method = "GET";
    req.url = path;
    const res = fakeRes();
    await handler(req, res);
    return { req, res };
}

// ===========================================================================
// scan.mjs
// ===========================================================================

test("scan: nonexistent path returns ok:false", async () => {
    const s = await scanRepo("/no/such/path/at/all/xyz");
    assert.equal(s.ok, false);
});

test("scan: empty repo is not_started with all gates not_run", async () => {
    await withRepo({}, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.ok, true);
        assert.equal(s.status, "not_started");
        assert.equal(s.percent, 0);
        assert.equal(s.plan.exists, false);
        assert.equal(s.progress.exists, false);
        assert.equal(s.summary.exists, false);
        for (const g of VALIDATION_GATES) assert.equal(s.gates[g.key], "not_run");
    });
});

test("scan: Maven Java version from properties", async () => {
    await withRepo(
        { "pom.xml": "<project><properties><java.version>8</java.version></properties></project>" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.buildTool, "Maven");
            assert.equal(s.assessment.javaVersion, "8");
        }
    );
});

test("scan: Maven compiler release strips 1.x and detects", async () => {
    await withRepo(
        { "pom.xml": "<project><properties><maven.compiler.release>17</maven.compiler.release></properties></project>" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.javaVersion, "17");
        }
    );
});

test("scan: Gradle build tool + sourceCompatibility", async () => {
    await withRepo(
        { "build.gradle": "sourceCompatibility = '11'\napply plugin: 'java'" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.buildTool, "Gradle");
            assert.equal(s.assessment.javaVersion, "11");
        }
    );
});

test("scan: nested module pom is discovered", async () => {
    await withRepo(
        { "service/pom.xml": "<project><properties><java.version>8</java.version></properties></project>" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.buildTool, "Maven");
            assert.equal(s.assessment.javaVersion, "8");
        }
    );
});

test("scan: Spring Boot detection", async () => {
    await withRepo(
        { "pom.xml": "<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.springBoot, true);
        }
    );
});

test("scan: Dockerfile detected at root and one level down", async () => {
    await withRepo({ Dockerfile: "FROM tomcat:9" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasDockerfile, true);
    });
    await withRepo({ "svc/Dockerfile": "FROM tomcat:9" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasDockerfile, true);
    });
});

test("scan: dependency relevance flags the right catalog tasks", async () => {
    const cases = [
        ["spring-boot-starter-amqp", "rabbitmq-to-servicebus"],
        ["activemq-client", "activemq-to-servicebus"],
        ["aws-java-sdk-s3", "aws-s3-to-blob"],
        ["ojdbc8", "databases-to-azure"],
        ["spring-ldap-core", "entra-id-auth"],
    ];
    for (const [dep, taskId] of cases) {
        await withRepo(
            { "pom.xml": `<project><dependencies><dependency><artifactId>${dep}</artifactId></dependency></dependencies></project>` },
            async (dir) => {
                const s = await scanRepo(dir, { includeGit: false });
                const task = s.tasks.find((t) => t.id === taskId);
                assert.ok(task, `task ${taskId} exists`);
                assert.equal(task.relevant, true, `${dep} -> ${taskId} relevant`);
            }
        );
    }
});

test("scan: checklist statuses (done / in_progress / pending)", async () => {
    await withRepo(
        { ...PROV, "progress.md": "- [x] Done step\n- [/] Working step\n- [ ] Todo step\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            const byTitle = Object.fromEntries(s.progress.steps.map((x) => [x.title, x.status]));
            assert.equal(byTitle["Done step"], "done");
            assert.equal(byTitle["Working step"], "in_progress");
            assert.equal(byTitle["Todo step"], "pending");
        }
    );
});

test("scan: emoji status markers override", async () => {
    await withRepo(
        { ...PROV, "progress.md": "- [ ] Build ✅\n- [ ] Tests ❌\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            const byTitle = Object.fromEntries(
                s.progress.steps.map((x) => [x.title.replace(/[^A-Za-z ].*/, "").trim(), x.status])
            );
            assert.equal(byTitle["Build"], "done");
            assert.equal(byTitle["Tests"], "failed");
        }
    );
});

test("scan: numbered-list fallback when no checkboxes", async () => {
    await withRepo({ ...PROV, "plan.md": "# Plan\n1. First thing\n2. Second thing\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.plan.steps.length, 2);
        assert.equal(s.plan.steps[0].title, "First thing");
    });
});

test("scan: heading fallback when no checkboxes or numbers", async () => {
    await withRepo({ ...PROV, "plan.md": "# Title\n## Phase one\n## Phase two\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        const titles = s.plan.steps.map((x) => x.title);
        assert.deepEqual(titles, ["Phase one", "Phase two"]);
    });
});

test("scan: percent counts in_progress as half", async () => {
    await withRepo(
        { ...PROV, "progress.md": "- [x] a\n- [/] b\n- [ ] c\n- [ ] d\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            // (1 + 0.5) / 4 = 37.5 -> 38
            assert.equal(s.percent, 38);
        }
    );
});

test("scan: gates derived from matching step titles", async () => {
    await withRepo(
        { ...PROV, "progress.md": "- [x] Unit Tests pass\n- [/] Build app\n- [ ] CVE scan\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.gates.tests, "done");
            assert.equal(s.gates.build, "in_progress");
            assert.equal(s.gates.cve, "pending"); // matched but not run
            assert.equal(s.gates.consistency, "not_run"); // unmatched
        }
    );
});

test("scan: gates scope to an explicit Validation section, not assessment text", async () => {
    // Assessment rows mention "build" and "vulnerable" (done); they must NOT
    // satisfy the Build/CVE gates, which live in the Validation section (pending).
    const md = [
        "## Assessment",
        "- [x] Inventory runtime, build tool, dependencies",
        "- [x] Identify vulnerable dependencies",
        "",
        "## Validation gates",
        "- [ ] Build — mvn clean package succeeds",
        "- [ ] CVE Check — no critical CVEs",
        "",
        "## Next",
        "- [x] something else with the word build in it",
    ].join("\n");
    await withRepo({ ...PROV, "progress.md": md }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.gates.build, "pending");
        assert.equal(s.gates.cve, "pending");
        const html = (await renderClientTab(s, "plan")).app();
        assert.match(html, /Open Validation/);
        assert.match(html, /run from Validation/);
    });
});

test("scan and renderer: a mixed remediation section stays actionable before validation", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const header = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n";
    const plan = header + "## Remediation and validation\n" +
        "- [ ] Upgrade vulnerable dependencies <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-finding:cve -->\n" +
        "- [ ] Build and test the Java 21 application <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config,
            findings: [{ id: "cve", severity: "P1", title: "Vulnerable dependency" }] }),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": plan,
        ".appmod/summary.md": "<!-- appmod-cockpit -->\n# Assessment summary\nNo code changed; Java 21 build, tests and vulnerability fixes remain pending.",
    }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.planConfigStatus, "current");
        assert.equal(state.ordering.activeRank, null);
        assert.deepEqual(state.gates, { build: "not_run", tests: "not_run", cve: "not_run",
            consistency: "not_run", completeness: "not_run" });
        state.planApprovalStatus = "approved";
        const html = (await renderClientTab(state, "plan")).app();
        assert.match(html, /<div class="workflow-stage"><strong>Remediation<\/strong>/);
        assert.match(html, /Start remediation: Vulnerable dependency/);
        assert.match(html, /data-kind="work_step"[^>]*Upgrade vulnerable dependencies/);
        assert.doesNotMatch(html, /run from Validation/);
        assert.doesNotMatch(html, /Next: Build and run unit tests/);
    });
});

test("scan: a summary alone cannot mark unfinished validation complete", async () => {
    await withRepo({ ...PROV, "summary.md": "# done" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.status, "in_progress");
    });
});

test("scan: status is completed when the summary and every validation gate are done", async () => {
    const summary = "## Validation\n- [x] Build\n- [x] Unit Tests\n- [x] CVE Check\n- [x] Consistency\n- [x] Completeness\n";
    await withRepo({ ...PROV, "summary.md": summary }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.status, "completed");
    });
});

test("scan: status is in_progress when only plan present", async () => {
    await withRepo({ ...PROV, "plan.md": "- [ ] a" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.status, "in_progress");
    });
});

test("scan: marked App Modernization plans appear from .github/modernize", async () => {
    const config = { id: "current-request", module: "service", targetJava: 21, cloud: "Azure" };
    const header = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n";
    await withRepo({
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".github/modernize/plan.md": header + "## P0 Build\n- [ ] Upgrade Maven <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n",
        ".github/modernize/progress.md": header + "## P0 Build\n- [ ] Upgrade Maven <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n",
        ".github/modernize/summary.md": header + "Assessment complete; validation pending.\n",
    }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.plan.path, ".github/modernize/plan.md");
        assert.equal(state.progress.path, ".github/modernize/progress.md");
        assert.equal(state.plan.steps.length, 1);
        assert.equal(state.summary.exists, true);
        assert.equal(state.planConfigStatus, "current");
        assert.equal(state.status, "in_progress");
        const planView = (await renderClientTab(state, "plan")).app();
        assert.match(planView, /Upgrade Maven/);
        assert.doesNotMatch(planView, /No plan yet/);

        await writeFile(join(dir, ".github", "modernize", "plan.md"), "## Unrelated plan\n- [ ] unrelated\n");
        const unmarked = await scanRepo(dir, { includeGit: false });
        assert.equal(unmarked.plan.exists, false, "native plans without the cockpit marker stay separate");
    });
});

test("scan: reads .appmod/assessment.json into report", async () => {
    const report = {
        generatedAt: "2026-01-01T00:00:00Z",
        headline: "h",
        findings: [{ id: "x", severity: "P0", title: "t", detail: "d", files: ["a"], action: { kind: "fix_finding" } }],
    };
    await withRepo({ ".appmod/assessment.json": JSON.stringify(report) }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.ok(s.report, "report should be present");
        assert.equal(s.report.findings.length, 1);
        assert.equal(s.report.findings[0].severity, "P0");
    });
});

test("scan: report is null when assessment.json absent or malformed", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.report, null);
    });
    await withRepo({ ".appmod/assessment.json": "{ not valid json" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.report, null, "malformed JSON should not throw, just yield null");
    });
});

test("scan: assessment report status distinguishes missing, invalid, and empty results", async () => {
    for (const [files, expected] of [
        [{ "pom.xml": "<project/>" }, "missing"],
        [{ ".appmod/assessment.json": "{ bad json" }, "invalid"],
        [{ ".appmod/assessment.json": "{}" }, "invalid"],
        [{ ".appmod/assessment.json": '{"findings":[]}' }, "ready"],
    ]) {
        await withRepo(files, async (dir) => {
            assert.equal((await scanRepo(dir, { includeGit: false })).reportStatus, expected);
        });
    }
});

test("scan: assessment artifacts identify current, outdated, and unverified settings", async () => {
    const options = { module: "service", targetJava: 17, cloud: "Azure" };
    const config = { ...options, id: "current-request" };
    await withRepo({
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: "previous-request", assessmentConfig: options, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:previous-request -->\n- [ ] Upgrade",
        ".appmod/progress.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:previous-request -->\n- [ ] Upgrade",
    }, async (dir) => {
        let state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "outdated");
        assert.equal(state.planConfigStatus, "outdated");

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: config.id, assessmentConfig: options, findings: [] }));
        await writeFile(join(dir, ".appmod", "plan.md"), "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade");
        await writeFile(join(dir, ".appmod", "progress.md"), "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade");
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "current");
        assert.equal(state.planConfigStatus, "current");

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: config.id, scope: { ...options, analysisCoverage: "issue-only" }, findings: [] }));
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "current", "matching report scope verifies settings when assessmentConfig is absent");

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: "previous-request", scope: options, findings: [] }));
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "outdated", "a matching scope cannot verify another request ID");

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: config.id, scope: { ...options, targetJava: 21 }, findings: [] }));
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "outdated", "scope must match the requested target");

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: config.id, scope: { module: options.module }, findings: [] }));
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "unverified", "an incomplete scope does not verify settings");

        await writeFile(join(dir, ".appmod", "assessment.json"), '{"findings":[]}');
        await writeFile(join(dir, ".appmod", "progress.md"), "<!-- appmod-cockpit -->\n- [ ] Upgrade");
        state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportConfigStatus, "unverified");
        assert.equal(state.planConfigStatus, "unverified");
    });
});

// ---- provenance gate (cross-repo safety) ------------------------------------

test("scan: an unrelated summary.md without provenance does NOT mark completed", async () => {
    await withRepo({ "summary.md": "# My library\nUsage and changelog notes." }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.notEqual(s.status, "completed", "a stray summary.md must not flip status to completed");
        assert.equal(s.status, "not_started");
        assert.equal(s.summary.exists, false, "untrusted summary is treated as absent");
    });
});

test("scan: an unrelated plan.md without provenance is not treated as workflow steps", async () => {
    await withRepo({ "plan.md": "# Roadmap\n- [ ] ship feature x\n- [ ] write docs\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.plan.steps.length, 0, "stray checkboxes must not become modernization steps");
        assert.equal(s.status, "not_started");
    });
});

test("scan: assessment.json provenance makes a root progress.md trusted", async () => {
    await withRepo(
        { ".appmod/assessment.json": "{}", "progress.md": "## P0\n- [x] a\n- [ ] b\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.progress.steps.length, 2);
            assert.equal(s.status, "in_progress");
        }
    );
});

test("scan: an explicit appmod marker makes a root plan trusted without .appmod/", async () => {
    await withRepo(
        { "plan.md": "<!-- appmod-cockpit -->\n## P0 Build\n- [ ] Fix build\n" },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.plan.steps.length, 1, "marked file is trusted");
            assert.equal(s.status, "in_progress");
        }
    );
});

test("scan: .appmod/ namespaced docs are trusted and take precedence over root", async () => {
    await withRepo(
        {
            ".appmod/plan.md": "## P0\n- [ ] from appmod\n",
            "plan.md": "## P0\n- [ ] from root\n- [ ] root two\n",
        },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.plan.steps.length, 1, "uses .appmod/plan.md, not the root copy");
            assert.equal(s.plan.steps[0].title, "from appmod");
        }
    );
});

test("scan: a non-directory path is reported unavailable (not scanned)", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const s = await scanRepo(join(dir, "pom.xml"), { includeGit: false });
        assert.equal(s.ok, false, "a file path is not a repo");
    });
});

test("scan: steps carry their section heading", async () => {
    const md = "# Plan\n## P0 — Build\n- [x] a\n- [ ] b\n## P1 — Secrets\n- [ ] c\n";
    await withRepo({ ...PROV, "progress.md": md }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        const byTitle = Object.fromEntries(s.progress.steps.map((x) => [x.title, x.section]));
        assert.equal(byTitle["a"], "P0 — Build");
        assert.equal(byTitle["b"], "P0 — Build");
        assert.equal(byTitle["c"], "P1 — Secrets");
    });
});

test("scan: ordering computes the active phase, ranks, and per-phase counts", async () => {
    const md =
        "# Plan\n## Assessment\n- [x] a1\n- [x] a2\n" +
        "## P0 — Build consistency\n- [x] b1\n- [ ] b2\n" +
        "## P1 — Secrets & identity\n- [ ] c1\n- [ ] c2\n" +
        "## Validation gates\n- [ ] v1\n";
    await withRepo({ ...PROV, "progress.md": md }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.ordering.activeRank, 1, "P0 is the active rank");
        assert.match(s.ordering.activePhase, /P0/);
        // Per-phase roll-up.
        const byName = Object.fromEntries(s.ordering.phases.map((p) => [p.name, p]));
        assert.equal(byName["Assessment"].done, 2);
        assert.equal(byName["Assessment"].total, 2);
        assert.equal(byName["P0 — Build consistency"].done, 1);
        assert.equal(byName["P0 — Build consistency"].total, 2);
        assert.equal(byName["P1 — Secrets & identity"].done, 0);
        // Each step carries a phase rank; P1 steps sit ahead of the active P0.
        const byTitle = Object.fromEntries(s.progress.steps.map((x) => [x.title, x.rank]));
        assert.equal(byTitle["a1"], 0);
        assert.equal(byTitle["b2"], 1);
        assert.equal(byTitle["c1"], 2);
        assert.ok(byTitle["c1"] > s.ordering.activeRank, "P1 step is ahead of sequence (locked)");
    });
});

test("scan: ordering activeRank is null once every ranked step is done", async () => {
    const md = "# Plan\n## Assessment\n- [x] a\n## P0 — Build\n- [x] b\n";
    await withRepo({ ...PROV, "progress.md": md }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.ordering.activeRank, null);
        assert.equal(s.ordering.activePhase, null);
    });
});


test("scan: discovers custom skills from .github/skills", async () => {
    await withRepo(
        {
            ".github/skills/my-skill/SKILL.md": "name: My Skill\ndescription: Does a thing\n",
            ".github/skills/other/SKILL.md": "# Other Skill\n",
        },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.skills.length, 2);
            const mine = s.skills.find((x) => x.folder === "my-skill");
            assert.equal(mine.name, "My Skill");
            assert.equal(mine.description, "Does a thing");
        }
    );
});

test("scan: git branch + migration detection + dirty flag", async () => {
    await withRepo({ "pom.xml": "<project/>", "README.md": "x" }, async (dir) => {
        git(dir, "init", "-b", "modernize-java21");
        git(dir, "config", "user.email", "t@example.com");
        git(dir, "config", "user.name", "Test");
        git(dir, "add", ".");
        git(dir, "commit", "-m", "init", "--no-gpg-sign");

        let s = await scanRepo(dir);
        assert.equal(s.git.branch, "modernize-java21");
        assert.equal(s.git.isMigrationBranch, true);
        assert.equal(s.git.dirty, false);

        await writeFile(join(dir, "new.txt"), "hi");
        s = await scanRepo(dir);
        assert.equal(s.git.dirty, true);
        assert.equal(s.git.changedFiles, 1);
    });
});

// ===========================================================================
// doctor.mjs (environment readiness)
// ===========================================================================

function fakeExec(map) {
    // map: cmd -> { stdout?, stderr?, error? }   (missing cmd => ENOENT)
    return async (cmd) => {
        const r = map[cmd];
        if (!r) return { error: Object.assign(new Error("not found"), { code: "ENOENT" }), stdout: "", stderr: "" };
        return { error: r.error || null, stdout: r.stdout || "", stderr: r.stderr || "" };
    };
}

test("doctor: parseToolVersion handles java (stderr), node, and generic output", () => {
    assert.equal(parseToolVersion("java", 'openjdk version "17.0.2" 2022-01-18'), "17.0.2");
    assert.equal(parseToolVersion("node", "v22.3.0"), "22.3.0");
    assert.equal(parseToolVersion("git", "git version 2.39.5"), "2.39.5");
    assert.equal(parseToolVersion("x", ""), null);
});

test("doctor: probeOne reports not-found on ENOENT and found otherwise", async () => {
    const exec = fakeExec({ java: { stderr: 'openjdk version "21.0.1"' } });
    const found = await probeOne({ key: "java", cmd: "java", args: ["-version"] }, exec);
    assert.deepEqual(found, { key: "java", found: true, version: "21.0.1" });
    const missing = await probeOne({ key: "mvn", cmd: "mvn", args: ["-v"] }, exec);
    assert.equal(missing.found, false);
});

test("doctor: Maven timeout is retried and never reported as not installed", async () => {
    const maven = TOOL_PROBES.find((probe) => probe.key === "mvn");
    const timedOut = { error: Object.assign(new Error("timed out"), { killed: true }), stdout: "", stderr: "" };
    let runs = 0;
    const recovered = await probeOne(maven, async () => ++runs === 1 ? timedOut :
        { error: null, stdout: "Apache Maven 3.9.9", stderr: "" });
    assert.deepEqual(recovered, { key: "mvn", found: true, version: "3.9.9" });
    assert.equal(runs, 2);

    const stalled = await probeOne(maven, async () => timedOut);
    assert.equal(stalled.reason, "timeout");
    const report = buildDoctorReport({
        probes: { java: { found: true, version: "21" }, git: { found: true }, mvn: stalled },
        scan: { assessment: { buildTool: "Maven", javaVersion: "21" } },
    });
    const build = report.groups.flatMap((group) => group.checks).find((check) => check.id === "build");
    assert.match(build.detail, /timed out/i);
    assert.doesNotMatch(build.detail, /not found/i);
    assert.equal(build.action.kind, "recheck_env");
});

test("doctor: Azure CLI retries a timeout and reports a persistent timeout", async () => {
    const azure = TOOL_PROBES.find((probe) => probe.key === "az");
    assert.deepEqual(azure.args, ["version", "--output", "json"]);
    const timedOut = { error: Object.assign(new Error("timed out"), { killed: true }), stdout: "", stderr: "" };
    let runs = 0;
    const recovered = await probeOne(azure, async () => ++runs === 1 ? timedOut :
        { error: null, stdout: '{"extensions":{"spring":"9.9.9"},"azure-cli":"2.91.0"}', stderr: "" });
    assert.deepEqual(recovered, { key: "az", found: true, version: "2.91.0" });
    assert.equal(runs, 2);

    const stalled = await probeOne(azure, async () => timedOut);
    const report = buildDoctorReport({ probes: { az: stalled }, scan: {} });
    const check = report.groups.flatMap((group) => group.checks).find((item) => item.id === "az");
    assert.equal(check.status, "info");
    assert.match(check.detail, /timed out/i);
    assert.equal(check.action.kind, "recheck_env");
});

test("doctor: Windows finds a Maven .cmd shim on PATH", { skip: process.platform !== "win32" }, async () => {
    await withRepo({ "mvn.cmd": "@echo off\r\necho Apache Maven 3.9.9 (test)\r\n" }, async (dir) => {
        const env = { ...process.env, PATH: dir + ";" + process.env.PATH };
        const exec = makeExec(env);
        assert.deepEqual(await probeOne(TOOL_PROBES.find((probe) => probe.key === "mvn"), exec),
            { key: "mvn", found: true, version: "3.9.9" });
        const untrusted = await exec("mvn", ["-v & echo unexpected"]);
        assert.ok(untrusted.error, "only the fixed version probe may use cmd.exe");
        assert.doesNotMatch(untrusted.stdout, /unexpected/);
    });
});

test("doctor: probeOne rejects the macOS java stub (non-zero exit, no version)", async () => {
    const stub = async () => ({
        error: Object.assign(new Error("exit 1"), { code: 1 }),
        stdout: "",
        stderr: "The operation couldn't be completed. Unable to locate a Java Runtime.",
    });
    const r = await probeOne({ key: "java", cmd: "java", args: ["-version"] }, stub);
    assert.equal(r.found, false, "stub with no real version is treated as not installed");
});

test("doctor: missing JDK + missing Maven (no wrapper) blocks readiness", () => {
    const rep = buildDoctorReport({
        probes: { git: { found: true, version: "2.39" } },
        scan: { ok: true, assessment: { buildTool: "Maven", hasMavenWrapper: false }, git: { branch: "main" }, plan: {}, progress: {} },
    });
    assert.equal(rep.overall, "blocked");
    const checks = rep.groups.flatMap((g) => g.checks);
    const jdk = checks.find((c) => c.id === "jdk");
    assert.equal(jdk.status, "fail");
    assert.ok(jdk.action && jdk.action.kind === "fix_env", "JDK failure offers a fix_env action");
    const build = checks.find((c) => c.id === "build");
    assert.equal(build.status, "fail");
});

test("doctor: a Maven wrapper satisfies the build-tool check without mvn installed", () => {
    const rep = buildDoctorReport({
        probes: { java: { found: true, version: "17" }, git: { found: true } },
        scan: { ok: true, assessment: { buildTool: "Maven", hasMavenWrapper: true }, git: { branch: "x" }, progress: { exists: true } },
    });
    const build = rep.groups.flatMap((g) => g.checks).find((c) => c.id === "build");
    assert.equal(build.status, "ok");
    assert.match(build.detail, /wrapper/i);
});

test("doctor: JDK version must satisfy the project and minimum toolchain", () => {
    const report = (version, projectVersion) => buildDoctorReport({
        probes: { java: { found: true, version }, git: { found: true }, mvn: { found: true } },
        scan: { ok: true, assessment: { buildTool: "Maven", javaVersion: projectVersion }, git: { branch: "x" }, progress: { exists: true } },
    });
    const jdk = (rep) => rep.groups.flatMap((group) => group.checks).find((check) => check.id === "jdk");
    const tooOld = report("17.0.12", "25");
    assert.equal(tooOld.overall, "blocked");
    assert.equal(jdk(tooOld).status, "fail");
    assert.match(jdk(tooOld).detail, /25/);
    assert.equal(jdk(tooOld).action.kind, "fix_env");
    assert.equal(jdk(report("11.0.19", "8")).status, "fail", "workflow requires JDK 17 at minimum");
    assert.equal(jdk(report(null, "21")).status, "fail", "an unverified Java version cannot be considered ready");
    assert.equal(jdk(report("25.0.1", "25")).status, "ok");
});

test("doctor: an Ant project needs Ant and an unrecognized build needs review", () => {
    const scan = { ok: true, assessment: { buildTool: "Ant", javaVersion: "17" }, git: { branch: "x" }, progress: { exists: true } };
    const probes = { java: { found: true, version: "17" }, git: { found: true } };
    const missing = buildDoctorReport({ scan, probes });
    assert.equal(missing.overall, "blocked");
    const build = (rep) => rep.groups[0].checks.find((check) => check.id === "build");
    assert.equal(build(missing).status, "fail");
    assert.equal(build(missing).action.kind, "fix_env");
    assert.equal(build(buildDoctorReport({ scan, probes: { ...probes, ant: { found: true, version: "1.10.14" } } })).status, "ok");
    const unknown = buildDoctorReport({ scan: { ...scan, assessment: { buildTool: null } }, probes });
    assert.equal(unknown.overall, "blocked");
    assert.match(build(unknown).detail, /build file/i);
});

test("doctor: a Dockerfile without Docker is a caution (warn), not a blocker", () => {
    const rep = buildDoctorReport({
        probes: { java: { found: true, version: "21" }, mvn: { found: true }, git: { found: true } },
        scan: { ok: true, assessment: { buildTool: "Maven", hasDockerfile: true }, git: { branch: "x" }, progress: { exists: true } },
    });
    const docker = rep.groups.flatMap((g) => g.checks).find((c) => c.id === "docker");
    assert.equal(docker.status, "warn");
    assert.equal(rep.overall, "caution");
});

test("doctor: no assessment yet surfaces a start_assessment action", () => {
    const rep = buildDoctorReport({
        probes: { java: { found: true }, mvn: { found: true }, git: { found: true } },
        scan: { ok: true, assessment: { buildTool: "Maven" }, git: { branch: "x" }, plan: { exists: false }, progress: { exists: false } },
    });
    const assessed = rep.groups.flatMap((g) => g.checks).find((c) => c.id === "assessed");
    assert.equal(assessed.status, "warn");
    assert.equal(assessed.action.kind, "start_assessment");
});

test("doctor: everything present is ready", () => {
    const rep = buildDoctorReport({
        probes: {
            java: { found: true, version: "21" }, mvn: { found: true }, git: { found: true },
            docker: { found: true }, az: { found: true }, azd: { found: true }, node: { found: true },
        },
        scan: { ok: true, assessment: { buildTool: "Maven" }, git: { branch: "modernize", isMigrationBranch: true }, progress: { exists: true }, skills: [{ folder: "a" }] },
    });
    assert.equal(rep.overall, "ready");
});

test("doctor: runDoctor probes every tool via the injected exec", async () => {
    const stub = fakeExec({
        java: { stderr: 'openjdk version "17.0.9"' },
        git: { stdout: "git version 2.40.0" },
    });
    const seen = [];
    const exec = async (cmd, args) => { seen.push(cmd); return stub(cmd, args); };
    const rep = await runDoctor(
        { ok: true, assessment: { buildTool: "Maven" }, git: { branch: "x" }, progress: { exists: true } },
        { exec }
    );
    assert.ok(rep.groups.length >= 3);
    assert.deepEqual(seen.sort(), TOOL_PROBES.map((probe) => probe.cmd).sort());
});

test("doctor: augmentedEnv covers Homebrew, keg JDKs, SDKMAN, and JAVA_HOME (macOS)", () => {
    // GUI apps inherit a minimal PATH; the doctor must still find tools the user's
    // terminal sees. Inject a directory lister so the test doesn't hit the filesystem.
    const lister = (d) => (d === "/opt/homebrew/opt" ? ["openjdk@21", "openjdk", "maven", "node@20"] : []);
    const env = augmentedEnv({ PATH: "/usr/bin:/bin", HOME: "/Users/x", JAVA_HOME: "/jh" }, "darwin", lister);
    const parts = env.PATH.split(":");
    assert.ok(parts.includes("/opt/homebrew/bin"), "Homebrew bin");
    assert.ok(parts.includes("/jh/bin"), "JAVA_HOME/bin");
    assert.ok(parts.includes("/Users/x/.sdkman/candidates/java/current/bin"), "SDKMAN");
    assert.ok(parts.includes("/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin"), "versioned keg");
    assert.ok(parts.includes("/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin"), "unversioned keg");
    assert.ok(!parts.some((p) => /\/maven\/libexec\/openjdk/.test(p)), "non-JDK kegs are skipped");
    assert.ok(env.PATH.endsWith("/usr/bin:/bin"), "original PATH preserved at the tail");
});

test("doctor: augmentedEnv is a no-op on Windows and tolerates a bare env", () => {
    assert.equal(augmentedEnv({ PATH: "C:\\Windows" }, "win32", () => []).PATH, "C:\\Windows");
    // No HOME/JAVA_HOME/PATH provided — must not throw and still prepend brew bins.
    const env = augmentedEnv({}, "darwin", () => []);
    assert.ok(env.PATH.split(":").includes("/opt/homebrew/bin"));
});

test("doctor: discoverJavaHome respects an explicit JAVA_HOME and skips rc files", async () => {
    let read = false;
    const readRc = async () => { read = true; return ""; };
    const jh = await discoverJavaHome({ JAVA_HOME: "/explicit/jdk" }, "darwin", readRc);
    assert.equal(jh, "/explicit/jdk");
    assert.equal(read, false, "must not read rc files when JAVA_HOME is already set");
});

test("doctor: discoverJavaHome statically parses a literal JAVA_HOME from the rc (no shell)", async () => {
    const reads = [];
    const readRc = async (p) => {
        reads.push(p);
        if (/\.zshrc$/.test(p)) {
            return 'export PATH="$HOME/bin:$PATH"\nexport JAVA_HOME="$HOME/.sdkman/candidates/java/current"\n';
        }
        return null;
    };
    const jh = await discoverJavaHome({ HOME: "/Users/x", SHELL: "/bin/zsh" }, "darwin", readRc);
    assert.equal(jh, "/Users/x/.sdkman/candidates/java/current", "expands $HOME, no execution");
    assert.ok(reads.some((p) => /\.zshrc$/.test(p)), "reads the zsh rc files");
});

test("doctor: discoverJavaHome returns null on Windows, no match, unresolved subst, or read error", async () => {
    assert.equal(await discoverJavaHome({ HOME: "/h" }, "win32", async () => "export JAVA_HOME=/x"), null);
    assert.equal(
        await discoverJavaHome({ HOME: "/h", SHELL: "/bin/zsh" }, "darwin", async () => "# nothing here"),
        null
    );
    // Command substitution can't be resolved statically -> null (falls back to PATH probing).
    assert.equal(
        await discoverJavaHome({ HOME: "/h", SHELL: "/bin/zsh" }, "darwin", async () =>
            "export JAVA_HOME=$(/usr/libexec/java_home -v 21)"
        ),
        null
    );
    assert.equal(
        await discoverJavaHome({ HOME: "/h", SHELL: "/bin/zsh" }, "darwin", async () => { throw new Error("boom"); }),
        null
    );
});

test("doctor: parseJavaHomeFromRc handles quotes, comments, ~ and last-wins", () => {
    assert.equal(parseJavaHomeFromRc("export JAVA_HOME=/opt/jdk17 # pinned", {}), "/opt/jdk17");
    assert.equal(parseJavaHomeFromRc("JAVA_HOME='/opt/jdk21'", {}), "/opt/jdk21");
    assert.equal(parseJavaHomeFromRc("export JAVA_HOME=~/jdks/21", { HOME: "/Users/x" }), "/Users/x/jdks/21");
    assert.equal(
        parseJavaHomeFromRc("export JAVA_HOME=/a\nexport JAVA_HOME=/b", {}),
        "/b",
        "later assignment wins"
    );
    assert.equal(parseJavaHomeFromRc("export NOTJAVA=/x", {}), null);
});

test("prompts: fix_env requires a tool and embeds the readiness detail", () => {
    const p = buildPrompt("fix_env", { tool: "a JDK", detail: "java not found", fix: "Install Temurin" }, "/r");
    assert.match(p, /a JDK/);
    assert.match(p, /java not found/);
    assert.match(p, /do not modify my application code/i);
    assert.match(p, /approval/i, "setup must ask before changing the local machine");
    assert.match(p, /install.*verify|verify.*install/is, "setup should perform and verify safe installation after approval");
    assert.equal(buildPrompt("fix_env", {}, "/r"), null);
});

test("scan: detects Maven/Gradle wrappers for the doctor", async () => {
    await withRepo({ "pom.xml": "<project/>", "mvnw": "#!/bin/sh\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasMavenWrapper, true);
        assert.equal(s.assessment.hasGradleWrapper, false);
    });
});

test("scan: detects Windows wrapper scripts (mvnw.cmd / gradlew.bat)", async () => {
    await withRepo({ "pom.xml": "<project/>", "mvnw.cmd": "@echo off\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasMavenWrapper, true, "mvnw.cmd counts as a wrapper");
    });
    await withRepo({ "build.gradle": "plugins {}", "gradlew.bat": "@echo off\n" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasGradleWrapper, true, "gradlew.bat counts as a wrapper");
    });
});

test("scan: Dockerfile detection is case-insensitive and accepts Containerfile", async () => {
    await withRepo({ "dockerfile": "FROM tomcat:9" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasDockerfile, true, "lowercase dockerfile");
    });
    await withRepo({ "Containerfile": "FROM tomcat:9" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.hasDockerfile, true, "Podman Containerfile");
    });
});

test("scan: multi-module repo unions Java version + deps across modules (not just the first)", async () => {
    await withRepo(
        {
            "pom.xml": "<project><packaging>pom</packaging><modules><module>api</module><module>worker</module></modules></project>",
            "api/pom.xml": "<project><properties><java.version>17</java.version></properties></project>",
            "worker/pom.xml":
                "<project><dependencies><dependency><groupId>com.rabbitmq</groupId><artifactId>amqp-client</artifactId></dependency></dependencies></project>",
        },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.equal(s.assessment.buildTool, "Maven");
            assert.equal(s.assessment.javaVersion, "17", "Java version comes from a module, not the aggregator");
            assert.ok(
                s.assessment.detectedKeys.includes("rabbitmq"),
                "a dependency declared only in a second module is still detected"
            );
        }
    );
});

test("scan: dependency matching no longer fires on English words containing a token", async () => {
    // "important"/"constant" contain "ant"; a plain substring match used to flag Ant.
    await withRepo(
        {
            "pom.xml":
                "<project><description>An important and constant service</description></project>",
        },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.ok(!s.assessment.detectedKeys.includes("ant"), "no false Ant detection");
        }
    );
    // A real Ant build is still flagged, via the build tool.
    await withRepo({ "build.xml": "<project default=\"build\"></project>" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.assessment.buildTool, "Ant");
        assert.ok(s.assessment.detectedKeys.includes("ant"), "genuine Ant build is detected");
    });
});

test("scan: a real coordinate token is still matched with boundary-aware logic", async () => {
    await withRepo(
        {
            "pom.xml":
                "<project><dependencies><dependency><artifactId>aws-java-sdk-s3</artifactId></dependency></dependencies></project>",
        },
        async (dir) => {
            const s = await scanRepo(dir, { includeGit: false });
            assert.ok(s.assessment.detectedKeys.includes("awsS3"));
        }
    );
});

test("scan: assessment.json is normalized (severity aliases, files string, bad shapes)", async () => {
    const raw = {
        findings: [
            { id: "a", severity: "critical", title: "x", files: "only/one.txt" },
            { id: "b", severity: "high", title: "y" },
            { id: "c", severity: "weird", title: "z", files: ["k.txt", 5] },
            "not-an-object",
            { severity: "low" },
        ],
        strengths: "single strength",
    };
    await withRepo({ ".appmod/assessment.json": JSON.stringify(raw) }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        const f = s.report.findings;
        assert.equal(f.length, 4, "non-object findings are dropped, valid ones kept");
        assert.equal(f[0].severity, "P0", "critical -> P0");
        assert.deepEqual(f[0].files, ["only/one.txt"], "string files -> array");
        assert.equal(f[1].severity, "P1", "high -> P1");
        assert.equal(f[2].severity, "P3", "unknown severity -> P3 (kept, not dropped)");
        assert.deepEqual(f[2].files, ["k.txt"], "non-string file entries filtered out");
        assert.equal(f[3].title, "Untitled finding", "missing title gets a fallback");
        assert.deepEqual(s.report.strengths, ["single strength"], "string strengths -> array");
    });
});

test("scan: checklist steps link exact finding IDs without changing their titles", () => {
    const steps = parseChecklist("## P0 Build\n- [ ] Upgrade runtime <!-- appmod-finding:service%3Aremoved-api%2F1 --> <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-task:rabbitmq-to-servicebus -->\n- [ ] Other task <!-- appmod-skill:team%20skill -->");
    assert.equal(steps[0].title, "Upgrade runtime");
    assert.deepEqual(steps[0].findingIds, ["service:removed-api/1"]);
    assert.equal(steps[0].id, "aaaaaaaaaaaaaaaa");
    assert.equal(steps[0].taskId, "rabbitmq-to-servicebus");
    assert.equal(steps[1].title, "Other task");
    assert.equal(steps[1].skillFolder, "team skill");
    assert.equal(steps[1].findingIds, undefined);
});

test("scan: findings link only uniquely identified current-plan steps and report real progress", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const marker = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = marker + "- [ ] Upgrade <!-- appmod-finding:api --> <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n" +
        "- [ ] Review CVEs <!-- appmod-finding:cve --> <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [
            { id: "api", title: "Removed API", severity: "P0" },
            { id: "cve", title: "Vulnerable dependency", severity: "P1" },
            { id: "unknown", title: "Other issue", severity: "P2" },
            { id: "unknown", title: "Duplicate ID", severity: "P2" },
        ] }),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": plan.replace("- [ ] Upgrade", "- [x] Upgrade"),
    }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        const [api, cve, unknown, duplicate] = state.report.findings;
        assert.equal(api.status, "done");
        assert.equal(api.planSteps[0].id, "aaaaaaaaaaaaaaaa");
        assert.equal(cve.status, "pending");
        assert.equal(cve.planSteps[0].title, "Review CVEs");
        assert.equal(unknown.status, "unmatched");
        assert.deepEqual(unknown.planSteps, []);
        assert.deepEqual(duplicate.planSteps, []);
    });
});

test("scan: findings retain impact, recommendation and structured evidence", async () => {
    const raw = { findings: [
        { id: "legacy", severity: "high", title: "Older result", files: "src/Main.java" },
        { id: "api", severity: "critical", title: "Removed API", impact: "Breaks on Java 21",
            recommendation: "Replace the removed call", files: ["src/Api.java"],
            evidence: [{ file: "src/Api.java", line: 42, detail: "Uses removed API" }, "Dependency warning", { line: -1 }, null] },
    ] };
    await withRepo({ ".appmod/assessment.json": JSON.stringify(raw) }, async (dir) => {
        const findings = (await scanRepo(dir, { includeGit: false })).report.findings;
        assert.equal(findings[0].impact, "");
        assert.deepEqual(findings[0].evidence, []);
        assert.equal(findings[1].impact, "Breaks on Java 21");
        assert.equal(findings[1].recommendation, "Replace the removed call");
        assert.deepEqual(findings[1].evidence, [
            { file: "src/Api.java", line: 42, detail: "Uses removed API" },
            { detail: "Dependency warning" },
        ]);
    });
});

test("scan: unified assessment v1 preserves rule severity, incidents and security evidence", async () => {
    const raw = {
        version: "1.0.0", producer: "Modernization assessment",
        metadata: { id: "report-one", name: "Java assessment", status: "completed", analysisStartTime: "2026-01-01T00:00:00Z", domains: ["java-upgrade", "security"], targetIds: ["openjdk21"] },
        projects: [{ path: "service", properties: { appName: "Orders", jdkVersion: "8" }, incidents: [
            { ruleId: "removed-api", incidentId: "removed-api/1", location: "src/Main.java", locationKind: "source-file", line: 42, message: "Uses removed API", snippet: "oldCall()" },
        ] }],
        rules: { "removed-api": { id: "removed-api", title: "Removed API", severity: "mandatory", effort: 5, domain: "java-upgrade", category: "deprecated-apis", description: "This call is unavailable in Java 21" } },
        security: [{ id: "CVE-2026-001", title: "Vulnerable dependency", category: "dependency", severity: "potential", description: "Update the library", evidence: { files: ["pom.xml"], explanation: "Affected version is present" } }],
    };
    await withRepo({ ".appmod/assessment.json": JSON.stringify(raw) }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportStatus, "ready");
        assert.equal(state.report.severityScale, "unified");
        assert.equal(state.report.findings.length, 2);
        assert.deepEqual(state.report.findings[0], {
            id: "service:removed-api/1", severity: "mandatory", domain: "java-upgrade", category: "deprecated-apis",
            title: "Removed API", detail: "This call is unavailable in Java 21", impact: "", recommendation: "",
            files: ["service/src/Main.java"], evidence: [{ file: "service/src/Main.java", line: 42, detail: "Uses removed API", snippet: "oldCall()" }],
            planSteps: [], status: "unmatched",
        });
        assert.equal(state.report.findings[1].severity, "potential");
        assert.equal(state.report.findings[1].domain, "security");
        assert.deepEqual(state.report.findings[1].evidence, [{ file: "pom.xml", detail: "Affected version is present" }]);
    });
});

test("scan: native assessment report is read-only and cannot approve an unrelated plan", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const nativeReport = (name, time) => ({
        version: "1.0.0", producer: "Modernization assessment",
        metadata: { id: name, name, status: "completed", analysisStartTime: time, domains: ["java-upgrade"], targetIds: ["openjdk21"] },
        projects: [{ path: ".", properties: { appName: "Orders" }, incidents: [] }], rules: {},
    });
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".github/modernize/reports/report-old/report.json": JSON.stringify(nativeReport("Older report", "2025-01-01T00:00:00Z")),
        ".github/modernize/reports/report-new/report.json": JSON.stringify(nativeReport("Newer report", "2026-01-01T00:00:00Z")),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade",
    }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportStatus, "ready");
        assert.equal(state.reportSource, "native");
        assert.equal(state.reportPath, ".github/modernize/reports/report-new/report.json");
        assert.equal(state.report.headline, "Newer report");
        assert.equal(state.reportConfigStatus, "unverified");
        assert.notEqual(state.planApprovalStatus, "approved");
    });
});

test("scan: in-progress unified report does not count as a finished assessment", async () => {
    const raw = { version: "1.0.0", producer: "Modernization assessment",
        metadata: { id: "report-one", name: "Java assessment", status: "running", analysisStartTime: "2026-01-01T00:00:00Z", domains: [], targetIds: [] },
        projects: [], rules: {} };
    await withRepo({ ".appmod/assessment.json": JSON.stringify(raw) }, async (dir) => {
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.reportStatus, "running");
        assert.notEqual(state.reportConfigStatus, "current");
        assert.match((await renderClientTab(state, "assessment")).app(), /Assessment in progress/);
    });
});

test("scan: a non-object assessment.json yields a null report (no crash)", async () => {
    await withRepo({ ".appmod/assessment.json": "42" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.report, null);
    });
    await withRepo({ ".appmod/assessment.json": "[1,2,3]" }, async (dir) => {
        const s = await scanRepo(dir, { includeGit: false });
        assert.equal(s.report, null, "a top-level array is not a valid report");
    });
});



test("catalog: has 16 well-formed tasks", () => {
    assert.equal(PREDEFINED_TASKS.length, 16);
    for (const t of PREDEFINED_TASKS) {
        assert.ok(t.id && t.name && t.category && t.summary, "task fields present: " + t.id);
        assert.ok(Array.isArray(t.detect));
    }
    const ids = new Set(PREDEFINED_TASKS.map((t) => t.id));
    assert.equal(ids.size, PREDEFINED_TASKS.length, "ids are unique");
});

test("catalog: catalogWithRelevance flags only matching detect keys", () => {
    const withRel = catalogWithRelevance(["rabbitmq"]);
    assert.equal(withRel.find((t) => t.id === "rabbitmq-to-servicebus").relevant, true);
    assert.equal(withRel.find((t) => t.id === "aws-s3-to-blob").relevant, false);
});

// ===========================================================================
// prompts.mjs
// ===========================================================================

test("prompts: every labelled action builds a non-empty prompt", () => {
    for (const kind of Object.keys(ACTION_LABELS)) {
        const payload =
            kind === "run_task"
                ? { taskId: PREDEFINED_TASKS[0].id }
                : kind === "run_skill"
                ? { folder: "x" }
                : kind === "fix_finding" || kind === "explain_finding"
                ? { title: "Some finding" }
                : kind === "work_step"
                ? { title: "Some step" }
                : kind === "fix_env"
                ? { tool: "a JDK" }
                : {};
        const p = buildPrompt(kind, payload, "/repo");
        assert.ok(typeof p === "string" && p.length > 0, "prompt for " + kind);
    }
});

test("prompts: run_task unknown id returns null", () => {
    assert.equal(buildPrompt("run_task", { taskId: "nope" }, "/repo"), null);
});

test("prompts: run_task known id embeds the task name", () => {
    const p = buildPrompt("run_task", { taskId: "aws-s3-to-blob" }, "/repo");
    assert.match(p, /AWS S3 to Azure Storage Blob/);
});

test("prompts: assessment embeds repo path; generate_plan embeds target", () => {
    assert.match(buildPrompt("start_assessment", {}, "/my/repo"), /\/my\/repo/);
    assert.match(buildPrompt("generate_plan", { targetJava: 21 }, "/r"), /Java 21/);
});

test("prompts: assessment and plan generation link verified findings to stable mirrored steps", () => {
    for (const kind of ["start_assessment", "generate_plan"]) {
        const prompt = buildPrompt(kind, { id: "current-request", targetJava: 21 }, "/repo");
        assert.match(prompt, /<!-- appmod-step:<16-32 lowercase hex> -->/);
        assert.match(prompt, /<!-- appmod-finding:<encoded finding\.id> -->/);
        assert.match(prompt, /same step ID in both files and preserve it/);
        assert.match(prompt, /Copy the exact id from \.appmod\/assessment\.json and encode it with encodeURIComponent/);
        assert.match(prompt, /service%3Aremoved-api%2F1/);
        assert.match(prompt, /one marker per associated finding/);
        assert.match(prompt, /Do not invent finding IDs or link unrelated validation steps/);
        assert.match(prompt, /<!-- appmod-task:<task\.id> -->/);
        assert.match(prompt, /rabbitmq-to-servicebus \(RabbitMQ to Azure Service Bus\)/);
        assert.match(prompt, /<!-- appmod-skill:<encoded folder> -->/);
        assert.match(prompt, /keep these markers when renaming steps/);
        assert.match(prompt, /<!-- appmod-assessment-id:current-request -->/);
    }
});

test("prompts: appmod tools referenced by hash command", () => {
    assert.match(buildPrompt("run_cve", {}, "/r"), /#appmod-validate-cves-for-java/);
    assert.match(buildPrompt("generate_tests", {}, "/r"), /#appmod-generate-tests-for-java/);
});

test("prompts: unknown kind returns null", () => {
    assert.equal(buildPrompt("bogus", {}, "/r"), null);
});

test("prompts: fix_finding embeds the finding title/detail and needs a title", () => {
    const p = buildPrompt("fix_finding", { title: "TLS off", detail: "encrypt=false", files: ["db.properties"], severity: "P1" }, "/r");
    assert.match(p, /TLS off/);
    assert.match(p, /encrypt=false/);
    assert.match(p, /db\.properties/);
    assert.equal(buildPrompt("fix_finding", {}, "/r"), null, "no title -> null");
});

test("prompts: start_assessment instructs writing structured assessment.json", () => {
    const p = buildPrompt("start_assessment", {}, "/my/repo");
    assert.match(p, /\.appmod\/assessment\.json/);
    assert.match(p, /findings/);
    assert.match(p, /P0\|P1\|P2\|P3/);
    assert.match(p, /"impact"/);
    assert.match(p, /"evidence"/);
    assert.match(p, /Use Assessment in user-facing chat/);
    assert.doesNotMatch(p, /AppCAT/i);
});

test("prompts: fix_finding has a label in ACTION_LABELS", () => {
    assert.ok(ACTION_LABELS.fix_finding, "fix_finding should be labelled");
});

test("prompts: work_step embeds the step title + phase and requires a title", () => {
    const p = buildPrompt("work_step", { title: "Add ingress TLS", section: "P1 — Secrets & identity" }, "/r");
    assert.match(p, /Add ingress TLS/);
    assert.match(p, /P1 — Secrets & identity/);
    assert.match(p, /progress\.md/);
    assert.equal(buildPrompt("work_step", {}, "/r"), null, "no title -> null");
});

// ===========================================================================
// renderer.mjs
// ===========================================================================

test("renderer: returns full HTML doc with app root and boot blob", () => {
    const html = renderHtml({ instanceId: "abc", initialTab: "plan" });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /id="app"/);
    assert.match(html, /Java Modernization Studio/);
    assert.match(html, /"initialTab":"plan"/);
    assert.match(html, /"instanceId":"abc"/);
});

test("renderer: defaults initialTab to assessment", () => {
    const html = renderHtml({ instanceId: "x" });
    assert.match(html, /"initialTab":"assessment"/);
});

test("renderer: button hover is contrast-safe (no inverted emphasis background)", () => {
    const html = renderHtml({ instanceId: "css" });
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    // Regression: a `:hover` must never swap a dark-text button onto the dark
    // `--background-color-emphasis` surface (that made hovered text unreadable).
    assert.ok(!/:hover[^}]*background-color-emphasis/.test(css), "no emphasis background on hover");
    // The default (non-primary) button keeps a readable surface on hover.
    assert.match(css, /button\.btn:not\(\.primary\):not\(:disabled\):hover/);
    // Keyboard users get a visible focus ring.
    assert.match(css, /button\.btn:focus-visible/);
});

test("renderer: boot blob escapes < so it cannot break out of <script>", () => {
    const html = renderHtml({ instanceId: "</script><script>bad", initialTab: "overview" });
    // The dangerous literal must not appear as a real closing tag + injected script.
    assert.ok(!html.includes("</script><script>bad"));
    assert.match(html, /\\u003c\/script>/);
});

test("renderer: includes an Assess tab and shared status/findings UI", () => {
    const html = renderHtml({ instanceId: "z", initialTab: "assessment" });
    assert.match(html, /data-tab="assessment"/);
    assert.match(html, /assessmentTab/);
    assert.match(html, /function workflowStatus/);
    assert.match(html, /function heroNext/);
    assert.match(html, /findingCard/);
    assert.match(html, /goto:assessment/);
    assert.match(html, /"initialTab":"assessment"/);
});

test("renderer: shared status, findings, and narrow-screen controls have layout rules", () => {
    const html = renderHtml({ instanceId: "z" });
    assert.match(html, /\.workflow-overview/);
    assert.match(html, /\.finding\.sev-P0/);
    assert.match(html, /@media \(max-width: 600px\)/);
    assert.match(html, /\.global-controls \{ flex: 1 1 100%; min-width: 0; flex-wrap: wrap; \}/);
    assert.match(html, /ul\.steps li \.stext \{ flex: 1; min-width: 0; overflow-wrap: anywhere; \}/);
    assert.match(html, /ul\.steps li \.srhs \{ flex: 1 1 100%; min-width: 0; margin-left: 25px;/);
    assert.match(html, /\.banner > span:not\(\.spin\):not\(\.spacer\) \{ flex: 1 1 200px; min-width: 0; \}/);
    assert.match(html, /\.banner \{[^}]*flex-wrap: wrap; overflow-wrap: anywhere;/);
});

test("renderer: Plan tab is actionable with reviewed steps and skills", () => {
    const html = renderHtml({ instanceId: "z", initialTab: "plan" });
    assert.match(html, /function planTab/);
    assert.match(html, /work_step/);
    assert.match(html, /stepRowAction/);
    assert.match(html, /planReview/);
    assert.match(html, /mappedExecution/);
    assert.match(html, /Work on this/);
});

test("renderer: Plan tab retains phase locks and override", async () => {
    const html = (await renderClientTab(sampleState(), "plan")).app();
    assert.match(html, /after P0/);
    assert.match(html, /Do anyway/);
    assert.match(html, /Upgrade Java/);
});

test("renderer: Assessment-tab findings honor the same phase locks", async () => {
    const report = { findings: [{ id: "later", title: "Later finding", severity: "P2",
        planSteps: [{ id: "aaaaaaaaaaaaaaaa", status: "pending", rank: 3 }] }] };
    const html = (await renderClientTab(sampleState({ report }), "assessment")).app();
    assert.match(html, /Later finding/);
    assert.match(html, /after P0/);
    assert.match(html, /data-kind="fix_finding"/);
});

test("renderer: assessment shows impact and recommended action with escaped evidence detail", async () => {
    const report = { findings: [
        { id: "api", severity: "P1", title: "Removed API", detail: "Obsolete call", impact: "Breaks on Java 21",
            recommendation: "Use the replacement API", files: ["src/Api.java"],
            evidence: [{ file: "src/Api.java", line: 42, detail: "<script>unsafe</script>" }] },
    ] };
    const html = (await renderClientTab(sampleState({ report }), "assessment")).app();
    assert.match(html, /Impact:<\/strong> Breaks on Java 21/);
    assert.match(html, /Suggested action:<\/strong> Use the replacement API/);
    assert.match(html, /<summary>Evidence \(1\)<\/summary>/);
    assert.match(html, /src\/Api\.java:42/);
    assert.ok(!html.includes("<script>unsafe</script>"));
    assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
    const legacy = (await renderClientTab(sampleState(), "assessment")).app();
    assert.ok(!legacy.includes("<summary>Evidence"));
});

test("renderer: assessment severity filter preserves source totals without posting an action", async () => {
    const client = await driveClient(sampleState(), { initialTab: "assessment" }).ready();
    assert.match(client.app(), /Java 8 is EOL/);
    assert.match(client.app(), /Vulnerable dependency/);
    await client.clickKind("filter_severity", { severity: "P1" });
    assert.doesNotMatch(client.app(), /Java 8 is EOL/);
    assert.match(client.app(), /Vulnerable dependency/);
    assert.match(client.app(), /aria-pressed="true"[^>]*>P1<\/button>/);
    assert.match(client.app(), /P0 · 1/);
    assert.deepEqual(client.posts(), []);
    await client.clickKind("filter_severity", { severity: "all" });
    assert.match(client.app(), /Java 8 is EOL/);
});

test("renderer: unified assessment renders source severity, rule evidence and filters", async () => {
    const report = { severityScale: "unified", lifecycleStatus: "completed", findings: [
        { id: "one", severity: "mandatory", domain: "java-upgrade", category: "deprecated-apis", title: "Removed API",
            files: ["service/src/Main.java"], evidence: [{ file: "service/src/Main.java", line: 42, snippet: "<oldCall()>" }] },
        { id: "two", severity: "potential", domain: "security", category: "dependency", title: "Vulnerable dependency",
            files: ["pom.xml"], evidence: [] },
    ] };
    const client = await driveClient(sampleState({ report }), { initialTab: "assessment" }).ready();
    assert.match(client.app(), /Mandatory · 1/);
    assert.match(client.app(), /Potential · 1/);
    assert.doesNotMatch(client.app(), /P0 · 1/);
    assert.match(client.app(), /service\/src\/Main\.java:42/);
    assert.match(client.app(), /&lt;oldCall\(\)&gt;/);
    await client.clickKind("filter_severity", { severity: "potential" });
    assert.doesNotMatch(client.app(), /Removed API/);
    assert.match(client.app(), /Vulnerable dependency/);
    assert.deepEqual(client.posts(), []);
});

test("renderer: findings offer fixes only for mapped pending steps and never trust report actions", async () => {
    const report = { findings: [
        { id: "done", title: "Old blocker", severity: "P0", status: "done", planSteps: [{ id: "aaaaaaaaaaaaaaaa", title: "Old blocker", status: "done", rank: 1 }] },
        { id: "api", title: "Upgrade runtime", severity: "P1", status: "pending", planSteps: [{ id: "bbbbbbbbbbbbbbbb", title: "Replace API", section: "P1 Security", status: "pending", rank: 2 }],
            action: { kind: "run_task", payload: { taskId: "unrelated" } } },
        { id: "unknown", title: "Unplanned finding", severity: "P2", status: "unmatched", planSteps: [] },
    ] };
    const state = sampleState({ report, reportStatus: "ready", planApprovalStatus: "approved" });
    const html = (await renderClientTab(state, "assessment")).app();
    assert.equal((html.match(/data-kind="fix_finding"/g) || []).length, 1);
    assert.match(html, /data-payload="\{&quot;findingId&quot;:&quot;api&quot;,&quot;stepId&quot;:&quot;bbbbbbbbbbbbbbbb&quot;\}"/);
    assert.doesNotMatch(html, /data-kind="run_task"/);
    assert.match(html, /Not in plan/);
    assert.equal((html.match(/data-kind="explain_finding"/g) || []).length, 3);
    const overview = (await renderClientTab(state, "overview")).app();
    assert.doesNotMatch(overview, /Blocker — fix this first/);
});

test("renderer: approved findings batch confirms deduplicated scope before dispatch", async () => {
    const report = { findings: [
        { id: "api", title: "Removed API", severity: "P0", planSteps: [{ id: "aaaaaaaaaaaaaaaa", status: "pending" }] },
        { id: "duplicate", title: "Related API", severity: "P1", planSteps: [{ id: "aaaaaaaaaaaaaaaa", status: "pending" }] },
        { id: "unmatched", title: "No step", severity: "P2", planSteps: [] },
    ] };
    const state = sampleState({ report, reportStatus: "ready", planApprovalStatus: "approved" });
    const client = await driveClient(state, { initialTab: "assessment" }).ready();
    assert.match(client.app(), /Run approved findings \(1\)/);
    assert.doesNotMatch(client.app(), /Start batch/);
    await client.clickKind("confirm_recommendations");
    assert.match(client.app(), /Run 1 approved finding step\(s\) in plan order\?/);
    assert.deepEqual(client.posts(), []);
    await client.clickKind("cancel_recommendations");
    assert.doesNotMatch(client.app(), /Start batch/);
    await client.clickKind("confirm_recommendations");
    await client.clickKind("autopilot_start", { scope: "recommendations" });
    assert.deepEqual(client.posts(), [{ kind: "autopilot_start", payload: { scope: "recommendations" } }]);
    const unapproved = (await renderClientTab(sampleState({ report, planApprovalStatus: "missing" }), "assessment")).app();
    assert.match(unapproved, /data-kind="confirm_recommendations"[^>]*disabled/);
});

test("renderer: native assessment explains its unverified scope", async () => {
    const report = { severityScale: "unified", lifecycleStatus: "completed", findings: [] };
    const state = sampleState({ report, reportStatus: "ready", reportSource: "native", reportPath: ".github/modernize/reports/report-1/report.json" });
    const html = (await renderClientTab(state, "assessment")).app();
    assert.match(html, /native assessment report/);
    assert.match(html, /scope is not linked to this canvas plan/);
    assert.match(html, /report-1\/report\.json/);
});

test("renderer: Readiness stays accessible through global controls", async () => {
    const view = await renderClientTab(sampleState(), "readiness");
    assert.match(view.app(), /Environment readiness/);
    assert.match(view.app(), /data-kind="recheck_env"/);
    assert.match(view.controls(), /data-kind="goto:readiness"/);
});

test("renderer: a blocked first snapshot enters guided Readiness", async () => {
    const blocked = sampleState({ doctor: { overall: "blocked", groups: [] } });
    assert.match((await renderClientTab(blocked, "assessment")).app(), /Not ready yet/);
    assert.match((await renderClientTab(sampleState(), "readiness")).app(), /data-kind="goto:assessment"/);
});

// Execute the serialized client against a realistic state and return the #app
// HTML for a given tab. Runs the script with `new Function` (global scope, NOT
// this module's lexical scope) so a stray reference to an undeclared variable
// surfaces as a real ReferenceError instead of silently resolving to a leaked
// local — that scope leak is exactly what hid a "dead Plan tab" regression.
async function renderClientTab(state, initialTab) {
    const html = renderHtml({ instanceId: "exec", initialTab });
    const script = html.split("<script>")[1].split("</script>")[0];
    const slots = {};
    const make = (id) => ({
        _html: "", id,
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
        classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, style: {}, dataset: {}, textContent: "",
    });
    const win = { __APPMOD__: { instanceId: "exec", initialTab }, addEventListener() {}, location: {}, scrollTo() {} };
    const ES = class { constructor() {} addEventListener() {} close() {} };
    const doc = {
        getElementById: (id) => { if (!slots[id]) slots[id] = make(id); return slots[id]; },
        querySelectorAll: () => [],
        querySelector: (s) => { if (typeof s === "string" && s[0] === "#") { const id = s.slice(1); if (!slots[id]) slots[id] = make(id); return slots[id]; } return null; },
        addEventListener() {}, createElement: () => make("x"), body: make("body"),
    };
    const fetchShim = async () => ({ ok: true, json: async () => state });
    // Inject our shims as the only free identifiers the client uses, so the body
    // runs against them rather than this module's lexical scope.
    const fn = new Function("window", "document", "EventSource", "fetch", "setTimeout", "clearTimeout", "console", script);
    fn(win, doc, ES, fetchShim, setTimeout, clearTimeout, console);
    // The client renders once synchronously (Loading), then loadState() fetches
    // and re-renders async — let those microtasks settle before reading #app.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    return { app: () => (slots.app ? slots.app._html : ""), controls: () => (slots.controls ? slots.controls._html : "") };
}

// A realistic snapshot with a multi-phase plan, an assessment report, gates, an
// environment report, and no autopilot run — exercises the common render paths.
function sampleState(extra = {}) {
    const steps = [
        { title: "Fix the build", section: "P0 Build", status: "in_progress", rank: 1 },
        { title: "Patch CVEs", section: "P1 Security", status: "pending", rank: 2 },
        { title: "Upgrade Java", section: "P2 Runtime", status: "pending", rank: 3 },
    ];
    return {
        ok: true, repoPath: "/demo/app", scannedAt: new Date().toISOString(),
        status: "in_progress", percent: 10,
        assessment: { buildTool: "Maven", javaVersion: "8", springBoot: true, hasDockerfile: true, detectedKeys: [] },
        tasks: [], skills: [],
        git: { branch: "modernize/java21", isMigrationBranch: true, dirty: true, changedFiles: 3 },
        plan: { exists: true, steps }, progress: { exists: true, steps },
        summary: { exists: false, markdown: "" },
        report: {
            generatedAt: new Date().toISOString(), headline: "Java 8 Spring app", summary: "Outdated runtime and deps.",
            stack: { buildTool: "Maven", java: "8", framework: "Spring Boot", database: "MSSQL", container: "Docker" },
            findings: [
                { id: "java8", severity: "P0", title: "Java 8 is EOL", detail: "Upgrade the runtime.", files: ["pom.xml"], action: { kind: "generate_plan", payload: { targetJava: 21 }, label: "Plan upgrade" } },
                { id: "cve", severity: "P1", title: "Vulnerable dependency", detail: "Bump it.", files: [], action: { kind: "fix_finding", payload: {}, label: "Fix" } },
            ],
            strengths: ["Has a Dockerfile"],
        },
        ordering: { activeRank: 1, activePhase: "P0 Build", phases: [{ name: "P0 Build", rank: 1, done: 0, total: 1 }] },
        gates: { build: "not_run", tests: "not_run", cve: "not_run", consistency: "not_run", completeness: "not_run" },
        doctor: { overall: "ready", generatedAt: new Date().toISOString(), groups: [
            { id: "build", name: "Build & run", checks: [{ id: "jdk", label: "JDK", status: "ok", detail: "Java 21" }] },
        ] },
        autopilot: null,
        ...extra,
    };
}

test("renderer: every tab renders without throwing against a realistic state", async () => {
    const tabs = ["overview", "readiness", "assessment", "plan", "validation", "tasks", "summary"];
    for (const tab of tabs) {
        const r = await renderClientTab(sampleState(), tab);
        const out = r.app();
        assert.ok(out && out.length > 40, "tab '" + tab + "' produced no body");
        assert.ok(!/hit an error/.test(out), "tab '" + tab + "' fell back to the error banner");
    }
});

test("renderer: three primary tabs preserve legacy destinations and global status", async () => {
    const shell = renderHtml({ instanceId: "exec" });
    const nav = shell.match(/<nav class="tabs">([\s\S]*?)<\/nav>/)?.[1] || "";
    assert.deepEqual([...nav.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]), ["assessment", "plan", "validation"]);
    const state = sampleState();
    const view = await renderClientTab(state, "overview");
    assert.match(view.app(), /aria-label="Workflow status"/);
    assert.match(view.controls(), /data-kind="goto:readiness"/);
    assert.match((await renderClientTab(state, "tasks")).app(), /Assessment settings/);
    assert.match((await renderClientTab(state, "summary")).app(), /Validation gates/);
    const running = sampleState({ autopilot: { running: true, scope: "phase", status: "running", current: { title: "Upgrade" }, completed: [] } });
    assert.match((await renderClientTab(running, "validation")).app(), /data-kind="autopilot_stop"/);
});

test("renderer: overview stays compact while global controls retain branch, refresh, Autopilot and summary", async () => {
    const state = sampleState({ planApprovalStatus: "approved", summary: { exists: true, markdown: "# Outcome\nValidated" },
        autopilot: { running: false, status: "completed", scope: "phase", completed: [{ title: "Fix build", done: true }] } });
    const assess = await renderClientTab(state, "assessment");
    assert.match(assess.app(), /<details class="summary-details"><summary>Summary<\/summary>/);
    assert.match(assess.app(), /Execution history \(1\)/);
    assert.doesNotMatch(assess.app(), /Your modernization journey|<h2>Stack<\/h2>|Run on autopilot/);
    assert.match(assess.controls(), /modernize\/java21/);
    assert.match(assess.controls(), /data-kind="refresh"/);
    assert.match(assess.controls(), /data-kind="autopilot_start"/);
    const plan = (await renderClientTab(state, "plan")).app();
    assert.doesNotMatch(plan, /Continue here · recommended next step|Recommended approach|card autopilot/);
    const running = sampleState({ autopilot: { running: true, scope: "phase", status: "running", current: { title: "Fix build" }, completed: [] } });
    assert.match((await renderClientTab(running, "assessment")).controls(), /data-kind="autopilot_stop"/);
});

test("renderer: persistent next action routes to the relevant view and permits handoff", async () => {
    const gates = { build: "done", tests: "done", cve: "done", consistency: "pending", completeness: "pending" };
    const state = sampleState({ planApprovalStatus: "approved", report: null, gates });
    const html = (await renderClientTab(state, "plan")).app();
    assert.match(html, /Next: Check consistency/);
    assert.match(html, /data-kind="goto:validation"/);
    const shipped = sampleState({ planApprovalStatus: "approved", status: "completed",
        gates: { build: "done", tests: "done", cve: "done", consistency: "done", completeness: "done" } });
    assert.match((await renderClientTab(shipped, "validation")).app(), /data-kind="open_pr"/);
});

test("renderer: report availability is distinct from plan progress in workflow status", async () => {
    const state = sampleState({
        status: "not_started", ordering: { activePhase: null },
        plan: { exists: false, steps: [] }, progress: { exists: false, steps: [] },
        reportStatus: "ready", assessmentConfig: { id: "request", module: "service", targetJava: 21, cloud: "Azure" },
        reportConfigStatus: "unverified", planConfigStatus: "missing",
    });
    const stage = async (value) => (await renderClientTab(value, "assessment")).app().match(/<div class="workflow-stage">([\s\S]*?)<\/div>/)?.[1];
    const unverified = await stage(state);
    assert.match(unverified, /Assessment review/);
    assert.match(unverified, /Report available · settings need review/);
    assert.doesNotMatch(unverified, /Assessment<\/strong><span>Not started/);

    const current = await stage({ ...state, reportConfigStatus: "current" });
    assert.match(current, /<strong>Plan<\/strong>/);
    assert.match(current, /Report ready · plan not started/);

    const missing = await stage({ ...state, report: null, reportStatus: "missing", assessmentConfig: null });
    assert.match(missing, /Assessment<\/strong><span>Not started/);
});

test("renderer: Plan tab actually renders its checklist when executed (regression)", async () => {
    const r = await renderClientTab(sampleState(), "plan");
    const out = r.app();
    assert.match(out, /Plan &amp; Progress/);
    assert.match(out, /Fix the build/);
    assert.match(out, /data-kind="work_step"/);
    assert.match(out, /Review plan/);
    assert.ok(!/hit an error/.test(out));
});

test("renderer: evidence-backed Plan steps retain exact task and skill execution", async () => {
    const steps = [
        { id: "aaaaaaaaaaaaaaaa", title: "Migrate messaging transport", taskId: "rabbitmq-to-servicebus", section: "P0 Build", status: "pending", rank: 1 },
        { id: "bbbbbbbbbbbbbbbb", title: "Apply local guidance", skillFolder: "team-skill", section: "P0 Build", status: "pending", rank: 1 },
        { id: "cccccccccccccccc", title: "Unrelated task", section: "P0 Build", status: "pending", rank: 1 },
    ];
    const report = { findings: [
        { id: "msg", severity: "P0", title: "Messaging migration", planSteps: [steps[0]] },
        { id: "skill", severity: "P0", title: "Custom migration", planSteps: [steps[1]] },
    ] };
    const state = sampleState({ report, reportStatus: "ready", planApprovalStatus: "approved",
        plan: { exists: true, steps }, progress: { exists: true, steps },
        tasks: [PREDEFINED_TASKS[0], PREDEFINED_TASKS[1]], skills: [{ folder: "team-skill", name: "Team skill" }] });
    const html = (await renderClientTab(state, "plan")).app();
    assert.match(html, /data-kind="run_task"[^>]*rabbitmq-to-servicebus/);
    assert.match(html, /data-kind="run_skill"[^>]*team-skill/);
    assert.equal((html.match(/data-kind="run_task"/g) || []).length, 1);
    assert.match(html, /Unrelated task/);
    const titleOnly = steps.map((step) => ({ ...step,
        title: step.taskId ? PREDEFINED_TASKS[0].name : step.skillFolder ? "Run .github/skills/team-skill/" : step.title,
        taskId: undefined, skillFolder: undefined }));
    const unlinked = sampleState({ report: { findings: [
        { id: "msg", planSteps: [titleOnly[0]] }, { id: "skill", planSteps: [titleOnly[1]] },
    ] }, reportStatus: "ready", planApprovalStatus: "approved",
    plan: { exists: true, steps: titleOnly }, progress: { exists: true, steps: titleOnly },
    tasks: [PREDEFINED_TASKS[0]], skills: [{ folder: "team-skill", name: "Team skill" }] });
    assert.doesNotMatch((await renderClientTab(unlinked, "plan")).app(), /data-kind="run_(?:task|skill)"/);
});

test("renderer: unassessed task catalog is not an execution view and skills remain discoverable", async () => {
    const state = sampleState({ report: null, reportStatus: "missing",
        tasks: PREDEFINED_TASKS.map((task) => ({ ...task, relevant: true })),
        skills: [{ folder: "team-skill", name: "Team skill" }] });
    const shell = renderHtml({ instanceId: "exec", initialTab: "tasks" });
    assert.doesNotMatch(shell, /data-tab="tasks"/);
    assert.doesNotMatch((await renderClientTab(state, "overview")).app(), /data-kind="run_task"/);
    assert.doesNotMatch((await renderClientTab(state, "tasks")).app(), /Microsoft predefined tasks/);
    assert.match((await renderClientTab(state, "plan")).app(), /\.github\/skills\//);
});

test("renderer: recommendation batch reports its scope and resumes only pending findings", async () => {
    const state = sampleState({ autopilot: { running: false, status: "stuck", scope: "recommendations",
        stuck: "Fix API", completed: [{ title: "Fix API", done: false }] } });
    const html = (await renderClientTab(state, "assessment")).app();
    assert.match(html, /data-kind="autopilot_start"[^>]*scope&quot;:&quot;recommendations/);
    assert.doesNotMatch(html, /Continue \(next phase\)/);
    assert.match(html, /approved findings/);
});

test("renderer: plan review edits and approves the current revision before execution", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const markdown = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    const state = sampleState({
        assessmentConfig: config, reportConfigStatus: "current", planConfigStatus: "current", planApprovalStatus: "missing",
        plan: { exists: true, steps: [{ title: "Upgrade", section: null, status: "pending" }], revision: "revision-one", editableMarkdown: markdown, path: ".appmod/plan.md" },
    });
    const client = await driveClient(state, { initialTab: "plan", actionResponse: { ok: true, state, message: "Saved" } }).ready();
    assert.match(client.app(), /data-kind="work_step"[^>]*disabled/);
    assert.doesNotMatch((await renderClientTab(state, "plan")).controls(), /data-kind="autopilot_start"/);
    assert.match(client.app(), /data-kind="approve_plan"/);
    await client.clickKind("edit_plan");
    assert.match(client.app(), /id="plan-editor"/);
    client.setValue("plan-editor", markdown.replace("Upgrade", "Upgrade Java"));
    await client.clickKind("save_plan");
    assert.deepEqual(client.posts()[0], { kind: "save_plan", payload: { revision: "revision-one", markdown: markdown.replace("Upgrade", "Upgrade Java") } });
    await client.clickKind("approve_plan");
    assert.deepEqual(client.posts()[1], { kind: "approve_plan", payload: { revision: "revision-one" } });
});

test("renderer: legacy plan requires explicit review before linking to the current assessment", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const markdown = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    const state = sampleState({
        assessmentConfig: config, reportConfigStatus: "current", planConfigStatus: "unverified", planApprovalStatus: "missing",
        reportRevision: "report-one", progress: { exists: true, steps: [], revision: "progress-one" },
        plan: { exists: true, adoptable: true, steps: [{ title: "Upgrade", section: null, status: "pending" }],
            revision: "plan-one", editableMarkdown: markdown, path: ".appmod/plan.md" },
    });
    const client = await driveClient(state, { initialTab: "plan" }).ready();
    assert.match(client.app(), /data-kind="edit_plan"/);
    assert.doesNotMatch(client.app(), /data-kind="approve_plan"/);
    await client.clickKind("edit_plan");
    assert.match(client.app(), /id="confirm-adopt-plan"/);
    client.setValue("plan-editor", markdown);
    await client.clickKind("save_plan");
    assert.equal(client.posts().length, 0);
    client.setChecked("confirm-adopt-plan", true);
    await client.clickKind("save_plan");
    assert.deepEqual(client.posts()[0], { kind: "save_plan", payload: {
        revision: "plan-one", markdown, adopt: true, assessmentId: config.id,
        reportRevision: "report-one", progressRevision: "progress-one",
    } });
});

test("renderer: reviewed task choice links an existing finding step without relying on its title", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const markdown = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n" +
        "- [ ] RabbitMQ to Azure Service Bus <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-finding:msg -->";
    const step = parseChecklist(markdown)[0];
    const state = sampleState({
        assessmentConfig: config, reportConfigStatus: "current", planConfigStatus: "current", planApprovalStatus: "approved",
        plan: { exists: true, steps: [step], revision: "plan-one", editableMarkdown: markdown, path: ".appmod/plan.md" },
        progress: { exists: true, steps: [step] },
        report: { findings: [{ id: "msg", planSteps: [step] }] }, tasks: [PREDEFINED_TASKS[0]],
    });
    const client = await driveClient(state, { initialTab: "plan" }).ready();
    assert.doesNotMatch(client.app(), /data-kind="run_task"/);
    await client.clickKind("edit_plan");
    assert.match(client.app(), /data-step-link="aaaaaaaaaaaaaaaa"/);
    client.setValue("plan-editor", markdown);
    client.setStepLink("aaaaaaaaaaaaaaaa", "task:rabbitmq-to-servicebus");
    await client.clickKind("save_plan");
    assert.match(client.posts()[0].payload.markdown, /<!-- appmod-step:aaaaaaaaaaaaaaaa -->.*<!-- appmod-task:rabbitmq-to-servicebus -->/);
});

test("renderer: recommends the next unfinished validation gate", async () => {
    const state = sampleState({
        report: null,
        gates: { build: "done", tests: "done", cve: "done", consistency: "pending", completeness: "pending" },
    });
    const out = (await renderClientTab(state, "overview")).app();
    assert.match(out, /Next: Check consistency/);
    assert.match(out, /data-kind="goto:validation"/);
    const validation = (await renderClientTab(state, "validation")).app();
    assert.match(validation, /data-kind="run_consistency"/);
    assert.doesNotMatch(out, /data-kind="run_build_tests"/);
    assert.match(out, /Last checked/, "shared status identifies when the snapshot was actually scanned");
});

test("renderer: a running autopilot shows the live strip and freezes manual actions", async () => {
    const state = sampleState({
        autopilot: { running: true, scope: "phase", status: "running", current: { title: "Fix the build", section: "P0 Build" }, completed: [{ title: "Earlier", section: "P0 Build", done: true }], maxSteps: 25 },
    });
    const r = await renderClientTab(state, "plan");
    const out = r.app();
    assert.match(out, /Autopilot running/);
    assert.match(out, /autopilot_stop/);
    assert.match(out, /Earlier/); // step log
    assert.match(out, /data-kind="work_step"[^>]*disabled/); // manual buttons frozen
});

test("renderer: assessment distinguishes invalid output from zero findings", async () => {
    const empty = (await renderClientTab(sampleState({ reportStatus: "ready", report: { findings: [], headline: "No issues found" } }), "assessment")).app();
    assert.match(empty, /Assessment results/);
    assert.match(empty, /No findings/);
    assert.doesNotMatch(empty, /No assessment yet/);
    const invalid = (await renderClientTab(sampleState({ reportStatus: "invalid", report: null }), "assessment")).app();
    assert.match(invalid, /Assessment results unavailable/);
    assert.match(invalid, /data-kind="submit_assessment"/);
    assert.match(invalid, /Re-run assessment/);
});

// Drive the live client: capture its click handler + EventSource so a test can
// fire a real button click and simulate an SSE (re)connect, then read #app.
// fetch routes GET /state -> current snapshot, POST /action -> a scripted result.
function driveClient(initialState, opts = {}) {
    const initialTab = opts.initialTab || "readiness";
    const html = renderHtml({ instanceId: "drive", initialTab });
    const script = html.split("<script>")[1].split("</script>")[0];
    const slots = {};
    const stepLinks = [];
    const make = (id) => ({
        _html: "", id,
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
        addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
        classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, style: {}, dataset: {}, textContent: "",
    });
    let clickHandler = null;
    const es = { onopen: null, onmessage: null, onerror: null, addEventListener() {}, close() {} };
    const win = { __APPMOD__: { instanceId: "drive", initialTab }, addEventListener() {}, location: {}, scrollTo() {} };
    const ES = function () { return es; }; // `new ES()` yields our singleton
    const doc = {
        getElementById: (id) => { if (!slots[id]) slots[id] = make(id); return slots[id]; },
        querySelectorAll: (selector) => selector === "select[data-step-link]" ? stepLinks : [],
        querySelector: (s) => { if (typeof s === "string" && s[0] === "#") { const id = s.slice(1); if (!slots[id]) slots[id] = make(id); return slots[id]; } return null; },
        addEventListener: (type, fn) => { if (type === "click") clickHandler = fn; },
        createElement: () => make("x"), body: make("body"),
    };
    let getState = initialState;
    let getStateCalls = 0;
    const getStateUrls = [];
    const posts = [];
    const fetchShim = async (url, init) => {
        if (init && init.method === "POST") {
            posts.push(JSON.parse(init.body));
            return { ok: true, json: async () => (opts.actionResponse || { ok: true, message: "ok" }) };
        }
        getStateCalls++;
        getStateUrls.push(url);
        return { ok: true, json: async () => getState };
    };
    new Function("window", "document", "EventSource", "fetch", "setTimeout", "clearTimeout", "console", script)(win, doc, ES, fetchShim, setTimeout, clearTimeout, console);
    const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
    return {
        async ready() { await settle(); return this; },
        app: () => (slots.app ? slots.app._html : ""),
        posts: () => posts,
        setValue(id, value) { if (!slots[id]) slots[id] = make(id); slots[id].value = value; },
        setChecked(id, checked) { if (!slots[id]) slots[id] = make(id); slots[id].checked = checked; },
        setStepLink(id, value) { stepLinks.push({ dataset: { stepLink: id, original: "" }, value }); },
        getStateCalls: () => getStateCalls,
        getStateUrls: () => getStateUrls,
        setGetState(s) { getState = s; },
        async clickKind(kind, payload) {
            const btnEl = { disabled: false, dataset: { kind, payload: JSON.stringify(payload || {}) } };
            const ev = { target: { closest: (sel) => (sel.indexOf("nav.tabs") === 0 ? null : btnEl) } };
            clickHandler(ev);
            await settle();
        },
        async reconnect() { if (es.onopen) es.onopen(); await settle(); },
    };
}

test("renderer: assessment settings recall saved scope and require explicit submission", async () => {
    const state = sampleState({
        report: null, reportStatus: "missing",
        assessmentConfig: { id: "last-request", module: "service", targetJava: 17, cloud: "Azure" },
        assessment: { buildTool: "Maven", modules: ["service"], detectedKeys: [] },
    });
    const client = await driveClient(state, { initialTab: "assessment" }).ready();
    assert.match(client.app(), /<option value="service" selected>/);
    assert.match(client.app(), /<option value="17" selected>/);
    await client.clickKind("start_assessment");
    assert.equal(client.posts().length, 0, "entry buttons only open settings");
    client.setValue("assessment-module", ".");
    client.setValue("assessment-java", "21");
    await client.clickKind("submit_assessment");
    assert.deepEqual(client.posts()[0], {
        kind: "start_assessment", payload: { module: ".", targetJava: 21, cloud: "Azure" },
    });
});

test("renderer: stale assessment warns and disables actions tied to old artifacts", async () => {
    const config = { id: "new-request", module: ".", targetJava: 17, cloud: "Azure" };
    const stale = sampleState({ assessmentConfig: config, reportConfigStatus: "outdated", planConfigStatus: "outdated" });
    const overview = (await renderClientTab(stale, "overview")).app();
    assert.match(overview, /Re-run assessment/);
    const assessment = (await renderClientTab(stale, "assessment")).app();
    assert.match(assessment, /report.*review|assessment.*outdated/i);
    assert.doesNotMatch(assessment, /data-kind="generate_plan"|data-kind="fix_finding"/);
    assert.match(assessment, /data-kind="explain_finding"/);
    const plan = (await renderClientTab(stale, "plan")).app();
    assert.match(plan, /plan.*review|plan.*outdated/i);
    assert.match(plan, /data-kind="work_step"[^>]*disabled/);
    assert.doesNotMatch((await renderClientTab(stale, "plan")).controls(), /data-kind="autopilot_start"/);

    const reportCurrent = sampleState({ assessmentConfig: config, reportConfigStatus: "current", planConfigStatus: "outdated" });
    const next = (await renderClientTab(reportCurrent, "overview")).app();
    assert.match(next, /Generate.*plan/);
    assert.match(next, /data-kind="goto:plan"/);
    assert.match((await renderClientTab(reportCurrent, "plan")).app(), /data-kind="generate_plan"/);
});

test("renderer: invalid saved settings require a fresh assessment", async () => {
    const invalid = sampleState({ assessmentConfig: null, assessmentConfigStatus: "invalid" });
    const overview = (await renderClientTab(invalid, "overview")).app();
    assert.match(overview, /Saved assessment settings.*invalid/i);
    assert.match(overview, /data-kind="start_assessment"/);
    const assessment = (await renderClientTab(invalid, "assessment")).app();
    assert.match(assessment, /Saved assessment settings.*invalid/i);
    assert.doesNotMatch(assessment, /data-kind="fix_finding"/);
    assert.match(assessment, /data-kind="explain_finding"/);
});

test("renderer: a sent assessment without a report offers a clear retry", async () => {
    const pending = sampleState({
        report: null, reportStatus: "missing",
        plan: { exists: false, steps: [] }, progress: { exists: false, steps: [] },
        assessmentConfig: { id: "sent-request", module: ".", targetJava: 21, cloud: "Azure" },
        reportConfigStatus: "missing", planConfigStatus: "missing",
    });
    const assessment = (await renderClientTab(pending, "assessment")).app();
    assert.match(assessment, /Assessment results unavailable/);
    assert.match(assessment, /Re-run assessment/);
    assert.doesNotMatch(assessment, /No assessment yet/);
    const overview = (await renderClientTab(pending, "overview")).app();
    assert.match(overview, /Assessment results unavailable/);
    assert.match(overview, /Re-run assessment/);
});

test("renderer: recheck_env applies the inline result and never strands the spinner", async () => {
    // Backend returns a fresh, now-ready snapshot inline (res.state) — the client
    // must apply it directly, not fall back to the agent-style 'pending' banner
    // that only clears on an SSE broadcast (which can be lost on a provider restart).
    const blocked = sampleState({ doctor: { overall: "blocked", generatedAt: "t", groups: [{ id: "build", name: "Build", checks: [{ id: "jdk", label: "JDK", status: "fail", detail: "java not found" }] }] } });
    const ready = sampleState({ doctor: { overall: "ready", generatedAt: "t2", groups: [{ id: "build", name: "Build", checks: [{ id: "jdk", label: "JDK", status: "ok", detail: "Java 21" }] }] } });
    const c = await driveClient(blocked, { initialTab: "readiness", actionResponse: { ok: true, message: "Re-checked environment", state: ready } }).ready();
    assert.match(c.app(), /Not ready yet/); // starts blocked
    await c.clickKind("recheck_env", {});
    assert.match(c.app(), /Your environment is ready/); // inline state applied
    assert.ok(!/Watch the chat/.test(c.app()), "must not show the agent 'pending' spinner banner");
    assert.equal(c.getStateCalls(), 1, "recheck must not need an extra /state fetch (uses inline state)");
});

test("renderer: Refresh applies the fresh environment result", async () => {
    const blocked = sampleState({ doctor: { overall: "blocked", groups: [] } });
    const ready = sampleState({ doctor: { overall: "ready", groups: [] } });
    const c = await driveClient(blocked, { initialTab: "readiness", actionResponse: { ok: true, message: "Refreshed", state: ready } }).ready();
    await c.clickKind("refresh", {});
    assert.match(c.app(), /Your environment is ready/);
    assert.equal(c.getStateCalls(), 1, "Refresh uses the re-probing action rather than cached GET state");
});

test("renderer: an SSE reconnect resyncs state (recovers a missed broadcast)", async () => {
    const blocked = sampleState({ doctor: { overall: "blocked", generatedAt: "t", groups: [{ id: "build", name: "Build", checks: [{ id: "jdk", label: "JDK", status: "fail", detail: "x" }] }] } });
    const ready = sampleState({ doctor: { overall: "ready", generatedAt: "t2", groups: [{ id: "build", name: "Build", checks: [{ id: "jdk", label: "JDK", status: "ok", detail: "Java 21" }] }] } });
    const c = await driveClient(blocked, { initialTab: "readiness" }).ready();
    await c.reconnect();
    const before = c.getStateCalls();
    assert.equal(before, 1, "first SSE connection must not duplicate the initial readiness probe");
    assert.match(c.app(), /Not ready yet/);
    // Provider finished the recheck after a restart that dropped the broadcast;
    // backend state is now ready. The stream reconnects -> client must re-fetch.
    c.setGetState(ready);
    await c.reconnect();
    assert.equal(c.getStateCalls(), before + 1, "onopen must re-fetch /state");
    assert.match(c.getStateUrls().at(-1), /recheckEnv=1/, "reconnect must re-probe the local environment");
    assert.match(c.app(), /Your environment is ready/);
});

// ===========================================================================
// server.mjs
// ===========================================================================

test("server: resolveRepoPath precedence input > session > last, else null", () => {
    assert.equal(
        resolveRepoPath({ input: { repoPath: "/in" }, session: { workingDirectory: "/s" } }, "/last"),
        "/in"
    );
    assert.equal(resolveRepoPath({ session: { workingDirectory: "/s" } }, "/last"), "/s");
    assert.equal(resolveRepoPath({}, "/last"), "/last");
    // No process.cwd() fallback — unresolved means null (UI shows "repo not available").
    assert.equal(resolveRepoPath({}, null), null);
    assert.equal(resolveRepoPath({}, undefined), null);
});

test("server: broadcast writes SSE frame to every client", () => {
    const chunks = [];
    const rec = { sseClients: new Set([{ write: (s) => chunks.push(s) }]) };
    broadcast(rec, { type: "state", state: { ok: true } });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /^data: /);
    assert.match(chunks[0], /"type":"state"/);
});

test("server: pushState scans repo and broadcasts snapshot", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const chunks = [];
        const rec = { repoPath: dir, sseClients: new Set([{ write: (s) => chunks.push(s) }]) };
        const state = await pushState(rec);
        assert.equal(state.ok, true);
        assert.equal(chunks.length, 1);
        assert.match(chunks[0], /"buildTool":"Maven"/);
    });
});

test("server: dispatch refresh re-scans without sending a prompt", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let sent = 0;
        const rec = { repoPath: dir, sseClients: new Set() };
        const res = await dispatchAction(rec, "refresh", {}, { sendPrompt: async () => sent++ });
        assert.equal(res.ok, true);
        assert.equal(sent, 0);
    });
});

test("server: dispatch agent action forwards crafted prompt to sendPrompt", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const sentPrompts = [];
    const displayPrompts = [];
    const res = await dispatchAction(rec, "run_cve", {}, { sendPrompt: async (prompt, displayPrompt) => {
        sentPrompts.push(prompt);
        displayPrompts.push(displayPrompt);
    } });
    assert.equal(res.ok, true);
    assert.equal(res.label, "CVE scan");
    assert.equal(Object.hasOwn(res, "prompt"), false, "the canvas response must not echo internal instructions");
    assert.equal(sentPrompts.length, 1);
    assert.match(sentPrompts[0], /#appmod-validate-cves-for-java/);
    assert.match(displayPrompts[0], /vulnerabilit|CVE/i);
    assert.ok(displayPrompts[0].length < 100);
    assert.notEqual(displayPrompts[0], sentPrompts[0]);
});

test("server: assessment rejects modules outside the repo and unsupported targets", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const sent = [];
        for (const payload of [
            { module: "../outside", targetJava: 21, cloud: "Azure" },
            { module: ".", targetJava: "latest", cloud: "Azure" },
            { module: ".", targetJava: 21, cloud: "AWS" },
        ]) {
            const result = await dispatchAction(rec, "start_assessment", payload, { sendPrompt: async (prompt) => sent.push(prompt) });
            assert.equal(result.ok, false, JSON.stringify(payload));
        }
        assert.equal(sent.length, 0);
    });
    await withRepo({ "pom.xml": "<project/>", "notes/README.md": "text" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        let sent = false;
        const result = await dispatchAction(rec, "start_assessment", { module: "notes" }, {
            sendPrompt: async () => { sent = true; },
        });
        assert.equal(result.ok, false, "an arbitrary directory is not a build module");
        assert.equal(sent, false);
    });
});

test("server: assessment persists its selected scope and target with a request ID", async () => {
    await withRepo({ "pom.xml": "<project/>", "service/pom.xml": "<project/>" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const sent = [];
        const result = await dispatchAction(rec, "start_assessment", { module: "service", targetJava: 17, cloud: "Azure" }, {
            sendPrompt: async (prompt) => sent.push(prompt),
        });
        assert.equal(result.ok, true);
        const config = JSON.parse(await readFile(join(dir, ".appmod", "assessment-config.json"), "utf8"));
        assert.equal(config.module, "service");
        assert.equal(config.targetJava, 17);
        assert.equal(config.cloud, "Azure");
        assert.ok(config.id);
        assert.match(sent[0], /service/);
        assert.match(sent[0], /Java 17/);
        assert.ok(sent[0].includes(config.id));
        assert.equal((await scanRepo(dir, { includeGit: false })).assessmentConfig.id, config.id);
    });
});

test("server: re-assessment invalidates the previously linked report and plan", async () => {
    const options = { module: ".", targetJava: 21, cloud: "Azure" };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify({ ...options, id: "first-request" }),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: "first-request", assessmentConfig: options, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:first-request -->\n- [ ] Upgrade",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        assert.equal((await scanRepo(dir, { includeGit: false })).reportConfigStatus, "current");
        const result = await dispatchAction(rec, "start_assessment", options, { sendPrompt: async () => {} });
        assert.equal(result.ok, true);
        const state = await scanRepo(dir, { includeGit: false });
        assert.notEqual(state.assessmentConfig.id, "first-request");
        assert.equal(state.reportConfigStatus, "outdated");
        assert.equal(state.planConfigStatus, "outdated");
    });
});

test("server: concurrent assessment requests cannot overwrite each other's settings", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        let releaseSend;
        let sendStarted;
        const started = new Promise((resolve) => { sendStarted = resolve; });
        const first = dispatchAction(rec, "start_assessment", { targetJava: 17 }, {
            sendPrompt: async () => { sendStarted(); await new Promise((resolve) => { releaseSend = resolve; }); },
        });
        await started;
        let secondSent = false;
        const second = await dispatchAction(rec, "start_assessment", { targetJava: 21 }, {
            sendPrompt: async () => { secondSent = true; },
        });
        assert.equal(second.ok, false);
        const otherCanvas = { repoPath: dir, sseClients: new Set() };
        const third = await dispatchAction(otherCanvas, "start_assessment", { targetJava: 21 }, {
            sendPrompt: async () => { secondSent = true; },
        });
        assert.equal(third.ok, false, "another canvas for the same repo cannot overwrite the in-flight request");
        assert.equal(secondSent, false);
        releaseSend();
        assert.equal((await first).ok, true);
        assert.equal(JSON.parse(await readFile(join(dir, ".appmod", "assessment-config.json"), "utf8")).targetJava, 17);
    });
});

test("server: failed assessment send restores the prior settings", async () => {
    const config = '{"id":"previous","module":".","targetJava":21,"cloud":"Azure"}\n';
    await withRepo({ "pom.xml": "<project/>", ".appmod/assessment-config.json": config }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const result = await dispatchAction(rec, "start_assessment", { targetJava: 17 }, {
            sendPrompt: async () => { throw new Error("session unavailable"); },
        });
        assert.equal(result.ok, false);
        assert.equal(await readFile(join(dir, ".appmod", "assessment-config.json"), "utf8"), config);
    });
});

test("server: a logging failure after sending does not roll back assessment settings", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        let sent = false;
        const result = await dispatchAction(rec, "start_assessment", { targetJava: 17 }, {
            sendPrompt: async () => { sent = true; },
            log: () => { throw new Error("logger failed"); },
        });
        assert.equal(sent, true);
        assert.equal(result.ok, true);
        assert.equal(JSON.parse(await readFile(join(dir, ".appmod", "assessment-config.json"), "utf8")).targetJava, 17);
    });
});

test("server: edited or malformed persisted settings cannot authorize execution", async () => {
    const config = { id: "tampered", module: "../outside", targetJava: 17, cloud: "Azure" };
    for (const rawConfig of [JSON.stringify(config), "{ invalid JSON"]) {
        await withRepo({
            "pom.xml": "<project/>",
            ".appmod/assessment-config.json": rawConfig,
            ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
            ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:tampered -->\n- [ ] Upgrade",
        }, async (dir) => {
            const rec = { repoPath: dir, sseClients: new Set() };
            const sent = [];
            const deps = { sendPrompt: async (prompt) => sent.push(prompt), runTurn: async () => {} };
            assert.equal((await dispatchAction(rec, "generate_plan", {}, deps)).ok, false);
            assert.equal((await dispatchAction(rec, "work_step", { title: "Upgrade" }, deps)).ok, false);
            assert.equal((await dispatchAction(rec, "autopilot_start", {}, deps)).ok, false);
            assert.equal(sent.length, 0);
        });
    }
});

test("server: stale assessment blocks execution but current report can regenerate its plan", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: "old-request", assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:old-request -->\n- [ ] Upgrade",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const sent = [];
        const deps = { sendPrompt: async (prompt) => sent.push(prompt), runTurn: async () => {} };
        assert.equal((await dispatchAction(rec, "run_task", { taskId: "cache-to-redis" }, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "autopilot_start", {}, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "generate_plan", { targetJava: 21 }, deps)).ok, false);
        assert.equal(sent.length, 0);

        await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }));
        const plan = await dispatchAction(rec, "generate_plan", { targetJava: 21 }, deps);
        assert.equal(plan.ok, true);
        assert.match(sent[0], /Java 17/);
        assert.ok(sent[0].includes(config.id));
        assert.doesNotMatch(sent[0], /Java 21/);
        assert.equal((await dispatchAction(rec, "work_step", { title: "Upgrade" }, deps)).ok, false);

        await writeFile(join(dir, ".appmod", "plan.md"), "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade");
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        assert.equal((await dispatchAction(rec, "work_step", { title: "Upgrade" }, deps)).ok, true);
        assert.ok(sent.at(-1).includes(config.id));
        assert.match(sent.at(-1), /Java 17/);
    });
});

test("server: current assessment and plan do not authorize unapproved code changes", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n- [ ] Upgrade",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        let sends = 0;
        const action = await dispatchAction(rec, "work_step", { title: "Upgrade" }, { sendPrompt: async () => sends++ });
        const autopilot = await dispatchAction(rec, "autopilot_start", { force: true }, { runTurn: async () => sends++ });
        assert.equal(action.ok, false);
        assert.equal(autopilot.ok, false);
        assert.equal(sends, 0);
    });
});

test("server: approval binds the current plan and assessment, and rejects stale review", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const plan = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n- [ ] Upgrade";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": plan,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: "outdated" }, {})).ok, false);
        const approved = await dispatchAction(rec, "approve_plan", { revision }, {});
        assert.equal(approved.ok, true);
        assert.equal((await scanRepo(dir, { includeGit: false })).planApprovalStatus, "approved");
        const sent = [];
        assert.equal((await dispatchAction(rec, "work_step", { title: "Upgrade", section: "P0 Build" }, { sendPrompt: async (prompt) => sent.push(prompt) })).ok, true);
        assert.equal(sent.length, 1);
        await writeFile(join(dir, ".appmod", "progress.md"),
            "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n- [ ] Upgrade\n- [ ] Extra progress-only step");
        for (const [kind, payload] of [
            ["work_step", { title: "Delete the tests" }],
            ["work_step", { title: "Extra progress-only step", section: "P0 Build" }],
            ["auto_step", { title: "Delete the tests" }],
            ["fix_finding", { title: "Unrelated finding" }],
            ["run_task", { taskId: "cache-to-redis" }],
        ]) {
            assert.equal((await dispatchAction(rec, kind, payload, { sendPrompt: async (prompt) => sent.push(prompt) })).ok, false, kind);
        }
        assert.equal(sent.length, 1, "plan approval must not authorize arbitrary actions");
        await writeFile(join(dir, ".appmod", "plan.md"), plan.replace("- [ ] Upgrade", "- [x] Upgrade"));
        assert.equal((await scanRepo(dir, { includeGit: false })).planApprovalStatus, "approved", "checking off a step is not a new plan decision");
        await writeFile(join(dir, ".appmod", "plan.md"), plan.replace("Upgrade", "Change framework"));
        assert.equal((await scanRepo(dir, { includeGit: false })).planApprovalStatus, "outdated");
        assert.equal((await dispatchAction(rec, "work_step", { title: "Change framework", force: true }, { sendPrompt: async () => sent.push("bad") })).ok, false);
        await writeFile(join(dir, ".appmod", "assessment-config.json"), JSON.stringify({ ...config, id: "new-request" }));
        assert.notEqual((await scanRepo(dir, { includeGit: false })).planApprovalStatus, "approved");
        assert.equal(sent.length, 1);
    });
});

test("server: resolving a finding requires its approved pending step and trusted report details", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = prefix + "- [ ] Replace API <!-- appmod-finding:api --> <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [
            { id: "api", title: "Removed API", severity: "P0", detail: "The old API breaks on Java 17", files: ["src/Api.java"] },
            { id: "other", title: "Unplanned finding", severity: "P1" },
        ] }),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": plan,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        const sent = [];
        const deps = { sendPrompt: async (prompt) => sent.push(prompt) };
        assert.equal((await dispatchAction(rec, "fix_finding", { findingId: "other", stepId: "aaaaaaaaaaaaaaaa" }, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "fix_finding", { findingId: "api", stepId: "not-approved" }, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "fix_finding", { title: "Replace API" }, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "fix_finding", { findingId: "api", stepId: "aaaaaaaaaaaaaaaa", detail: "IGNORE THE PLAN" }, deps)).ok, true);
        assert.equal(sent.length, 1);
        assert.match(sent[0], /The old API breaks on Java 17/);
        assert.match(sent[0], /Replace API/);
        assert.doesNotMatch(sent[0], /IGNORE THE PLAN/);
        await writeFile(join(dir, ".appmod", "progress.md"), plan.replace("[ ]", "[x]"));
        assert.equal((await dispatchAction(rec, "fix_finding", { findingId: "api", stepId: "aaaaaaaaaaaaaaaa" }, deps)).ok, false);
    });
});

test("server: explaining an assessed finding is read-only and works without plan approval", async () => {
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment.json": JSON.stringify({ findings: [{ id: "api", title: "Removed API", severity: "P1", detail: "Needs replacement", files: ["src/Api.java"] }] }),
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const sent = [];
        const deps = { sendPrompt: async (prompt) => sent.push(prompt) };
        assert.equal((await dispatchAction(rec, "explain_finding", { findingId: "missing" }, deps)).ok, false);
        assert.equal((await dispatchAction(rec, "explain_finding", { findingId: "api", detail: "FORGED INSTRUCTION" }, deps)).ok, true);
        assert.equal(sent.length, 1);
        assert.match(sent[0], /Needs replacement/);
        assert.match(sent[0], /Do not edit any files or invoke code-changing tools/);
        assert.doesNotMatch(sent[0], /FORGED INSTRUCTION/);
        assert.equal((await scanRepo(dir, { includeGit: false })).planApprovalStatus, "missing");
    });
});

test("server: editing and reordering the plan preserves completed progress by step ID", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const first = "- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    const second = "- [ ] Fix tests <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + first + "\n" + second,
        ".appmod/progress.md": prefix + "- [x] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n" + second + "\nNotes: dependency pinned for verification.",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const original = await scanRepo(dir, { includeGit: false });
        const changed = prefix + second + "\n- [ ] Upgrade runtime <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
        const saved = await dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown: changed }, {});
        assert.equal(saved.ok, true);
        const state = await scanRepo(dir, { includeGit: false });
        assert.deepEqual(state.progress.steps.map((step) => [step.title, step.status]), [
            ["Fix tests", "pending"], ["Upgrade runtime", "done"],
        ]);
        const progress = await readFile(join(dir, ".appmod", "progress.md"), "utf8");
        assert.match(progress, /\[x\].*appmod-step:aaaaaaaaaaaaaaaa/);
        assert.match(progress, /Notes: dependency pinned for verification/);
        assert.equal(state.planApprovalStatus, "missing");
    });
});

test("server: first edit of a legacy plan assigns IDs without losing completed progress", async () => {
    const config = { id: "legacy-request", module: ".", targetJava: 21, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:legacy-request -->\n## P0 Build\n";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + "- [ ] Upgrade\n- [ ] Fix tests",
        "progress.md": prefix + "- [x] Upgrade\n- [ ] Fix tests\nNotes: keep this detail.",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const original = await scanRepo(dir, { includeGit: false });
        assert.match(original.plan.editableMarkdown, /Upgrade <!-- appmod-step:[a-f0-9]{16} -->/);
        const markdown = original.plan.editableMarkdown.replace("- [ ] Upgrade ", "- [ ] Upgrade runtime ");
        assert.equal((await dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown }, {})).ok, true);
        const current = await scanRepo(dir, { includeGit: false });
        assert.deepEqual(current.progress.steps.map((step) => [step.title, step.status]), [
            ["Upgrade runtime", "done"], ["Fix tests", "pending"],
        ]);
        const progress = await readFile(join(dir, "progress.md"), "utf8");
        assert.match(progress, /\[x\] Upgrade runtime <!-- appmod-step:[a-f0-9]{16} -->/);
        assert.match(progress, /Notes: keep this detail/);
    });
});

test("server: reviewed legacy plan links to the current assessment without approving or losing progress", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const plan = "<!-- appmod-cockpit -->\n## P0 Build\n- [ ] Upgrade\n- [ ] Fix tests";
    const progress = "<!-- appmod-cockpit -->\n## P0 Build\n- [x] Upgrade\n- [ ] Fix tests\nNotes: keep this detail.";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": progress,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const original = await scanRepo(dir, { includeGit: false });
        assert.equal(original.planConfigStatus, "unverified");
        assert.equal(original.plan.adoptable, true);
        const draft = original.plan.editableMarkdown;
        assert.ok(draft.startsWith("<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n"));
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: original.plan.revision }, {})).ok, false);
        assert.equal((await dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown: draft }, {})).ok, false);

        const request = {
            revision: original.plan.revision, markdown: draft, adopt: true, assessmentId: config.id,
            reportRevision: original.reportRevision, progressRevision: original.progress.revision,
        };
        for (const invalid of [
            { assessmentId: "another-request" }, { reportRevision: "stale-report" }, { progressRevision: "stale-progress" },
        ]) assert.equal((await dispatchAction(rec, "save_plan", { ...request, ...invalid }, {})).ok, false);
        const saved = await dispatchAction(rec, "save_plan", request, {});
        assert.equal(saved.ok, true);
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.planConfigStatus, "current");
        assert.equal(state.planApprovalStatus, "missing");
        assert.deepEqual(state.progress.steps.map((step) => [step.title, step.status]), [
            ["Upgrade", "done"], ["Fix tests", "pending"],
        ]);
        assert.match(await readFile(join(dir, ".appmod", "progress.md"), "utf8"), /Notes: keep this detail\./);
    });
});

test("server: legacy linkage rejects conflicting IDs and outdated reports", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const plain = "<!-- appmod-cockpit -->\n## P0 Build\n- [ ] Upgrade";
    const other = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:other-request -->\n## P0 Build\n- [ ] Upgrade";
    for (const [plan, progress, reportId] of [
        [plain, other, config.id], [other, plain, config.id], [plain, plain, "outdated-request"],
    ]) {
        await withRepo({
            "pom.xml": "<project/>",
            ".appmod/assessment-config.json": JSON.stringify(config),
            ".appmod/assessment.json": JSON.stringify({ assessmentId: reportId, assessmentConfig: config, findings: [] }),
            ".appmod/plan.md": plan,
            ".appmod/progress.md": progress,
        }, async (dir) => {
            const rec = { repoPath: dir, sseClients: new Set() };
            const state = await scanRepo(dir, { includeGit: false });
            assert.equal(state.plan.adoptable, false);
            const result = await dispatchAction(rec, "save_plan", {
                revision: state.plan.revision, markdown: state.plan.editableMarkdown, adopt: true,
                assessmentId: config.id, reportRevision: state.reportRevision, progressRevision: state.progress.revision,
            }, {});
            assert.equal(result.ok, false);
            assert.equal(await readFile(join(dir, ".appmod", "plan.md"), "utf8"), plan);
            assert.equal(await readFile(join(dir, ".appmod", "progress.md"), "utf8"), progress);
        });
    }
});

test("server: relinking progress alone cannot resurrect a previous approval", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const plan = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n" +
        "- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": plan, ".appmod/progress.md": plan.replace("- [ ]", "- [x]"),
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const initial = await scanRepo(dir, { includeGit: false });
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: initial.plan.revision }, {})).ok, true);
        await writeFile(join(dir, ".appmod", "progress.md"),
            plan.replace("<!-- appmod-assessment-id:current-request -->\n", "").replace("- [ ]", "- [x]"));
        const legacy = await scanRepo(dir, { includeGit: false });
        assert.equal(legacy.plan.adoptable, true);
        assert.equal(legacy.planApprovalStatus, "outdated");
        const saved = await dispatchAction(rec, "save_plan", {
            revision: legacy.plan.revision, markdown: legacy.plan.editableMarkdown, adopt: true,
            assessmentId: config.id, reportRevision: legacy.reportRevision, progressRevision: legacy.progress.revision,
        }, {});
        assert.equal(saved.ok, true);
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.planConfigStatus, "current");
        assert.equal(state.progress.steps[0].status, "done");
        assert.equal(state.planApprovalStatus, "missing");
    });
});

test("server: namespaced legacy documents with CRLF or noncanonical headers can be linked", async () => {
    const config = { id: "current-request", module: ".", targetJava: 21, cloud: "Azure" };
    const cases = [
        ["## P0 Build\r\n- [ ] Upgrade", "## P0 Build\r\n- [x] Upgrade"],
        ["<!-- appmod-assessment-id:current-request -->\n## P0 Build\n- [ ] Upgrade",
            "## P0 Build\n- [x] Upgrade"],
    ];
    for (const [plan, progress] of cases) {
        await withRepo({
            "pom.xml": "<project/>",
            ".appmod/assessment-config.json": JSON.stringify(config),
            ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
            ".appmod/plan.md": plan, ".appmod/progress.md": progress,
        }, async (dir) => {
            const rec = { repoPath: dir, sseClients: new Set() };
            const original = await scanRepo(dir, { includeGit: false });
            assert.equal(original.plan.adoptable, true);
            assert.match(original.plan.editableMarkdown, /^<!-- appmod-cockpit -->\r?\n<!-- appmod-assessment-id:current-request -->\r?\n/);
            const saved = await dispatchAction(rec, "save_plan", {
                revision: original.plan.revision, markdown: original.plan.editableMarkdown, adopt: true,
                assessmentId: config.id, reportRevision: original.reportRevision, progressRevision: original.progress.revision,
            }, {});
            assert.equal(saved.ok, true);
            const state = await scanRepo(dir, { includeGit: false });
            assert.equal(state.planConfigStatus, "current");
            assert.equal(state.progress.steps[0].status, "done");
            assert.equal(state.planApprovalStatus, "missing");
        });
    }
});

test("server: plan edits reject stale, conflicting and destructive revisions", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const completed = "- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    const pending = "- [ ] Fix tests <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + completed + "\n" + pending,
        ".appmod/progress.md": prefix + completed.replace("[ ]", "[x]") + "\n" + pending,
        "plan.md": "<!-- appmod-cockpit -->\n- [ ] Root plan must not change",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const other = { repoPath: dir, sseClients: new Set() };
        const original = await scanRepo(dir, { includeGit: false });
        assert.equal(original.plan.path, ".appmod/plan.md");
        for (const markdown of [
            prefix + pending,
            (prefix + completed + "\n" + pending).replace("appmod-cockpit", "unrelated"),
            prefix + completed + "\n" + pending.replace("bbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaa"),
        ]) {
            assert.equal((await dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown }, {})).ok, false);
        }
        const [first, second] = await Promise.all([
            dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown: prefix + completed + "\n" + pending + "\nAssumption: one" }, {}),
            dispatchAction(other, "save_plan", { revision: original.plan.revision, markdown: prefix + completed + "\n" + pending + "\nAssumption: two" }, {}),
        ]);
        assert.equal(Number(first.ok) + Number(second.ok), 1);
        assert.equal((await dispatchAction(other, "save_plan", { revision: original.plan.revision, markdown: original.plan.editableMarkdown }, {})).ok, false);
        assert.match(await readFile(join(dir, "plan.md"), "utf8"), /Root plan must not change/);
        assert.match(await readFile(join(dir, ".appmod", "progress.md"), "utf8"), /\[x\] Upgrade/);
    });
});

test("server: saving a reviewed task link preserves completed progress and invalidates approval", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const plan = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n" +
        "- [ ] Migrate transport <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-finding:msg -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config,
            findings: [{ id: "msg", title: "Messaging", severity: "P0" }] }),
        ".appmod/plan.md": plan, ".appmod/progress.md": plan.replace("- [ ]", "- [x]"),
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const original = await scanRepo(dir, { includeGit: false });
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: original.plan.revision }, {})).ok, true);
        const markdown = original.plan.editableMarkdown.replace("<!-- appmod-step:aaaaaaaaaaaaaaaa -->",
            "<!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-task:rabbitmq-to-servicebus -->");
        const saved = await dispatchAction(rec, "save_plan", { revision: original.plan.revision, markdown }, {});
        assert.equal(saved.ok, true);
        const state = await scanRepo(dir, { includeGit: false });
        assert.equal(state.planApprovalStatus, "outdated");
        assert.equal(state.progress.steps[0].status, "done");
        assert.equal(state.plan.steps[0].taskId, "rabbitmq-to-servicebus");
        assert.match(await readFile(join(dir, ".appmod", "progress.md"), "utf8"), /\[x\].*<!-- appmod-task:rabbitmq-to-servicebus -->/);
    });
});

test("server: plan save does not overwrite files changed after its scan", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = prefix + "- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": plan,
    }, async (dir) => {
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        const externalPlan = plan + "\nExternal decision: use containers.";
        const externalProgress = plan.replace("[ ]", "[x]");
        const rec = {
            repoPath: dir, sseClients: new Set(),
            runDoctor: async () => {
                await writeFile(join(dir, ".appmod", "plan.md"), externalPlan);
                await writeFile(join(dir, ".appmod", "progress.md"), externalProgress);
                return { overall: "ready", groups: [] };
            },
        };
        const saved = await dispatchAction(rec, "save_plan", { revision, markdown: plan.replace("Upgrade", "Upgrade Java") }, {});
        assert.equal(saved.ok, false);
        assert.equal(await readFile(join(dir, ".appmod", "plan.md"), "utf8"), externalPlan);
        assert.equal(await readFile(join(dir, ".appmod", "progress.md"), "utf8"), externalProgress);
    });
});

test("server: predefined tasks and custom skills require a mapped current finding", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = prefix + "- [ ] Migrate messaging transport <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-task:rabbitmq-to-servicebus -->\n" +
        "- [ ] Apply local guidance <!-- appmod-step:bbbbbbbbbbbbbbbb --> <!-- appmod-skill:team-skill -->\n" +
        "- [ ] RabbitMQ to Azure Service Bus <!-- appmod-step:cccccccccccccccc --> <!-- appmod-finding:msg -->";
    await withRepo({
        "pom.xml": "<project/>", ".github/skills/team-skill/SKILL.md": "name: Team skill\n",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config,
            findings: [{ id: "msg", title: "Messaging migration", severity: "P0" },
                { id: "skill", title: "Custom migration", severity: "P0" }] }),
        ".appmod/plan.md": plan, ".appmod/progress.md": plan,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        const sent = [];
        const sendPrompt = async (prompt) => sent.push(prompt);
        assert.equal((await dispatchAction(rec, "run_task", { taskId: "rabbitmq-to-servicebus" }, { sendPrompt })).ok, false);
        assert.equal((await dispatchAction(rec, "run_skill", { folder: "team-skill" }, { sendPrompt })).ok, false);
        assert.equal(sent.length, 0);
        const mapped = plan.replace("transport <!--", "transport <!-- appmod-finding:msg --> <!--")
            .replace("guidance <!--", "guidance <!-- appmod-finding:skill --> <!--");
        await writeFile(join(dir, ".appmod", "plan.md"), mapped);
        const updatedRevision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: updatedRevision }, {})).ok, true);
        assert.equal((await dispatchAction(rec, "run_task", { taskId: "rabbitmq-to-servicebus" }, { sendPrompt })).ok, true);
        assert.equal((await dispatchAction(rec, "run_skill", { folder: "team-skill" }, { sendPrompt })).ok, true);
        assert.equal(sent.length, 2);
        const unlinked = mapped.replace(" <!-- appmod-task:rabbitmq-to-servicebus -->", "")
            .replace(" <!-- appmod-skill:team-skill -->", "");
        await writeFile(join(dir, ".appmod", "plan.md"), unlinked);
        const unlinkedRevision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision: unlinkedRevision }, {})).ok, true);
        assert.equal((await dispatchAction(rec, "run_task", { taskId: "rabbitmq-to-servicebus" }, { sendPrompt })).ok, false);
        assert.equal((await dispatchAction(rec, "run_skill", { folder: "team-skill" }, { sendPrompt })).ok, false);
        assert.equal(sent.length, 2);
    });
});

test("server: editing plan choices synchronizes pending progress entries", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const keep = "- [ ] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-finding:old -->";
    const remove = "- [ ] Old optional step <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    const add = "- [ ] Add tests <!-- appmod-step:cccccccccccccccc --> <!-- appmod-finding:new -->";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + keep + "\n" + remove,
        ".appmod/progress.md": prefix + keep.replace("[ ]", "[x]") + "\n" + remove,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "save_plan", { revision, markdown: prefix + keep.replace("appmod-finding:old", "appmod-finding:new") + "\n" + add }, {})).ok, true);
        const progress = await readFile(join(dir, ".appmod", "progress.md"), "utf8");
        assert.doesNotMatch(progress, /Old optional step/);
        assert.doesNotMatch(progress, /appmod-finding:old/);
        assert.match(progress, /\[x\] Upgrade <!-- appmod-step:aaaaaaaaaaaaaaaa --> <!-- appmod-finding:new -->/);
        assert.match(progress, /\[ \] Add tests <!-- appmod-step:cccccccccccccccc --> <!-- appmod-finding:new -->/);
        assert.deepEqual((await scanRepo(dir, { includeGit: false })).progress.steps.map((step) => [step.title, step.status]), [
            ["Upgrade", "done"], ["Add tests", "pending"],
        ]);
    });
});

test("server: Autopilot stops before the next step when assessment settings change", async () => {
    const config = { id: "original-request", module: ".", targetJava: 17, cloud: "Azure" };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:original-request -->\n## P0 Build\n- [ ] First\n- [ ] Second",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        const turns = [];
        const start = await dispatchAction(rec, "autopilot_start", { scope: "all" }, {
            runTurn: async (prompt) => {
                turns.push(prompt);
                await writeFile(join(dir, ".appmod", "assessment-config.json"), JSON.stringify({ ...config, id: "new-request" }));
            },
        });
        assert.equal(start.ok, true);
        await rec.autopilotPromise;
        assert.equal(turns.length, 1);
        assert.ok(turns[0].includes(config.id));
        assert.equal(rec.autopilot.status, "error");
        assert.match(rec.autopilot.error, /assessment|settings/i);
    });
});

test("server: Autopilot never executes progress-only steps outside the approved plan", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + "- [ ] Upgrade",
        ".appmod/progress.md": prefix + "- [ ] Upgrade\n- [ ] Unapproved extra",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        const turns = [];
        assert.equal((await dispatchAction(rec, "autopilot_start", { scope: "all" }, {
            runTurn: async (prompt) => {
                turns.push(prompt);
                await writeFile(join(dir, ".appmod", "progress.md"), prefix + "- [x] Upgrade\n- [ ] Unapproved extra");
            },
        })).ok, true);
        await rec.autopilotPromise;
        assert.equal(turns.length, 1);
        assert.equal(rec.autopilot.status, "completed");
    });
});

test("server: recommendation batch executes mapped findings only and rejects empty scope", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = prefix + "- [ ] Fix API <!-- appmod-finding:api --> <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n" +
        "- [ ] Run tests <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    const report = { assessmentId: config.id, assessmentConfig: config, findings: [{ id: "api", title: "Removed API", severity: "P0" }] };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify(report),
        ".appmod/plan.md": plan,
        ".appmod/progress.md": plan,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        const turns = [];
        assert.equal((await dispatchAction(rec, "autopilot_start", { scope: "recommendations" }, {
            runTurn: async (prompt) => {
                turns.push(prompt);
                await writeFile(join(dir, ".appmod", "progress.md"), plan.replace("- [ ] Fix API", "- [x] Fix API"));
            },
        })).ok, true);
        await rec.autopilotPromise;
        assert.equal(turns.length, 1);
        assert.match(turns[0], /Work only on these approved assessed findings:\n- api: Removed API/);
        assert.doesNotMatch(turns[0], /Run tests/);
        assert.equal(rec.autopilot.status, "completed");
        assert.equal((await dispatchAction(rec, "autopilot_start", { scope: "recommendations" }, { runTurn: async () => {} })).ok, false);
    });
});

test("server: recommendation batch pauses when assessment report changes mid-run", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    const plan = prefix + "- [ ] Fix API <!-- appmod-finding:api --> <!-- appmod-step:aaaaaaaaaaaaaaaa -->\n" +
        "- [ ] Fix CVE <!-- appmod-finding:cve --> <!-- appmod-step:bbbbbbbbbbbbbbbb -->";
    const report = { assessmentId: config.id, assessmentConfig: config, findings: [
        { id: "api", title: "Removed API", severity: "P0" }, { id: "cve", title: "Vulnerable dependency", severity: "P1" },
    ] };
    await withRepo({
        "pom.xml": "<project/>", ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify(report), ".appmod/plan.md": plan, ".appmod/progress.md": plan,
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        let turns = 0;
        assert.equal((await dispatchAction(rec, "autopilot_start", { scope: "recommendations" }, {
            runTurn: async () => {
                turns++;
                await writeFile(join(dir, ".appmod", "progress.md"), plan.replace("- [ ] Fix API", "- [x] Fix API"));
                await writeFile(join(dir, ".appmod", "assessment.json"), JSON.stringify({ ...report, summary: "Changed findings need review" }));
            },
        })).ok, true);
        await rec.autopilotPromise;
        assert.equal(turns, 1);
        assert.equal(rec.autopilot.status, "error");
        assert.match(rec.autopilot.error, /approved plan changed|Assessment settings/i);
    });
});

test("server: Autopilot pauses when an approved plan changes during a turn", async () => {
    const config = { id: "current-request", module: ".", targetJava: 17, cloud: "Azure" };
    const prefix = "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:current-request -->\n## P0 Build\n";
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": prefix + "- [ ] First\n- [ ] Second",
    }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        let turns = 0;
        assert.equal((await dispatchAction(rec, "autopilot_start", { scope: "all" }, {
            runTurn: async () => {
                turns++;
                await writeFile(join(dir, ".appmod", "plan.md"), prefix + "- [ ] First\n- [ ] Different second");
            },
        })).ok, true);
        await rec.autopilotPromise;
        assert.equal(turns, 1);
        assert.equal(rec.autopilot.status, "error");
        assert.match(rec.autopilot.error, /plan changed|approved plan/i);
    });
});

test("server: blocked readiness rejects direct execution but permits assessment", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const rec = {
            repoPath: dir, sseClients: new Set(), doctor: null,
            runDoctor: async () => ({ overall: "blocked", groups: [] }),
        };
        const sent = [];
        for (const [kind, payload] of [
            ["run_task", { taskId: "cache-to-redis" }],
            ["fix_finding", { title: "Fix the cache" }],
            ["run_build_tests", {}],
        ]) {
            const result = await dispatchAction(rec, kind, payload, { sendPrompt: async (prompt) => sent.push(prompt) });
            assert.equal(result.ok, false, kind + " must be blocked by readiness");
            assert.match(result.error, /readiness|environment/i);
        }
        assert.equal(sent.length, 0);
        assert.equal((await dispatchAction(rec, "start_assessment", {}, { sendPrompt: async (prompt) => sent.push(prompt) })).ok, true);
        assert.equal(sent.length, 1, "read-only assessment remains accessible");
        const forced = await dispatchAction(rec, "autopilot_start", { force: true }, { runTurn: async () => {} });
        assert.equal(forced.ok, false, "force must not bypass readiness");
    });
});

test("server: execution rechecks a formerly ready toolchain", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let overall = "ready";
        let probes = 0;
        let sent = 0;
        const rec = {
            repoPath: dir, sseClients: new Set(), doctor: null,
            runDoctor: async () => { probes++; return { overall, groups: [] }; },
        };
        await dispatchAction(rec, "recheck_env", {}, {});
        overall = "blocked";
        const action = await dispatchAction(rec, "run_build_tests", {}, { sendPrompt: async () => sent++ });
        assert.equal(action.ok, false);
        assert.equal(sent, 0);
        assert.equal(probes, 2, "code-changing actions must check current readiness");
    });
});

test("server: HTTP action cannot bypass blocked readiness", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let sent = 0;
        const rec = await createInstanceServer({
            instanceId: "gated", repoPath: dir, initialTab: "overview",
            sendPrompt: async () => { sent++; }, runDoctor: async () => ({ overall: "blocked", groups: [] }),
        });
        try {
            const url = new URL(rec.url);
            const response = await fetch(url.origin + "/action?token=" + url.searchParams.get("token"), {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "run_task", payload: { taskId: "cache-to-redis" } }),
            });
            assert.equal((await response.json()).ok, false);
            assert.equal(sent, 0);
        } finally {
            await new Promise((resolve) => rec.server.close(resolve));
        }
    });
});

test("server: dispatch unknown action returns error, no send", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    let sent = 0;
    const res = await dispatchAction(rec, "bogus", {}, { sendPrompt: async () => sent++ });
    assert.equal(res.ok, false);
    assert.match(res.error, /Unknown action/);
    assert.equal(sent, 0);
});

test("server: dispatch without sendPrompt reports session not ready", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const res = await dispatchAction(rec, "run_cve", {}, {});
    assert.equal(res.ok, false);
    assert.match(res.error, /not ready/);
});

test("server: handler GET / serves HTML", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const handler = makeHandler(rec, { instanceId: "i", initialTab: "overview", sendPrompt: async () => {} });
    const { res } = await invokeGet(handler, "/");
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /Java Modernization Studio/);
});

test("server: handler GET /state serves scanned JSON", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const rec = { repoPath: dir, sseClients: new Set() };
        const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => {} });
        const { res } = await invokeGet(handler, "/state");
        const json = JSON.parse(res.body);
        assert.equal(json.ok, true);
        assert.equal(json.repoPath, dir);
    });
});

test("server: handler GET /events registers and cleans up SSE client", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => {} });
    const { req } = await invokeGet(handler, "/events");
    assert.equal(rec.sseClients.size, 1);
    req.emit("close");
    assert.equal(rec.sseClients.size, 0);
});

test("server: handler POST /action runs dispatch", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const sent = [];
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async (p) => sent.push(p) });
    const res = await invokePost(handler, "/action", { kind: "run_cve" });
    const json = JSON.parse(res.body);
    assert.equal(json.ok, true);
    assert.equal(sent.length, 1);
});

test("server: token guard forbids requests without the per-instance token", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set(), token: "s3cret" };
    const sent = [];
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async (p) => sent.push(p) });
    for (const path of ["/", "/state", "/events"]) {
        const { res } = await invokeGet(handler, path);
        assert.equal(res.statusCode, 403, path + " without a token must be forbidden");
    }
    const post = await invokePost(handler, "/action", { kind: "run_cve" });
    assert.equal(post.statusCode, 403, "/action without a token must be forbidden");
    assert.equal(sent.length, 0, "no action is dispatched for an unauthenticated request");
    assert.equal(rec.sseClients.size, 0, "no SSE client is registered for an unauthenticated request");
});

test("server: token guard allows requests carrying the correct token", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set(), token: "s3cret" };
    const sent = [];
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async (p) => sent.push(p) });
    const { req } = await invokeGet(handler, "/events?token=s3cret");
    assert.equal(rec.sseClients.size, 1, "a valid token registers the SSE client");
    req.emit("close");
    const post = await invokePost(handler, "/action?token=s3cret", { kind: "run_cve" });
    const json = JSON.parse(post.body);
    assert.equal(json.ok, true);
    assert.equal(sent.length, 1);
});

test("server: POST /action rejects an oversized request body (413)", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const sent = [];
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async (p) => sent.push(p) });
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/action";
    const res = fakeRes();
    const pending = handler(req, res);
    req.emit("data", "x".repeat(300 * 1024)); // > 256 KB cap
    req.emit("end");
    await pending;
    assert.equal(res.statusCode, 413);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
    assert.match(json.error, /too large/i);
    assert.equal(sent.length, 0, "no action is dispatched for a rejected body");
});

test("server: handler unknown route 404s", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => {} });
    const { res } = await invokeGet(handler, "/nope");
    assert.equal(res.statusCode, 404);
});

test("server: broadcast drops a client whose write fails (no leak, no repeat throw)", () => {
    const live = [];
    const dead = {
        write() {
            throw new Error("EPIPE: client gone");
        },
    };
    const rec = { sseClients: new Set([dead, { write: (s) => live.push(s) }]) };
    broadcast(rec, { type: "state", state: { ok: true } });
    assert.ok(!rec.sseClients.has(dead), "a client whose write throws is removed from the Set");
    assert.equal(rec.sseClients.size, 1, "the healthy client is retained");
    assert.equal(live.length, 1, "the healthy client still receives the frame");
    // A later broadcast must not keep throwing now that the dead client is gone.
    assert.doesNotThrow(() => broadcast(rec, { type: "state", state: { ok: true } }));
    assert.equal(live.length, 2);
});

test("server: POST /action rejects malformed JSON with 400 and dispatches nothing", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    let sent = 0;
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => sent++ });
    const req = new EventEmitter();
    req.method = "POST";
    req.url = "/action";
    const res = fakeRes();
    const pending = handler(req, res);
    req.emit("data", "{ not valid json ");
    req.emit("end");
    await pending;
    assert.equal(res.statusCode, 400);
    assert.match(res.headers["content-type"], /application\/json/);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
    assert.match(json.error, /invalid JSON/i);
    assert.equal(sent, 0, "a malformed body dispatches no action");
});

test("server: POST /action rejects a missing/invalid kind with 400", async () => {
    const rec = { repoPath: "/repo", sseClients: new Set() };
    let sent = 0;
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => sent++ });
    const res = await invokePost(handler, "/action", { payload: {} }); // no kind
    assert.equal(res.statusCode, 400);
    assert.match(res.headers["content-type"], /application\/json/);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
    assert.match(json.error, /kind/i);
    assert.equal(sent, 0, "a kindless request dispatches no action");
});

test("server: a handler exception returns 500 with a JSON content-type", async () => {
    // A throwing repoPath getter makes buildState (GET /state) reject, exercising
    // the handler's outer catch — which must still label the error body as JSON.
    const rec = {
        sseClients: new Set(),
        get repoPath() {
            throw new Error("boom");
        },
    };
    const handler = makeHandler(rec, { instanceId: "i", sendPrompt: async () => {} });
    const { res } = await invokeGet(handler, "/state");
    assert.equal(res.statusCode, 500);
    assert.match(res.headers["content-type"], /application\/json/);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
});

test("server: concurrent first reads share one readiness probe", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let runs = 0;
        let started;
        let release;
        const probeStarted = new Promise((resolve) => { started = resolve; });
        const probePending = new Promise((resolve) => { release = resolve; });
        const rec = {
            repoPath: dir, doctor: null,
            runDoctor: async () => { runs++; started(); await probePending; return { overall: "ready", groups: [] }; },
        };
        const first = buildState(rec);
        const second = buildState(rec);
        await probeStarted;
        await new Promise((resolve) => setTimeout(resolve, 150));
        release();
        const states = await Promise.all([first, second]);
        assert.equal(runs, 1, "concurrent snapshots must not compete to replace the cached doctor result");
        assert.ok(states.every((state) => state.doctor.overall === "ready"));
    });
});

test("server: recheck during an initial probe uses the newer result", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let runs = 0;
        let started;
        let release;
        const probeStarted = new Promise((resolve) => { started = resolve; });
        const probePending = new Promise((resolve) => { release = resolve; });
        const rec = {
            repoPath: dir, doctor: null,
            runDoctor: async () => {
                if (++runs === 1) {
                    started();
                    await probePending;
                    return { overall: "blocked", groups: [] };
                }
                return { overall: "ready", groups: [] };
            },
        };
        const initial = buildState(rec);
        await probeStarted;
        const recheck = buildState(rec, { recheckEnv: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(runs, 1, "recheck waits for the in-flight probe");
        release();
        const updated = await recheck;
        await initial;
        assert.equal(runs, 2);
        assert.equal(updated.doctor.overall, "ready");
        assert.equal(rec.doctor.overall, "ready");
    });
});

test("server: recheck_env runs the doctor, caches it, and broadcasts (no agent prompt)", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let runs = 0;
        const chunks = [];
        const rec = {
            repoPath: dir,
            sseClients: new Set([{ write: (s) => chunks.push(s) }]),
            doctor: null,
            runDoctor: async () => ({ overall: "blocked", groups: [], runs: ++runs }),
        };
        let sent = 0;
        const res = await dispatchAction(rec, "recheck_env", {}, { sendPrompt: async () => sent++ });
        assert.equal(res.ok, true);
        assert.equal(sent, 0, "recheck_env does not message the agent");
        assert.equal(rec.doctor.overall, "blocked");
        assert.equal(runs, 1);
        assert.match(chunks[0], /"overall":"blocked"/);
    });
});

test("server: refresh reprobes a changed environment", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let ready = false;
        let runs = 0;
        const rec = {
            repoPath: dir, sseClients: new Set(), doctor: null,
            runDoctor: async () => ({ overall: ready ? "ready" : "blocked", groups: [], runs: ++runs }),
        };
        await dispatchAction(rec, "recheck_env", {}, {});
        ready = true;
        const refreshed = await dispatchAction(rec, "refresh", {}, {});
        assert.equal(refreshed.state.doctor.overall, "ready");
        assert.equal(runs, 2);
    });
});

test("server: session idle rechecks blocked or repaired environments only", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let overall = "blocked";
        let runs = 0;
        const rec = {
            repoPath: dir, sseClients: new Set(), doctor: null,
            runDoctor: async () => ({ overall, groups: [], runs: ++runs }),
        };
        await refreshAfterTurn(rec);
        overall = "ready";
        assert.equal((await refreshAfterTurn(rec)).doctor.overall, "ready");
        await refreshAfterTurn(rec);
        assert.equal(runs, 2, "unrelated turns reuse a ready environment");
        const fix = await dispatchAction(rec, "fix_env", { tool: "Maven" }, { sendPrompt: async () => {} });
        assert.equal(fix.ok, true);
        assert.equal(rec.needsEnvRecheck, true);
        assert.equal((await refreshAfterTurn(rec)).doctor.overall, "ready");
        assert.equal(rec.needsEnvRecheck, false);
        assert.equal(runs, 3);
    });
});

test("server: reconnect state request rechecks cached readiness", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        let overall = "blocked";
        const rec = await createInstanceServer({
            instanceId: "reconnect", repoPath: dir, initialTab: "overview",
            sendPrompt: async () => {}, runDoctor: async () => ({ overall, groups: [] }),
        });
        try {
            const url = new URL(rec.url);
            const endpoint = url.origin + "/state?token=" + url.searchParams.get("token");
            assert.equal((await (await fetch(endpoint)).json()).doctor.overall, "blocked");
            overall = "ready";
            assert.equal((await (await fetch(endpoint + "&recheckEnv=1")).json()).doctor.overall, "ready");
        } finally {
            await new Promise((resolve) => rec.server.close(resolve));
        }
    });
});

test("server: createInstanceServer binds a loopback socket end-to-end", async () => {
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        const sent = [];
        const rec = await createInstanceServer({
            instanceId: "live",
            repoPath: dir,
            initialTab: "overview",
            sendPrompt: async (p) => sent.push(p),
            runDoctor: async () => ({ overall: "ready", groups: [] }),
        });
        try {
            assert.match(rec.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+$/);
            const u = new URL(rec.url);
            const base = u.origin;
            const q = "?token=" + u.searchParams.get("token");

            const home = await fetch(rec.url);
            assert.equal(home.status, 200);
            assert.match(await home.text(), /Java Modernization Studio/);

            const state = await (await fetch(base + "/state" + q)).json();
            assert.equal(state.ok, true);
            assert.equal(state.assessment.buildTool, "Maven");
            assert.equal(state.doctor.overall, "ready", "doctor report is attached to state");

            const action = await fetch(base + "/action" + q, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind: "run_cve" }),
            });
            const aj = await action.json();
            assert.equal(aj.ok, true);
            assert.equal(sent.length, 1);

            // A request that omits the per-instance token must be refused, even though
            // it reached the right loopback port.
            const unauth = await fetch(base + "/state");
            assert.equal(unauth.status, 403, "missing token is rejected at the socket");
        } finally {
            await new Promise((r) => rec.server.close(() => r()));
        }
    });
});

// ---- autopilot --------------------------------------------------------------

// Build an evolving plan model: snapshot() reflects current statuses and a fresh
// activeRank; markNextDone() simulates the agent checking a step off.
function planSim(steps) {
    const model = steps.map((s) => ({ section: null, rank: null, status: "pending", ...s }));
    const activeRank = () => {
        const notDone = model.filter((s) => s.status !== "done" && s.rank != null);
        return notDone.length ? Math.min(...notDone.map((s) => s.rank)) : null;
    };
    return {
        model,
        snapshot: async () => ({
            ok: true,
            progress: { steps: model.map((s) => ({ ...s })) },
            plan: { steps: model.map((s) => ({ ...s })) },
            ordering: { activeRank: activeRank() },
        }),
        markNextDone() {
            const notDone = model.find((s) => s.status !== "done");
            if (notDone) notDone.status = "done";
        },
    };
}

test("autopilot: selectNextStep follows phase order then falls back", () => {
    const s = {
        progress: { steps: [
            { title: "A", status: "done", rank: 1 },
            { title: "B", status: "pending", rank: 1 },
            { title: "C", status: "pending", rank: 2 },
        ] },
        ordering: { activeRank: 1 },
    };
    assert.equal(selectNextStep(s).title, "B", "picks the active-phase pending step");
    const s2 = { progress: { steps: [{ title: "X", status: "done", rank: 1 }] }, ordering: { activeRank: null } };
    assert.equal(selectNextStep(s2), null, "null when nothing is pending");
    assert.equal(selectNextStep({}), null, "null when there are no steps");
});

test("autopilot: stepKey is stable and isStepDone reads status", () => {
    const step = { title: "Upgrade", section: "P0 Build" };
    assert.equal(stepKey(step), "P0 Build::Upgrade");
    const state = { progress: { steps: [{ title: "Upgrade", section: "P0 Build", status: "done" }] } };
    assert.equal(isStepDone(state, step), true);
    assert.equal(isStepDone({ progress: { steps: [] } }, step), false);
});

test("autopilot: auto_step prompt is autonomous and never commits", () => {
    assert.equal(buildPrompt("auto_step", {}, "/repo"), null, "no title -> no prompt");
    const p = buildPrompt("auto_step", { title: "Bump Spring", section: "P1 Security" }, "/repo");
    assert.match(p, /AUTOPILOT/);
    assert.match(p, /Bump Spring/);
    assert.match(p, /Do NOT commit/);
    assert.match(p, /one step/i);
});

test("autopilot: runs every step to completion (happy path)", async () => {
    const sim = planSim([
        { title: "A", section: "P0 Build", rank: 1 },
        { title: "B", section: "P0 Build", rank: 1 },
    ]);
    const run = makeRun({ scope: "all", maxSteps: 10, startRank: 1 });
    const prompts = [];
    const displayPrompts = [];
    await runAutopilot(run, {
        snapshot: sim.snapshot,
        runTurn: async (prompt, displayPrompt) => { prompts.push(prompt); displayPrompts.push(displayPrompt); sim.markNextDone(); },
        buildStepPrompt: (step) => step.title,
        onProgress: () => {},
    });
    assert.equal(run.status, "completed");
    assert.equal(run.completed.length, 2);
    assert.ok(run.completed.every((c) => c.done), "each step ended up checked off");
    assert.deepEqual(prompts, ["A", "B"]);
    assert.deepEqual(displayPrompts, ["Work on the next modernization plan step.", "Work on the next modernization plan step."]);
    assert.equal(run.running, false);
});

test("autopilot: recommendations run only deduplicated approved finding steps", async () => {
    const steps = [
        { id: "aaaaaaaaaaaaaaaa", title: "Fix API", section: "P0 Build", rank: 1, status: "pending" },
        { id: "bbbbbbbbbbbbbbbb", title: "Unrelated task", section: "P0 Build", rank: 1, status: "pending" },
    ];
    const state = { plan: { steps }, progress: { steps }, ordering: { activeRank: 1 } };
    const turnTitles = [];
    const run = makeRun({ scope: "recommendations", recommendationStepIds: ["aaaaaaaaaaaaaaaa", "aaaaaaaaaaaaaaaa"] });
    await runAutopilot(run, {
        snapshot: async () => state,
        runTurn: async (prompt) => { turnTitles.push(prompt); steps[0].status = "done"; },
        buildStepPrompt: (step) => step.title,
    });
    assert.deepEqual(turnTitles, ["Fix API"]);
    assert.equal(run.status, "completed");
});

test("autopilot: recommendations prioritize earlier phases even when the plan is reordered", () => {
    const steps = [
        { id: "bbbbbbbbbbbbbbbb", title: "P2", status: "pending", rank: 3 },
        { id: "aaaaaaaaaaaaaaaa", title: "P0", status: "pending", rank: 1 },
    ];
    assert.equal(selectNextStep({ progress: { steps }, ordering: { activeRank: 1 } }, steps.map((step) => step.id)).title, "P0");
    assert.equal(selectNextStep({ progress: { steps }, ordering: { activeRank: 2 } }, steps.map((step) => step.id)).title, "P0");
});

test("autopilot: phase scope stops at the phase boundary", async () => {
    const sim = planSim([
        { title: "A", section: "P0 Build", rank: 1 },
        { title: "B", section: "P1 Security", rank: 2 },
    ]);
    const run = makeRun({ scope: "phase", maxSteps: 10, startRank: 1 });
    await runAutopilot(run, {
        snapshot: sim.snapshot,
        runTurn: async () => sim.markNextDone(),
        buildStepPrompt: (step) => step.title,
        onProgress: () => {},
    });
    assert.equal(run.status, "phase_done");
    assert.equal(run.completed.length, 1, "only the P0 step ran; it paused before P1");
    assert.equal(run.completed[0].title, "A");
});

test("autopilot: stops (stuck) when a step does not get checked off", async () => {
    const sim = planSim([{ title: "Tricky", section: "P0 Build", rank: 1 }]);
    const run = makeRun({ scope: "all", maxSteps: 10, startRank: 1 });
    await runAutopilot(run, {
        snapshot: sim.snapshot,
        runTurn: async () => { /* agent fails to complete the step */ },
        buildStepPrompt: (step) => step.title,
        onProgress: () => {},
    });
    assert.equal(run.status, "stuck");
    assert.equal(run.stuck, "Tricky");
    assert.equal(run.completed.length, 1);
    assert.equal(run.completed[0].done, false);
});

test("autopilot: honors cancellation between steps", async () => {
    const sim = planSim([
        { title: "A", section: "P0 Build", rank: 1 },
        { title: "B", section: "P0 Build", rank: 1 },
    ]);
    const run = makeRun({ scope: "all", maxSteps: 10, startRank: 1 });
    await runAutopilot(run, {
        snapshot: sim.snapshot,
        runTurn: async () => sim.markNextDone(),
        buildStepPrompt: (step) => step.title,
        onProgress: (r) => { if (r.current) r.cancelled = true; },
    });
    assert.equal(run.status, "cancelled");
    assert.equal(run.completed.length, 1, "the in-flight step finished, then it stopped");
});

test("server: autopilot_start refuses without a runTurn driver", async () => {
    const rec = { repoPath: "/nope", sseClients: new Set(), doctor: null, autopilot: null };
    const res = await dispatchAction(rec, "autopilot_start", {}, { sendPrompt: async () => {}, log: () => {} });
    assert.equal(res.ok, false);
    assert.match(res.error, /drive/i);
    assert.equal(rec.autopilot, null);
});

test("server: autopilot_start is blocked when the environment is not ready", async () => {
    await withRepo({ ...PROV, "pom.xml": "<project/>", "progress.md": "## P0 Build\n- [ ] Fix build\n" }, async (dir) => {
        const rec = {
            repoPath: dir,
            sseClients: new Set(),
            doctor: null,
            autopilot: null,
            runDoctor: async () => ({ overall: "blocked", groups: [] }),
        };
        const res = await dispatchAction(rec, "autopilot_start", {}, { runTurn: async () => {}, log: () => {} });
        assert.equal(res.ok, false);
        assert.match(res.error, /environment/i);
        assert.equal(rec.autopilot, null, "no run starts while blocked");
    });
});

test("server: autopilot_start drives the loop and broadcasts progress", async () => {
    const config = { id: "autopilot-request", module: ".", targetJava: 21, cloud: "Azure" };
    await withRepo({
        "pom.xml": "<project/>",
        ".appmod/assessment-config.json": JSON.stringify(config),
        ".appmod/assessment.json": JSON.stringify({ assessmentId: config.id, assessmentConfig: config, findings: [] }),
        ".appmod/plan.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:autopilot-request -->\n## P0 Build\n- [ ] Fix the build",
        ".appmod/progress.md": "<!-- appmod-cockpit -->\n<!-- appmod-assessment-id:autopilot-request -->\n## P0 Build\n- [ ] Fix the build",
    }, async (dir) => {
        const chunks = [];
        const rec = {
            repoPath: dir,
            sseClients: new Set([{ write: (s) => chunks.push(s) }]),
            doctor: null,
            autopilot: null,
            runDoctor: async () => ({ overall: "ready", groups: [] }),
        };
        const revision = (await scanRepo(dir, { includeGit: false })).plan.revision;
        assert.equal((await dispatchAction(rec, "approve_plan", { revision }, {})).ok, true);
        let turns = 0;
        const res = await dispatchAction(rec, "autopilot_start", { scope: "phase" }, { runTurn: async () => { turns++; }, log: () => {} });
        assert.equal(res.ok, true);
        assert.ok(rec.autopilot, "a run record is attached");
        await rec.autopilotPromise; // let the loop settle
        assert.equal(rec.autopilot.running, false);
        assert.ok(turns >= 1, "the agent was driven at least once");
        // The step never gets checked off (runTurn is a stub), so it pauses as stuck.
        assert.equal(rec.autopilot.status, "stuck");
        assert.ok(chunks.some((c) => /autopilot|"type":"state"/.test(c)), "progress was broadcast");
    });
});

test("server: autopilot_stop and autopilot_dismiss behave by run state", async () => {
    const rec = { repoPath: "/x", sseClients: new Set(), doctor: null, autopilot: null };
    const stopIdle = await dispatchAction(rec, "autopilot_stop", {}, {});
    assert.equal(stopIdle.ok, false, "nothing to stop when idle");

    rec.autopilot = { running: true, cancelled: false, completed: [] };
    const stopRunning = await dispatchAction(rec, "autopilot_stop", {}, {});
    assert.equal(stopRunning.ok, true);
    assert.equal(rec.autopilot.cancelled, true, "stop flips the cancel flag");

    rec.autopilot = { running: false, status: "completed", completed: [] };
    await withRepo({ "pom.xml": "<project/>" }, async (dir) => {
        rec.repoPath = dir;
        const res = await dispatchAction(rec, "autopilot_dismiss", {}, {});
        assert.equal(res.ok, true);
        assert.equal(rec.autopilot, null, "dismiss clears a finished run");
    });
});

test("renderer: ships the Autopilot controls (start/stop, card, live strip)", () => {
    const html = renderHtml({ instanceId: "x" });
    assert.match(html, /autopilot_start/);
    assert.match(html, /autopilot_stop/);
    assert.match(html, /Autopilot/);
    assert.match(html, /autopilotStrip/);
});
