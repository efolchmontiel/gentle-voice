/**
 * Pi registers one command name per loaded extension. A package install plus
 * `--extension` on the same checkout produces gentle-voice:1 and gentle-voice:2.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function duplicateVoiceInstallWarning(
	argv: readonly string[],
	packages: readonly string[],
): string | undefined {
	const packaged = packages.some((item) => item === "npm:gentle-voice" || item.startsWith("npm:gentle-voice@"));
	const flag = argv.findIndex((arg) => arg === "--extension" || arg === "-e");
	const target = flag >= 0 ? argv[flag + 1] ?? "" : "";
	if (!packaged || !target.includes("gentle-voice")) return undefined;
	return "Gentle Voice is installed from npm and this process also loads a checkout with --extension. Pi will register /gentle-voice twice. Use one installation.";
}

export function readDuplicateVoiceWarning(
	env: NodeJS.ProcessEnv = process.env,
	argv: readonly string[] = process.argv,
): string | undefined {
	const dir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	try {
		const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { packages?: unknown };
		const packages = Array.isArray(settings.packages)
			? settings.packages.filter((item): item is string => typeof item === "string")
			: [];
		return duplicateVoiceInstallWarning(argv, packages);
	} catch {
		return undefined;
	}
}
