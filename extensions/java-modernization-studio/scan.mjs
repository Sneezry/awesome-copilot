// scan.mjs — Grounds the cockpit in the real repository. Reads App Modernization
// artifacts (plan.md / progress.md / summary.md), discovers custom skills under
// .github/skills/, extracts assessment facts from Maven/Gradle build files, and
// reports git branch state. Everything degrades gracefully when files are absent.

import { readFile, readdir, stat, open, lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { execFile } from "node:child_process";
import { catalogWithRelevance, VALIDATION_GATES } from "./catalog.mjs";

// Dependency signatures: substring(s) searched in build files -> catalog `detect` key.
const DEP_SIGNATURES = {
    rabbitmq: ["rabbitmq", "spring-rabbit", "amqp-client", "spring-amqp", "starter-amqp", "amqp"],
    activemq: ["activemq"],
    jms: ["javax.jms", "jakarta.jms", "spring-jms"],
    awsS3: ["aws-java-sdk-s3", "s3", "software.amazon.awssdk"],
    awsSqs: ["aws-java-sdk-sqs", "sqs"],
    awsSecrets: ["secretsmanager"],
    javamail: ["javax.mail", "jakarta.mail", "com.sun.mail", "spring-boot-starter-mail"],
    ldap: ["spring-ldap", "spring-security-ldap", "unboundid-ldapsdk", "ldaptive"],
    cache: ["infinispan", "swarmcache", "memcached", "spymemcached", "ehcache"],
    oracle: ["ojdbc", "oracle"],
    db2: ["db2jcc", "com.ibm.db2"],
    sybase: ["jconn", "sybase"],
    informix: ["informix"],
    jdbc: ["jdbc", "hikari", "mysql", "postgresql", "mssql-jdbc", "sqlserver"],
    keystore: ["keystore", ".jks", "javax.net.ssl"],
    crypto: ["javax.crypto", "java.security", "bouncycastle", "bcprov"],
    filelog: ["fileappender", "rollingfileappender", "logback", "log4j"],
};

// Cap how much of any single file we read. Build files and modernization docs are
// tiny; an unbounded read on a pathological repo (a giant generated XML, a vendored
// blob) would waste memory for no parsing benefit. Truncating is safe — every
// parser here scans for early markers/coordinates.
const MAX_READ_BYTES = 2 * 1024 * 1024;

function execGit(args, cwd) {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, timeout: 4000 }, (err, stdout) => {
            if (err) resolve(null);
            else resolve(String(stdout).trim());
        });
    });
}

