// Harness: drive watch.ts with a fake pi and assert the interim messages.
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../watch/index.ts", import.meta.url).pathname);

const sent = [];
const tools = new Map();
const pi = {
	on: () => {},
	registerCommand: () => {},
	registerToolRenderer: () => {},
	registerTool: (tool) => tools.set(tool.name, tool),
	// The real handler is synchronous and returns nothing; an async stub here
	// hides promise assumptions, which is how a `.catch()` on it once crashed pi.
	sendMessage: (message, options) => {
		sent.push({ message, options });
	},
};
mod.default(pi);

const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	ui: { setStatus: () => {}, setWorkingMessage: () => {} },
};

const watch = tools.get("watch");
assert.ok(watch, "watch tool registered");

const started = await watch.execute(
	"call-1",
	{
		command: "for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 1; done; echo ALLDONE",
		until: "^ALLDONE",
		background: true,
		progress: 5,
		timeout: 60,
	},
	undefined,
	undefined,
	ctx,
);
assert.match(started.content[0].text, /started in the background/);

await new Promise((resolve) => setTimeout(resolve, 11_000));

const progress = sent.filter((entry) => entry.message.customType === "watch_progress");
assert.ok(progress.length >= 1, `expected interim messages, got ${progress.length}`);
assert.match(progress[0].message.content, /^watch w\d+ still running · \d/);
assert.match(progress[0].message.content, /tick \d/);
assert.equal(progress[0].options.triggerTurn, true);
assert.ok(
	progress.every((entry) => entry.message.content.length < 4_000),
	"an interim message should stay small",
);

await new Promise((resolve) => setTimeout(resolve, 3_000));

const reports = sent.filter((entry) => entry.message.customType === "watch_report");
assert.equal(reports.length, 1, "exactly one settled report");
assert.match(reports[0].message.content, /matched after/);

// A silent command sends no interim messages: nothing changed to report.
sent.length = 0;
await watch.execute(
	"call-2",
	{ command: "sleep 8", background: true, progress: 5, timeout: 60 },
	undefined,
	undefined,
	ctx,
);
await new Promise((resolve) => setTimeout(resolve, 7_000));
assert.equal(
	sent.filter((entry) => entry.message.customType === "watch_progress").length,
	0,
	"a silent watch must not wake the model",
);

console.log(`ok: ${progress.length} interim messages, 1 settled report, no wake on silence`);
process.exit(0);
