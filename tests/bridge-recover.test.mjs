// Regression suite for src/bridge-recover.ts.
//
//   node --experimental-strip-types tests/bridge-recover.test.mjs
//
// Same harness as watch.test.mjs (scratch copy, stub pi). Timers are made
// fast via the extension's env tunables. The cases pin the recovery state
// machine: stall warning while busy → grace → abort + resume follow-up;
// a turn that settles inside the grace window is left alone; cooldown and
// the manual /recover path.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.PI_RECOVER_GRACE_MS = "150";
// Wide cooldown: the back-to-back negative check needs grace+scheduler-lag to
// fit INSIDE the window even when doctor runs this suite under full load.
process.env.PI_RECOVER_COOLDOWN_MS = "1500";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(process.env.TMPDIR ?? "/tmp", "bridge-recover-test");

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
cpSync(
	join(ROOT, "src/bridge-recover.ts"),
	join(SCRATCH, "bridge-recover.ts"),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll until cond() holds or the deadline passes — fixed sleeps around the
// grace timer flake under load (same class as watch.test.mjs, v1.50.1).
const waitFor = async (cond, ms = 5000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await sleep(50);
	}
	return cond();
};
const handlers = new Map();
const sent = [];
const notes = [];
let command;
let aborts = 0;
const ui = {
	setWidget() {},
	setStatus() {},
	notify(msg, type) {
		notes.push(`${type ?? "info"}: ${msg}`);
	},
};
const ctx = {
	ui,
	abort() {
		aborts += 1;
	},
};
const pi = {
	on(ev, fn) {
		if (!handlers.has(ev)) handlers.set(ev, []);
		handlers.get(ev).push(fn);
	},
	registerCommand(_name, spec) {
		command = spec;
	},
	registerTool() {},
	sendUserMessage(text) {
		sent.push(text);
	},
};
const emit = async (ev, event = {}) => {
	for (const fn of handlers.get(ev) ?? []) await fn(event, ctx);
};

const results = [];
const check = (name, cond, extra = "") =>
	results.push(
		`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`,
	);

const ext = (
	await import(pathToFileURL(join(SCRATCH, "bridge-recover.ts")).href)
).default;
ext(pi);
await emit("session_start");

const STALL =
	"Claude bridge: 1 tool handler(s) still waiting — provider may be stuck";

// ── stall while busy: grace passes, turn still stuck → abort + resume
await emit("agent_start");
ui.notify(STALL, "warning");
check(
	"stall warning itself still reaches the user",
	notes.some((n) => n.includes("still waiting")),
);
check("no instant abort (grace first)", aborts === 0);
check(
	"stuck turn is aborted after grace",
	await waitFor(() => aborts === 1),
	`aborts=${aborts}`,
);
check(
	"resume follow-up queued",
	sent.length === 1 && /bridge-recover/.test(sent[0]),
	JSON.stringify(sent.map((s) => s.slice(0, 40))),
);
check(
	"recovery announced",
	notes.some((n) => /aborting and resuming \(recovery 1\/5\)/.test(n)),
	notes.at(-1),
);
await emit("agent_settled");

// ── turn that settles inside the grace window is left alone
await sleep(2200); // clear cooldown (1500ms) with margin for scheduler lag
await emit("agent_start");
ui.notify(STALL, "warning");
await emit("agent_settled"); // bridge dug itself out
await sleep(300);
check("settled turn is not aborted", aborts === 1, `aborts=${aborts}`);
check("no extra resume sent", sent.length === 1, `sent=${sent.length}`);

// ── cooldown: a second stall right after a recovery does not re-fire
await sleep(2200); // clear cooldown with the same margin
await emit("agent_start");
ui.notify(STALL, "warning");
check(
	"second recovery after cooldown works",
	await waitFor(() => aborts === 2),
	`aborts=${aborts}`,
);
ui.notify(STALL, "warning"); // still busy, immediately after recovery
await sleep(400); // > grace+lag margin, well inside the 1500ms cooldown
check(
	"cooldown blocks back-to-back recovery",
	aborts === 2,
	`aborts=${aborts}`,
);
await emit("agent_settled");

// ── stall warning while idle is ignored
ui.notify(STALL, "warning");
await sleep(300);
check("idle stall warning ignored", aborts === 2, `aborts=${aborts}`);

// ── repair-warning dedupe: first passes, identical repeat swallowed,
// differing message passes
const REPAIR =
	'Claude bridge: 4 missing tool result(s) repaired with "[no tool result recorded]" for bash×2, edit×2. Real tool output was lost.';
const notesBefore = notes.length;
ui.notify(REPAIR, "error");
check(
	"first repair warning reaches the user",
	notes.length === notesBefore + 1 && notes.at(-1).includes("repaired"),
	`notes=${notes.length}`,
);
ui.notify(REPAIR, "error");
check(
	"identical repair repeat swallowed",
	notes.length === notesBefore + 1,
	`notes=${notes.length}`,
);
ui.notify(REPAIR.replace("4 missing", "2 missing"), "error");
check(
	"differing repair message passes",
	notes.length === notesBefore + 2,
	`notes=${notes.length}`,
);

// ── manual /recover: aborts and queues resume regardless of warnings
const sentBefore = sent.length;
await command.handler("", ctx);
check("/recover aborts", aborts === 3, `aborts=${aborts}`);
check(
	"/recover queues resume",
	sent.length === sentBefore + 1,
	`sent=${sent.length}`,
);

// ── idempotent across hot reloads: a re-fired session_start must not re-wrap
// notify, or the chain grows one link per save
const wrappedOnce = ui.notify;
await emit("session_start");
check("session_start re-fire does not re-wrap notify", ui.notify === wrappedOnce);

await emit("session_shutdown");
rmSync(SCRATCH, { recursive: true, force: true });

const passed = results.filter((r) => r.startsWith("PASS")).length;
console.log(results.join("\n"));
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