async function readText(path) {
    try {
        const st = await stat(path);
        if (!st.isFile()) return null;
        if (st.size > MAX_READ_BYTES) {
            const fh = await open(path, "r");
            try {
                const buf = Buffer.alloc(MAX_READ_BYTES);
                const { bytesRead } = await fh.read(buf, 0, MAX_READ_BYTES, 0);
                return buf.toString("utf8", 0, bytesRead);
            } finally {
                await fh.close();
            }
        }
        return await readFile(path, "utf8");
    } catch {
        return null;
    }
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function isDirectory(path) {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

// Explicit provenance marker the cockpit writes at the top of artifacts it owns,
// so a root plan/progress/summary self-identifies as modernization state even
// when there is no .appmod/ directory yet.
const APPMOD_MARKER_RE = /<!--\s*appmod-cockpit\b/i;
function hasMarker(md) {
    return typeof md === "string" && APPMOD_MARKER_RE.test(md.slice(0, 2000));
}

function artifactAssessmentId(md) {
    const match = typeof md === "string" && md.slice(0, 2000).match(/<!--\s*appmod-assessment-id:([a-z0-9-]+)\s*-->/i);
    return match ? match[1] : null;
}

// The assessment.json is written by an LLM step, so its shape can drift: severities
// may be lowercase or word-form, `files` may be a bare string, findings may be
// missing, and the top level might not even be an object. Normalize defensively so
// the renderer always gets P0–P3 severities and array `files`, and nothing is
// silently dropped or used to build an invalid CSS class.
const SEVERITY_ALIASES = {
    p0: "P0", p1: "P1", p2: "P2", p3: "P3",
    critical: "P0", blocker: "P0", severe: "P0",
    high: "P1", major: "P1",
    medium: "P2", moderate: "P2", warning: "P2", warn: "P2",
    low: "P3", minor: "P3", info: "P3", informational: "P3", note: "P3",
};
function normalizeSeverity(sev) {
    if (typeof sev !== "string") return "P3";
    return SEVERITY_ALIASES[sev.trim().toLowerCase()] || "P3";
}
function normalizeEvidence(item) {
    if (typeof item === "string") return item.trim() ? { detail: item.trim() } : null;
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const evidence = {};
    if (typeof item.file === "string" && item.file.trim()) evidence.file = item.file.trim();
    if (Number.isSafeInteger(item.line) && item.line > 0) evidence.line = item.line;
    if (typeof item.detail === "string" && item.detail.trim()) evidence.detail = item.detail.trim();
    if (typeof item.snippet === "string" && item.snippet.trim()) evidence.snippet = item.snippet;
    return Object.keys(evidence).length ? evidence : null;
}
function normalizeFinding(f, idx) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    let files = [];
    if (typeof f.files === "string") files = f.files ? [f.files] : [];
    else if (Array.isArray(f.files)) files = f.files.filter((x) => typeof x === "string");
    const evidenceIn = Array.isArray(f.evidence) ? f.evidence : (f.evidence ? [f.evidence] : []);
    const title =
        (typeof f.title === "string" && f.title.trim()) ||
        (typeof f.id === "string" && f.id.trim()) ||
        "Untitled finding";
    const out = {
        id: typeof f.id === "string" && f.id ? f.id : "finding-" + (idx + 1),
        severity: normalizeSeverity(f.severity),
        title,
        detail: typeof f.detail === "string" ? f.detail : "",
        files,
        impact: typeof f.impact === "string" ? f.impact : "",
        recommendation: typeof f.recommendation === "string" ? f.recommendation : "",
        evidence: evidenceIn.map(normalizeEvidence).filter(Boolean),
    };
    if (f.action && typeof f.action === "object" && !Array.isArray(f.action)) out.action = f.action;
    return out;
}
function normalizeUnifiedReport(raw) {
    if (raw.version !== "1.0.0" || !raw.metadata || !Array.isArray(raw.projects) ||
        !raw.rules || typeof raw.rules !== "object" || Array.isArray(raw.rules)) return null;
    const severities = new Set(["mandatory", "potential", "optional", "information"]);
    const findings = [];
    for (const project of raw.projects) {
        if (!project || typeof project.path !== "string" || !Array.isArray(project.incidents)) return null;
        for (const incident of project.incidents) {
            const rule = incident && raw.rules[incident.ruleId];
            if (!rule || !severities.has(rule.severity) || typeof incident.incidentId !== "string") return null;
            const location = incident.locationKind === "source-file" && typeof incident.location === "string" && incident.location ?
                posix.join(project.path.replaceAll("\\", "/"), incident.location.replaceAll("\\", "/")) : "";
            findings.push({
                id: project.path + ":" + incident.incidentId, severity: rule.severity,
                domain: rule.domain, category: rule.category, title: rule.title || rule.id,
                detail: rule.description || "", impact: "", recommendation: "",
                files: location ? [location] : [],
                evidence: [{ ...(location ? { file: location } : {}),
                    ...(Number.isSafeInteger(incident.line) && incident.line > 0 ? { line: incident.line } : {}),
                    ...(typeof incident.message === "string" && incident.message ? { detail: incident.message } : {}),
                    ...(typeof incident.snippet === "string" && incident.snippet ? { snippet: incident.snippet } : {}) }],
            });
        }
    }
    if (raw.security != null && !Array.isArray(raw.security)) return null;
    for (const item of raw.security || []) {
        if (!item || !severities.has(item.severity) || !item.evidence || !Array.isArray(item.evidence.files)) return null;
        const explanation = typeof item.evidence.explanation === "string" ? item.evidence.explanation : "";
        const files = item.evidence.files.filter((file) => typeof file === "string");
        findings.push({
            id: item.id, severity: item.severity, domain: "security", category: item.category,
            title: item.title, detail: item.description || "", impact: "", recommendation: "", files,
            evidence: files.length ? files.map((file) => ({ file, detail: explanation })) : (explanation ? [{ detail: explanation }] : []),
        });
    }
    return { severityScale: "unified", lifecycleStatus: raw.metadata.status,
        generatedAt: raw.metadata.analysisEndTime || raw.metadata.analysisStartTime,
        headline: raw.metadata.name, findings };
}
function normalizeReport(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if ("version" in raw && "projects" in raw) return normalizeUnifiedReport(raw);
    const findingsIn = Array.isArray(raw.findings) ? raw.findings : [];
    const findings = [];
    findingsIn.forEach((f, i) => {
        const n = normalizeFinding(f, i);
        if (n) findings.push(n);
    });
    const out = { ...raw, findings };
    if (raw.strengths != null && !Array.isArray(raw.strengths)) {
        out.strengths = typeof raw.strengths === "string" && raw.strengths ? [raw.strengths] : [];
    }
    return out;
}

async function readNativeAssessment(repoPath) {
    const reportsDir = join(repoPath, ".github", "modernize", "reports");
    let root;
    let entries;
    try {
        root = await realpath(repoPath);
        const directory = await realpath(reportsDir);
        const rel = relative(root, directory);
        if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
        entries = (await readdir(reportsDir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("report-"))
            .sort((left, right) => right.name.localeCompare(left.name)).slice(0, 100);
    } catch { return null; }
    const candidates = [];
    for (const entry of entries) {
        const path = join(reportsDir, entry.name, "report.json");
        try {
            if (!(await lstat(path)).isFile()) continue;
            const rel = relative(root, await realpath(path));
            if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) continue;
            const raw = JSON.parse(await readText(path));
            const report = normalizeReport(raw);
            if (report?.severityScale !== "unified" || report.lifecycleStatus !== "completed") continue;
            candidates.push({ report, path: rel.split(sep).join("/"), time: Date.parse(report.generatedAt) || 0 });
        } catch {}
    }
    candidates.sort((left, right) => right.time - left.time || right.path.localeCompare(left.path));
    return candidates[0] || null;
}

function stripMd(s) {
    return String(s)
        .replace(/[*_`~]+/g, "")
        .replace(/^\s*#+\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Infer a status from inline markers / emojis in a line of text.
function statusFromText(text) {
    const t = text.toLowerCase();
    if (/[✅✔]|\bdone\b|\bcompleted?\b|\bpassed?\b/.test(t)) return "done";
    if (/[❌✖]|\bfailed?\b|\berror\b|\bblocked\b/.test(t)) return "failed";
    if (/[⏳🔄]|in progress|in-progress|ongoing|running|wip/.test(t)) return "in_progress";
    return null;
}

// Parse GitHub-style task list items: "- [ ] ...", "- [x] ...", "- [/] ...".
// Each item also carries the nearest preceding heading as its `section`.
export function parseChecklist(md) {
    const items = [];
    let section = null;
    for (const line of md.split(/\r?\n/)) {
        const h = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
        if (h) { section = stripMd(h[1]); continue; }
        const m = line.match(/^\s*[-*]\s+\[([ xX/~\-])\]\s+(.*\S)\s*$/);
        if (!m) continue;
        const mark = m[1].toLowerCase();
        let status = "pending";
        if (mark === "x") status = "done";
        else if (mark === "/" || mark === "~" || mark === "-") status = "in_progress";
        const id = m[2].match(/<!--\s*appmod-step:([a-f0-9]{16,32})\s*-->/i)?.[1] || null;
        const findingIds = [...m[2].matchAll(/<!--\s*appmod-finding:([^\s<>]+)\s*-->/gi)]
            .map((match) => { try { return decodeURIComponent(match[1]); } catch { return null; } }).filter(Boolean);
        const taskId = m[2].match(/<!--\s*appmod-task:([a-z0-9-]+)\s*-->/i)?.[1] || null;
        const skillToken = m[2].match(/<!--\s*appmod-skill:([^\s<>]+)\s*-->/i)?.[1];
        let skillFolder = null;
        try { if (skillToken) skillFolder = decodeURIComponent(skillToken); } catch { /* Invalid marker is not a link. */ }
        const title = m[2].replace(/<!--\s*appmod-step:[a-f0-9]{16,32}\s*-->/gi, "")
            .replace(/<!--\s*appmod-(?:finding|task|skill):[^\s<>]+\s*-->/gi, "");
        const inline = statusFromText(title);
        if (inline) status = inline;
        items.push({ title: stripMd(title), status, section, id,
            ...(findingIds.length ? { findingIds: [...new Set(findingIds)] } : {}),
            ...(taskId ? { taskId } : {}), ...(skillFolder ? { skillFolder } : {}) });
    }
    return items;
}

// Fallbacks when there are no checkbox items: numbered steps, then H2/H3 headings.
function parseLooseSteps(md) {
    const numbered = [];
    let section = null;
    for (const line of md.split(/\r?\n/)) {
        const h = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
        if (h) { section = stripMd(h[1]); continue; }
        const m = line.match(/^\s*\d+[.)]\s+(.*\S)\s*$/);
        if (m) numbered.push({ title: stripMd(m[1]), status: statusFromText(m[1]) || "pending", section });
    }
    if (numbered.length) return numbered;

    const headings = [];
    for (const line of md.split(/\r?\n/)) {
        const m = line.match(/^\s*#{2,4}\s+(.*\S)\s*$/);
        if (m) headings.push({ title: stripMd(m[1]), status: statusFromText(m[1]) || "pending", section: null });
    }
    return headings;
}

function parseSteps(md) {
    if (!md) return [];
    const checklist = parseChecklist(md);
    return checklist.length ? checklist : parseLooseSteps(md);
}

export function editablePlanMarkdown(markdown) {
    const revision = createHash("sha256").update(markdown).digest("hex");
    let ordinal = 0;
    return markdown.replace(/^([ \t]*[-*][ \t]+\[[ xX/~\-]\][ \t]+.*\S[ \t]*)(\r?)$/gm, (line, body, ending) => {
        ordinal++;
        if (/<!--\s*appmod-step:[a-f0-9]{16,32}\s*-->/i.test(body)) return line;
        const id = createHash("sha256").update(revision + ":" + ordinal).digest("hex").slice(0, 16);
        return body.trimEnd() + " <!-- appmod-step:" + id + " -->" + ending;
    });
}

export function withAssessmentId(markdown, id) {
    const existing = artifactAssessmentId(markdown);
    if (existing && existing !== id) throw new Error("Assessment ID does not match the current assessment.");
    const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
    const marker = "<!-- appmod-cockpit -->" + newline;
    const provenance = "<!-- appmod-assessment-id:" + id + " -->" + newline;
    if (markdown.startsWith(marker + provenance)) return markdown;
    const body = existing ? markdown.replace(/<!--\s*appmod-assessment-id:[a-z0-9-]+\s*-->\r?\n?/i, "") : markdown;
    return body.startsWith(marker) ? marker + provenance + body.slice(marker.length) : marker + provenance + body;
}

// Return the steps under the first heading matching `headingRe`, up to the next
// heading, or null if there is no such section. Used to scope the validation
// gates to an explicit "Validation gates" section so unrelated checklist items
// that merely mention "build"/"vulnerable"/etc. don't hijack a gate's status.
function validationSection(md) {
    if (!md) return null;
    let inSection = false;
    const buf = [];
    for (const line of md.split(/\r?\n/)) {
        const h = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
        if (h) {
            if (inSection) break; // next heading closes the section
            if (phaseRankFromName(h[1]) === 5) inSection = true;
            continue;
        }
        if (inSection) buf.push(line);
    }
    return inSection ? buf.join("\n") : null;
}

function sectionSteps(md) {
    const section = validationSection(md);
    if (section == null) return null;
    const steps = parseSteps(section);
    return steps.length ? steps : null;
}

function percentDone(steps) {
    if (!steps.length) return 0;
    let score = 0;
    for (const s of steps) {
        if (s.status === "done") score += 1;
        else if (s.status === "in_progress") score += 0.5;
    }
    return Math.round((score / steps.length) * 100);
}

// Rank a phase/section heading into the canonical modernization order so the UI
// can recommend (and gently gate) the sequence: assessment -> P0 -> P1 -> P2 ->
// P3 -> validation. Unknown sections return null (never gated).
function phaseRankFromName(name) {
    if (!name) return null;
    const n = String(name).trim().toLowerCase();
    if (/assessment/.test(n)) return 0;
    if (/^(?:p[0-3]\s*[-:.]?\s*)?(?:validation(?:\s+(?:gates|checks|tests))?|gates|sign-?off)$/.test(n)) return 5;
    const m = n.match(/\bp([0-3])\b/);
    if (m) return 1 + Number(m[1]);
    return null;
}

// Summarize phase ordering from the checklist: which phase is the earliest one
// with unfinished work (the "active" phase the user should be in), plus a
// per-phase done/total roll-up. Steps in phases ranked after `activeRank` are
// "ahead of sequence" and the UI flags them so users don't jump the gun.
function computeOrdering(steps) {
    const phases = [];
    const byKey = {};
    for (const st of steps) {
        const key = st.section || "Steps";
        if (!byKey[key]) {
            byKey[key] = { name: key, rank: st.rank == null ? null : st.rank, total: 0, done: 0 };
            phases.push(byKey[key]);
        }
        byKey[key].total++;
        if (st.status === "done") byKey[key].done++;
    }
    let activeRank = null;
    let activePhase = null;
    for (const st of steps) {
        if (st.status !== "done" && st.rank != null) {
            if (activeRank == null || st.rank < activeRank) {
                activeRank = st.rank;
                activePhase = st.section;
            }
        }
    }
    return { activeRank, activePhase, phases };
}

// Derive the five validation gates from progress/summary step titles.
function deriveGates(steps, summaryText) {
    const patterns = {
        build: /\bbuild\b|compil/i,
        tests: /unit test|\btests?\b|junit/i,
        cve: /\bcve\b|vulnerab|security scan/i,
        consistency: /consistenc/i,
        completeness: /completenes/i,
    };
    const gates = {};
    for (const g of VALIDATION_GATES) {
        let status = "not_run";
        for (const s of steps) {
            if (patterns[g.key].test(s.title)) {
                status = s.status; // done | in_progress | failed | pending
                break;
            }
        }
        if (status === "not_run" && summaryText) {
            const line = summaryText
                .split(/\r?\n/)
                .find((l) => patterns[g.key].test(l));
            if (line) status = statusFromText(line) || "in_progress";
        }
        gates[g.key] = status;
    }
    return gates;
}

async function discoverSkills(repoPath) {
    const skillsDir = join(repoPath, ".github", "skills");
    const out = [];
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const md = await readText(join(skillsDir, e.name, "SKILL.md"));
        let name = e.name;
        let description = "";
        if (md) {
            const nameM = md.match(/(?:^|\n)#+\s*(.+)|name:\s*(.+)/i);
            if (nameM) name = stripMd(nameM[1] || nameM[2] || e.name);
            const descM = md.match(/description:\s*(.+)/i);
            if (descM) description = stripMd(descM[1]);
        }
        out.push({ folder: e.name, name, description, hasSkillMd: !!md });
    }
    return out;
}

function detectJavaVersion(pom, gradle) {
    const text = `${pom || ""}\n${gradle || ""}`;
    const grab = (re) => {
        const m = text.match(re);
        return m ? m[1].replace(/^1\./, "") : null;
    };
    return (
        grab(/<maven\.compiler\.release>\s*([\d.]+)\s*</) ||
        grab(/<maven\.compiler\.source>\s*([\d.]+)\s*</) ||
        grab(/<java\.version>\s*([\d.]+)\s*</) ||
        grab(/<source>\s*([\d.]+)\s*</) ||
        grab(/<release>\s*([\d.]+)\s*</) ||
        grab(/sourceCompatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?([\d.]+)/) ||
        grab(/languageVersion[^)]*?(\d+)/) ||
        null
    );
}

// Match a dependency signature against build text. Plain substring matching makes
// short alpha tokens dangerous ("ant" used to hit "important/constant", and a bare
// token could land inside an unrelated word). We instead require the signature to
// begin a *token* — i.e. be preceded by a word boundary — which rejects mid-word
// matches while still allowing versioned/suffixed coordinates (ojdbc -> "ojdbc8",
// hikari -> "hikaricp", s3 -> "...-s3"). Signatures that intentionally start with a
// separator (e.g. ".jks") are matched as plain substrings.
function signatureMatches(text, sig) {
    const s = sig.toLowerCase();
    if (!s) return false;
    const alnum = (c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (!alnum(s[0])) return text.includes(s);
    let from = 0;
    for (;;) {
        const i = text.indexOf(s, from);
        if (i < 0) return false;
        const before = i === 0 ? "" : text[i - 1];
        if (before === "" || !alnum(before)) return true; // signature begins a token
        from = i + 1;
    }
}

function detectDependencies(buildText) {
    const text = (buildText || "").toLowerCase();
    const keys = [];
    for (const [key, sigs] of Object.entries(DEP_SIGNATURES)) {
        if (sigs.some((s) => signatureMatches(text, s))) keys.push(key);
    }
    return keys;
}

const DOCKERFILE_RE = /^(dockerfile|containerfile)(\.[\w.-]+)?$/i;

async function dirHasDockerfile(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.some((e) => (e.isFile() || e.isSymbolicLink()) && DOCKERFILE_RE.test(e.name));
    } catch {
        return false;
    }
}

async function findDockerfile(repoPath) {
    // Case-insensitive, and also accept Containerfile (Podman) / Dockerfile.<tag>.
    if (await dirHasDockerfile(repoPath)) return true;
    try {
        const entries = await readdir(repoPath, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith(".")) {
                if (await dirHasDockerfile(join(repoPath, e.name))) return true;
            }
        }
    } catch {
        /* ignore */
    }
    return false;
}

// Directories we never descend into when unioning module build files.
const SKIP_DIRS = new Set(["node_modules", "target", "build", "dist", "out", "bin", ".git"]);

async function buildAssessment(repoPath) {
    const rootPom = await readText(join(repoPath, "pom.xml"));
    let rootGradle = await readText(join(repoPath, "build.gradle"));
    if (!rootGradle) rootGradle = await readText(join(repoPath, "build.gradle.kts"));
    const antBuild = await readText(join(repoPath, "build.xml"));

    // Union one level of modules so multi-module Maven, Gradle subprojects, and
    // monorepos report the real Java version / dependencies — not just whatever
    // the (often dependency-free) aggregator root pom declares.
    const childPoms = [];
    const childGradles = [];
    const modules = [];
    try {
        const entries = await readdir(repoPath, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
            const cp = await readText(join(repoPath, e.name, "pom.xml"));
            if (cp) childPoms.push(cp);
            let cg = await readText(join(repoPath, e.name, "build.gradle"));
            if (!cg) cg = await readText(join(repoPath, e.name, "build.gradle.kts"));
            if (cg) childGradles.push(cg);
            if (cp || cg || (await readText(join(repoPath, e.name, "build.xml")))) modules.push(e.name);
        }
    } catch {
        /* ignore */
    }

    const allPom = [rootPom, ...childPoms].filter(Boolean).join("\n");
    const allGradle = [rootGradle, ...childGradles].filter(Boolean).join("\n");
    const buildText = `${allPom}\n${allGradle}\n${antBuild || ""}`;
    const hasMaven = !!(rootPom || childPoms.length);
    const hasGradle = !!(rootGradle || childGradles.length);
    const buildTool = hasMaven ? "Maven" : hasGradle ? "Gradle" : antBuild ? "Ant" : null;
    const springBoot = /spring-boot/i.test(buildText);
    const springVersion = (() => {
        const m = buildText.match(/spring-boot[^>]*?<version>\s*([\d.]+[\w.-]*)\s*</i);
        return m ? m[1] : null;
    })();

    const detectedKeys = detectDependencies(buildText);
    // Ant is identified by its build file, not a content substring (avoids the
    // old "ant" false positives), so flag it from the resolved build tool.
    if (buildTool === "Ant" && !detectedKeys.includes("ant")) detectedKeys.push("ant");

    return {
        buildTool,
        modules: modules.sort(),
        javaVersion: detectJavaVersion(allPom, allGradle),
        springBoot,
        springVersion,
        hasDockerfile: await findDockerfile(repoPath),
        hasMavenWrapper:
            (await exists(join(repoPath, "mvnw"))) || (await exists(join(repoPath, "mvnw.cmd"))),
        hasGradleWrapper:
            (await exists(join(repoPath, "gradlew"))) || (await exists(join(repoPath, "gradlew.bat"))),
        detectedKeys,
    };
}

/**
 * Scan a repo and produce the full cockpit state snapshot.
 * @param {string} repoPath absolute path to the repo working directory
 * @param {{ includeGit?: boolean }} [opts]
 */
export async function scanRepo(repoPath, opts = {}) {
    const includeGit = opts.includeGit !== false;
    if (!repoPath || !(await isDirectory(repoPath))) {
        return { ok: false, repoPath: repoPath || null, error: "repo path not available" };
    }

    // Modernization docs. Prefer the namespaced .appmod/ copies; the root-level
    // files (plan.md / progress.md / summary.md) use very common filenames, so we
    // trust them as workflow state only when the provenance gate below passes.
    const [apPlan, apProgress, apSummary, rootPlan, rootProgress, rootSummary, nativePlan, nativeProgress, nativeSummary] = await Promise.all([
        readText(join(repoPath, ".appmod", "plan.md")),
        readText(join(repoPath, ".appmod", "progress.md")),
        readText(join(repoPath, ".appmod", "summary.md")),
        readText(join(repoPath, "plan.md")),
        readText(join(repoPath, "progress.md")),
        readText(join(repoPath, "summary.md")),
        readText(join(repoPath, ".github", "modernize", "plan.md")),
        readText(join(repoPath, ".github", "modernize", "progress.md")),
        readText(join(repoPath, ".github", "modernize", "summary.md")),
    ]);

    // Structured assessment report (written by the assessment step). Optional,
    // and the strongest provenance signal that this repo is running the workflow.
    let report = null;
    const reportRaw = await readText(join(repoPath, ".appmod", "assessment.json"));
    const nativeReport = reportRaw == null ? await readNativeAssessment(repoPath) : null;
    let reportStatus = nativeReport ? "ready" : (reportRaw == null ? "missing" : "invalid");
    if (nativeReport) report = nativeReport.report;
    if (reportRaw != null) {
        try {
            const raw = JSON.parse(reportRaw);
            report = normalizeReport(raw);
            if (report && (Array.isArray(raw.findings) || report.severityScale === "unified" && report.lifecycleStatus === "completed")) reportStatus = "ready";
            else if (report?.severityScale === "unified" && ["pending", "running"].includes(report.lifecycleStatus)) reportStatus = "running";
        } catch {
            report = null;
        }
    }
    let assessmentConfig = null;
    const configRaw = await readText(join(repoPath, ".appmod", "assessment-config.json"));
    let assessmentConfigStatus = configRaw == null ? "missing" : "invalid";
    if (configRaw != null) {
        try {
            const config = JSON.parse(configRaw);
            if (config && typeof config.id === "string" && config.id &&
                typeof config.module === "string" && config.module &&
                [17, 21].includes(config.targetJava) && config.cloud === "Azure") {
                assessmentConfig = config;
                assessmentConfigStatus = "ready";
            }
        } catch {
            assessmentConfig = null;
        }
    }

    // Provenance gate. A .appmod/ artifact (assessment.json or a namespaced doc)
    // means the modernization workflow is active in this repo, so the root docs
    // are ours. Otherwise a root doc is trusted only if it carries the explicit
    // <!-- appmod-cockpit --> marker. This stops an unrelated summary.md from
    // flipping a foreign repo to "completed", or a stray plan.md from injecting
    // fake steps into the progress/ordering/autopilot machinery.
    const hasAppmodArtifact =
        reportRaw != null || apPlan != null || apProgress != null || apSummary != null;
    const trusted = (root) => hasAppmodArtifact || hasMarker(root);
    const planPath = apPlan !== null ? ".appmod/plan.md" : trusted(rootPlan) && rootPlan !== null ? "plan.md" :
        nativePlan !== null && hasMarker(nativePlan) ? ".github/modernize/plan.md" : null;
    const planMd = planPath === ".appmod/plan.md" ? apPlan : planPath === "plan.md" ? rootPlan : planPath ? nativePlan : null;
    const progressPath = apProgress !== null ? ".appmod/progress.md" : trusted(rootProgress) && rootProgress !== null ? "progress.md" :
        nativeProgress !== null && hasMarker(nativeProgress) ? ".github/modernize/progress.md" : null;
    const progressMd = progressPath === ".appmod/progress.md" ? apProgress : progressPath === "progress.md" ? rootProgress : progressPath ? nativeProgress : null;
    const summaryMd = apSummary || (trusted(rootSummary) ? rootSummary : null) ||
        (nativeSummary !== null && hasMarker(nativeSummary) ? nativeSummary : null);
    let reportConfigStatus = null;
    let planConfigStatus = null;
    if (assessmentConfig) {
        if (reportStatus !== "ready") reportConfigStatus = "missing";
        else {
            const scope = report.scope;
            const scopeConfig = scope && typeof scope.module === "string" && scope.module &&
                typeof scope.targetJava === "number" && typeof scope.cloud === "string" && scope.cloud ? scope : null;
            const options = report.assessmentConfig || scopeConfig;
            if (!report.assessmentId || !options) reportConfigStatus = "unverified";
            else reportConfigStatus = report.assessmentId === assessmentConfig.id &&
                options.module === assessmentConfig.module && options.targetJava === assessmentConfig.targetJava &&
                options.cloud === assessmentConfig.cloud ? "current" : "outdated";
        }
        const planDocs = [planMd, progressMd].filter(Boolean);
        if (!planDocs.length) planConfigStatus = "missing";
        else if (planDocs.some((doc) => !artifactAssessmentId(doc))) planConfigStatus = "unverified";
        else planConfigStatus = planDocs.every((doc) => artifactAssessmentId(doc) === assessmentConfig.id) ? "current" : "outdated";
    }
    const planRevision = planMd == null ? null : createHash("sha256").update(planMd).digest("hex");
    const adoptable = !!planMd && !!assessmentConfig && reportConfigStatus === "current" && !!reportRaw &&
        planConfigStatus === "unverified" && parseChecklist(planMd).length > 0 &&
        [[planMd, planPath], [progressMd, progressPath]].filter(([doc]) => doc != null).every(([doc, path]) => {
            const id = artifactAssessmentId(doc);
            return (!id || id === assessmentConfig.id) &&
                (!/<!--\s*appmod-assessment-id:/i.test(doc.slice(0, 2000)) || !!id) &&
                (hasMarker(doc) || path?.startsWith(".appmod/"));
        });
    const planContentHash = planMd == null ? null : createHash("sha256")
        .update(planMd.replace(/^(\s*[-*]\s+\[)[ xX/~\-](\]\s+)/gm, "$1 $2")).digest("hex");
    const approvalRaw = await readText(join(repoPath, ".appmod", "plan-approval.json"));
    let planApprovalStatus = approvalRaw == null ? "missing" : "invalid";
    if (approvalRaw != null) {
        try {
            const approval = JSON.parse(approvalRaw);
            const config = assessmentConfig;
            if (approval && typeof approval.planHash === "string" && typeof approval.assessmentId === "string" &&
                typeof approval.planPath === "string" && approval.scope && typeof approval.scope === "object") {
                planApprovalStatus = config && approval.assessmentId === config.id && approval.planPath === planPath &&
                    approval.planHash === planContentHash && approval.scope.module === config.module &&
                    approval.scope.targetJava === config.targetJava && approval.scope.cloud === config.cloud &&
                    reportConfigStatus === "current" && planConfigStatus === "current" ? "approved" : "outdated";
            }
        } catch { planApprovalStatus = "invalid"; }
    }

    const assessment = await buildAssessment(repoPath);
    const skills = await discoverSkills(repoPath);

    const planSteps = parseSteps(planMd);
    const progressSteps = parseSteps(progressMd);
    // Tag each step with its canonical phase rank for ordering guidance.
    for (const arr of [planSteps, progressSteps]) {
        for (const st of arr) st.rank = phaseRankFromName(st.section);
    }
    // Keep progress status while using the reviewed plan for step names and order.
    const linkedSteps = planMd && parseChecklist(planMd).length ? planSteps.map((step) => {
        const progress = progressSteps.find((item) => step.id && item.id === step.id) ||
            progressSteps.find((item) => item.title === step.title && (item.section || "") === (step.section || ""));
        return { ...step, status: progress?.status || step.status };
    }) : null;
    if (report?.findings && reportStatus === "ready") {
        const counts = new Map();
        for (const finding of report.findings) counts.set(finding.id, (counts.get(finding.id) || 0) + 1);
        report = { ...report, findings: report.findings.map((finding) => {
            const matches = !nativeReport && reportConfigStatus === "current" && planConfigStatus === "current" && counts.get(finding.id) === 1 ?
                (linkedSteps || planSteps).filter((step) => step.findingIds?.includes(finding.id)) : [];
            const planSteps = matches.map(({ id, title, section, status, rank }) => ({ id, title, section, status, rank }));
            const status = !matches.length ? "unmatched" : matches.every((step) => step.status === "done") ? "done" :
                matches.some((step) => step.status === "failed") ? "failed" :
                matches.some((step) => step.status === "in_progress" || step.status === "done") ? "in_progress" : "pending";
            return { ...finding, planSteps, status };
        }) };
    }
    const steps = linkedSteps || (progressSteps.length ? progressSteps : planSteps);
    const percent = percentDone(steps);
    const ordering = computeOrdering(steps);
    // Prefer an explicit "Validation"/"gates" section for gate status; fall back
    // to scanning all steps when no such section exists.
    const gateSteps =
        sectionSteps(progressMd) ||
        sectionSteps(summaryMd) ||
        (steps.some((step) => step.section) ? [] : steps);
    const gates = deriveGates(gateSteps, validationSection(summaryMd));

    let status = "not_started";
    if (summaryMd && VALIDATION_GATES.every(({ key }) => gates[key] === "done") &&
        (!assessmentConfig || (reportConfigStatus === "current" && planConfigStatus === "current"))) status = "completed";
    else if (planMd || progressMd || summaryMd) status = "in_progress";

    let git = null;
    if (includeGit) {
        const branch = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
        const dirty = await execGit(["status", "--porcelain"], repoPath);
        git = {
            branch,
            isMigrationBranch: !!branch && /moderniz|migrat|upgrade|appmod/i.test(branch),
            dirty: dirty === null ? null : dirty.length > 0,
            changedFiles: dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0,
        };
    }

    return {
        ok: true,
        repoPath,
        scannedAt: new Date().toISOString(),
        status,
        percent,
        assessment,
        tasks: catalogWithRelevance(assessment.detectedKeys),
        skills,
        git,
        plan: { exists: !!planMd, steps: planSteps, markdown: planMd || "", editableMarkdown: planMd ?
            (adoptable ? withAssessmentId(editablePlanMarkdown(planMd), assessmentConfig.id) : editablePlanMarkdown(planMd)) : "",
            adoptable, path: planPath, revision: planRevision, contentHash: planContentHash },
        progress: { exists: !!progressMd, steps: linkedSteps && progressMd ? linkedSteps : progressSteps, path: progressPath,
            revision: progressMd == null ? null : createHash("sha256").update(progressMd).digest("hex") },
        summary: { exists: !!summaryMd, markdown: summaryMd || "" },
        report,
        reportStatus,
        reportRevision: reportRaw == null ? null : createHash("sha256").update(reportRaw).digest("hex"),
        reportSource: nativeReport ? "native" : (reportRaw == null ? null : "cockpit"),
        reportPath: nativeReport ? nativeReport.path : (reportRaw == null ? null : ".appmod/assessment.json"),
        assessmentConfig,
        assessmentConfigStatus,
        reportConfigStatus,
        planConfigStatus,
        planApprovalStatus,
        ordering,
        gates,
    };
}
