// @ts-nocheck
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const BRAVE_SKILL =
	process.env.PI_BRAVE_SEARCH_SKILL ??
	join(
		process.env.HOME ?? "",
		".pi/agent/git/github.com/je-boska/pi-brave-search-skill/skills/brave-search/SKILL.md",
	);
const GUARD_EXTENSION = join(EXTENSION_DIR, "guard.ts");
const MAX_TASKS = 6;
const MAX_CONCURRENCY = 3;
const DEFAULT_OUTPUT_LIMIT = 2500;
const TIMEOUT_MS = 180_000;

type Tier = "easy" | "standard" | "hard";
type ToolMode = "none" | "read_only" | "read_bash" | "web";

type TaskInput = {
	id?: string;
	task: string;
	tier?: Tier;
	cwd?: string;
	tools?: ToolMode;
	outputLimit?: number;
};

type RunResult = {
	id: string;
	task: string;
	tier: Tier;
	tools: ToolMode;
	cwd: string;
	model: string;
	thinking: string;
	success: boolean;
	output: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
};

function tierDefaults(tier: Tier): {
	model: string;
	thinking: "high" | "xhigh";
} {
	switch (tier) {
		case "easy":
			return { model: "openai-codex/gpt-5.4", thinking: "high" };
		case "standard":
			return { model: "openai-codex/gpt-5.4", thinking: "xhigh" };
		case "hard":
			return { model: "openai-codex/gpt-5.5", thinking: "high" };
	}
}

function inferTools(task: string, tools?: ToolMode): ToolMode {
	if (tools) return tools;
	if (
		/\b(web|internet|online|current|latest|docs?|documentation|url|https?:\/\/|search)\b/i.test(
			task,
		)
	)
		return "web";
	return "read_only";
}

function toolArg(mode: ToolMode): string | undefined {
	switch (mode) {
		case "none":
			return undefined;
		case "read_only":
			return "read,grep,find,ls";
		case "read_bash":
		case "web":
			return "read,grep,find,ls,bash";
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`;
}

function finalAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		for (const part of msg.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string")
				return part.text.trim();
		}
	}
	return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (
		currentScript &&
		!currentScript.startsWith("/$bunfs/root/") &&
		existsSync(currentScript)
	) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function buildPrompt(task: TaskInput, tools: ToolMode, limit: number): string {
	const web = tools === "web";
	return [
		"You are a subagent running in an isolated throwaway Pi session.",
		"Your job: complete exactly the delegated task and return concise findings to the main agent.",
		"Rules:",
		"- Do not spawn subagents. Do not suggest spawning subagents. Do not run `pi` from bash.",
		"- Do not write, edit, delete, commit, or push files. Main session handles mutations.",
		"- Prefer local repo reads/search for code questions; use web only when asked or necessary.",
		"- Keep raw tool output out of final answer. Summarize.",
		"- Include file paths, line numbers, URLs, versions, and uncertainty when relevant.",
		`- Final answer max ${limit} characters.`,
		web
			? `- Web search available via Brave helper: ${BRAVE_SKILL.replace(/\/SKILL\.md$/, "/scripts/brave-search.py")} "query" --count 5. Never expose API keys. Cite URLs.`
			: "",
		"",
		"Return format:",
		"- Findings: bullets only",
		"- Sources: file paths or URLs",
		"- Caveats: only if any",
		"",
		"Task:",
		task.task,
	]
		.filter(Boolean)
		.join("\n");
}

async function mapLimit<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) return;
				results[index] = await fn(items[index], index);
			}
		}),
	);
	return results;
}

async function runSubagent(
	task: TaskInput,
	index: number,
	defaultCwd: string,
	signal?: AbortSignal,
): Promise<RunResult> {
	const tier = task.tier ?? "standard";
	const { model, thinking } = tierDefaults(tier);
	const tools = inferTools(task.task, task.tools);
	const cwd = task.cwd ?? defaultCwd;
	const outputLimit = Math.max(
		500,
		Math.min(task.outputLimit ?? DEFAULT_OUTPUT_LIMIT, 10_000),
	);
	const id = task.id ?? `agent-${index + 1}`;
	const messages: any[] = [];
	let stderr = "";
	let timedOut = false;

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		GUARD_EXTENSION,
		"--no-context-files",
		"--no-prompt-templates",
		"--no-themes",
		"--no-skills",
		"--model",
		model,
		"--thinking",
		thinking,
	];

	const toolsArg = toolArg(tools);
	if (toolsArg) args.push("--tools", toolsArg);
	else args.push("--no-tools");

	if (tools === "web") args.push("--skill", BRAVE_SKILL);

	args.push(buildPrompt(task, tools, outputLimit));

	const invocation = getPiInvocation(args);
	const exitCode = await new Promise<number | null>((resolve) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let settled = false;

		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(code);
		};

		const kill = () => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000).unref();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, TIMEOUT_MS);
		timer.unref();

		const onAbort = () => kill();
		if (signal?.aborted) onAbort();
		signal?.addEventListener("abort", onAbort, { once: true });

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line);
				if (event.type === "message_end" && event.message)
					messages.push(event.message);
			} catch {
				// Ignore non-JSON noise.
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			stderr += String(error?.message ?? error);
			finish(1);
		});
		proc.on("close", (code) => {
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			signal?.removeEventListener("abort", onAbort);
			finish(code);
		});
	});

	const rawOutput =
		finalAssistantText(messages) ||
		(stderr.trim()
			? `No assistant output. stderr:\n${stderr.trim()}`
			: "No assistant output.");
	const success = exitCode === 0 && !timedOut;
	return {
		id,
		task: task.task,
		tier,
		tools,
		cwd,
		model,
		thinking,
		success,
		output: truncate(rawOutput, outputLimit),
		stderr: truncate(stderr.trim(), 1200),
		exitCode,
		timedOut,
	};
}

function summarize(results: RunResult[]): string {
	return results
		.map((r) => {
			const status = r.success
				? "ok"
				: r.timedOut
					? "timeout"
					: `failed exit=${r.exitCode ?? "?"}`;
			const stderr = !r.success && r.stderr ? `\n  stderr: ${r.stderr}` : "";
			return `## ${r.id} (${status}, ${r.tier}, ${r.tools}, ${r.model}:${r.thinking})\n${r.output}${stderr}`;
		})
		.join("\n\n");
}

