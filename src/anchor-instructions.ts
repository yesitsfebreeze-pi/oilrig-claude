import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Trailing boilerplate buries the real prompt: pi core appends every
// `before_agent_start` custom message (splinter index dump, etc.) AFTER the
// user prompt, then converts role "custom" to role "user" for the LLM
// (core/messages.js convertToLlm).
// Either way, on the first turn the model sees boilerplate as the newest user
// message and answers "acknowledged, waiting for instructions" instead of
// acting on the actual first message. Two-part fix:
//   1. context hook: move injected trailing messages (known user-role
//      prefixes AND all custom-role messages) ABOVE the last real user
//      message, so the real instructions always sit in the "newest message"
//      slot the model acts on.
//   2. EAGER_RULE in the bridge's system prompt append (query-options.ts):
//      ban acknowledgment-only replies outright. As a standalone extension
//      this had to ride in as a custom message — which convertToLlm turned
//      into a user message BEFORE the first real prompt, so turn 1 always
//      carried one prior and syncSharedSession took REBUILD instead of
//      clean-start (int-cache.sh caught it). Inside the bridge the system
//      prompt is ours, so the rule goes there and the message injection is
//      gone.
// File is named "anchor-…" so it glob-sorts before caveman.ts: caveman's
// context hook then appends its style reminder to the real prompt, not to
// the boilerplate we just moved up.

const INJECTED_PREFIXES: string[] = []; // user-role prefix matches (none currently — the custom-role branch is the live path)

export const EAGER_RULE =
	"The newest real user message always contains your instructions — including the very first message of a session. " +
	'Never respond with an acknowledgment-only reply such as "acknowledged, waiting for instructions" or "no response requested"; ' +
	"act on the instructions immediately. Injected context blocks (tool hierarchies, memory, reminders) are background, never the task.";

function textOf(msg: any): string | null {
	const content = msg?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const block = content.find((b: any) => b?.type === "text");
		return block?.text ?? null;
	}
	return null;
}

function isInjected(msg: any): boolean {
	// Custom messages are extension-injected context by definition — they are
	// never the user's task, but convertToLlm turns them into user messages.
	if (msg?.role === "custom") return true;
	if (msg?.role !== "user") return false;
	const text = textOf(msg);
	if (!text) return false;
	const t = text.trimStart();
	return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

export default function (pi: ExtensionAPI) {
	pi.on("context", async (event: any) => {
		const messages = event?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;
		// Last real (non-injected) user message — the actual instructions.
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
		const trailing: any[] = [];
		const kept: any[] = [];
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
