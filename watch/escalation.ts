/**
 * Escalated pi sessions for the watch extension.
 *
 * An investigation runs as a separate pi process with its own context and a session that outlives
 * it, so a follow-up costs a question instead of a fresh investigation. Sessions live outside the
 * project's session list to keep `/resume` clean, and stay resumable with
 * `pi --session <id> --session-dir <dir>`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

export interface Escalation {
	key: string;
	sessionId: string;
	sessionDir: string;
	tools: string[];
	model?: string;
	cwd: string;
	status: "running" | "done" | "failed" | "aborted";
	report?: string;
}

export interface EscalationUsage {
	input: number;
	output: number;
	cost: number;
}

export interface EscalationOutcome {
	status: Escalation["status"];
	/** The agent's reply, or why it produced none. */
	text: string;
	usage: EscalationUsage;
	sessionId: string;
	sessionDir: string;
}

export interface EscalationRunOptions {
	/** Watch id; keys both the escalation record and the running child. */
	key: string;
	sessionId: string;
	cwd: string;
	prompt: string;
	tools: string[];
	model?: string;
}

interface ChildRun {
	text: string;
	exitCode: number;
	stderr: string;
	usage: EscalationUsage;
}

const NO_USAGE: EscalationUsage = { input: 0, output: 0, cost: 0 };

/** `watch_cancel` clears this flag from outside the running agent, so it cannot be narrowed. */
function isAborted(escalation: Escalation): boolean {
	return escalation.status === "aborted";
}

/** Resolve the pi entry point the way `pi` itself was started: dev checkout, binary, or PATH. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** Spawn one pi child in JSON mode and read back its last assistant message. */
function runPiChild(
	register: (child: ChildProcess) => void,
	release: () => void,
	args: string[],
	cwd: string,
	onText: ((text: string) => void) | undefined,
): Promise<ChildRun> {
	return new Promise((resolve, reject) => {
		const invocation = piInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		register(child);

		let buffer = "";
		let text = "";
		let stderr = "";
		const usage: EscalationUsage = { input: 0, output: 0, cost: 0 };

		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: any };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			const part = event.message.content?.find((piece: any) => piece?.type === "text");
			if (part?.text) {
				text = part.text;
				onText?.(text);
			}
			const reported = event.message.usage;
			if (reported) {
				usage.input += reported.input ?? 0;
				usage.output += reported.output ?? 0;
				usage.cost += reported.cost?.total ?? 0;
			}
		};

		child.stdout?.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			release();
			reject(error);
		});
		child.on("close", (code) => {
			release();
			if (buffer.trim()) handleLine(buffer);
			resolve({ text: text.trim(), exitCode: code ?? 1, stderr, usage });
		});
	});
}

/** Resumable pi children keyed by watch id. The record outlives the child so `watch_ask` can
 * continue the thread later. */
export class Escalator {
	private readonly sessionDir: string;
	private readonly escalations = new Map<string, Escalation>();
	private readonly children = new Map<string, ChildProcess>();

	constructor(sessionDir: string) {
		this.sessionDir = sessionDir;
	}

	get(key: string): Escalation | undefined {
		return this.escalations.get(key);
	}

	isRunning(key: string): boolean {
		return this.children.has(key);
	}

	/** Run a fresh investigation and report what it said. */
	start(
		options: EscalationRunOptions,
		onText?: (text: string) => void,
		signal?: AbortSignal,
	): Promise<EscalationOutcome> {
		const escalation: Escalation = {
			key: options.key,
			sessionId: options.sessionId,
			sessionDir: this.sessionDir,
			tools: options.tools,
			model: options.model,
			cwd: options.cwd,
			status: "running",
		};
		this.escalations.set(options.key, escalation);
		return this.execute(escalation, options.prompt, onText, signal);
	}

	/** Continue an existing investigation with a user message, keeping its context. */
	async ask(key: string, message: string): Promise<EscalationOutcome> {
		const escalation = this.escalations.get(key);
		if (!escalation) {
			throw new Error(`No investigating agent for "${key}". Pass onMatch when starting a watch, or read its log.`);
		}
		if (this.isRunning(key)) {
			throw new Error(
				`The investigating agent for ${key} is still working. Wait for its report, or cancel with watch_cancel.`,
			);
		}
		// No narrowing afterwards: `cancel()` writes this field from the outside.
		escalation.status = "running";
		return this.execute(escalation, message, undefined, undefined);
	}

	/** Kill a running child. Returns false when there was nothing to cancel. */
	cancel(key: string): boolean {
		const escalation = this.escalations.get(key);
		const child = this.children.get(key);
		if (!escalation && !child) return false;
		if (escalation && !isAborted(escalation)) escalation.status = "aborted";
		child?.kill("SIGTERM");
		return true;
	}

	killAll(): void {
		for (const child of this.children.values()) child.kill("SIGTERM");
		this.children.clear();
	}

	private async execute(
		escalation: Escalation,
		prompt: string,
		onText: ((text: string) => void) | undefined,
		signal: AbortSignal | undefined,
	): Promise<EscalationOutcome> {
		const args = [
			"--mode",
			"json",
			"-p",
			"--session-id",
			escalation.sessionId,
			"--session-dir",
			escalation.sessionDir,
			"--tools",
			escalation.tools.join(","),
		];
		if (escalation.model) args.push("--model", escalation.model);
		args.push(prompt);

		const onAbort = () => this.cancel(escalation.key);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		let run: ChildRun;
		try {
			run = await runPiChild(
				(child) => this.children.set(escalation.key, child),
				() => this.children.delete(escalation.key),
				args,
				escalation.cwd,
				onText,
			);
		} catch (error) {
			const outcome = this.settle(escalation, `investigation failed to start: ${errorMessage(error)}`, NO_USAGE);
			// A cancel wins; otherwise the spawn failure is the answer.
			if (outcome.status === "done") escalation.status = "failed";
			return outcome;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		// A cancel outranks the exit code, which only reports the signal that killed it.
		if (isAborted(escalation)) return this.settle(escalation, "investigation cancelled", run.usage);
		const text = run.text || run.stderr.trim() || "(the investigating agent produced no output)";
		escalation.status = run.exitCode === 0 ? "done" : "failed";
		return this.settle(escalation, text, run.usage);
	}

	private settle(escalation: Escalation, text: string, usage: EscalationUsage): EscalationOutcome {
		escalation.report = text;
		return {
			status: escalation.status,
			text,
			usage,
			sessionId: escalation.sessionId,
			sessionDir: escalation.sessionDir,
		};
	}
}
