import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export interface PromptContextSettings {
	includeAppendSystemPromptMd?: boolean;
	includeProjectAgentsHook?: boolean;
	includeTaskPanelHook?: boolean;
	includeCavemanHook?: boolean;
}

export interface PromptContextAppend {
	text?: string;
	labels: string[];
}

function piUserDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return resolve(configured.replace(/^~(?=\/|$)/, homedir()));
	return join(homedir(), ".pi", "agent");
}

function readTrimmed(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const content = readFileSync(path, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

function findProjectAppendSystem(startDir: string): string | undefined {
	let current = resolve(startDir);
	while (true) {
		const candidate = join(current, ".pi", "APPEND_SYSTEM.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export function readAppendSystemPromptFiles(cwd: string): Array<{ label: string; content: string }> {
	const files: Array<{ label: string; path: string }> = [
		{ label: "global APPEND_SYSTEM.md", path: join(piUserDir(), "APPEND_SYSTEM.md") },
	];
	const projectPath = findProjectAppendSystem(cwd);
	if (projectPath) files.push({ label: "project .pi/APPEND_SYSTEM.md", path: projectPath });

	const seen = new Set<string>();
	const output: Array<{ label: string; content: string }> = [];
	for (const file of files) {
		if (seen.has(file.path)) continue;
		seen.add(file.path);
		const content = readTrimmed(file.path);
		if (content) output.push({ label: file.label, content });
	}
	return output;
}

function splitPromptBlocks(systemPrompt?: string): string[] {
	return (systemPrompt ?? "")
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean);
}

function extractHeadingSection(systemPrompt: string | undefined, headings: string[]): string | undefined {
	if (!systemPrompt) return undefined;
	let start = -1;
	for (const heading of headings) {
		const index = systemPrompt.indexOf(heading);
		if (index >= 0 && (start < 0 || index < start)) start = index;
	}
	if (start < 0) return undefined;
	const rest = systemPrompt.slice(start).trim();
	const nextHeading = rest.slice(1).search(/\n##\s+/);
	return (nextHeading >= 0 ? rest.slice(0, nextHeading + 1) : rest).trim();
}

function extractBlockByMarkers(systemPrompt: string | undefined, markers: RegExp[]): string | undefined {
	for (const block of splitPromptBlocks(systemPrompt)) {
		if (markers.some((marker) => marker.test(block))) return block;
	}
	return undefined;
}

export function buildPromptContextAppend(systemPrompt: string | undefined, cwd: string, settings: PromptContextSettings): PromptContextAppend {
	const parts: string[] = [];
	const labels: string[] = [];

	if (settings.includeAppendSystemPromptMd) {
		for (const file of readAppendSystemPromptFiles(cwd)) {
			parts.push(`### ${file.label}\n\n${file.content}`);
			labels.push(file.label);
		}
	}

	if (settings.includeProjectAgentsHook) {
		const projectAgents = extractHeadingSection(systemPrompt, ["## Project Agents", "## Project Subagents"]);
		if (projectAgents) {
			parts.push(`### before_agent_start: project agents\n\n${projectAgents}`);
			labels.push("project agents hook");
		}
	}

	if (settings.includeTaskPanelHook) {
		const taskReminder = extractBlockByMarkers(systemPrompt, [/^Task workflow reminder:/]);
		if (taskReminder) {
			parts.push(`### before_agent_start: task panel\n\n${taskReminder}`);
			labels.push("task panel hook");
		}
	}

	if (settings.includeCavemanHook) {
		const caveman = extractBlockByMarkers(systemPrompt, [/^You MUST respond in caveman /m]);
		if (caveman) {
			parts.push(`### before_agent_start: caveman\n\n${caveman}`);
			labels.push("caveman hook");
		}
	}

	if (parts.length === 0) return { labels };
	return {
		labels,
		text: [
			"## Forwarded Pi Context",
			"The following content was explicitly enabled in pi-claude-bridge settings and comes from Pi prompt files or before_agent_start prompt hooks.",
			...parts,
		].join("\n\n"),
	};
}
