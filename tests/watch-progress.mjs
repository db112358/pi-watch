// Harness: drive watch.ts with a fake pi and assert the messages it produces.
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(new URL("../watch/index.ts", import.meta.url).pathname);

const sent = [];
const tools = new Map();
const renderers = new Map();
const pi = {
	on: () => {},
	registerCommand: () => {},
	registerToolRenderer: () => {},
	registerTool: (tool) => tools.set(tool.name, tool),
	registerMessageRenderer: (customType, renderer) => renderers.set(customType, renderer),
	// The real handler is synchronous and returns nothing; an async stub here
	// hides promise assumptions, which is how a `.catch()` on it once crashed pi.
	sendMessage: (message, options) => {
		sent.push({ message, options });
	},
};
mod.default(pi);

const widgets = [];
const ctx = {
	cwd: process.cwd(),
	hasUI: true,
	ui: {
		theme: { fg: (_token, text) => text },
		setWidget: (key, content, options) => widgets.push({ key, content, options }),
		setStatus: () => {},
		setWorkingMessage: () => {},
	},
};

const watch = tools.get("watch");
assert.ok(watch, "watch tool registered");
assert.ok(
	watch.parameters.required?.includes("title"),
	"title is required, so the card always says why the watch is running",
);

const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };

const started = await watch.execute(
	"call-1",
	{
		title: "tick demo for the progress test",
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
assert.match(started.content[0].text, /title: tick demo for the progress test/);

await new Promise((resolve) => setTimeout(resolve, 6_000));

// The card below the editor, under andon's, reads the clock when it paints.
const cards = widgets.filter((entry) => entry.key === "watch" && entry.content);
const latest = cards.at(-1);
assert.ok(latest, "watch draws a widget card");
assert.equal(latest.options.placement, "belowEditor");
assert.equal(typeof latest.content, "function", "the card is a component, not frozen lines");
const card = latest.content({ requestRender: () => {} }, theme).render(80);
assert.match(card[0], /tick demo for the progress test/);
assert.match(card[0], /⏳/, "running watches show an hourglass");

const progress = sent.filter((entry) => entry.message.customType === "watch_progress");
assert.ok(progress.length >= 1, `expected interim messages, got ${progress.length}`);
assert.match(
	progress[0].message.content,
	/^watch w\d+ tick demo for the progress test still running · \d/,
);
assert.match(progress[0].message.content, /tick \d/);
assert.equal(progress[0].options.triggerTurn, true);

const renderer = renderers.get("watch_progress");
assert.ok(renderer, "a renderer is registered for watch_progress");

const folded = renderer(progress[0].message, { expanded: false, outputPad: 1 }, theme).render(120);
assert.equal(folded.length, 1, `folds to one row, got ${folded.length}`);
assert.match(folded[0], /▶ watch w\d+ .* still running/);
assert.doesNotMatch(folded[0], /tick \d/, "the tail stays folded");

// ctrl+o is the expand control: the same one that opens a tool row.
const opened = renderer(progress[0].message, { expanded: true, outputPad: 1 }, theme).render(120);
assert.ok(opened.length > 1, "expanded shows the tail");
assert.match(opened.join("\n"), /tick \d/);

await new Promise((resolve) => setTimeout(resolve, 6_000));

const reports = sent.filter((entry) => entry.message.customType === "watch_report");
assert.equal(reports.length, 1, "exactly one settled report");
assert.match(reports[0].message.content, /tick demo for the progress test matched after/);
assert.equal(
	widgets.filter((entry) => entry.key === "watch").at(-1).content,
	undefined,
	"the card clears when nothing is running",
);

// A silent command sends no interim messages: nothing changed to report.
sent.length = 0;
await watch.execute(
	"call-2",
	{ title: "silent run", command: "sleep 8", background: true, progress: 5, timeout: 60 },
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

console.log(`ok: ${progress.length} interim messages, folded to one row, 1 settled report, no wake on silence`);
process.exit(0);
