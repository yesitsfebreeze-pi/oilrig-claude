// src/bridge-recover.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var STALL_RE = /Claude bridge: \d+ tool handler\(s\) still waiting/;
var REPAIR_RE = /Claude bridge: \d+ missing tool result\(s\) repaired/;
var GRACE_MS = Number(process.env.PI_RECOVER_GRACE_MS ?? 8e3);
var COOLDOWN_MS = Number(process.env.PI_RECOVER_COOLDOWN_MS ?? 9e4);
var MAX_RECOVERIES = 5;
var RESUME_MSG = "[bridge-recover] The previous turn was aborted automatically: the Claude bridge reported tool handlers stuck waiting for results that never arrived. Continue the task exactly where it stopped \u2014 if a tool call was interrupted and its result is missing, re-issue that call first, then keep going. Do not restart the task from the beginning.";
function bridge_recover_default(pi) {
  let busy = false;
  let turnSeq = 0;
  let timer;
  let lastRecovery = 0;
  let recoveries = 0;
  let ctxRef;
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = void 0;
    }
  };
  const recover = (notify) => {
    recoveries += 1;
    lastRecovery = Date.now();
    notify(
      `bridge-recover: turn stalled \u2014 aborting and resuming (recovery ${recoveries}/${MAX_RECOVERIES})`,
      "warning"
    );
    try {
      ctxRef?.abort?.();
    } catch {
    }
    pi.sendUserMessage(RESUME_MSG, { deliverAs: "followUp" });
  };
  const scheduleRecovery = (notify) => {
    if (timer) return;
    if (recoveries >= MAX_RECOVERIES) return;
    if (Date.now() - lastRecovery < COOLDOWN_MS) return;
    if (!busy) return;
    const seq = turnSeq;
    timer = setTimeout(() => {
      timer = void 0;
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
    if (!process.env.CLAUDE_CONFIG_DIR) {
      try {
        const root = join(homedir(), ".claude");
        const last = readFileSync(join(root, ".last-login"), "utf8").trim();
        if (last && last !== "default" && existsSync(join(root, last))) {
          process.env.CLAUDE_CONFIG_DIR = join(root, last);
        }
      } catch {
      }
    }
    ctxRef = ctx;
    const ui = ctx?.ui;
    if (!ui || typeof ui.notify !== "function") return;
    if (ui.notify.__bridgeRecoverWrapped) return;
    const orig = ui.notify.bind(ui);
    const seenRepairs = /* @__PURE__ */ new Set();
    ui.notify = (message, type) => {
      if (typeof message === "string") {
        if (STALL_RE.test(message)) scheduleRecovery(orig);
        if (REPAIR_RE.test(message)) {
          if (seenRepairs.has(message)) return;
          seenRepairs.add(message);
        }
      }
      return orig(message, type);
    };
    ui.notify.__bridgeRecoverWrapped = true;
  });
  pi.registerCommand("recover", {
    description: "Abort a stuck turn and auto-resume the task (manual bridge-stall recovery)",
    async handler(_args, ctx) {
      disarm();
      try {
        ctx?.abort?.();
      } catch {
      }
      pi.sendUserMessage(RESUME_MSG, { deliverAs: "followUp" });
      ctx.ui.notify("bridge-recover: abort + resume queued", "info");
    }
  });
}
export {
  bridge_recover_default as default
};
