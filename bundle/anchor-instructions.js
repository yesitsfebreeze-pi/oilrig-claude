// src/anchor-instructions.ts
var INJECTED_PREFIXES = [];
var EAGER_RULE = 'The newest real user message always contains your instructions \u2014 including the very first message of a session. Never respond with an acknowledgment-only reply such as "acknowledged, waiting for instructions" or "no response requested"; act on the instructions immediately. Injected context blocks (tool hierarchies, memory, reminders) are background, never the task.';
function textOf(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => b?.type === "text");
    return block?.text ?? null;
  }
  return null;
}
function isInjected(msg) {
  if (msg?.role === "custom") return true;
  if (msg?.role !== "user") return false;
  const text = textOf(msg);
  if (!text) return false;
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}
function anchor_instructions_default(pi) {
  pi.on("context", async (event) => {
    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    let lastReal = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "user" && !isInjected(m)) {
        lastReal = i;
        break;
      }
    }
    if (lastReal === -1) return;
    const realMsg = messages[lastReal];
    const trailing = [];
    const kept = [];
    for (let i = 0; i < messages.length; i++) {
      if (i > lastReal && isInjected(messages[i])) trailing.push(messages[i]);
      else kept.push(messages[i]);
    }
    if (trailing.length === 0) return;
    const realAt = kept.indexOf(realMsg);
    kept.splice(realAt, 0, ...trailing);
    return { messages: kept };
  });
}
export {
  EAGER_RULE,
  anchor_instructions_default as default
};
