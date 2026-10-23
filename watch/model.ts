/**
 * Which model investigating agents run on, and where that choice is stored.
 *
 * An investigation reads output and answers a question, so it defaults to the cheap tier rather
 * than the parent's model. The choice persists per user in `~/.pi/agent/watch.json`, set with
 * `/watch model`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

/** Used when nothing else is configured and this provider has credentials. */
export const PREFERRED_INVESTIGATION_MODEL = "fireworks/accounts/fireworks/models/glm-5p3-flash";

const CONFIG_PATH = join(getAgentDir(), "watch.json");

interface WatchConfig {
	investigationModel?: string;
}

let configCache: WatchConfig | undefined;

function readConfig(): WatchConfig {
	if (configCache) return configCache;
	try {
		const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		configCache = typeof parsed === "object" && parsed !== null ? (parsed as WatchConfig) : {};
	} catch {
		// Missing or unreadable config is the same as no config.
		configCache = {};
	}
	return configCache;
}

export function configPath(): string {
	return CONFIG_PATH;
}

export function configuredModel(): string | undefined {
	return readConfig().investigationModel;
}

/** Persist the choice. `undefined` clears it and restores the default chain. */
export function setConfiguredModel(spec: string | undefined): void {
	const next = { ...readConfig() };
	if (spec) next.investigationModel = spec;
	else delete next.investigationModel;
	configCache = next;
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
}

export function specOf(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

/** Exact `provider/id`, then exact id, then a substring match over provider, id, and name. */
export function searchModels(ctx: ExtensionContext, text: string): Model<any>[] {
	const query = text.trim().toLowerCase();
	if (!query) return [];
	const models = ctx.modelRegistry.getAll();
	const exact = models.find((model) => specOf(model).toLowerCase() === query);
	if (exact) return [exact];
	const byId = models.filter((model) => model.id.toLowerCase() === query);
	if (byId.length > 0) return byId;
	return models.filter((model) => `${specOf(model)} ${model.name}`.toLowerCase().includes(query));
}

/** Cheap first: what an investigation costs is the point of this setting. */
export function choices(ctx: ExtensionContext): Model<any>[] {
	const inputCost = (model: Model<any>) => model.cost?.input ?? Number.POSITIVE_INFINITY;
	return [...ctx.modelRegistry.getAvailable()].sort(
		(a, b) => inputCost(a) - inputCost(b) || specOf(a).localeCompare(specOf(b)),
	);
}

export function costLabel(model: Model<any>): string {
	const cost = model.cost;
	if (!cost || cost.input === undefined || cost.output === undefined) return "";
	return `$${cost.input}/$${cost.output} per M`;
}

export function lookupModel(ctx: ExtensionContext, spec: string): Model<any> | undefined {
	const slash = spec.indexOf("/");
	if (slash === -1) return undefined;
	return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

function usable(ctx: ExtensionContext, model: Model<any>): boolean {
	const inScope =
		ctx.scopedModels.length === 0 ||
		ctx.scopedModels.some((scoped) => scoped.model.provider === model.provider && scoped.model.id === model.id);
	return inScope && ctx.modelRegistry.hasConfiguredAuth(model);
}

/**
 * Explicit request, `/watch model`, PI_WATCH_INVESTIGATION_MODEL, the cheap default, the parent's
 * model. The fallbacks matter: the default provider is useless to anyone who has not configured it.
 */
export function resolveInvestigationModel(ctx: ExtensionContext, requested?: string): string | undefined {
	if (requested) return requested;
	const configured = configuredModel();
	if (configured) return configured;
	const fromEnv = process.env.PI_WATCH_INVESTIGATION_MODEL?.trim();
	if (fromEnv) return fromEnv;
	const preferred = lookupModel(ctx, PREFERRED_INVESTIGATION_MODEL);
	return preferred && usable(ctx, preferred) ? PREFERRED_INVESTIGATION_MODEL : undefined;
}

/** One line for `/watch`: the effective model and where it came from. */
export function describeInvestigationModel(ctx: ExtensionContext): string {
	const configured = configuredModel();
	const fromEnv = process.env.PI_WATCH_INVESTIGATION_MODEL?.trim();
	const preferred = lookupModel(ctx, PREFERRED_INVESTIGATION_MODEL);
	const defaultUsable = Boolean(preferred && usable(ctx, preferred));

	if (configured) return `investigation model: ${configured} (set by /watch model)`;
	if (fromEnv) return `investigation model: ${fromEnv} (from PI_WATCH_INVESTIGATION_MODEL)`;
	if (preferred && defaultUsable) return `investigation model: ${PREFERRED_INVESTIGATION_MODEL} (default)`;
	return "investigation model: the parent's model (no cheap default available)";
}
