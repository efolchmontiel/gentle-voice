/**
 * sherpa-onnx runtime pins and archive checks. No network, no native load.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SHERPA_NODE,
	SHERPA_PLATFORM,
	checkTarListing,
	resolveSherpaRuntime,
	sherpaDownloadBytes,
	sherpaTarget,
} from "../lib/vad/sherpa-runtime.ts";

const listing = (...lines: string[]) => lines.join("\n");

test("every supported target is pinned with an sha512 integrity", () => {
	for (const pkg of [SHERPA_NODE, ...Object.values(SHERPA_PLATFORM)]) {
		assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]+=*$/);
		assert.ok(pkg.size > 0 && pkg.unpackedSize > pkg.size);
	}
	assert.equal(SHERPA_PLATFORM["win32-x64"].name, "sherpa-onnx-win-x64");
	assert.equal(sherpaTarget("linux", "x64"), "linux-x64");
	assert.equal(sherpaTarget("freebsd", "x64"), undefined);
});

test("the Linux x64 runtime stays a small download", () => {
	assert.ok(sherpaDownloadBytes("linux-x64") < 12 * 1024 * 1024);
});

test("archive listing accepts regular files under package/", () => {
	checkTarListing(listing(
		"-rw-r--r-- 0/0 1200 1985-10-26 08:15 package/package.json",
		"-rw-r--r-- 0/0 900 1985-10-26 08:15 package/vad.js",
	), SHERPA_NODE);
});

test("archive listing refuses links, traversal and extra files", () => {
	assert.throws(
		() => checkTarListing("lrwxrwxrwx 0/0 0 1985-10-26 08:15 package/vad.js -> /etc/passwd", SHERPA_NODE),
		/sherpa_archive_entry/,
	);
	assert.throws(
		() => checkTarListing("-rw-r--r-- 0/0 1 1985-10-26 08:15 package/../../evil.js", SHERPA_NODE),
		/sherpa_archive_path/,
	);
	assert.throws(
		() => checkTarListing("-rw-r--r-- 0/0 1 1985-10-26 08:15 other/file.js", SHERPA_NODE),
		/sherpa_archive_path/,
	);
	const tooMany = Array.from({ length: SHERPA_NODE.fileCount + 1 }, (_, i) => `-rw-r--r-- 0/0 1 1985-10-26 08:15 package/f${i}.js`);
	assert.throws(() => checkTarListing(listing(...tooMany), SHERPA_NODE), /sherpa_archive_count/);
});

test("an env without a home never resolves the developer's runtime", () => {
	assert.equal(resolveSherpaRuntime({}), undefined);
});
