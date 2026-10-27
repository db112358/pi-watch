// A failing log file must not take pi down: no uncaught 'error' from the sink, the watch
// still settles on its condition, and the failure is reported in the result.
// Regression for: pi exiting on ERR_STREAM_WRITE_AFTER_END from watch/index.ts onData.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createJiti } from "jiti";

const realWrite = fs.WriteStream.prototype._write;
let failWrites = false;
fs.WriteStream.prototype._write = function (data, encoding, callback) {
	if (!failWrites) return realWrite.call(this, data, encoding, callback);
	callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
};

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../watch/index.ts", import.meta.url).pathname);

const tools = new Map();
const pi = {
	on: () => {},
	registerCommand: () => {},
	registerTool: (tool) => tools.set(tool.name, tool),
	registerMessageRenderer: () => {},
	sendMessage: () => {},
};
mod.default(pi);

const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: () => {} } };

failWrites = true;
try {
	const result = await tools.get("watch").execute(
		"call-1",
		{ title: "log file failure", command: "echo hello; echo world", until: "^world$", timeout: 30 },
		undefined,
		undefined,
		ctx,
	);

	// A stream error is delivered on a later tick: staying alive through it is the test.
	await new Promise((resolve) => setTimeout(resolve, 100));

	assert.equal(result.details.status, "matched", "the watch still settles on its condition");
	assert.match(result.content[0].text, /error: ENOSPC/, "the failed log is reported, not swallowed");
	assert.match(result.content[0].text, /--- tail ---\nhello\nworld/, "the in-memory buffer still has the output");
} finally {
	fs.WriteStream.prototype._write = realWrite;
}

console.log("ok: a failing log file neither crashes pi nor loses the result");
