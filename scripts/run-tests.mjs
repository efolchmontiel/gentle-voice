#!/usr/bin/env node
/**
 * Runs the test suite, then removes the scratch directories it left in the
 * system temp dir. Only entries that did not exist before the run are removed,
 * so a concurrent run or a real Gentle Voice temp dir is never touched.
 *
 *   node scripts/run-tests.mjs                 # whole suite
 *   node scripts/run-tests.mjs tests/x.test.ts # selected files
 */

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = /^(gv-|gentle-voice$)/;

function scratchEntries() {
	try {
		return new Set(readdirSync(tmpdir()).filter((name) => SCRATCH.test(name)));
	} catch {
		return new Set();
	}
}

if (process.argv[2] === "--clean") {
	let count = 0;
	for (const name of scratchEntries()) {
		if (!name.startsWith("gv-")) continue;
		rmSync(join(tmpdir(), name), { recursive: true, force: true });
		count += 1;
	}
	console.log(`Removed ${count} leftover test director${count === 1 ? "y" : "ies"} from ${tmpdir()}.`);
	process.exit(0);
}

const before = scratchEntries();
const files = process.argv.slice(2);
const run = spawnSync(
	process.execPath,
	["--experimental-strip-types", "--test", ...(files.length > 0 ? files : ["tests/*.test.ts"])],
	{ stdio: "inherit" },
);

let removed = 0;
for (const name of scratchEntries()) {
	if (before.has(name)) continue;
	try {
		rmSync(join(tmpdir(), name), { recursive: true, force: true });
		removed += 1;
	} catch {
		/* a locked file on Windows must not fail the run */
	}
}
if (removed > 0) console.log(`Removed ${removed} test scratch director${removed === 1 ? "y" : "ies"} from ${tmpdir()}.`);

process.exit(run.status ?? 1);
