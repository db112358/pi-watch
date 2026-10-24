/**
 * Watch Tool - settle on a condition instead of a clock
 *
 * `bash` returns on exit or timeout, which forces a guess at a build's duration and a poll loop
 * after it: one turn per poll, output lost in between. `watch` streams output into a bounded ring
 * buffer plus a full log file, and settles on the first of: a line matching `until`, a line
 * matching `fail`, the exit code, or a timeout. One call covers the run and returns only the tail.
 *
 * Foreground (default) holds the call. `background: true` returns a handle and delivers the report
 * as a message that starts a new turn. `onMatch` sends the matched output to a pi session that
 * investigates and reports back (escalation.ts).
 *
 * There is no way to wait on a watch except by being told. `watch_status` reads progress for when a
 * person asks; using it to detect completion rebuilds the poll loop this replaces.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionToolContext,
	formatSize,
	getAgentDir,
	getShellConfig,
	ModelSelectorComponent,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	MouseRegion,
	Text,
	type Component,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type EscalationOutcome, Escalator, errorMessage, formatDuration } from "./escalation.ts";
import {
	choices,
	configPath,
	costLabel,
	describeInvestigationModel,
	lookupModel,
	resolveInvestigationModel,
	searchModels,
	setConfiguredModel,
	specOf,
} from "./model.ts";

/** Returned tail and the retained scan window. Full output goes to a log file regardless. */
const MAX_BUFFER_BYTES = 256 * 1024;
/** Overlap kept between chunks so a pattern split across two writes still matches. */
const SCAN_OVERLAP = 8 * 1024;
const DEFAULT_TAIL_LINES = 80;
const DEFAULT_TIMEOUT_SECONDS = 1800;
const MAX_TIMEOUT_SECONDS = 86_400;
const PROGRESS_INTERVAL_MS = 500;
/** Floor for `progress`: each interim message starts a turn, so faster is noise. */
const MIN_PROGRESS_SECONDS = 5;
const KILL_GRACE_MS = 3_000;
const WIDGET_KEY = "watch";
/** Bumped whenever the loaded build matters; echoed in the tool result. */
const BUILD = 9;
/** One glyph per state, so the card reads at a glance like the andon light. */
const STATUS_GLYPH: Record<string, string> = {
	running: "⏳",
	matched: "✓",
	exited: "✓",
	failed: "✗",
	error: "✗",
	timeout: "◷",
	aborted: "■",
};
/** Settled watches kept around for `watch_status`; each pins its buffer. */
const HISTORY_LIMIT = 10;
/** Output handed to an investigating agent, before it is told to read the full log. */
const ESCALATION_LINES = 400;
const ESCALATION_BYTES = 16 * 1024;
/** Read-only by default: most investigations are reading a failure, not reproducing it. */
const DEFAULT_INVESTIGATION_TOOLS = ["read", "grep", "find", "ls"];
/** Escalated sessions are kept out of the project's session list, but stay resumable. */
const ESCALATION_SESSION_DIR = join(getAgentDir(), "watch-sessions");

type WatchStatus = "running" | "exited" | "matched" | "failed" | "timeout" | "aborted" | "error";

interface WatchOptions {
	command: string;
	/** A few words on what the run is for, shown wherever the watch is. */
	title?: string;
	cwd: string;
	until?: RegExp;
	fail?: RegExp;
	timeoutMs?: number;
	tailLines: number;
}

interface WatchResult {
	status: WatchStatus;
	command: string;
	exitCode: number | null;
	elapsedMs: number;
	matchedPattern?: "until" | "fail";
	matchedLine?: string;
	tail: string;
	truncated: boolean;
	bufferedLines: number;
	outputBytes: number;
	fullOutputPath: string;
	error?: string;
}

interface WatchDetails {
	watchId: string;
	status: WatchStatus;
	title?: string;
	command: string;
	elapsedMs: number;
	exitCode: number | null;
	background: boolean;
	fullOutputPath: string;
	lastLine?: string;
	matchedPattern?: "until" | "fail";
	matchedLine?: string;
	escalationSession?: string;
	escalationStatus?: string;
}

interface EscalationRequest {
	task: string;
	tools?: string[];
	model?: string;
}

let watchSeq = 0;

function compileRegex(source: string | undefined, name: string): RegExp | undefined {
	if (!source) return undefined;
	try {
		return new RegExp(source, "m");
	} catch (error) {
		throw new Error(`Invalid ${name} regex "${source}": ${errorMessage(error)}`);
	}
}

