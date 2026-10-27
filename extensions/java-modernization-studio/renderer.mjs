// renderer.mjs — Single-page cockpit UI served by each instance's loopback server.
// The client script is authored as a real function (clientMain) and serialized to
// a string at render time, so its own template literals / ${} are NOT evaluated by
// this module's template literal. Only CSS and a boot blob are interpolated.

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--background-color-default, #ffffff);
  color: var(--text-color-default, #1f2328);
  font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: var(--text-body-medium, 14px);
  line-height: var(--leading-body-medium, 20px);
}
a { color: var(--true-color-blue, #0969da); }
.muted { color: var(--text-color-muted, #656d76); }
header.top {
  position: sticky; top: 0; z-index: 5;
  background: var(--background-color-default, #fff);
  border-bottom: 1px solid var(--border-color-default, #d0d7de);
  padding: 14px 18px 0;
}
.title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.global-controls { display: flex; align-items: center; gap: 8px; }
.global-controls .branch { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.utility-menu { position: relative; }
.utility-menu summary { cursor: pointer; list-style: none; border: 1px solid var(--border-color-default,#d0d7de); border-radius: 6px; padding: 3px 9px; font-size: 19px; line-height: 23px; }
.utility-menu summary::-webkit-details-marker { display: none; }
.utility-menu summary:focus-visible { outline: 2px solid var(--color-focus-outline, var(--true-color-blue,#0969da)); }
.utility-popover { position: absolute; right: 0; top: calc(100% + 6px); z-index: 12; min-width: 180px; display: flex; flex-direction: column; gap: 6px; background: var(--background-color-default,#fff); border: 1px solid var(--border-color-default,#d0d7de); border-radius: 6px; padding: 8px; box-shadow: 0 6px 16px rgba(31,35,40,.12); }
.utility-popover .btn { text-align: left; }
h1 {
  font-size: var(--text-title-medium, 18px);
  font-weight: var(--font-weight-semibold, 600);
  margin: 0; letter-spacing: .2px;
}
.spacer { flex: 1; }
.repo { font-family: var(--font-mono, monospace); font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 12px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--border-color-default, #d0d7de);
  border-radius: 999px; padding: 3px 10px; font-size: 12px;
  background: var(--background-color-muted, #f6f8fa);
}
.chip b { font-weight: 600; }
.badge { border-radius: 999px; padding: 2px 9px; font-size: 11px; font-weight: 600; border: 1px solid transparent; white-space: nowrap; }
.b-green { color: #fff; background: var(--true-color-green, #1a7f37); }
.b-amber { color: #fff; background: var(--true-color-orange, #9a6700); }
.b-red   { color: #fff; background: var(--true-color-red, #cf222e); }
.b-gray  { color: var(--text-color-default,#1f2328); background: var(--background-color-muted,#eaeef2); border-color: var(--border-color-default,#d0d7de); }
.b-blue  { color: #fff; background: var(--true-color-blue, #0969da); }
nav.tabs { display: flex; gap: 2px; margin-top: 6px; flex-wrap: wrap; }
nav.tabs button {
  background: none; border: none; border-bottom: 2px solid transparent;
  padding: 8px 12px; font-size: 13px; cursor: pointer; color: var(--text-color-muted,#656d76);
  font-family: inherit;
}
nav.tabs button.active { color: var(--text-color-default,#1f2328); border-bottom-color: var(--true-color-blue,#0969da); font-weight: 600; }
nav.tabs button:hover { color: var(--text-color-default,#1f2328); border-bottom-color: var(--border-color-default,#d0d7de); }
nav.tabs button.active:hover { border-bottom-color: var(--true-color-blue,#0969da); }
nav.tabs button:focus-visible { outline: 2px solid var(--color-focus-outline, var(--true-color-blue,#0969da)); outline-offset: -2px; border-radius: 4px; }
nav.tabs button .count { font-size: 11px; color: var(--text-color-muted,#656d76); }
main { padding: 16px 18px 40px; max-width: 980px; }
.workflow-overview { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 10px 0 14px; margin-bottom: 16px; border-bottom: 1px solid var(--border-color-default,#d0d7de); }
.workflow-stage, .workflow-next { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.workflow-stage strong, .workflow-next strong { overflow-wrap: anywhere; }
.workflow-stage span, .workflow-next span { color: var(--text-color-muted,#656d76); font-size: 12px; }
.workflow-next { flex: 1 1 320px; }
.workflow-next .btn { margin-left: auto; }
.summary-details { flex: 0 0 100%; font-size: 12.5px; }
.summary-details summary, .run-log summary { cursor: pointer; font-weight: 600; }
.summary-details .md { margin-top: 8px; }
.card {
  border: 1px solid var(--border-color-default, #d0d7de);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
  background: var(--background-color-default, #fff);
}
.card h2 { font-size: 14px; margin: 0 0 10px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.card.relevant { border-color: var(--true-color-blue, #0969da); box-shadow: 0 0 0 1px var(--true-color-blue-muted, rgba(9,105,218,.25)); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px,1fr)); gap: 10px; }
.kv { display: flex; flex-direction: column; gap: 2px; }
.kv .k { font-size: 11px; text-transform: uppercase; letter-spacing: .4px; color: var(--text-color-muted,#656d76); }
.kv .v { font-size: 14px; font-weight: 600; }
button.btn {
  font-family: inherit; font-size: 12.5px; cursor: pointer;
  border: 1px solid var(--border-color-default, #d0d7de);
  background: var(--background-color-muted, #f6f8fa);
  color: var(--text-color-default, #1f2328);
  border-radius: 7px; padding: 6px 12px;
}
button.btn:not(.primary):not(:disabled):hover {
  background: var(--background-color-muted, #eaeef2);
  border-color: var(--border-color-muted, #afb8c1);
  box-shadow: inset 0 0 0 999px rgba(140,149,159,.14);
}
button.btn.primary { background: var(--true-color-blue, #0969da); color: #fff; border-color: transparent; }
button.btn.primary:not(:disabled):hover { filter: brightness(1.08); box-shadow: 0 1px 2px rgba(31,35,40,.18); }
button.btn:focus-visible { outline: 2px solid var(--color-focus-outline, var(--true-color-blue, #0969da)); outline-offset: 1px; }
button.btn:disabled { opacity: .55; cursor: default; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.progress { height: 8px; border-radius: 999px; background: var(--background-color-muted,#eaeef2); overflow: hidden; }
.progress > span { display: block; height: 100%; background: var(--true-color-green,#1a7f37); }
ul.steps { list-style: none; margin: 0; padding: 0; }
ul.steps li { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; border-bottom: 1px solid var(--border-color-muted, #eaeef2); }
ul.steps li:last-child { border-bottom: none; }
.dot { width: 16px; height: 16px; border-radius: 50%; flex: 0 0 auto; margin-top: 2px; border: 2px solid; }
.dot.done { background: var(--true-color-green,#1a7f37); border-color: var(--true-color-green,#1a7f37); }
.dot.in_progress { background: var(--true-color-orange,#9a6700); border-color: var(--true-color-orange,#9a6700); }
.dot.failed { background: var(--true-color-red,#cf222e); border-color: var(--true-color-red,#cf222e); }
.dot.pending { background: transparent; border-color: var(--border-color-default,#8c959f); }
.task { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border-color-muted,#eaeef2); }
.task:last-child { border-bottom: none; }
.task .body { flex: 1; }
.task .name { font-weight: 600; font-size: 13px; }
.task .sum { font-size: 12.5px; color: var(--text-color-muted,#656d76); margin-top: 2px; }
.cat { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--text-color-muted,#656d76); margin: 14px 0 4px; font-weight: 600; }
.empty { text-align: center; padding: 26px 16px; color: var(--text-color-muted,#656d76); }
.empty .big { font-size: 15px; color: var(--text-color-default,#1f2328); margin-bottom: 6px; font-weight: 600; }
.assessment-settings { padding: 0 0 16px; margin-bottom: 16px; border-bottom: 1px solid var(--border-color-default,#d0d7de); }
.assessment-settings h2 { font-size: 14px; margin: 0 0 12px; }
.setting-fields { display: grid; grid-template-columns: repeat(auto-fit,minmax(180px,1fr)); gap: 12px; margin-bottom: 12px; }
.setting-fields label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-color-muted,#656d76); min-width: 0; }
.setting-fields select, .setting-fields .setting-value { color: var(--text-color-default,#1f2328); font: inherit; font-size: 13px; }
.setting-fields select { width: 100%; padding: 6px 8px; border: 1px solid var(--border-color-default,#d0d7de); border-radius: 4px; background: var(--background-color-default,#fff); }
.setting-fields .setting-value { overflow-wrap: anywhere; padding: 7px 0; }
.toast {
  position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
  background: var(--true-color-blue,#0969da); color: #fff; padding: 9px 16px;
  border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 20;
  max-width: 90%;
}
.toast.show { opacity: 1; }
.banner { background: var(--true-color-blue-muted, #ddf4ff); border: 1px solid var(--true-color-blue,#0969da); color: var(--text-color-default,#1f2328); padding: 8px 12px; border-radius: 8px; font-size: 12.5px; margin-bottom: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; overflow-wrap: anywhere; }
.banner > span:not(.spin):not(.spacer) { flex: 1 1 200px; min-width: 0; }
.banner > .btn { margin-left: auto; }
.md { font-size: 13px; line-height: 1.55; }
.md h1,.md h2,.md h3 { font-size: 15px; margin: 14px 0 6px; }
.md code { font-family: var(--font-mono,monospace); background: var(--background-color-muted,#f6f8fa); padding: 1px 4px; border-radius: 4px; font-size: 12px; }
.md ul { padding-left: 20px; }
.spin { width:13px; height:13px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; display:inline-block; animation: sp .7s linear infinite; }
@keyframes sp { to { transform: rotate(360deg); } }

.hero { border: 1px solid var(--true-color-blue,#0969da); background: var(--true-color-blue-muted,#ddf4ff); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.hero .eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; font-weight: 700; color: var(--true-color-blue,#0969da); }
.hero .htitle { font-size: 16px; font-weight: 700; margin: 3px 0 4px; }
.hero .hbody { font-size: 13px; color: var(--text-color-default,#1f2328); margin: 0 0 10px; }

/* findings */
.sevrow { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.finding { border: 1px solid var(--border-color-default,#d0d7de); border-left-width: 4px; border-radius: 8px; padding: 11px 13px; margin-bottom: 9px; }
.finding.sev-P0 { border-left-color: var(--true-color-red,#cf222e); }
.finding.sev-P1 { border-left-color: var(--true-color-orange,#9a6700); }
.finding.sev-P2 { border-left-color: var(--true-color-blue,#0969da); }
.finding.sev-P3 { border-left-color: var(--border-color-default,#8c959f); }
.finding.sev-mandatory { border-left-color: var(--true-color-red,#cf222e); }
.finding.sev-potential { border-left-color: var(--true-color-orange,#9a6700); }
.finding.sev-optional { border-left-color: var(--true-color-blue,#0969da); }
.finding.sev-information { border-left-color: var(--border-color-default,#8c959f); }
.finding .ftitle { font-weight: 600; font-size: 13.5px; display: flex; align-items: center; gap: 8px; }
.finding .fdetail { font-size: 12.5px; color: var(--text-color-default,#1f2328); margin: 6px 0 0; }
.finding .fcontext { font-size: 12.5px; line-height: 1.45; margin: 6px 0 0; overflow-wrap: anywhere; }
.finding .fcontext strong { color: var(--text-color-muted,#656d76); }
.finding .fevidence { margin-top: 8px; font-size: 12px; }
.finding .fevidence summary { cursor: pointer; font-weight: 600; }
.finding .fevidence ul { margin: 6px 0 0 18px; padding: 0; }
.finding .fevidence li { margin: 0 0 4px; overflow-wrap: anywhere; }
.finding .fevidence pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; padding: 6px; background: var(--background-color-muted,#f6f8fa); }
.finding .fmeta { font-size: 11.5px; color: var(--text-color-muted,#656d76); margin-top: 5px; }
.finding-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 16px 0 8px; }
.finding-filters .btn[aria-pressed="true"] { border-color: var(--true-color-blue,#0969da); color: var(--true-color-blue,#0969da); font-weight: 600; }
.finding .ffiles { font-size: 11.5px; color: var(--text-color-muted,#656d76); margin-top: 7px; display: flex; flex-wrap: wrap; gap: 4px; }
.finding .ffiles code { font-family: var(--font-mono,monospace); background: var(--background-color-muted,#f6f8fa); padding: 1px 5px; border-radius: 4px; word-break: break-all; }

/* plan & progress steps */
.plan-review { border-block: 1px solid var(--border-color-default,#d0d7de); padding: 14px 0; margin-bottom: 16px; }
.plan-review-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.plan-review-head h2 { font-size: 14px; margin: 0; }
.plan-review-scope { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 0 0 12px; font-size: 12.5px; }
.plan-review-scope div { display: flex; gap: 5px; min-width: 0; }
.plan-review-scope dt { color: var(--text-color-muted,#656d76); }
.plan-review-scope dd { margin: 0; overflow-wrap: anywhere; }
.plan-editor-label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
#plan-editor { display: block; width: 100%; min-height: 260px; resize: vertical; font: 12.5px/1.5 var(--font-mono,monospace); color: var(--text-color-default,#1f2328); background: var(--background-color-default,#fff); border: 1px solid var(--border-color-default,#d0d7de); border-radius: 6px; padding: 10px; margin-bottom: 10px; }
#plan-editor:focus-visible { outline: 2px solid var(--color-focus-outline, var(--true-color-blue,#0969da)); outline-offset: 1px; }
.plan-review-confirm { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 12px; font-size: 12.5px; }
.plan-review-confirm input { margin-top: 2px; }
.plan-links { border: 0; padding: 0; margin: 0 0 12px; min-width: 0; }
.plan-links legend { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.plan-links label { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 1fr); align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12.5px; }
.plan-links label span { overflow-wrap: anywhere; }
.plan-links select { width: 100%; min-width: 0; padding: 5px 7px; color: var(--text-color-default,#1f2328); background: var(--background-color-default,#fff); border: 1px solid var(--border-color-default,#d0d7de); border-radius: 4px; }
@media (max-width: 600px) { .plan-links label { grid-template-columns: 1fr; } }
.legend { display: flex; gap: 16px; margin-top: 11px; font-size: 11.5px; color: var(--text-color-muted,#656d76); }
.legend > span { display: inline-flex; align-items: center; }
.legend .dot { width: 12px; height: 12px; margin: 0 5px 0 0; }
ul.steps li { align-items: center; }
ul.steps li .stext { flex: 1; min-width: 0; overflow-wrap: anywhere; }
ul.steps li .srhs { flex: 0 0 auto; margin-left: 10px; }
.smuted { font-size: 11.5px; color: var(--text-color-muted,#656d76); white-space: nowrap; }
ul.steps li.locked .stext { opacity: .55; }
ul.steps li.locked .dot { opacity: .5; }
.card.locked { border-style: dashed; }
.card.locked > h2 { color: var(--text-color-muted,#656d76); }
.finding.locked { opacity: .72; }
.finding.locked .ftitle { opacity: .8; }
/* environment doctor / readiness checks */
ul.checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
ul.checks li { display: flex; gap: 10px; align-items: flex-start; }
ul.checks .ci { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex: 0 0 auto; margin-top: 1px; }
.chk.ok .ci { background: rgba(26,127,55,.15); color: var(--true-color-green,#1a7f37); }
.chk.warn .ci { background: rgba(154,103,0,.18); color: #9a6700; }
.chk.fail .ci { background: rgba(207,34,46,.15); color: var(--true-color-red,#cf222e); }
.chk.info .ci { background: var(--background-color-muted,#eaeef2); color: var(--text-color-muted,#656d76); }
ul.checks .cbody { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
ul.checks .clabel { font-weight: 600; }
ul.checks .cdetail { font-size: 12px; color: var(--text-color-muted,#656d76); }
ul.checks .cfix { font-size: 12px; color: #9a6700; margin-top: 2px; }
ul.checks .crhs { flex: 0 0 auto; }
.chk.fail .clabel { color: var(--true-color-red,#cf222e); }
.banner-red { border-color: var(--true-color-red,#cf222e); background: rgba(207,34,46,.08); }
nav.tabs button .count.c-red { color: var(--true-color-red,#cf222e); font-weight: 700; }
nav.tabs button .count.c-amber { color: #9a6700; font-weight: 700; }
.lockwhy { margin-right: 8px; }
/* autopilot */
.banner-auto { border-color: var(--true-color-blue,#0969da); background: var(--true-color-blue-muted,#ddf4ff); align-items: center; }
.badge.b-blue { background: var(--true-color-blue-muted,#ddf4ff); color: var(--true-color-blue,#0969da); }
.apc { font-size: 11.5px; color: var(--text-color-muted,#656d76); margin-left: 6px; }
ul.aplog { list-style: none; margin: 8px 0 12px; padding: 8px 12px; border: 1px solid var(--border-color-default,#d0d7de); border-radius: 8px; background: var(--background-color-muted,#f6f8fa); display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
ul.aplog li { display: block; }
.apok { color: var(--true-color-green,#1a7f37); font-weight: 700; }
.apno { color: var(--true-color-red,#cf222e); font-weight: 700; }
@media (max-width: 600px) {
    header.top { padding: 12px 12px 0; }
    main { padding: 12px 12px 32px; }
    .global-controls { flex: 1 1 100%; min-width: 0; flex-wrap: wrap; }
    .global-controls .branch { max-width: min(45vw, 180px); min-width: 0; }
    .utility-menu { margin-left: auto; }
    .workflow-next { flex-basis: 100%; }
    .workflow-next .btn { margin-left: 0; }
    ul.steps li { flex-wrap: wrap; }
    ul.steps li .srhs { flex: 1 1 100%; min-width: 0; margin-left: 25px; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
}
`;

function clientMain() {
    const boot = window.__APPMOD__ || {};
    // The host embeds a per-instance token in the iframe URL; echo it back on every
    // request so the loopback server accepts us. Empty in unit harnesses (no guard).
    const apiToken = boot.token || "";
    const tokenQuery = apiToken ? "?token=" + encodeURIComponent(apiToken) : "";
    let state = null;
    const legacyTabs = { overview: "assessment", tasks: "assessment", summary: "validation" };
    let activeTab = legacyTabs[boot.initialTab] || boot.initialTab || "assessment";
    let pending = null;
    let autopilotRunning = false;
    let entryResolved = false;
    let planEditing = false;
    let planDraft = null;
    let planBaseRevision = null;
    let planBaseAdopting = false;
    let planBaseReportRevision = null;
    let planBaseProgressRevision = null;
    let planBaseAssessmentId = null;
    let severityFilter = "all";
    let batchConfirm = false;

    const $ = (sel) => document.querySelector(sel);
    const esc = (s) =>
        String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );

    function toast(msg) {
        const t = $("#toast");
        t.textContent = msg;
        t.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove("show"), 2600);
    }

    function routeFirstSnapshot(next) {
        if (entryResolved || !next || !next.ok) return;
        entryResolved = true;
        if (next.doctor && next.doctor.overall === "blocked") activeTab = "readiness";
    }

    function statusBadge(status) {
        const map = {
            completed: ["b-green", "Completed"],
            in_progress: ["b-amber", "In progress"],
            not_started: ["b-gray", "Not started"],
            done: ["b-green", "Done"],
            unmatched: ["b-gray", "Not in plan"],
            pending: ["b-gray", "Pending"],
            failed: ["b-red", "Failed"],
            not_run: ["b-gray", "Not run"],
            pass: ["b-green", "Pass"],
        };
        const [cls, label] = map[status] || ["b-gray", status || "—"];
        return '<span class="badge ' + cls + '">' + esc(label) + "</span>";
    }

    function btn(label, kind, payload, opts) {
        opts = opts || {};
        const cls = "btn" + (opts.primary ? " primary" : "");
        // While Autopilot runs, freeze manual actions so a stray click can't inject
        // a competing prompt into the same session — except Stop and tab navigation.
        const frozen = autopilotRunning && kind !== "autopilot_stop" && kind !== "autopilot_dismiss" && kind !== "filter_severity" && String(kind).indexOf("goto:") !== 0;
        const needsReview = state && (state.assessmentConfigStatus === "invalid" ||
            (state.assessmentConfig && (state.reportConfigStatus !== "current" || state.planConfigStatus !== "current")));
        const execution = ["run_task", "run_skill", "run_cve", "generate_tests", "run_build_tests", "run_consistency", "run_completeness", "work_step", "auto_step", "fix_finding", "open_pr", "autopilot_start"].includes(kind);
        const mutating = ["run_task", "run_skill", "generate_tests", "work_step", "auto_step", "fix_finding", "open_pr", "create_skill", "autopilot_start"].includes(kind);
        const configBlocked = needsReview && (execution || (kind === "generate_plan" && state.reportConfigStatus !== "current"));
        const approvalBlocked = (mutating || kind === "confirm_recommendations") && state && state.planApprovalStatus !== "approved";
        const dis = pending || frozen || configBlocked || approvalBlocked || (kind === "approve_plan" && planEditing) ? " disabled" : "";
        const title = configBlocked ? ' title="Review the assessment and plan for the selected settings"' :
            approvalBlocked ? ' title="Approve the current plan before making changes"' : "";
        const pressed = typeof opts.pressed === "boolean" ? ' aria-pressed="' + opts.pressed + '"' : "";
        return (
            '<button class="' + cls + '" data-kind="' + esc(kind) + '" data-payload="' +
            esc(JSON.stringify(payload || {})) + '"' + title + pressed + dis + ">" + esc(label) + "</button>"
        );
    }

    function workflowStatus(s) {
        const blocked = s.doctor?.overall === "blocked";
        const next = blocked ? { title: "Resolve required environment tools" } : heroNext(s);
        const reportReady = !!s.report && s.reportStatus === "ready";
        const needsAssessment = !reportReady || (s.assessmentConfig && s.reportConfigStatus !== "current");
        const needsPlan = !s.plan?.exists || (s.assessmentConfig && s.planConfigStatus !== "current") || s.planApprovalStatus !== "approved";
        const target = blocked ? "readiness" : next.target;
        const steps = s.progress?.steps?.length ? s.progress.steps : (s.plan?.steps || []);
        const remaining = steps.filter((step) => step.status !== "done").length;
        const phase = blocked ? "Readiness blocked" : s.status === "completed" ? "Ready to ship" :
            s.ordering?.activePhase || (needsAssessment ? reportReady ? "Assessment review" : "Assessment" :
            needsPlan ? s.plan?.exists ? "Plan review" : "Plan" : remaining ? "Remediation" : "Validation");
        const progressText = steps.length ? esc(s.percent || 0) + '% complete · ' + remaining + ' remaining' :
            !reportReady || blocked ? "Not started" : needsAssessment ? "Report available · settings need review" : "Report ready · plan not started";
        let html = '<section class="workflow-overview" aria-label="Workflow status"><div class="workflow-stage">' +
            '<strong>' + esc(phase) + '</strong><span>' + progressText +
            (s.scannedAt ? '</span><span>Last checked ' + esc(fmtDate(s.scannedAt)) : '') +
            '</span></div><div class="workflow-next"><span>Next</span><strong>' + esc(next.title) + '</strong>' +
            (next.eyebrow === "Final step" ? btn("Open pull request", "open_pr", {}, { primary: true }) :
                activeTab === target ? "" : btn("Open " + (target === "readiness" ? "Readiness" : target === "assessment" ? "Assess" : target === "plan" ? "Plan" : "Validate"), "goto:" + target)) +
            '</div>';
        if (s.summary?.exists && s.summary.markdown) {
            html += '<details class="summary-details"><summary>Summary</summary><div class="md">' + miniMd(s.summary.markdown) + '</div></details>';
        }
        return html + '</section>';
    }

    // ---- tab renderers -------------------------------------------------------

    function assessmentSettings(s) {
        const config = s.assessmentConfig || {};
        const modules = [".", ...((s.assessment && s.assessment.modules) || [])];
        if (config.module && !modules.includes(config.module)) modules.push(config.module);
        const moduleChoice = config.module || ".";
        const javaChoice = config.targetJava || 21;
        let html = '<section class="assessment-settings"><h2>Assessment settings</h2><div class="setting-fields">' +
            '<label>Repository<span class="setting-value">' + esc(s.repoPath) + '</span></label>' +
            '<label for="assessment-module">Scope<select id="assessment-module">';
        for (const module of modules) {
            html += '<option value="' + esc(module) + '"' + (module === moduleChoice ? " selected" : "") + '>' +
                esc(module === "." ? "Whole repository" : module) + '</option>';
        }
        html += '</select></label><label for="assessment-java">Target Java<select id="assessment-java">';
        for (const version of [17, 21]) {
            html += '<option value="' + version + '"' + (version === javaChoice ? " selected" : "") + '>Java ' + version + '</option>';
        }
        html += '</select></label><label>Cloud<span class="setting-value">Azure</span></label></div>' +
            btn(s.report || s.assessmentConfig || s.reportStatus === "invalid" ? "Re-run assessment" : "Run assessment", "submit_assessment", {}, { primary: true }) + '</section>';
        return html;
    }

    function assessmentTab(s) {
        const rep = s.report;
        const settings = assessmentSettings(s) + (s.assessmentConfigStatus === "invalid" ?
            '<div class="banner banner-red">Saved assessment settings are invalid. Re-run the assessment to replace them.</div>' : "");
        if (s.reportStatus === "invalid") {
            return settings + emptyState(
                "Assessment results unavailable",
                "The assessment file is invalid or incomplete. Re-run the assessment to regenerate it."
            );
        }
        if (s.reportStatus === "running") {
            return settings + emptyState("Assessment in progress", "The report is still being generated. Refresh to see the finished results.", btn("Refresh", "refresh"));
        }
        if (!rep) {
            const existing = !!s.assessmentConfig || (s.plan && s.plan.exists) || (s.progress && s.progress.exists);
            return settings + emptyState(
                existing ? "Assessment results unavailable" : "No assessment yet",
                existing ? "A plan exists, but its assessment results are missing. Re-run the assessment to recover them." :
                    "Run an assessment to scan this repo for its Java runtime, dependencies, vulnerabilities, and Azure cloud-readiness gaps. Findings land here as a prioritized, clickable checklist — nothing in your code changes."
            );
        }
        const levels = severityLevels(rep);
        const by = sevCounts(rep.findings, levels);
        if (severityFilter !== "all" && !levels.includes(severityFilter)) severityFilter = "all";
        const stale = s.assessmentConfig && s.reportConfigStatus !== "current";
        const notice = stale ? '<div class="banner banner-red">This assessment report is outdated or its settings cannot be verified. Re-run the assessment before using these findings. ' + btn("Re-run assessment", "start_assessment") + '</div>' : "";
        const nativeNotice = s.reportSource === "native" ? '<div class="banner">Showing the native assessment report from <code>' + esc(s.reportPath) +
            '</code>. Its scope is not linked to this canvas plan; review settings and run an assessment before executing steps.</div>' : "";
        let html = settings + nativeNotice + notice + '<div class="card"><h2>Assessment results';
        if (rep.generatedAt) html += ' <span class="muted" style="font-weight:400">' + esc(fmtDate(rep.generatedAt)) + "</span>";
        html += '<span class="spacer"></span>' + btn("Re-run", "start_assessment") + "</h2>";
        if (rep.headline) html += '<p style="margin:0 0 6px;font-weight:600">' + esc(rep.headline) + "</p>";
        if (rep.summary) html += '<p class="muted" style="margin:0 0 10px">' + esc(rep.summary) + "</p>";
        if (rep.assessmentConfig) {
            const config = rep.assessmentConfig;
            html += '<div class="grid" style="margin-bottom:10px">' + kv("Scope", esc(config.module || ".")) +
                kv("Target", "Java " + esc(config.targetJava)) + kv("Cloud", esc(config.cloud)) + '</div>';
        }
        if (rep.stack) {
            const st = rep.stack;
            html += '<div class="grid" style="margin-bottom:10px">' +
                (st.buildTool ? kv("Build", esc(st.buildTool)) : "") +
                (st.java ? kv("Java", esc(st.java)) : "") +
                (st.framework ? kv("Framework", esc(st.framework)) : "") +
                (st.database ? kv("Database", esc(st.database)) : "") +
                (st.container ? kv("Container", esc(st.container)) : "") +
                "</div>";
        }
        html += '<div class="sevrow">' + levels.map((level) => sevChip(level, by[level])).join("") + "</div></div>";
        if (!rep.findings.length) html += '<div class="card"><p class="muted">No findings in this report.</p></div>';
        else {
            const stepIds = new Set(rep.findings.flatMap((finding) => finding.planSteps?.filter((step) => step.id && step.status !== "done").map((step) => step.id) || []));
            if (stepIds.size) {
                html += '<div class="actions finding-batch">' + (batchConfirm ?
                    '<span>Run ' + stepIds.size + ' approved finding step(s) in plan order?</span>' +
                        btn("Start batch", "autopilot_start", { scope: "recommendations" }, { primary: true }) + btn("Cancel", "cancel_recommendations") :
                    btn("Run approved findings (" + stepIds.size + ")", "confirm_recommendations", {}, { primary: true })) + "</div>";
            }
            html += '<div class="finding-filters" role="group" aria-label="Filter findings by severity">';
            ["all", ...levels].forEach((severity) => {
                html += btn(severity === "all" ? "All" : severityLabel(severity), "filter_severity", { severity }, { pressed: severityFilter === severity });
            });
            html += "</div>";
        }

        levels.forEach((sev) => {
            if (severityFilter !== "all" && severityFilter !== sev) return;
            const items = rep.findings.filter((x) => x.severity === sev);
            if (!items.length) return;
            html += '<div class="cat">' + esc(sevName(sev)) + "</div>";
            items.forEach((x) => (html += findingCard(x, s.ordering)));
        });

        if (rep.strengths && rep.strengths.length) {
            html += '<div class="card"><h2>Already done well <span class="badge b-green">' + rep.strengths.length + "</span></h2><ul class=\"steps\">";
            rep.strengths.forEach((x) => (html += '<li><span class="dot done"></span><span>' + esc(x) + "</span></li>"));
            html += "</ul></div>";
        }
        return html;
    }

    // ---- assessment helpers --------------------------------------------------

    function heroNext(s) {
        const rep = s.report;
        const findings = rep && rep.findings ? rep.findings : [];
        const hasReport = !!rep && s.reportStatus !== "invalid";
        const actionable = findings.filter((finding) => finding.planSteps?.some((step) => step.id && step.status !== "done"));
        const p0 = actionable.filter((finding) => ["P0", "mandatory"].includes(finding.severity));
        const p1 = actionable.filter((finding) => ["P1", "potential"].includes(finding.severity));
        const gates = s.gates || {};
        const anyGate = Object.keys(gates).some((k) => gates[k] && gates[k] !== "not_run");
        const hasPlan = !!((s.plan && s.plan.exists) || (s.progress && s.progress.exists));
        const checks = [
            { keys: ["build", "tests"], title: "Build and run unit tests" },
            { keys: ["cve"], title: "Check for vulnerabilities" },
            { keys: ["consistency"], title: "Check consistency" },
            { keys: ["completeness"], title: "Check completeness" },
        ];
        const nextCheck = checks.find((check) => check.keys.some((key) => gates[key] !== "done"));

        if (s.assessmentConfigStatus === "invalid") {
            return {
                eyebrow: "Assessment needs attention",
                title: "Saved assessment settings are invalid",
                target: "assessment",
            };
        }
        if (s.reportStatus === "invalid" || (s.reportStatus === "missing" && (hasPlan || s.assessmentConfig))) {
            return {
                eyebrow: "Assessment needs attention",
                title: "Assessment results unavailable",
                target: "assessment",
            };
        }
        if (s.assessmentConfig && s.reportConfigStatus !== "current") {
            return {
                eyebrow: "Assessment needs attention",
                title: "Review assessment settings",
                target: "assessment",
            };
        }
        if (s.assessmentConfig && s.planConfigStatus !== "current") {
            return {
                eyebrow: "Plan needs attention",
                title: s.plan?.adoptable ? "Review and link the existing plan" : "Generate a plan for this assessment",
                target: "plan",
            };
        }
        if (hasPlan && s.assessmentConfig && s.planApprovalStatus !== "approved") {
            return {
                eyebrow: "Plan needs approval",
                title: "Review the plan before changing code",
                target: "plan",
            };
        }
        if (s.status === "completed" && !nextCheck) {
            return {
                eyebrow: "Final step",
                title: "Ship your changes",
                target: "validation",
            };
        }
        if (!hasReport && !hasPlan) {
            return {
                eyebrow: "Start here",
                title: "Assess the project",
                target: "assessment",
            };
        }
        if (p0.length) {
            return {
                eyebrow: "Blocker — fix this first",
                title: p0[0].title,
                target: "assessment",
            };
        }
        if (p1.length) {
            return {
                eyebrow: "Recommended next",
                title: "Start remediation: " + p1[0].title,
                target: "assessment",
            };
        }
        if (actionable.length) {
            return {
                eyebrow: "Recommended next",
                title: "Work through the planned findings",
                target: "assessment",
            };
        }
        if (hasReport && findings.length && !anyGate) {
            return {
                eyebrow: "Recommended next",
                title: "Review findings against the plan",
                target: "assessment",
            };
        }
        return nextCheck ? {
            eyebrow: "Recommended next",
            title: (nextCheck.keys.some((key) => gates[key] === "failed") ? "Retry: " : "Next: ") + nextCheck.title,
            target: "validation",
        } : {
            eyebrow: "Validation complete",
            title: "Review your results",
            target: "validation",
        };
    }

    function findingCard(x, ord) {
        const locked = isFindingLocked(x, ord);
        let h = '<div class="finding sev-' + esc(x.severity || "P3") + (locked ? " locked" : "") + '">';
        h += '<div class="ftitle"><span class="badge ' + sevBadgeClass(x.severity) + '">' + esc(x.severity || "—") + "</span>" + esc(x.title) + "</div>";
        if (x.domain) h += '<div class="fmeta">' + esc(x.domain) + (x.category ? " · " + esc(x.category) : "") + "</div>";
        if (x.status) h += '<div class="fmeta">' + statusBadge(x.status) + "</div>";
        if (x.detail) h += '<div class="fdetail">' + esc(x.detail) + "</div>";
        if (x.impact) h += '<p class="fcontext"><strong>Impact:</strong> ' + esc(x.impact) + "</p>";
        if (x.recommendation) h += '<p class="fcontext"><strong>Suggested action:</strong> ' + esc(x.recommendation) + "</p>";
        if (x.files && x.files.length) {
            h += '<div class="ffiles">' + x.files.map((p) => "<code>" + esc(p) + "</code>").join("") + "</div>";
        }
        if (x.evidence && x.evidence.length) {
            h += '<details class="fevidence"><summary>Evidence (' + x.evidence.length + ")</summary><ul>";
            x.evidence.forEach((item) => {
                const location = item.file ? item.file + (item.line ? ":" + item.line : "") : (item.line ? "Line " + item.line : "");
                h += "<li>" + (location ? "<code>" + esc(location) + "</code> " : "") + esc(item.detail || "") +
                    (item.snippet ? '<pre>' + esc(item.snippet) + '</pre>' : "") + "</li>";
            });
            h += "</ul></details>";
        }
        h += '<div class="actions">' + findingActions(x, ord) + "</div>";
        return h + "</div>";
    }

    function sevRank(sev) {
        const m = { P0: 1, P1: 2, P2: 3, P3: 4 };
        return m[sev] != null ? m[sev] : null;
    }
    function isFindingLocked(x, ord) {
        if (!ord || ord.activeRank == null) return false;
        const r = x.planSteps?.[0]?.rank ?? sevRank(x.severity);
        return r != null && r > ord.activeRank;
    }

    function findingActions(x, ord) {
        const explain = btn("Explain & decide", "explain_finding", { findingId: x.id });
        const step = x.planSteps?.find((item) => item.id && item.status !== "done");
        if (x.status === "done") return explain;
        if (!step) return explain + '<span class="smuted">No matching planned action. ' + btn("Review Plan", "goto:plan") + "</span>";
        const locked = isFindingLocked(x, ord);
        const fix = btn("Fix this", "fix_finding", { findingId: x.id, stepId: step.id }, { primary: !locked });
        return locked ? '<span class="smuted lockwhy">🔒 after ' + esc(shortPhase(ord.activePhase)) + "</span>" + fix + explain : fix + explain;
    }
    function severityLevels(report) {
        return report && report.severityScale === "unified" ? ["mandatory", "potential", "optional", "information"] : ["P0", "P1", "P2", "P3"];
    }
    function sevCounts(f, levels = ["P0", "P1", "P2", "P3"]) {
        const c = Object.fromEntries(levels.map((level) => [level, 0]));
        (f || []).forEach((x) => { if (c[x.severity] != null) c[x.severity]++; });
        return c;
    }
    function sevBadgeClass(sev) {
        return { P0: "b-red", P1: "b-amber", P2: "b-blue", P3: "b-gray",
            mandatory: "b-red", potential: "b-amber", optional: "b-blue", information: "b-gray" }[sev] || "b-gray";
    }
    function sevChip(sev, n) {
        return '<span class="badge ' + sevBadgeClass(sev) + '">' + esc(severityLabel(sev)) + " · " + (n || 0) + "</span>";
    }
    function severityLabel(sev) {
        return { mandatory: "Mandatory", potential: "Potential", optional: "Optional", information: "Information" }[sev] || sev;
    }
    function sevName(sev) {
        return { P0: "P0 · Blockers", P1: "P1 · High priority", P2: "P2 · Medium priority", P3: "P3 · Low / platform" }[sev] || severityLabel(sev);
    }
    function fmtDate(iso) {
        try {
            const d = new Date(iso);
            if (isNaN(d.getTime())) return iso;
            return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        } catch (e) {
            return iso;
        }
    }

    // ---- autopilot -----------------------------------------------------------

    // Live status strip for an Autopilot run, shown above the active tab body.
    function autopilotStrip(s) {
        const a = s && s.autopilot;
        if (!a) return "";
        if (a.running) {
            const scopeLabel = a.scope === "recommendations" ? "approved findings" : (a.scope === "all" ? "all phases" : "this phase");
            const now = a.current
                ? "Working: " + esc(a.current.title) + (a.current.section ? ' <span class="smuted">' + esc(a.current.section) + "</span>" : "")
                : "Selecting the next step…";
            return (
                '<div class="banner banner-auto"><span class="spin"></span>' +
                "<span><b>Autopilot running</b> · " + esc(scopeLabel) + " · " + now +
                ' <span class="apc">' + a.completed.length + " done</span></span>" +
                '<span class="spacer"></span>' +
                btn("■ Stop", "autopilot_stop", {}) +
                "</div>" + autopilotLog(a)
            );
        }
        const labels = {
            completed: "finished — every eligible step is done",
            phase_done: "finished this phase",
            stuck: "paused — a step needs your input",
            cancelled: "stopped",
            capped: "reached its step limit",
            error: "stopped on an error",
        };
        const label = labels[a.status] || "finished";
        const bad = a.status === "error" || a.status === "stuck";
        let note = a.scope === "recommendations" && a.status === "completed" ?
            "Review the changes; nothing was committed." : "Review the changes (nothing was committed), then continue.";
        if (a.stuck) note = "Stuck on: " + esc(a.stuck) + ". Open it in Plan &amp; Progress to finish it yourself, then resume.";
        if (a.error) note = esc(a.error);
        const more = a.scope === "recommendations" ?
            (a.status === "completed" ? "" : btn("Resume approved findings", "autopilot_start", { scope: "recommendations" }, { primary: true })) +
                btn("Dismiss", "autopilot_dismiss", {}) :
            btn("▶ Continue (next phase)", "autopilot_start", { scope: "phase" }, { primary: true }) +
                btn("Dismiss", "autopilot_dismiss", {});
        return (
            '<div class="banner ' + (bad ? "banner-red" : "banner-auto") + '">' +
            "<span><b>Autopilot " + esc(label) + ".</b> Completed " + a.completed.length + " step(s). " + note + "</span>" +
            '<span class="spacer"></span>' + more +
            "</div>" + autopilotLog(a)
        );
    }

    function autopilotLog(a) {
        if (!a || !a.completed || !a.completed.length) return "";
        let h = '<ul class="aplog">';
        a.completed.forEach((c) => {
            h +=
                "<li>" + (c.done ? '<span class="apok">✓</span>' : '<span class="apno">•</span>') +
                " " + esc(c.title) +
                (c.section ? ' <span class="smuted">' + esc(c.section) + "</span>" : "") +
                (c.error ? ' <span class="apno">' + esc(c.error) + "</span>" : "") +
                "</li>";
        });
        return '<details class="run-log"><summary>Execution history (' + a.completed.length + ')</summary>' + h + "</ul></details>";
    }

    function planReview(s) {
        if (!s.plan || !s.plan.exists) return "";
        const config = s.assessmentConfig;
        const current = config && s.reportConfigStatus === "current" && s.planConfigStatus === "current";
        const adoptable = config && s.reportConfigStatus === "current" && s.plan.adoptable;
        const approved = s.planApprovalStatus === "approved";
        const badge = approved ? '<span class="badge b-green">Approved</span>' : '<span class="badge b-amber">Approval required</span>';
        let body = config ? '<dl class="plan-review-scope"><div><dt>Module</dt><dd>' + esc(config.module) +
            '</dd></div><div><dt>Target</dt><dd>Java ' + esc(config.targetJava) + ' · ' + esc(config.cloud) +
            '</dd></div><div><dt>File</dt><dd>' + esc(s.plan.path || "plan.md") + '</dd></div></dl>' : "";
        if ((current || adoptable) && planEditing) {
            if (planBaseRevision !== s.plan.revision) body += '<div class="banner banner-red">The plan changed on disk while you were editing. Refresh before saving.</div>';
            body += '<label class="plan-editor-label" for="plan-editor">Plan text</label>' +
                '<textarea id="plan-editor" spellcheck="false">' + esc(planDraft == null ? s.plan.editableMarkdown : planDraft) + '</textarea>';
            const linked = (s.plan.steps || []).filter((step) => step.id && s.report?.findings?.some((finding) =>
                finding.planSteps?.some((item) => item.id === step.id)));
            if (linked.length) {
                const tasks = s.tasks || [];
                const skills = s.skills || [];
                body += '<fieldset class="plan-links"><legend>Finding-linked execution</legend>';
                for (const step of linked) {
                    const selected = step.taskId ? "task:" + step.taskId : step.skillFolder ? "skill:" + encodeURIComponent(step.skillFolder) : "";
                    const option = (value, label) => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(label) + '</option>';
                    body += '<label><span>' + esc(step.title) + '</span><select data-step-link="' + esc(step.id) + '" data-original="' + esc(selected) + '">' +
                        option("", "Work on step") + tasks.map((task) => option("task:" + task.id, "Task: " + task.name)).join("") +
                        skills.map((skill) => option("skill:" + encodeURIComponent(skill.folder), "Skill: " + skill.name)).join("") +
                        (step.taskId && !tasks.some((task) => task.id === step.taskId) ? option(selected, "Unavailable task: " + step.taskId) : "") +
                        (step.skillFolder && !skills.some((skill) => skill.folder === step.skillFolder) ? option(selected, "Unavailable skill: " + step.skillFolder) : "") +
                        '</select></label>';
                }
                body += '</fieldset>';
            }
            if (adoptable) body += '<label class="plan-review-confirm"><input id="confirm-adopt-plan" type="checkbox">' +
                'I reviewed this plan and its progress and want to link them to assessment ' + esc(config.id) + '.</label>';
            body += '<div class="actions">' + btn(adoptable ? "Link plan to assessment" : "Save plan", "save_plan", {}, { primary: true }) + btn("Cancel", "cancel_plan") + "</div>";
        } else if (current) {
            body += '<div class="actions">' + btn("Edit plan", "edit_plan") +
                (approved ? "" : btn("Approve plan", "approve_plan", {}, { primary: true })) + "</div>";
        } else if (adoptable) {
            body += '<div class="banner banner-amber">This plan and its progress are not yet linked to the current assessment. Review before linking; approval is a separate step.</div>' +
                '<div class="actions">' + btn("Review and link plan", "edit_plan") + "</div>";
        } else {
            body += '<div class="banner banner-red">Review the assessment and regenerate the plan before approval.</div>';
        }
        return '<section class="plan-review" aria-label="Plan review"><div class="plan-review-head"><h2>Review plan</h2>' + badge + '</div>' + body + '</section>';
    }

    function planTab(s) {
        const usingProgress = !!(s.progress && s.progress.steps.length);
        const steps = (usingProgress ? s.progress.steps : (s.plan ? s.plan.steps : [])) || [];
        let notice = "";
        if ((s.assessmentConfigStatus === "invalid" || (s.assessmentConfig && s.planConfigStatus !== "current")) &&
            ((s.plan && s.plan.exists) || (s.progress && s.progress.exists))) {
            const reportReady = s.reportConfigStatus === "current";
            notice = s.plan?.adoptable ? '' : '<div class="banner banner-red">This plan is outdated or its assessment settings cannot be verified. Review it before execution. ' +
                (reportReady ? btn("Generate plan", "generate_plan") : btn("Re-run assessment", "start_assessment")) + '</div>';
        }
        if (!steps.length) {
            return notice + emptyState(
                "No plan yet",
                "Run an assessment or generate an upgrade plan. App Modernization writes <code>plan.md</code> and a <code>progress.md</code> checklist, and your steps land here — each unchecked one becomes a button that hands that exact step to the agent.",
                btn("Run assessment", "start_assessment", {}, { primary: true }) +
                (s.assessmentConfig && s.reportConfigStatus === "current" ? btn("Generate upgrade plan", "generate_plan") : "")
            ) + skillsAccess();
        }
        const src = usingProgress ? "progress.md" : "plan.md";
        const total = steps.length;
        const done = steps.filter((x) => x.status === "done").length;
        const ord = s.ordering || { activeRank: null, activePhase: null };

        // Intro + overall progress + legend.
        let html = notice + planReview(s) + '<div class="card"><h2>Plan &amp; Progress <span class="muted" style="font-weight:400">' + esc(src) + "</span><span class=\"spacer\"></span>" + statusBadge(s.status) + "</h2>";
        html += '<div class="progress"><span style="width:' + (s.percent || 0) + '%"></span></div>';
        html += '<p class="muted" style="margin:6px 0 0">' + done + " of " + total + " steps done · " + (s.percent || 0) + "% complete</p>";
        html += '<div class="legend"><span><span class="dot done"></span>Done</span><span><span class="dot in_progress"></span>In progress</span><span><span class="dot pending"></span>To do</span><span>🔒 Do later</span></div>';
        html += "</div>";

        // Steps grouped by their phase/section.
        const groups = [];
        const idx = {};
        steps.forEach((st) => {
            const key = st.section || "Steps";
            if (idx[key] == null) { idx[key] = groups.length; groups.push({ name: key, items: [], rank: st.rank }); }
            groups[idx[key]].items.push(st);
        });

        groups.forEach((g) => {
            const gdone = g.items.filter((x) => x.status === "done").length;
            const isValidation = g.rank === 5;
            const gLocked = ord.activeRank != null && g.rank != null && g.rank > ord.activeRank;
            html += '<div class="card' + (gLocked ? " locked" : "") + '"><h2>' + (gLocked ? "🔒 " : "") + esc(g.name) + ' <span class="badge ' + (gdone === g.items.length && g.items.length ? "b-green" : "b-gray") + '">' + gdone + "/" + g.items.length + "</span>";
            if (isValidation) html += '<span class="spacer"></span>' + btn("Open Validation →", "goto:validation");
            else if (gLocked) html += '<span class="spacer"></span><span class="smuted">after ' + esc(shortPhase(ord.activePhase)) + "</span>";
            html += '</h2><ul class="steps">';
            g.items.forEach((st) => {
                const locked = ord.activeRank != null && st.rank != null && st.rank > ord.activeRank;
                html +=
                    '<li' + (locked ? ' class="locked"' : "") + '><span class="dot ' + esc(st.status) + '"></span>' +
                    '<span class="stext">' + esc(st.title) + "</span>" +
                    '<span class="srhs">' + stepRowAction(st, isValidation, locked, ord) +
                    (!locked && !isValidation && st.status !== "done" ? mappedExecution(st, s) : "") + "</span></li>";
            });
            html += "</ul></div>";
        });

        return html + skillsAccess();
    }

    function skillsAccess() {
        return '<details class="skills-access"><summary>Repository skills</summary>' +
            '<p>Open <code>.github/skills/&lt;skill-name&gt;/SKILL.md</code> in the repository to create or edit skills.</p></details>';
    }

    function shortPhase(name) {
        if (!name) return "the current phase";
        const m = String(name).match(/\bP[0-3]\b/i);
        return m ? m[0].toUpperCase() : name;
    }

    function mappedExecution(st, s) {
        if (s.planApprovalStatus !== "approved" || !st.id || !s.report?.findings?.some((finding) =>
            finding.planSteps?.some((step) => step.id === st.id && step.status !== "done"))) return "";
        const task = (s.tasks || []).find((item) => item.id === st.taskId);
        if (task) return btn("Run predefined task", "run_task", { taskId: task.id });
        const skill = (s.skills || []).find((item) => item.folder === st.skillFolder);
        return skill ? btn("Run skill", "run_skill", { folder: skill.folder }) : "";
    }
    function stepRowAction(st, isValidation, locked, ord) {
        if (st.status === "done") return '<span class="smuted">✓ Done</span>';
        if (isValidation) return '<span class="smuted">run from Validation →</span>';
        if (locked) {
            return '<span class="smuted lockwhy">🔒 after ' + esc(shortPhase(ord && ord.activePhase)) + "</span>" + btn("Do anyway", "work_step", { title: st.title, section: st.section });
        }
        const label = st.status === "in_progress" ? "Resume" : "Work on this";
        return btn(label, "work_step", { title: st.title, section: st.section });
    }

    function validationTab(s) {
        const gates = s.gates || {};
        const labels = { build: "Build", tests: "Unit Tests", cve: "CVE Check", consistency: "Consistency", completeness: "Completeness" };
        let html = '<div class="card"><h2>Validation gates</h2><div class="grid">';
        Object.keys(labels).forEach((k) => {
            html += '<div class="kv"><span class="k">' + esc(labels[k]) + "</span><span class=v>" + statusBadge(gates[k] || "not_run") + "</span></div>";
        });
        html += "</div></div>";
        html +=
            '<div class="card"><h2>Run validations</h2><div class="actions">' +
            btn("Build & unit tests", "run_build_tests", {}, { primary: true }) +
            btn("Scan CVEs", "run_cve") +
            btn("Generate unit tests", "generate_tests") +
            btn("Consistency check", "run_consistency") +
            btn("Completeness check", "run_completeness") +
            "</div><p class=muted style='margin:10px 0 0'>CVE scan uses <code>#appmod-validate-cves-for-java</code>; test generation uses <code>#appmod-generate-tests-for-java</code>.</p></div>";
        return html;
    }

    function doctorTab(s) {
        const d = s.doctor;
        if (!d) {
            return emptyState(
                "Environment readiness",
                "Check that your machine has the tools the App Modernization workflow needs — a JDK, your build tool, git, and (optionally) Docker and the Azure CLI. This only reads version numbers; nothing is installed or changed.",
                btn("Check my environment", "recheck_env", {}, { primary: true })
            );
        }
        const tone = d.overall === "ready" ? "b-green" : d.overall === "caution" ? "b-amber" : "b-red";
        const head =
            d.overall === "ready" ? "Your environment is ready" :
            d.overall === "caution" ? "Almost ready — a couple of things to check" :
            "Not ready yet — resolve the blockers below";
        const sub =
            d.overall === "ready" ? "All required tools are installed. You're clear to start modernizing." :
            d.overall === "caution" ? "The required tools are present; some optional or recommended items need attention." :
            "One or more required tools are missing. Fix these before building the project or running tasks.";

        const notAssessed = d.groups.some((g) => g.checks.some((c) => c.id === "assessed" && c.status !== "ok"));
        let heroActions = d.overall === "blocked"
            ? btn("Re-check environment", "recheck_env", {}, { primary: true })
            : btn("Continue", "goto:assessment", {}, { primary: true }) + btn("Re-check environment", "recheck_env");
        if (notAssessed) heroActions += btn("Run assessment", "start_assessment", {});

        let html =
            '<div class="hero"><div class="eyebrow">Environment readiness</div>' +
            '<div class="htitle">' + esc(head) + ' <span class="badge ' + tone + '">' + esc(d.overall) + "</span></div>" +
            '<div class="hbody">' + esc(sub) + "</div>" +
            '<div class="actions">' + heroActions + "</div></div>";

        d.groups.forEach((g) => {
            html += '<div class="card"><h2>' + esc(g.name) + "</h2><ul class=\"checks\">";
            g.checks.forEach((c) => {
                html +=
                    '<li class="chk ' + esc(c.status) + '">' +
                    '<span class="ci">' + checkIcon(c.status) + "</span>" +
                    '<span class="cbody"><span class="clabel">' + esc(c.label) + "</span>" +
                    '<span class="cdetail">' + esc(c.detail || "") + "</span>" +
                    (c.fix ? '<span class="cfix">Fix: ' + esc(c.fix) + "</span>" : "") +
                    "</span>" +
                    '<span class="crhs">' + checkAction(c) + "</span></li>";
            });
            html += "</ul></div>";
        });

        html += '<p class="muted" style="margin:2px 2px 0">The readiness check only reads version numbers. Setup actions require your approval.</p>';
        return html;
    }

    function checkIcon(status) {
        if (status === "ok") return "✓";
        if (status === "warn") return "!";
        if (status === "fail") return "✕";
        return "•";
    }
    function checkAction(c) {
        if (!c.action) return "";
        const opts = c.status === "fail" ? { primary: true } : {};
        return btn(c.action.label || "Fix", c.action.kind, c.action.payload || {}, opts);
    }

    // ---- helpers -------------------------------------------------------------

    function nextTarget(v) {
        const ladder = [11, 17, 21, 25];
        for (const t of ladder) if (t > v) return t;
        return 25;
    }
    function kv(k, v) {
        return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + "</span></div>";
    }
    function emptyState(big, sub, action) {
        return '<div class="card"><div class="empty"><div class="big">' + esc(big) + "</div><div>" + sub + "</div>" + (action ? '<div class="actions" style="justify-content:center;margin-top:14px">' + action + "</div>" : "") + "</div></div>";
    }
    function miniMd(md) {
        const lines = esc(md).split(/\r?\n/);
        let out = "";
        let inList = false;
        for (let line of lines) {
            if (/^\s*[-*]\s+/.test(line)) {
                if (!inList) { out += "<ul>"; inList = true; }
                out += "<li>" + line.replace(/^\s*[-*]\s+/, "") + "</li>";
                continue;
            }
            if (inList) { out += "</ul>"; inList = false; }
            const h = line.match(/^(#{1,3})\s+(.*)/);
            if (h) { out += "<h" + h[1].length + ">" + h[2] + "</h" + h[1].length + ">"; continue; }
            if (line.trim() === "") { out += "<br>"; continue; }
            out += "<p style='margin:4px 0'>" + line + "</p>";
        }
        if (inList) out += "</ul>";
        return out.replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    // ---- shell ---------------------------------------------------------------

    function render() {
        if (!state) {
            $("#app").innerHTML = '<div class="empty"><span class="spin"></span> Loading…</div>';
            return;
        }
        if (!state.ok) {
            $("#app").innerHTML = emptyState("Repo not available", esc(state.error || "Could not read the repository."), btn("Retry", "refresh", {}, { primary: true }));
            renderHeader();
            return;
        }
        autopilotRunning = !!(state.autopilot && state.autopilot.running);
        renderHeader();
        const tabs = { readiness: doctorTab, assessment: assessmentTab, plan: planTab, validation: validationTab };
        let body = "";
        try {
            body = workflowStatus(state);
            body += autopilotStrip(state);
            body += pending ? '<div class="banner"><span class="spin"></span> Agent working on <b>' + esc(pending) + "</b>. Waiting for updated artifacts when the turn finishes.</div>" : "";
            body += (tabs[activeTab] || assessmentTab)(state);
        } catch (e) {
            // A tab renderer threw — show the error instead of silently leaving the
            // previous tab's content on screen (which looks like a dead click).
            body = '<div class="banner banner-red">This view hit an error: ' + esc(e && e.message ? e.message : String(e)) + " " + btn("Reload", "refresh", {}, { primary: true }) + "</div>";
        }
        $("#app").innerHTML = body;
    }

    function renderHeader() {
        const s = state || {};
        $("#status").innerHTML = s.status ? statusBadge(s.status) : "";
        $("#repo").textContent = s.repoPath ? s.repoPath.split(/[\\/]/).slice(-2).join("/") : "";
        const steps = s.progress?.steps?.length ? s.progress.steps : (s.plan?.steps || []);
        const canRun = s.planApprovalStatus === "approved" && s.doctor?.overall !== "blocked" && steps.some((step) => step.status !== "done");
        $("#controls").innerHTML = s.ok ?
            (s.git?.branch ? '<span class="branch repo muted" title="' + esc(s.git.branch) + '">' + esc(s.git.branch) + '</span>' : "") +
            btn(s.doctor?.overall === "blocked" ? "Readiness: blocked" : "Readiness", "goto:readiness") +
            (s.autopilot?.running ? btn("Stop", "autopilot_stop") : "") +
            '<details class="utility-menu"><summary title="More actions" aria-label="More actions">⋯</summary><div class="utility-popover">' +
            btn("Refresh", "refresh") +
            (!s.autopilot?.running && canRun ? btn("Run this phase", "autopilot_start", { scope: "phase" }) +
                btn("Run all phases", "autopilot_start", { scope: "all" }) : "") +
            '</div></details>' : "";
        const counts = {
            assessment: s.report && s.report.findings ? s.report.findings.length : 0,
            plan: s.progress && s.progress.steps.length ? s.progress.steps.length : (s.plan ? s.plan.steps.length : 0),
        };
        document.querySelectorAll("nav.tabs button").forEach((b) => {
            b.classList.toggle("active", b.dataset.tab === activeTab);
            const c = b.querySelector(".count");
            if (!c) return;
            if (b.dataset.tab === "readiness") {
                const ov = s.doctor && s.doctor.overall;
                c.textContent = ov === "blocked" ? "⚠" : ov === "caution" ? "!" : "";
                c.className = "count " + (ov === "blocked" ? "c-red" : ov === "caution" ? "c-amber" : "");
            } else {
                c.textContent = counts[b.dataset.tab] ? "(" + counts[b.dataset.tab] + ")" : "";
            }
        });
    }

    async function loadState(recheckEnv = false) {
        try {
            const query = tokenQuery + (recheckEnv ? (tokenQuery ? "&" : "?") + "recheckEnv=1" : "");
            const r = await fetch("/state" + query);
            const next = await r.json();
            routeFirstSnapshot(next);
            state = next;
            render();
        } catch (e) {
            toast("Failed to load state");
        }
    }

    function applyStepLinks(markdown) {
        const choices = new Map(Array.from(document.querySelectorAll("select[data-step-link]"), (select) =>
            [select.dataset.stepLink, { value: select.value, original: select.dataset.original || "" }]));
        return markdown.replace(/^[^\r\n]*<!--\s*appmod-step:([a-f0-9]{16,32})\s*-->[^\r\n]*$/gim, (line, id) => {
            const choice = choices.get(id);
            if (!choice || choice.value === choice.original) return line;
            const bare = line.replace(/\s*<!--\s*appmod-(?:task|skill):[^\s<>]+\s*-->/gi, "").trimEnd();
            if (choice.value.startsWith("task:")) return bare + " <!-- appmod-task:" + choice.value.slice(5) + " -->";
            if (choice.value.startsWith("skill:")) return bare + " <!-- appmod-skill:" + choice.value.slice(6) + " -->";
            return bare;
        });
    }

    async function doAction(kind, payload) {
        if (kind === "refresh") toast("Refreshing…");
        if (kind.indexOf("goto:") === 0) { activeTab = legacyTabs[kind.slice(5)] || kind.slice(5); render(); window.scrollTo(0, 0); return; }
        if (kind === "confirm_recommendations" || kind === "cancel_recommendations") {
            batchConfirm = kind === "confirm_recommendations";
            render();
            return;
        }
        if (kind === "filter_severity") {
            severityFilter = ["P0", "P1", "P2", "P3", "mandatory", "potential", "optional", "information"].includes(payload.severity) ? payload.severity : "all";
            render();
            return;
        }
        if (kind === "edit_plan") {
            planDraft = state.plan.editableMarkdown;
            planBaseRevision = state.plan.revision;
            planBaseAdopting = state.planConfigStatus !== "current" && state.plan.adoptable === true;
            planBaseReportRevision = state.reportRevision;
            planBaseProgressRevision = state.progress?.revision ?? null;
            planBaseAssessmentId = state.assessmentConfig?.id ?? null;
            planEditing = true;
            render();
            return;
        }
        if (kind === "cancel_plan") {
            planEditing = false;
            planDraft = null;
            planBaseRevision = null;
            planBaseAdopting = false;
            render();
            return;
        }
        if (kind === "save_plan") {
            const editor = $("#plan-editor");
            if (!editor) { toast("Plan editor unavailable"); return; }
            payload = { revision: planBaseRevision, markdown: applyStepLinks(editor.value) };
            if (planBaseAdopting) {
                if (!$("#confirm-adopt-plan")?.checked) { toast("Review and confirm the assessment link first"); return; }
                payload = { ...payload, adopt: true, assessmentId: planBaseAssessmentId,
                    reportRevision: planBaseReportRevision, progressRevision: planBaseProgressRevision };
            }
        }
        if (kind === "approve_plan") payload = { revision: state.plan.revision };
        if (kind === "start_assessment") {
            activeTab = "assessment";
            render();
            window.scrollTo(0, 0);
            return;
        }
        if (kind === "submit_assessment") {
            const module = $("#assessment-module");
            const java = $("#assessment-java");
            if (!module || !java) { toast("Assessment settings unavailable"); return; }
            payload = { module: module.value || state.assessmentConfig?.module || ".", targetJava: Number(java.value || state.assessmentConfig?.targetJava || 21), cloud: "Azure" };
            kind = "start_assessment";
        }
        // Autopilot controls stream their results over SSE, so they must not set the
        // blocking "pending" banner that freezes the whole view for a one-shot send.
        const isAutopilot = kind.indexOf("autopilot_") === 0;
        try {
            const r = await fetch("/action" + tokenQuery, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ kind, payload }),
            });
            const res = await r.json();
            if (res.ok) {
                if (kind === "autopilot_start") batchConfirm = false;
                if (kind === "save_plan") {
                    planEditing = false;
                    planDraft = null;
                    planBaseRevision = null;
                    planBaseAdopting = false;
                }
                if (res.state) {
                    // Local, synchronous actions (refresh, recheck_env) hand back a
                    // fresh snapshot inline. Apply it now and clear any spinner instead
                    // of waiting on an SSE broadcast that can be missed if the provider
                    // restarts or the connection drops — which would spin forever.
                    state = res.state;
                    pending = null;
                } else if (!isAutopilot) {
                    pending = res.label || kind;
                }
                toast(res.message || "Sent to the agent");
                render();
            } else {
                toast(res.error || "Action failed");
            }
        } catch (e) {
            toast("Action failed");
        }
    }

    // event delegation for all action buttons + tabs
    document.addEventListener("click", (e) => {
        const tabBtn = e.target.closest("nav.tabs button");
        if (tabBtn) { activeTab = tabBtn.dataset.tab; render(); return; }
        const b = e.target.closest("[data-kind]");
        if (b && !b.disabled) {
            let payload = {};
            try { payload = JSON.parse(b.dataset.payload || "{}"); } catch {}
            doAction(b.dataset.kind, payload);
        }
    });
    document.addEventListener("input", (e) => {
        if (e.target && e.target.id === "plan-editor") planDraft = e.target.value;
    });

    // live updates: server pushes a fresh snapshot when the agent finishes a turn
    try {
        const ev = new EventSource("/events" + tokenQuery);
        // The initial load already fetches state. After a reconnect, re-fetch to
        // recover a broadcast missed while the stream was disconnected.
        let connected = false;
        ev.onopen = () => {
            if (connected) loadState(true);
            connected = true;
        };
        ev.onmessage = (m) => {
            try {
                const data = JSON.parse(m.data);
                if (data && data.type === "state") { routeFirstSnapshot(data.state); state = data.state; pending = null; render(); }
                else if (data && data.type === "autopilot" && state) { state.autopilot = data.autopilot; render(); }
            } catch {}
        };
    } catch {}

    render();
    loadState();
}

export function renderHtml({ instanceId, initialTab, token } = {}) {
    // Escape `<` so a stray "</script>" in any field can't break out of the inline
    // <script> tag below. (instanceId is runtime-validated, but stay robust anyway.)
    const boot = JSON.stringify({ instanceId: instanceId || "", initialTab: initialTab || "assessment", token: token || "" }).replace(/</g, "\\u003c");
    return (
        "<!doctype html><html><head><meta charset=\"utf-8\" />" +
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />" +
        "<title>Java Modernization Studio</title><style>" + CSS + "</style></head><body>" +
        '<header class="top"><div class="title-row">' +
        "<h1>Java Modernization Studio</h1><span id=\"status\"></span><span class=\"spacer\"></span>" +
        '<span id="repo" class="repo muted"></span><span id="controls" class="global-controls"></span>' +
        "</div>" +
        '<nav class="tabs">' +
        '<button data-tab="assessment">Assess <span class="count"></span></button>' +
        '<button data-tab="plan">Plan <span class="count"></span></button>' +
        '<button data-tab="validation">Validate</button>' +
        "</nav></header>" +
        '<main id="app"></main><div id="toast" class="toast"></div>' +
        "<script>window.__APPMOD__=" + boot + ";(" + clientMain.toString() + ")();</script>" +
        "</body></html>"
    );
}