function header(theme: any): Text {
	return new Text(theme.fg("toolTitle", theme.bold("󱓞 Subagent")), 0, 0);
}

function compact(theme: any, detail: string): Text {
	return new Text(`${theme.fg("muted", "  ╰ ")}${detail}`, 0, 0);
}

function compactText(value: string, max = 90): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, max - 1)}…`;
}

const TierSchema = StringEnum(["easy", "standard", "hard"] as const, {
	default: "standard",
});
const ToolSchema = StringEnum(
	["none", "read_only", "read_bash", "web"] as const,
	{ default: "read_only" },
);

const TaskSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Short result label" })),
	task: Type.String({
		description:
			"Concrete delegated task. Ask for concise output with sources.",
	}),
	tier: Type.Optional(TierSchema),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for this subagent" }),
	),
	tools: Type.Optional(ToolSchema),
	outputLimit: Type.Optional(
		Type.Number({ description: "Max returned characters for this subagent" }),
	),
});

const ParamsSchema = Type.Object({
	task: Type.Optional(Type.String({ description: "Single delegated task" })),
	tasks: Type.Optional(
		Type.Array(TaskSchema, { description: "Parallel delegated tasks" }),
	),
	tier: Type.Optional(TierSchema),
	cwd: Type.Optional(Type.String({ description: "Default cwd for tasks" })),
	tools: Type.Optional(ToolSchema),
	outputLimit: Type.Optional(
		Type.Number({ description: "Default max returned characters per task" }),
	),
});

export default function subagentsExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n## Subagents\n\nUse the \`subagents\` tool proactively for isolated parallel research that would otherwise fill main context: web/doc lookup, large/reference codebase reconnaissance, independent investigations, or comparing APIs/patterns. Batch independent tasks in one call.\n\nDo not use subagents for tiny direct questions, current-repo edits, destructive actions, secrets, commits, or pushes. Main session owns writes.\n\nChoose defaults: easy = quick lookup/recon; standard = normal investigation; hard = rare/deep ambiguity. For web/current docs use tools="web". For codebase scan use tools="read_only" unless commands are necessary. Give concrete task, cwd when relevant, strict concise output format, and ask for sources.`,
	}));

	pi.registerCommand("subagents", {
		description: "Show subagents extension defaults",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"subagents: easy gpt-5.4 high, standard gpt-5.4 xhigh, hard gpt-5.5 high; max 6 tasks / 3 concurrent",
				"info",
			);
		},
	});

	pi.registerTool({
		name: "subagents",
		label: "Subagent",
		renderShell: "self",
		description:
			"Run one or more isolated throwaway Pi subagents in parallel. Use for web/docs lookup, reference codebase reconnaissance, and independent investigations. Returns concise summaries only. Subagents cannot spawn subagents and cannot write files.",
		promptSnippet:
			"Run isolated parallel subagents for web/docs lookup, large codebase reconnaissance, or independent investigations; returns concise summaries with sources.",
		promptGuidelines: [
			"Use subagents proactively for web/doc lookup, large/reference codebase scans, and independent investigations that would otherwise pollute main context.",
			"Do not use subagents for edits, writes, destructive actions, secrets, commits, pushes, or trivial questions.",
		],
		parameters: ParamsSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const taskList: TaskInput[] = params.tasks?.length
				? params.tasks.map((task: TaskInput) => ({
						...task,
						tier: task.tier ?? params.tier,
						cwd: task.cwd ?? params.cwd,
						tools: task.tools ?? params.tools,
						outputLimit: task.outputLimit ?? params.outputLimit,
					}))
				: params.task
					? [
							{
								task: params.task,
								tier: params.tier,
								cwd: params.cwd,
								tools: params.tools,
								outputLimit: params.outputLimit,
							},
						]
					: [];

			if (taskList.length === 0)
				return { content: [{ type: "text", text: "No task provided." }] };
			if (taskList.length > MAX_TASKS)
				return {
					content: [
						{
							type: "text",
							text: `Too many subagents: ${taskList.length}. Max ${MAX_TASKS}.`,
						},
					],
				};

			let done = 0;
			const results = await mapLimit(
				taskList,
				MAX_CONCURRENCY,
				async (task, index) => {
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `subagents running: ${done}/${taskList.length} done`,
							},
						],
					});
					const result = await runSubagent(task, index, ctx.cwd, signal);
					done++;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `subagents running: ${done}/${taskList.length} done`,
							},
						],
					});
					return result;
				},
			);

			return {
				content: [{ type: "text", text: summarize(results) }],
				details: {
					results: results.map((r) => ({
						...r,
						output: truncate(r.output, 500),
						stderr: truncate(r.stderr, 500),
					})),
				},
			};
		},
		renderCall(_args, theme) {
			return header(theme);
		},
		renderResult(result, options, theme) {
			const details = result.details as { results?: RunResult[] } | undefined;
			if (options.isPartial) {
				const text =
					result.content?.[0]?.type === "text"
						? result.content[0].text
						: "running…";
				return compact(theme, compactText(text));
			}
			if (!details?.results?.length) {
				const text =
					result.content?.[0]?.type === "text"
						? result.content[0].text
						: "done";
				return compact(theme, compactText(text));
			}
			const total = details.results.length;
			const ok = details.results.filter((r) => r.success).length;
			const failed = total - ok;
			const tools = Array.from(
				new Set(details.results.map((r) => r.tools)),
			).join(",");
			const tiers = Array.from(
				new Set(details.results.map((r) => r.tier)),
			).join(",");
			const status = failed
				? theme.fg("warning", `${ok}/${total} ok`)
				: theme.fg("success", `${ok}/${total} ok`);
			const ids = details.results.map((r) => r.id).join(", ");
			return compact(
				theme,
				`${status} · ${theme.fg("accent", compactText(ids, 50))} · ${tiers}/${tools}`,
			);
		},
	});
}