/** The whole line containing a match, so the report shows context rather than the fragment. */
function matchedLineOf(text: string, match: RegExpMatchArray): string {
	const index = match.index ?? 0;
	const start = text.lastIndexOf("\n", index) + 1;
	const end = text.indexOf("\n", index + match[0].length);
	return text.slice(start, end === -1 ? undefined : end).trim();
}

/** One plain line: no control sequences from a model-written title reach the terminal. */
function plain(text: string, max: number): string {
	const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function formatUsage(usage: EscalationOutcome["usage"]): string {
	return `${usage.input} in / ${usage.output} out${usage.cost > 0 ? `, $${usage.cost.toFixed(2)}` : ""}`;
}

/**
 * Order: explicit request, `/watch model`, PI_WATCH_INVESTIGATION_MODEL, cheap default, parent.
 */

class Watch {
	readonly id: string;
	readonly command: string;
	readonly title?: string;
	readonly cwd: string;
	readonly startedAt = Date.now();
	readonly fullOutputPath: string;
	readonly done: Promise<WatchResult>;

	status: WatchStatus = "running";
	exitCode: number | null = null;
	outputBytes = 0;
	matchedPattern: "until" | "fail" | undefined;
	matchedLine: string | undefined;

	private readonly options: WatchOptions;
	private buffer = "";
	private truncated = false;
	private scanTail = "";
	private child: ChildProcess | undefined;
	private sink: WriteStream;
	private timeoutHandle: NodeJS.Timeout | undefined;
	private killHandle: NodeJS.Timeout | undefined;
	private settled = false;
	private resolveDone!: (result: WatchResult) => void;
	private progressHandlers = new Set<() => void>();

	constructor(options: WatchOptions) {
		this.options = options;
		this.id = `w${++watchSeq}`;
		this.command = options.command;
		this.title = options.title;
		this.cwd = options.cwd;
		this.fullOutputPath = join(mkdtempSync(join(tmpdir(), "pi-watch-")), "output.log");
		this.sink = createWriteStream(this.fullOutputPath);
		this.done = new Promise<WatchResult>((resolve) => {
			this.resolveDone = resolve;
		});
		this.spawnChild();
	}

	/** What this run is for, in the reader's terms. */
	get label(): string {
		return this.title ?? this.command;
	}

	get lastLine(): string {
		const trimmed = this.buffer.trimEnd();
		const index = trimmed.lastIndexOf("\n");
		return (index === -1 ? trimmed : trimmed.slice(index + 1)).slice(0, 160);
	}

	get elapsedMs(): number {
		return Date.now() - this.startedAt;
	}

	/** A slice of the retained output, trimmed to a caller's budget. */
	snapshot(maxLines: number, maxBytes: number): string {
		return truncateTail(this.buffer, { maxLines, maxBytes }).content;
	}

	onProgress(handler: () => void): () => void {
		this.progressHandlers.add(handler);
		return () => this.progressHandlers.delete(handler);
	}

	cancel(): void {
		this.finish("aborted");
	}

	private spawnChild(): void {
		const config = getShellConfig();
		const commandFromStdin = config.commandTransport === "stdin";
		let child: ChildProcess;
		try {
			child = spawn(config.shell, commandFromStdin ? config.args : [...config.args, this.command], {
				cwd: this.options.cwd,
				// Detached makes the shell a process group leader, so the whole tree can be
				// signalled with a negative pid. Tracked and killed on session shutdown.
				detached: process.platform !== "win32",
				env: process.env,
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			this.append(`failed to spawn: ${errorMessage(error)}\n`);
			this.finish("error", errorMessage(error));
			return;
		}
		this.child = child;

		if (commandFromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(this.command);
		}
		child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.onData(chunk));
		child.on("error", (error) => {
			this.append(`spawn error: ${errorMessage(error)}\n`);
			this.finish("error", errorMessage(error));
		});
		child.on("close", (code, signal) => {
			this.exitCode = code ?? (signal ? 128 : 1);
			this.finish("exited");
		});

		if (this.options.timeoutMs) {
			this.timeoutHandle = setTimeout(() => this.finish("timeout"), this.options.timeoutMs);
		}
	}

	private onData(chunk: Buffer): void {
		const text = chunk.toString();
		this.outputBytes += Buffer.byteLength(text);
		this.sink.write(text);

		this.buffer += text;
		if (this.buffer.length > MAX_BUFFER_BYTES) {
			this.truncated = true;
			this.buffer = this.buffer.slice(-MAX_BUFFER_BYTES);
		}

		// Carry an overlap so a pattern split across two writes still matches.
		const scan = this.scanTail + text;
		this.scanTail = scan.slice(-SCAN_OVERLAP);
		this.match(scan);
		this.notifyProgress();
	}

	private match(scan: string): void {
		if (this.settled) return;
		// Fail first: when both patterns appear, the failure is the more useful answer.
		if (this.options.fail) {
			const match = scan.match(this.options.fail);
			if (match) {
				this.matchedPattern = "fail";
				this.matchedLine = matchedLineOf(scan, match);
				this.finish("failed");
				return;
			}
		}
		if (this.options.until) {
			const match = scan.match(this.options.until);
			if (match) {
				this.matchedPattern = "until";
				this.matchedLine = matchedLineOf(scan, match);
				this.finish("matched");
			}
		}
	}

	private append(text: string): void {
		this.sink.write(text);
		this.buffer = (this.buffer + text).slice(-MAX_BUFFER_BYTES);
	}

	private finish(status: WatchStatus, error?: string): void {
		if (this.settled) return;
		this.settled = true;
		this.status = status;
		if (this.timeoutHandle) clearTimeout(this.timeoutHandle);
		// Settling early leaves the command running, so take the tree down.
		if (status !== "exited" && status !== "error") this.terminate();
		this.sink.end(() => this.resolveDone(this.result(error)));
	}

	private terminate(): void {
		const pid = this.child?.pid;
		if (!pid || this.child?.exitCode !== null) return;
		if (process.platform === "win32") {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on(
				"error",
				() => {},
			);
			return;
		}
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		this.killHandle = setTimeout(() => {
			try {
				if (this.child?.exitCode === null) process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}, KILL_GRACE_MS);
		this.killHandle.unref();
	}

	private result(error?: string): WatchResult {
		const truncation = truncateTail(this.buffer, { maxLines: this.options.tailLines });
		return {
			status: this.status,
			command: this.command,
			exitCode: this.exitCode,
			elapsedMs: this.elapsedMs,
			matchedPattern: this.matchedPattern,
			matchedLine: this.matchedLine,
			tail: truncation.content,
			truncated: truncation.truncated || this.truncated,
			bufferedLines: truncation.totalLines,
			outputBytes: this.outputBytes,
			fullOutputPath: this.fullOutputPath,
			error,
		};
	}

	private notifyProgress(): void {
		if (this.settled) return;
		for (const handler of this.progressHandlers) handler();
	}
}

/** The prompt an investigating agent sees: what ran, what matched, and what to find out. */
function escalationPrompt(watch: Watch, result: WatchResult, brief: string): string {
	const head = [
		"A command was run in the background and its output matched a condition.",
		"",
		`command: ${result.command}`,
		`settled: ${result.status} after ${formatDuration(result.elapsedMs)}${result.exitCode !== null ? `, exit code ${result.exitCode}` : ""}`,
	];
	if (result.matchedPattern) head.push(`matched ${result.matchedPattern}: ${result.matchedLine}`);
	head.push(`full log: ${result.fullOutputPath}`);
	head.push(
		"",
		"## What to find out",
		brief.trim(),
		"",
		"## Recent output",
		"```",
		watch.snapshot(ESCALATION_LINES, ESCALATION_BYTES).trimEnd(),
		"```",
		"",
		"Read the full log if the recent output is not enough. Answer directly, citing the lines you relied on.",
	);
	return head.join("\n");
}

export default function (pi: ExtensionAPI) {
	/** Watches still running, plus settled ones whose investigation is still going. */
	const live = new Set<Watch>();
	const history: Watch[] = [];
	const escalator = new Escalator(ESCALATION_SESSION_DIR);

	const findWatch = (id: string): Watch | undefined =>
		[...live].find((watch) => watch.id === id) ?? history.find((watch) => watch.id === id);

	const remember = (watch: Watch) => {
		live.delete(watch);
		if (history.includes(watch)) return;
		history.push(watch);
		if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
	};

	const stopAll = () => {
		for (const watch of live) watch.cancel();
		live.clear();
		escalator.killAll();
	};

	// Idempotent: quit, reload, and session replacement all converge here.
	pi.on("session_shutdown", async () => stopAll());

	/** Persist a choice. `undefined` restores the default chain. */
	const applyModel = (spec: string | undefined, ctx: ExtensionCommandContext) => {
		setConfiguredModel(spec);
		ctx.ui.notify(`Investigation model: ${spec ?? "default"}`, "info");
	};

	/**
	 * pi's own /model picker, so search, scope and auth filtering match the built-in command. The
	 * class is exported and aliased to the running build; only the catalog it reads is private.
	 */
	const builtInPicker = (ctx: ExtensionCommandContext, search: string) => {
		const { runtime } = ctx.modelRegistry as unknown as {
			runtime: ConstructorParameters<typeof ModelSelectorComponent>[2];
		};
		if (!runtime) return undefined;
		const spec = resolveInvestigationModel(ctx);
		return ctx.ui.custom<Model<any> | undefined>(
			(tui, _theme, _keybindings, done) =>
				new ModelSelectorComponent(
					tui,
					(spec ? lookupModel(ctx, spec) : undefined) ?? ctx.model,
					runtime,
					ctx.scopedModels,
					(picked) => done(picked),
					() => done(undefined),
					search || undefined,
				),
		);
	};

	/** Pick a model and persist it. `candidates` narrows the fallback list, not the built-in picker. */
	const pickModel = async (ctx: ExtensionCommandContext, search = "", candidates?: Model<any>[]) => {
		// Cancelling the built-in picker resolves undefined, which leaves the choice alone.
		const picker = ctx.mode === "tui" ? builtInPicker(ctx, search) : undefined;
		if (picker) {
			const picked = await picker;
			if (picked) applyModel(specOf(picked), ctx);
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Choosing a model needs the interactive UI. Use /watch model <spec>.", "warning");
			return;
		}

		// RPC clients forward dialogs but cannot render custom components.
		const byLabel = new Map<string, string>();
		byLabel.set("default (cheapest configured)", "");
		for (const model of candidates ?? choices(ctx)) {
			byLabel.set(`${specOf(model)}  ${costLabel(model)}`.trimEnd(), specOf(model));
		}
		const selected = await ctx.ui.select("Investigation model", [...byLabel.keys()]);
		const spec = selected === undefined ? undefined : byLabel.get(selected);
		if (spec === undefined) return;
		applyModel(spec || undefined, ctx);
	};

	pi.registerCommand("watch", {
		description: "Show or choose the model investigating agents run on",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (subcommand && subcommand !== "model") {
				ctx.ui.notify(
					`Unknown subcommand "${subcommand}". Use /watch or /watch model [<model>|default].`,
					"warning",
				);
				return;
			}
			if (!subcommand) {
				ctx.ui.notify(`${describeInvestigationModel(ctx)}\n${configPath()}`, "info");
				return;
			}

			const requested = rest.join(" ");
			if (requested === "default" || requested === "reset") {
				setConfiguredModel(undefined);
				ctx.ui.notify(`Reset. ${describeInvestigationModel(ctx)}`, "info");
				return;
			}
			if (!requested) {
				await pickModel(ctx);
				return;
			}

			const matches = searchModels(ctx, requested);
			if (matches.length === 0) {
				// Nothing matched exactly, so hand the fragment to the picker as a search.
				await pickModel(ctx, requested);
				return;
			}
			if (matches.length > 1) {
				await pickModel(ctx, requested, matches);
				return;
			}
			applyModel(specOf(matches[0]), ctx);
		},
	});

	const detailsOf = (watch: Watch, background: boolean, result?: WatchResult): WatchDetails => {
		const escalation = escalator.get(watch.id);
		return {
			watchId: watch.id,
			status: result?.status ?? watch.status,
			title: watch.title,
			command: watch.command,
			elapsedMs: result?.elapsedMs ?? watch.elapsedMs,
			exitCode: result ? result.exitCode : watch.exitCode,
			background,
			fullOutputPath: watch.fullOutputPath,
			lastLine: watch.lastLine || undefined,
			matchedPattern: result?.matchedPattern ?? watch.matchedPattern,
			matchedLine: result?.matchedLine ?? watch.matchedLine,
			escalationSession: escalation?.sessionId,
			escalationStatus: escalation?.status,
		};
	};

	const formatResult = (result: WatchResult, investigation?: string): string => {
		const head = [`status: ${result.status} after ${formatDuration(result.elapsedMs)}`];
		if (result.exitCode !== null) head.push(`exit code: ${result.exitCode}`);
		head.push(`command: ${result.command}`);
		if (result.matchedPattern) head.push(`matched ${result.matchedPattern}: ${result.matchedLine}`);
		if (result.error) head.push(`error: ${result.error}`);
		const meta = [`${formatSize(result.outputBytes)} of output`];
		if (result.truncated) meta.push("older output dropped from the retained buffer");
		meta.push(`full log: ${result.fullOutputPath}`);
		head.push(meta.join(", "));

		const tail = result.tail.trimEnd();
		let text = tail ? `${head.join("\n")}\n\n--- tail ---\n${tail}` : head.join("\n");
		if (investigation) text += `\n\n--- investigation ---\n${investigation}`;
		return text;
	};

	/**
	 * `w2 draft-PR CI` — the title is why the row is worth reading, so it travels
	 * whole: the surfaces that have a width trim it when they paint.
	 */
	const plan = (id: string, label: string) => `${id} ${plain(label, 60)}`;

	/** Painted by the widget factory below; kept so a tick can repaint it. */
	let cardTui: { requestRender: () => void } | undefined;
	let cardTimer: NodeJS.Timeout | undefined;

	const cardRows = (theme: Theme | undefined): string[] => {
		const dim = (text: string) => (theme ? theme.fg("dim", text) : text);
		const watches = [...live].slice(0, 3);
		const rows = watches.map((watch) => {
			const phase = escalator.isRunning(watch.id)
				? " investigating"
				: watch.status === "running"
					? ""
					: ` ${watch.status}`;
			const glyph = STATUS_GLYPH[watch.status] ?? "●";
			return plain(`${glyph} ${watch.label}`, 60) + `  ${dim(`${formatDuration(watch.elapsedMs)}${phase}`)}`;
		});
		// A lone watch says what it is doing, not just how long it has been at it.
		const only = watches[0];
		if (watches.length === 1 && only.status === "running" && only.lastLine) {
			rows.push(dim(`  ${plain(only.lastLine, 100)}`));
		}
		if (live.size > watches.length) rows.push(dim(`+${live.size - watches.length} more`));
		return rows;
	};

	/**
	 * Live watches as a card below the editor — the only signal once a watch
	 * outlives its turn. A component rather than lines, so the elapsed time is
	 * read when the frame is painted and never goes stale.
	 */
	const refreshStatus = (ctx: ExtensionToolContext) => {
		if (!ctx.hasUI) return;
		// A background watch's tool context outlives its turn.
		try {
			if (live.size === 0) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				if (cardTimer) clearInterval(cardTimer);
				cardTimer = undefined;
				cardTui = undefined;
				return;
			}
			// Registered after andon's card, so it sits beneath it.
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					cardTui = tui;
					cardTimer ??= setInterval(() => cardTui?.requestRender(), 1_000);
					return { render: () => cardRows(theme), invalidate: () => {} };
				},
				{ placement: "belowEditor" },
			);
		} catch {
			// The UI is gone; the log file is still on disk.
		}
	};

	const shouldEscalate = (result: WatchResult, request: EscalationRequest | undefined): request is EscalationRequest =>
		Boolean(request) && result.status === "matched";

	/**
	 * Interim messages while a background watch runs, so a caller can see the run
	 * evolving instead of only its end. Silent when the command produced nothing
	 * new since the last one.
	 */
	const reportProgress = (watch: Watch, everyMs: number) => {
		let lastBytes = 0;
		const timer = setInterval(() => {
			if (watch.status !== "running" || watch.outputBytes === lastBytes) return;
			lastBytes = watch.outputBytes;
			const tail = watch.snapshot(5, 2_000).trimEnd();
			const id = watch.id;
			const title = watch.label;
			const status = `still running · ${formatDuration(watch.elapsedMs)} · ${formatSize(watch.outputBytes)} output`;
			const label = `watch ${plan(watch.id, watch.label)} ${status}`;
			try {
				// sendMessage is synchronous: it queues a turn, it does not return one.
				pi.sendMessage(
					{
						customType: "watch_progress",
						display: true,
						content: tail ? `${label}\n\n${tail}` : label,
						details: { id, title, status, tail },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// Session shutting down; the log file is still on disk.
			}
		}, everyMs);
		void watch.done.then(() => clearInterval(timer));
	};

	/** Deliver a settled watch as a message, which starts a new turn. */
	const reportLater = (
		watch: Watch,
		onMatch: EscalationRequest | undefined,
		ctx: ExtensionToolContext,
		progressSeconds: number | undefined,
	) => {
		if (progressSeconds && progressSeconds > 0) {
			reportProgress(watch, Math.max(progressSeconds, MIN_PROGRESS_SECONDS) * 1000);
		}
		void watch.done.then(async (result) => {
			let investigation: string | undefined;
			if (shouldEscalate(result, onMatch)) {
				investigation = await escalate(watch, result, onMatch, ctx, undefined, undefined);
			}
			remember(watch);
			refreshStatus(ctx);
			const status = `${result.status} after ${formatDuration(result.elapsedMs)}`;
			const summary = `watch ${plan(watch.id, watch.label)} ${status}`;
			try {
				await pi.sendMessage(
					{
						customType: "watch_report",
						display: true,
						content: `${summary}\n\n${formatResult(result, investigation)}`,
						details: { id: watch.id, title: watch.label, status, body: formatResult(result, investigation) },
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// Session shutting down; the log file is still on disk.
			}
		});
	};

	/**
	 * Rows the reader opened or closed by clicking. Keyed by whatever identifies
	 * the message: an undefined key would make one click open every row at once.
	 */
	const overrides = new Map<string, boolean>();
	const rowKey = (message: { content: unknown; id?: string; timestamp?: number }) =>
		String(message.id ?? message.timestamp ?? message.content);

	/**
	 * One foldable row: a dim lead, the run's title, and its outcome right-aligned
	 * in the dim register zen gives an action's summary. The title gets the room
	 * the outcome leaves, so nothing is chopped for a fixed budget.
	 */
	const foldRow = (
		message: { timestamp: number; content: unknown; details?: unknown },
		expanded: boolean,
		outputPad: number,
		invalidate: (() => void) | undefined,
		theme: Theme,
	) => {
		void expanded; // a check-in is a glance: it stays folded whatever ctrl+o says
		const details = message.details as
			| { id?: string; title?: string; status?: string; tail?: string; body?: string }
			| undefined;
		const [head, ...rest] = String(message.content).split("\n\n");
		const title = details?.title ?? head.replace(/^watch /, "");
		const status = details?.status ?? "";
		const body = details?.body ?? details?.tail ?? rest.join("\n\n");
		const open = overrides.get(rowKey(message)) ?? false;
		// The id is for addressing a watch (`watch_status`, `watch_cancel`), not
		// for the reader glancing at the row.
		const lead = theme.fg("dim", theme.bold("watch"));
		const row: Component = {
			render(width: number) {
				// Keep the text off the right edge, matching the frame's left inset.
				const usable = Math.max(24, width - 2);
				const right = status ? theme.fg("dim", status) : "";
				const room = Math.max(12, usable - visibleWidth(lead) - visibleWidth(right) - 2);
				const main = truncateToWidth(theme.fg("text", title), room, "…");
				const pad = Math.max(1, usable - visibleWidth(lead) - visibleWidth(main) - visibleWidth(right));
				const lines = [`${lead} ${main}${" ".repeat(pad)}${right}`];
				if (open && body) {
					lines.push(...body.split("\n").map((line) => theme.fg("dim", `  ${line}`)));
				}
				return lines;
			},
			invalidate() {},
		};
		const clickable = new MouseRegion(row, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			overrides.set(rowKey(message), !open);
			invalidate?.();
			return { handled: true };
		});
		// The same frame a default custom message gets: one column in, one line clear.
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(clickable);
		return box;
	};

	/** A renderer that throws is silently replaced by pi's default drawing. Say so instead. */
	const guarded = (build: () => Component, theme: Theme): Component => {
		try {
			return build();
		} catch (error) {
			return new Text(`${theme.fg("error", "watch renderer failed: ")}${errorMessage(error)}`, 0, 0);
		}
	};

	/** An interim check-in folds to one row; clicking it opens the tail. */
	pi.registerMessageRenderer<{ label: string; tail?: string }>("watch_progress", (message, options, theme) =>
		guarded(() => foldRow(message, options.expanded, options.outputPad, options.invalidate, theme), theme),
	);

	/** The settled report folds too, with the tail and any investigation behind it. */
	pi.registerMessageRenderer("watch_report", (message, options, theme) =>
		guarded(() => foldRow(message, options.expanded, options.outputPad, options.invalidate, theme), theme),
	);

	pi.registerTool({
		name: "watch",
		label: "watch",
		description: `Run a command and settle on a condition instead of a fixed timeout. Returns the tail of the output, the exit code, and a path to the full log. Settles on the first of: a line matching \`until\`, a line matching \`fail\`, the process exiting, or \`timeout\` elapsing.

Use this instead of bash for anything that may take more than a couple of minutes. One call covers the whole run, so there is no duration to guess and nothing to poll. When you know what success looks like, pass \`until\` (for example "Tests:.*passed", "EXIT=0", or "BUILD SUCCESSFUL"): the call returns as soon as it appears, however long that takes.

\`onMatch\` escalates when \`until\` matches: a separate agent with its own context reads the output and investigates, and its report is returned with the result. Use it when the useful answer is not in the output itself, for example "the build failed, find out which change broke it". That agent's session persists, so \`watch_ask\` can follow up on what it found without starting over.

With \`background: true\` the call returns a handle immediately and the report, including any investigation, arrives later as a message that starts a new turn. It needs an interactive session; print/JSON mode exits at the end of the turn and takes the watch with it. Keep working, or do nothing; do not poll, and do not re-run the command. Add \`progress\` (seconds) to have interim messages arrive while it runs — the same handle, but with the evolving tail — for a run you want to steer before it settles.`,
		promptSnippet: "Run a long command and wait for a condition (regex, exit, or timeout)",
		promptGuidelines: [
			"Prefer `watch` over `bash` for builds, test suites, CI runs, and any command that may outlive a bash timeout.",
			"Pass `onMatch` when the output only raises a question that needs investigating, rather than returning raw text.",
			"Never poll a running watch with sleep or repeated tail; its report arrives as a message.",
			"`watch_status` is for answering a person's question about progress. It is not a way to wait, and calling it in a loop defeats the point of a watch.",
		],
		parameters: Type.Object({
			title: Type.String({
				description:
					'What this run is for, in a few words under ~60 characters: it labels the status row, the interim messages and the report. Say why, not what — "draft PR CI for AI-1493" beats "gh pr checks".',
			}),
			command: Type.String({ description: "Shell command to run" }),
			until: Type.Optional(
				Type.String({ description: "Regex. Settle successfully as soon as a line of output matches." }),
			),
			fail: Type.Optional(
				Type.String({ description: "Regex. Settle early as a failure if a line of output matches." }),
			),
			timeout: Type.Optional(
				Type.Number({
					description: `Seconds before giving up. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}. 0 waits forever.`,
				}),
			),
			tail: Type.Optional(Type.Number({ description: `Lines of output to return. Default ${DEFAULT_TAIL_LINES}.` })),
			background: Type.Optional(
				Type.Boolean({ description: "Return immediately and deliver the report as a message later." }),
			),
			progress: Type.Optional(
				Type.Number({
					description: `Background only: seconds between interim progress messages (min ${MIN_PROGRESS_SECONDS}). Sent only when new output arrives; each one starts a turn, so keep it coarse.`,
				}),
			),
			onMatch: Type.Optional(
				Type.Object({
					task: Type.String({
						description:
							"What the investigating agent should find out. Be specific: it sees the output, not your conversation.",
					}),
					tools: Type.Optional(
						Type.Array(Type.String(), {
							description: `Tools for the investigating agent. Default ${DEFAULT_INVESTIGATION_TOOLS.join(", ")}. Add bash when it must reproduce or query something.`,
						}),
					),
					model: Type.Optional(
						Type.String({
							description:
								"Model for the investigating agent. Defaults to the cheap tier; the user can change it with /watch model.",
						}),
					),
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the session cwd." })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const until = compileRegex(params.until, "until");
			const fail = compileRegex(params.fail, "fail");
			const timeoutSeconds = params.timeout ?? DEFAULT_TIMEOUT_SECONDS;
			if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
				throw new Error("timeout must be a non-negative number of seconds");
			}
			const timeoutMs = Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000;

			const watch = new Watch({
				title: plain(params.title, 60),
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				until,
				fail,
				timeoutMs: timeoutMs > 0 ? timeoutMs : undefined,
				tailLines: params.tail ?? DEFAULT_TAIL_LINES,
			});
			live.add(watch);
			const background = params.background === true;
			if (background && !ctx.hasUI) {
				throw new Error(
					"background watches need an interactive session: the report arrives as a message after this turn, and print/JSON mode exits — killing the watch — when the turn ends. Use a foreground watch with `until` instead.",
				);
			}
			const onMatch = params.onMatch;

			if (background) {
				reportLater(watch, onMatch, ctx, params.progress);
				refreshStatus(ctx);
				const conditions: string[] = [];
				if (until) conditions.push(`until ${until.source}`);
				if (fail) conditions.push(`fail ${fail.source}`);
				conditions.push(timeoutMs > 0 ? `timeout ${formatDuration(timeoutMs)}` : "no timeout");
				if (onMatch) conditions.push("escalates to an investigating agent on match");
				return {
					content: [
						{
							type: "text",
							text: `watch ${watch.id} started in the background (build ${BUILD})\ntitle: ${watch.label}\ncommand: ${watch.command}\nsettles on: ${conditions.join(", ")}\n\nThe report arrives as a message when it settles. Do not poll it.`,
						},
					],
					details: detailsOf(watch, true),
				};
			}

			let lastPush = 0;
			const unsubscribe = watch.onProgress(() => {
				const now = Date.now();
				if (now - lastPush < PROGRESS_INTERVAL_MS) return;
				lastPush = now;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `watch ${watch.id} running for ${formatDuration(watch.elapsedMs)}${watch.lastLine ? `\n${watch.lastLine}` : ""}`,
						},
					],
					details: detailsOf(watch, false),
				});
			});

			// Cancelling the turn must take the command down with it, or the process leaks.
			const onAbort = () => watch.cancel();
			if (signal?.aborted) watch.cancel();
			else signal?.addEventListener("abort", onAbort, { once: true });

			refreshStatus(ctx);
			const result = await watch.done;
			signal?.removeEventListener("abort", onAbort);
			unsubscribe();

			let investigation: string | undefined;
			if (shouldEscalate(result, onMatch)) {
				lastPush = 0;
				investigation = await escalate(watch, result, onMatch, ctx, signal, (text) => {
					const now = Date.now();
					if (now - lastPush < PROGRESS_INTERVAL_MS) return;
					lastPush = now;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: `watch ${watch.id} matched after ${formatDuration(result.elapsedMs)}, investigating\n${text.slice(-400)}`,
							},
						],
						details: detailsOf(watch, false, result),
					});
				});
			}

			remember(watch);
			refreshStatus(ctx);

			return {
				content: [{ type: "text", text: formatResult(result, investigation) }],
				details: detailsOf(watch, false, result),
			};
		},

		renderResult(result, options, theme) {
			const content = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
			const details = result.details as WatchDetails | undefined;
			if (!details || options.expanded) return new Text(content, 0, 0);
			const color =
				details.status === "running"
					? "accent"
					: details.status === "exited" || details.status === "matched"
						? "success"
						: "error";
			const lines = [
				theme.fg(color, `${details.status} ${formatDuration(details.elapsedMs)}`),
				theme.fg("dim", `$ ${details.command}`),
			];
			if (details.escalationStatus) lines.push(theme.fg("muted", `investigation: ${details.escalationStatus}`));
			else if (details.lastLine) lines.push(theme.fg("toolOutput", details.lastLine));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "watch_status",
		label: "watch_status",
		description: `Read a watch's progress without waiting for it: status, elapsed time, recent output, and whether an investigating agent is still working. Answers "how is it going" for a person.

This is not a way to wait for completion. Done watches report themselves, so calling this in a loop only recreates the polling that \`watch\` exists to avoid.`,
		parameters: Type.Object({
			id: Type.String({ description: "Watch id, for example w3" }),
			tail: Type.Optional(Type.Number({ description: "Lines of recent output. Default 20." })),
		}),
		async execute(_toolCallId, params) {
			const watch = findWatch(params.id);
			if (!watch) throw new Error(`No watch with id "${params.id}"`);
			const escalation = escalator.get(params.id);
			const head = [
				`status: ${watch.status} after ${formatDuration(watch.elapsedMs)}`,
				`title: ${watch.label}`,
				`command: ${watch.command}`,
			];
			if (watch.exitCode !== null) head.push(`exit code: ${watch.exitCode}`);
			if (watch.matchedPattern) head.push(`matched ${watch.matchedPattern}: ${watch.matchedLine}`);
			head.push(`full log: ${watch.fullOutputPath}`);
			if (escalation) {
				head.push(`investigating agent: ${escalation.status}, session ${escalation.sessionId}`);
				head.push(`resume it: pi -p --session ${escalation.sessionId} --session-dir ${escalation.sessionDir}`);
			}
			const tail = watch.snapshot(params.tail ?? 20, 8 * 1024).trimEnd();
			if (tail) head.push("", "--- recent output ---", tail);
			return {
				content: [{ type: "text", text: head.join("\n") }],
				details: detailsOf(watch, false),
			};
		},
	});

	pi.registerTool({
		name: "watch_ask",
		label: "watch_ask",
		description: `Send a follow-up message to the agent a watch escalated to, and return its reply. The agent keeps its session, so this is cheaper and more precise than escalating again.

Only works once that agent has finished its current run. If it is still working the call fails: wait for its report, or cancel with \`watch_cancel\`.`,
		parameters: Type.Object({
			id: Type.String({ description: "Watch id, for example w3" }),
			message: Type.String({
				description:
					"What to ask or instruct. This is typed in as a user message, so the agent keeps its context and its earlier findings.",
			}),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ watchId: string; sessionId: string }>> {
			const outcome = await escalator.ask(params.id, params.message);
			return {
				content: [{ type: "text", text: outcome.text }],
				details: { watchId: params.id, sessionId: outcome.sessionId },
			};
		},
	});

	pi.registerTool({
		name: "watch_cancel",
		label: "watch_cancel",
		description: "Cancel a watch, its command's process tree, and any investigation still running for it.",
		parameters: Type.Object({ id: Type.String({ description: "Watch id, for example w1" }) }),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ id: string }>> {
			const watch = findWatch(params.id);
			const cancelled = escalator.cancel(params.id);
			if (!watch && !cancelled) throw new Error(`No watch with id "${params.id}"`);
			watch?.cancel();
			return {
				content: [{ type: "text", text: `Cancelled ${params.id}.` }],
				details: { id: params.id },
			};
		},
	});
}
