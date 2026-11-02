// extension.mjs — Java Modernization Studio canvas. Wiring only.
//
// Declares the canvas and bridges the SDK to the testable modules:
//   scan.mjs      repo + markdown parsing -> grounded state
//   catalog.mjs   Microsoft predefined task catalog
//   prompts.mjs   action -> crafted agent prompt
//   server.mjs    per-instance loopback HTTP server + action dispatch
//   renderer.mjs  cockpit UI
//
// Button clicks POST /action; agent actions are forwarded to session.send. When a
// turn finishes (session.idle) every open cockpit re-scans and pushes fresh state.

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { basename } from "node:path";
import { buildState, createInstanceServer, pushState, refreshAfterTurn, resolveRepoPath } from "./server.mjs";
import { AUTOPILOT_TURN_TIMEOUT_MS } from "./autopilot.mjs";
import { handleModernizationPrompt } from "./intent.mjs";

const instances = new Map(); // instanceId -> rec { server, url, repoPath, sseClients }
let sessionRef = null;
let lastWorkingDir = null;

const session = await joinSession({
    hooks: {
        onSessionStart: (input) => {
            if (input.workingDirectory) lastWorkingDir = input.workingDirectory;
        },
        onUserPromptSubmitted: async (input) => {
            if (input.workingDirectory) lastWorkingDir = input.workingDirectory;
            return handleModernizationPrompt(input, sessionRef);
        },
    },
    canvases: [
        createCanvas({
            id: "appmod-cockpit",
            displayName: "Java Modernization Studio",
            description:
                "Drive the GitHub Copilot App Modernization for Java workflow: assessment, plan/progress, validation gates, and task/skill runs grounded in the repo's real artifacts.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    repoPath: { type: "string", description: "Absolute path to the Java repo to inspect." },
                    initialTab: { type: "string", enum: ["overview", "readiness", "assessment", "plan", "validation", "tasks", "summary"] },
                },
            },
            actions: [
                {
                    name: "get_state",
                    description:
                        "Return the current modernization state snapshot scanned from the repo (assessment, plan/progress, gates, skills, tasks).",
                    handler: async (ctx) => {
                        const rec = instances.get(ctx.instanceId);
                        if (!rec) throw new CanvasError("not_open", "Cockpit instance is not open.");
                        return await buildState(rec);
                    },
                },
                {
                    name: "refresh",
                    description: "Re-scan the repo and push a fresh snapshot to the open cockpit.",
                    handler: async (ctx) => {
                        const rec = instances.get(ctx.instanceId);
                        if (!rec) throw new CanvasError("not_open", "Cockpit instance is not open.");
                        const state = await pushState(rec, logFn, { recheckEnv: true });
                        if (!state?.ok) throw new CanvasError("refresh_failed", state?.error || "Could not refresh the repository state.");
                        return state;
                    },
                },
            ],
            open: async (ctx) => {
                const directory = ctx.input?.repoPath ? null : (await sessionRef.rpc.metadata.snapshot()).workingDirectory;
                const repoPath = resolveRepoPath(ctx, directory || lastWorkingDir);
                if (directory) lastWorkingDir = directory;
                const initialTab = ctx.input && ctx.input.initialTab ? ctx.input.initialTab : "assessment";
                let rec = instances.get(ctx.instanceId);
                if (!rec) {
                    rec = await createInstanceServer({
                        instanceId: ctx.instanceId,
                        repoPath,
                        initialTab,
                        sendPrompt: (prompt, displayPrompt) => sessionRef.send({ prompt, displayPrompt }),
                        runTurn: (prompt, displayPrompt) => sessionRef.sendAndWait({ prompt, displayPrompt }, AUTOPILOT_TURN_TIMEOUT_MS),
                        log: logFn,
                    });
                    instances.set(ctx.instanceId, rec);
                } else if (rec.repoPath !== repoPath) {
                    rec.repoPath = repoPath; // refresh target on re-open
                    rec.doctor = null; // env readiness depends on repo facts — recompute for the new target
                }
                return {
                    title: "Java Modernization Studio",
                    status: repoPath ? basename(repoPath) : "no repo",
                    url: rec.url,
                };
            },
            onClose: async (ctx) => {
                const rec = instances.get(ctx.instanceId);
                if (rec) {
                    instances.delete(ctx.instanceId);
                    for (const res of rec.sseClients) {
                        try {
                            res.end();
                        } catch {
                            /* ignore */
                        }
                    }
                    await new Promise((resolve) => rec.server.close(() => resolve()));
                }
            },
        }),
    ],
});

sessionRef = session;
function logFn(message, opts) {
    try {
        return sessionRef.log(message, opts);
    } catch {
        /* logging is best-effort */
    }
}

// A finished turn may have changed plan.md/progress.md/summary.md or the working
// tree — re-scan and push fresh state to every open cockpit.
session.on("session.idle", async () => {
    for (const rec of instances.values()) {
        await refreshAfterTurn(rec, logFn);
    }
});

await session.log("Java Modernization Studio ready", { ephemeral: true });
