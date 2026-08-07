import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// bridge-recover — auto-recovery for the Claude-bridge tool-handler stall.
//
// Failure mode: the bridge delivers tool results back to waiting MCP handlers;
// when one never arrives (delivered 1/2), it warns
//   "Claude bridge: N tool handler(s) still waiting — provider may be stuck"
// and the turn hangs on "Working…" forever. The bridge only rebuilds its
// session on the NEXT turn, so the manual fix has always been: press Esc
// (abort), then say "continue". This extension automates exactly that.
//
// Detection is the warning itself: we wrap ui.notify at session_start and
// pattern-match the stall message. Then a
// grace timer — if the agent is still busy in the same turn when it fires,
// the turn is genuinely stuck: abort it and queue a resume follow-up that
// tells the agent to re-issue the interrupted tool call and keep going.
//
// Guard rails: one armed timer at a time, cooldown between recoveries, hard
// cap per session — an abort loop would be worse than the stall. `/recover`
// triggers the same abort+resume by hand for stalls that never printed the
// warning.
//
// Second job of the same notify wrap: dedupe the bridge's rebuild-repair
// error. Holes from an earlier abort are baked into the pi session, so every
// session rebuild re-repairs the same tool_use ids and re-emits a
// byte-identical "N missing tool result(s) repaired" error. The first is
// signal (real data loss); repeats are noise — swallowed for the session.
// A message with different counts/tool names passes through.
//
// Tunables (ms, env): PI_RECOVER_GRACE_MS, PI_RECOVER_COOLDOWN_MS.

const STALL_RE = /Claude bridge: \d+ tool handler\(s\) still waiting/;
const REPAIR_RE = /Claude bridge: \d+ missing tool result\(s\) repaired/;
const GRACE_MS = Number(process.env.PI_RECOVER_GRACE_MS ?? 8_000);
const COOLDOWN_MS = Number(process.env.PI_RECOVER_COOLDOWN_MS ?? 90_000);
const MAX_RECOVERIES = 5;

const RESUME_MSG =
	"[bridge-recover] The previous turn was aborted automatically: the Claude " +
	"bridge reported tool handlers stuck waiting for results that never " +
	"arrived. Continue the task exactly where it stopped — if a tool call was " +
	"interrupted and its result is missing, re-issue that call first, then " +
	"keep going. Do not restart the task from the beginning.";

export default function (pi: ExtensionAPI) {
	let busy = false;
	let turnSeq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastRecovery = 0;
	let recoveries = 0;
	let ctxRef: any;

	const disarm = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const recover = (notify: (msg: string, type?: string) => void) => {
		recoveries += 1;
		lastRecovery = Date.now();
		notify(
			`bridge-recover: turn stalled — aborting and resuming (recovery ${recoveries}/${MAX_RECOVERIES})`,
			"warning",
		);
		try {
			ctxRef?.abort?.();
		} catch {
			/* not streaming anymore — resume alone is enough */
		}
		pi.sendUserMessage(RESUME_MSG, { deliverAs: "followUp" });
	};

	const scheduleRecovery = (notify: (msg: string, type?: string) => void) => {
		if (timer) return; // one armed timer at a time
		if (recoveries >= MAX_RECOVERIES) return;
		if (Date.now() - lastRecovery < COOLDOWN_MS) return;
		if (!busy) return; // stall warning outside a turn — nothing to recover
		const seq = turnSeq;
		timer = setTimeout(() => {
			timer = undefined;
			// The turn finished (or a new one started) while we waited — the
			// bridge dug itself out; recovering now would abort healthy work.
			if (!busy || turnSeq !== seq) return;
			recover(notify);
		}, GRACE_MS);
	};

	pi.on("agent_start", () => {
		busy = true;
		turnSeq += 1;
	});
	pi.on("agent_settled", () => {
		busy = false;
		disarm();
	});
	pi.on("session_shutdown", () => disarm());

	pi.on("session_start", (_event, ctx) => {
		// Pin Claude auth to the cc/cr last-login profile. claude-bridge's presence
		// check reads ~/.claude/.last-login, but the SDK spawn authenticates against
		// process.env.CLAUDE_CONFIG_DIR — unset, it falls back to the top-level
		// ~/.claude account, ignoring the selected profile. Set it here so both
		// agree. An explicit env value wins. (Ported from the old oilrig-launch.sh
		// wrapper so the dotfiles' `pi` no longer depends on a shell launcher.)
		if (!process.env.CLAUDE_CONFIG_DIR) {
			try {
				const root = join(homedir(), ".claude");
				const last = readFileSync(join(root, ".last-login"), "utf8").trim();
				if (last && last !== "default" && existsSync(join(root, last))) {
					process.env.CLAUDE_CONFIG_DIR = join(root, last);
				}
			} catch {}
		}
		ctxRef = ctx;
		const ui = (ctx as any)?.ui;
		if (!ui || typeof ui.notify !== "function") return;
		// Idempotent across hot reloads: session_start re-fires on every save, and
		// wrapping an already-wrapped notify grows the chain one link per reload —
		// constant in development, where hot reload is the point.
		if ((ui.notify as any).__bridgeRecoverWrapped) return;
		const orig = ui.notify.bind(ui);
		const seenRepairs = new Set<string>();
		ui.notify = (message: string, type?: string) => {
			if (typeof message === "string") {
				if (STALL_RE.test(message)) scheduleRecovery(orig);
				if (REPAIR_RE.test(message)) {
					if (seenRepairs.has(message)) return;
					seenRepairs.add(message);
				}
			}
			return orig(message, type);
		};
		(ui.notify as any).__bridgeRecoverWrapped = true;
	});

	pi.registerCommand("recover", {
		description:
			"Abort a stuck turn and auto-resume the task (manual bridge-stall recovery)",
		async handler(_args, ctx) {
			disarm();
			try {
				(ctx as any)?.abort?.();
			} catch {
				/* idle — just queue the resume */
			}
			pi.sendUserMessage(RESUME_MSG, { deliverAs: "followUp" });
			ctx.ui.notify("bridge-recover: abort + resume queued", "info");
		},
	});
}
