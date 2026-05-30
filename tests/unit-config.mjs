/**
 * Tests for claude-bridge extension-manager config projection.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

function withTempDirs(fn) {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-config-"));
	const oldPiDir = process.env.PI_CODING_AGENT_DIR;
	try {
		const user = join(root, "user");
		const project = join(root, "project");
		mkdirSync(join(user), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = user;
		return fn({ user, project });
	} finally {
		if (oldPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldPiDir;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("maps extension-manager allowExtraUsage into provider config", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": { allowExtraUsage: false } } } },
		}));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": { allowExtraUsage: true } } } },
		}));

		const config = loadConfig(project);
		assert.equal(config.provider?.allowExtraUsage, true);
	}));

	it("maps extension-manager effort overrides into provider config", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": {
				forceEffort: "high",
				modelEffortOverrides: JSON.stringify({ "claude-opus-4-8": "xhigh", ignored: "bogus" }),
			} } } },
		}));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": {
				forceEffort: "max",
				modelEffortOverrides: { "claude-bridge/claude-opus-4-8": "max", "claude-haiku-4-5": "low" },
			} } } },
		}));

		const config = loadConfig(project);
		assert.equal(config.provider?.forceEffort, "max");
		assert.deepEqual(config.provider?.modelEffortOverrides, {
			"claude-bridge/claude-opus-4-8": "max",
			"claude-haiku-4-5": "low",
		});
	}));

	it("ignores invalid effort override settings", () => withTempDirs(({ project }) => {
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": {
				forceEffort: "ultracode",
				modelEffortOverrides: "not json",
			} } } },
		}));

		const config = loadConfig(project);
		assert.equal(config.provider?.forceEffort, undefined);
		assert.equal(config.provider?.modelEffortOverrides, undefined);
	}));

	it("lets manager defaults clear lower-precedence legacy effort overrides", () => withTempDirs(({ user, project }) => {
		writeFileSync(join(user, "claude-bridge.json"), JSON.stringify({
			provider: { forceEffort: "max", modelEffortOverrides: { "claude-opus-4-8": "max" } },
		}));
		writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
			vstack: { extensionManager: { config: { "@vanillagreen/pi-claude-bridge": {
				forceEffort: "none",
				modelEffortOverrides: "{}",
			} } } },
		}));

		const config = loadConfig(project);
		assert.equal(config.provider?.forceEffort, undefined);
		assert.equal(config.provider?.modelEffortOverrides, undefined);
	}));
});
