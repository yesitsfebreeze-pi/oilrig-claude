import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPromptContextAppend } from "../src/prompt-context.ts";

describe("prompt context forwarding", () => {
	it("forwards nothing by default", () => {
		const prompt = "base\n\n## Project Agents\nagent list\n\nTask workflow reminder: do tasks";
		const result = buildPromptContextAppend(prompt, process.cwd(), {});
		assert.equal(result.text, undefined);
		assert.deepEqual(result.labels, []);
	});

	it("extracts recognized before_agent_start hook blocks only when enabled", () => {
		const prompt = [
			"base",
			"## Project Agents\nUse subagent.\n- rust: reviewer\n\nDefault `agentScope` is \"project\`.",
			"Task workflow reminder: Current active task: Test. Before focused work, ensure the active task matches the work.",
			"Caveman communication mode active for assistant natural-language chat.\nFull: terse smart caveman.",
		].join("\n\n");
		const result = buildPromptContextAppend(prompt, process.cwd(), {
			includeProjectAgentsHook: true,
			includeTaskPanelHook: true,
			includeCavemanHook: true,
		});
		assert.match(result.text ?? "", /before_agent_start: project agents/);
		assert.match(result.text ?? "", /rust: reviewer/);
		assert.match(result.text ?? "", /before_agent_start: task panel/);
		assert.match(result.text ?? "", /Task workflow reminder/);
		assert.match(result.text ?? "", /before_agent_start: caveman/);
		assert.match(result.text ?? "", /terse smart caveman/);
		assert.deepEqual(result.labels, ["project agents hook", "task panel hook", "caveman hook"]);
	});

	it("reads project .pi/APPEND_SYSTEM.md only when enabled", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-prompt-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Extra Pi rules");
		const off = buildPromptContextAppend("base", cwd, {});
		assert.equal(off.text, undefined);
		const on = buildPromptContextAppend("base", cwd, { includeAppendSystemPromptMd: true });
		assert.match(on.text ?? "", /project \.pi\/APPEND_SYSTEM\.md/);
		assert.match(on.text ?? "", /Extra Pi rules/);
	});
});
