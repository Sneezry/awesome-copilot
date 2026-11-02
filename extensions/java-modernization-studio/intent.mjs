import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { APPMOD_PREAMBLE } from "./prompts.mjs";
import { scanRepo } from "./scan.mjs";

function userRequestText(prompt) {
    if (typeof prompt !== "string") return "";
    // Host-supplied metadata is context, not user intent or a requested repo path.
    return prompt.replace(/(?:^|\r?\n)<(canvas-context|system_reminder|current_datetime)>[\s\S]*?<\/\1>[ \t]*(?=\r?\n|$)/gi, "").trim();
}

export function isJavaModernizationRequest(prompt) {
    const text = userRequestText(prompt);
    if (/^(?:what (?:is|are|does)\b|explain\b|define\b|compare\b)/i.test(text) ||
        /^(?:什么是|解释)/.test(text)) return false;
    return /\bjava\b/i.test(text) &&
        (/\b(?:moderniz|modernis|migrat|upgrad)\w*\b/i.test(text) || /现代化|迁移|升级/.test(text)) &&
        (/\b(?:apps?|applications?|services?|projects?|repos?|repositor(?:y|ies)|codebases?)\b/i.test(text) ||
            /应用|项目|仓库|服务|代码/.test(text));
}

export async function openModernizationCanvas(prompt, workingDirectory, openCanvas) {
    const request = userRequestText(prompt);
    if (!isJavaModernizationRequest(request)) return null;
    if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory)) {
        return { opened: false, reason: "No active repository path is available." };
    }
    const repoPath = resolve(workingDirectory);
    if (/[a-z]:[\\/]|https?:\/\/|(?:^|[\s('"`])(?:\/[^\s]|~[\\/]|\.{1,2}[\\/])/i.test(request)) {
        return { opened: false, reason: "The request names a path or URL; verify that Java repository explicitly." };
    }
    const namedRepo = request.match(/\b(?:in|for)\s+(?:the\s+)?(?:repo(?:sitory)?|project)\s+["'`]?([a-z0-9._/-]+)/i)?.[1];
    if (namedRepo && !["this", "current"].includes(namedRepo.toLowerCase()) &&
        namedRepo.toLowerCase() !== basename(repoPath).toLowerCase()) {
        return { opened: false, reason: "The named repository is not the active repository." };
    }
    const state = await scanRepo(repoPath, { includeGit: false });
    if (!state.ok) return { opened: false, reason: "The active repository is not available." };
    if (!state.assessment.buildTool) {
        const javaSource = await stat(join(repoPath, "src", "main", "java")).then(
            (entry) => entry.isDirectory(),
            (error) => {
                if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
                throw error;
            }
        );
        if (!javaSource) return { opened: false, reason: "The active repository has no detected Java project." };
    }
    const instanceId = "java-modernization-" + createHash("sha256").update(repoPath).digest("hex").slice(0, 20);
    await openCanvas({ canvasId: "appmod-cockpit", instanceId, input: { repoPath, initialTab: "readiness" } });
    return { opened: true, repoPath, instanceId };
}

export async function handleModernizationPrompt(input, session) {
    const prompt = userRequestText(input.prompt);
    if (prompt.startsWith(APPMOD_PREAMBLE + "\n\n")) return;
    if (!isJavaModernizationRequest(prompt)) return;
    try {
        if (session.capabilities.ui?.canvases === false) {
            return { additionalContext: "This host cannot display the Java Modernization Studio canvas. Tell the user the canvas is unavailable; do not assume its approval gates apply to ordinary chat." };
        }
        const directory = input.workingDirectory || (await session.rpc.metadata.snapshot()).workingDirectory;
        const result = await openModernizationCanvas(prompt, directory,
            (request) => session.rpc.canvas.open(request));
        if (!result.opened) {
            return { additionalContext: "Java Modernization Studio was not opened: " + result.reason +
                " If the user gave an explicit Java repoPath, use it after verifying the target; otherwise ask them to select the repository. Do not guess another repository." };
        }
        return { additionalContext: "Java Modernization Studio is open for " + result.repoPath +
            ". Start with Readiness, then configure the assessment and have the user review and approve the plan before changing code." };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (session) {
            try { await session.log("Java Modernization Studio could not open: " + detail, { level: "error" }); }
            catch { /* The hook still reports the failure to the agent. */ }
        }
        return { additionalContext: "Java Modernization Studio could not open: " + detail +
            ". Tell the user what failed; do not proceed as if the canvas or its approval gates are active." };
    }
}
