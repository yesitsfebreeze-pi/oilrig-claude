// User-facing extension config. Legacy config is loaded from
// ~/.pi/agent/claude-bridge.json and .pi/claude-bridge.json. vstack extension
// manager config is loaded from settings.json and overrides legacy files.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export const PACKAGE_ID = "pi-claude-bridge";
export const SCOPED_PACKAGE_ID = "@vanillagreen/pi-claude-bridge";

export interface Config {
	enabled?: boolean;
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		appendSystemPrompt?: boolean;
		settingSources?: SettingSource[];
		strictMcpConfig?: boolean;
		pathToClaudeCodeExecutable?: string;
	};
	/** Extra Pi context forwarded to Claude Code on top of AGENTS.md + skills. */
	promptContext?: {
		includeAppendSystemPromptMd?: boolean;
		includeProjectAgentsHook?: boolean;
		includeTaskPanelHook?: boolean;
		includeCavemanHook?: boolean;
	};
}

type SettingsRecord = Record<string, unknown>;

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

function piUserDir(): string {
	return resolve(expandHome(process.env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent"));
}

function asRecord(value: unknown): SettingsRecord | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as SettingsRecord : undefined;
}

function mergeDeep<T extends SettingsRecord>(target: T, source: SettingsRecord): T {
	for (const [key, value] of Object.entries(source)) {
		const current = asRecord(target[key]);
		const incoming = asRecord(value);
		if (current && incoming) target[key as keyof T] = mergeDeep({ ...current }, incoming) as T[keyof T];
		else target[key as keyof T] = value as T[keyof T];
	}
	return target;
}

function projectSettingsPath(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		const candidate = join(current, ".pi", "settings.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(current, ".pi")) || existsSync(join(current, ".git")) || existsSync(join(current, ".vstack-lock.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return join(resolve(cwd), ".pi", "settings.json");
		current = parent;
	}
}

function settingsPaths(cwd: string): string[] {
	return [join(piUserDir(), "settings.json"), projectSettingsPath(cwd)];
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

function readManagerConfig(cwd: string): SettingsRecord {
	const merged: SettingsRecord = {};
	for (const path of settingsPaths(cwd)) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const configRoot = asRecord(asRecord(asRecord(parsed?.vstack)?.extensionManager)?.config);
			const config = asRecord(configRoot?.[PACKAGE_ID]) ?? asRecord(configRoot?.[SCOPED_PACKAGE_ID]);
			if (config) mergeDeep(merged, config);
		} catch {
			// Ignore malformed optional manager config; Pi will surface settings issues elsewhere.
		}
	}
	return merged;
}

function boolFrom(raw: SettingsRecord, key: string): boolean | undefined {
	return typeof raw[key] === "boolean" ? raw[key] as boolean : undefined;
}

function stringFrom(raw: SettingsRecord, key: string): string | undefined {
	const value = raw[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function managerToConfig(raw: SettingsRecord): Partial<Config> {
	const provider: Config["provider"] = {};
	const promptContext: Config["promptContext"] = {};

	const appendSystemPrompt = boolFrom(raw, "appendSystemPrompt");
	if (appendSystemPrompt !== undefined) provider.appendSystemPrompt = appendSystemPrompt;
	const strictMcpConfig = boolFrom(raw, "strictMcpConfig");
	if (strictMcpConfig !== undefined) provider.strictMcpConfig = strictMcpConfig;
	const claudePath = stringFrom(raw, "pathToClaudeCodeExecutable");
	if (claudePath) provider.pathToClaudeCodeExecutable = claudePath;

	const includeAppendSystemPromptMd = boolFrom(raw, "includeAppendSystemPromptMd");
	if (includeAppendSystemPromptMd !== undefined) promptContext.includeAppendSystemPromptMd = includeAppendSystemPromptMd;
	const includeProjectAgentsHook = boolFrom(raw, "includeProjectAgentsHook");
	if (includeProjectAgentsHook !== undefined) promptContext.includeProjectAgentsHook = includeProjectAgentsHook;
	const includeTaskPanelHook = boolFrom(raw, "includeTaskPanelHook");
	if (includeTaskPanelHook !== undefined) promptContext.includeTaskPanelHook = includeTaskPanelHook;
	const includeCavemanHook = boolFrom(raw, "includeCavemanHook");
	if (includeCavemanHook !== undefined) promptContext.includeCavemanHook = includeCavemanHook;

	return {
		...(boolFrom(raw, "enabled") !== undefined ? { enabled: boolFrom(raw, "enabled") } : {}),
		...(Object.keys(provider).length ? { provider } : {}),
		...(Object.keys(promptContext).length ? { promptContext } : {}),
	};
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(join(piUserDir(), "claude-bridge.json"));
	const project = tryParseJson(join(cwd, ".pi", "claude-bridge.json"));
	const manager = managerToConfig(readManagerConfig(cwd));
	return {
		enabled: manager.enabled ?? project.enabled ?? global.enabled ?? true,
		provider: { ...global.provider, ...project.provider, ...manager.provider },
		promptContext: { ...global.promptContext, ...project.promptContext, ...manager.promptContext },
	};
}
