// @ts-nocheck
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function blocksSubagentSpawn(command: string): boolean {
	return (
		/(^|[\s;&|()`])(?:npx\s+)?pi(?:\s|$)/.test(command) ||
		/pi\s+--mode\s+json/.test(command)
	);
}

export default function subagentGuard(pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any)?.command ?? "");
			if (blocksSubagentSpawn(command)) {
				return {
					block: true,
					reason: "Subagents may not spawn Pi or other subagents.",
				};
			}
			if (/\bgit\s+(commit|push)\b/.test(command)) {
				return { block: true, reason: "Subagents may not commit or push." };
			}
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			return { block: true, reason: "Subagents may not write files." };
		}
	});
}
