import { join } from "node:path";

export const CLI_CONTRACT_VERSION = 1;
export const CLI_DOMAINS = ["java-upgrade", "cloud-readiness", "security"];
export const CLI_AZURE_TARGETS = ["azure-aks", "azure-appservice", "azure-container-apps"];
export const CLI_TARGET_OS = ["windows", "linux"];

export function cliConfigPath(id) {
    return join(".appmod", `assessment-cli-${id}.yaml`);
}

export function cliOutputDir(id) {
    return join(".appmod", "native-assessment", id);
}

export function cliReportPath(id) {
    return join(cliOutputDir(id), "report.json");
}

export function buildCliConfig(config) {
    if (![17, 21].includes(config.targetJava) || config.cloud !== "Azure") {
        throw new Error("Unsupported Modernize CLI assessment target.");
    }
    return [
        "analysisCoverage: issue-only",
        "security:",
        "  minimumCveSeverity: high",
        "  cveScanScope: direct",
        "java:",
        "  assessmentDomains:",
        ...CLI_DOMAINS.map((domain) => "    - " + domain),
        "  targetRuntime: openjdk" + config.targetJava,
        "  targetComputeServices:",
        ...CLI_AZURE_TARGETS.map((target) => "    - " + target),
        "  targetOS:",
        ...CLI_TARGET_OS.map((os) => "    - " + os),
        "  enableContainerization: false",
        "",
    ].join("\n");
}

function sameValues(actual, expected) {
    return Array.isArray(actual) && actual.length === expected.length &&
        new Set(actual).size === expected.length && expected.every((value) => actual.includes(value));
}

export function verifyCliReport(report, config) {
    const meta = report?.metadata;
    if (report?.version !== "1.0.0" || !meta || !["complete", "completed"].includes(String(meta.status).toLowerCase()) ||
        !Array.isArray(report.projects) || !report.projects.length) {
        return { ok: false, error: "The native Modernize CLI report is not complete." };
    }
    const requestedAt = Date.parse(config.requestedAt);
    const startedAt = Date.parse(meta.analysisStartTime);
    if (!Number.isFinite(requestedAt) || !Number.isFinite(startedAt) || startedAt < requestedAt) {
        return { ok: false, error: "The native report predates this assessment request." };
    }
    if (!sameValues(meta.capabilities, ["openjdk" + config.targetJava])) {
        return { ok: false, error: "The native report does not target Java " + config.targetJava + "." };
    }
    if (!sameValues(meta.domains, CLI_DOMAINS) || !Array.isArray(report.security)) {
        return { ok: false, error: "The native report did not assess all requested domains, including security." };
    }
    if (!sameValues(meta.targetIds, CLI_AZURE_TARGETS) || !sameValues(meta.os, CLI_TARGET_OS)) {
        return { ok: false, error: "The native report did not use the requested Azure targets and operating systems." };
    }
    if (meta.mode !== "issue-only" || meta.minimumCveSeverity !== "high") {
        return { ok: false, error: "The native report did not use the requested analysis coverage and CVE threshold." };
    }
    return { ok: true };
}
