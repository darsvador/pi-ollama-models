/**
 * pi-ollama-models — discover local Ollama models and register them as a live Pi provider.
 *
 * Data sources:
 *  - GET  {baseUrl}/api/tags   → model list (name, size, parameter_size, quantization_level)
 *  - POST {baseUrl}/api/show   → per-model capabilities (vision/tools/thinking),
 *                                context_length from model_info, and num_ctx overrides
 *
 * The chat traffic itself goes through Ollama's OpenAI-compatible endpoint
 * ({baseUrl}/v1, api: "openai-completions"), which Pi already supports natively.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants & config
// ---------------------------------------------------------------------------

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = process.env.PI_OLLAMA_MODELS_CONFIG || join(AGENT_DIR, "ollama-models.json");
const CACHE_PATH = join(AGENT_DIR, "ollama-models-cache.json");

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_CLOUD_CATALOG_URL = "https://ollama.com/api/tags";
const DEFAULT_PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama"; // dummy — Ollama ignores it, but Pi wants a resolved key
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SHOW_CONCURRENCY = 6;
const DEFAULT_MAX_TOKENS_CAP = 32_768;
const DEFAULT_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FALLBACK_CONTEXT_WINDOW = 4096; // Ollama's documented default when nothing is reported

interface ModelOverrides {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
	enabled?: boolean;
}

interface OllamaModelsConfig {
	/** Ollama server root (no /v1 suffix). */
	baseUrl?: string;
	/** Pi provider id to register. */
	providerId?: string;
	/** Display name in Pi UI. */
	name?: string;
	/** Provider API type; Ollama speaks OpenAI Chat Completions. */
	api?: "openai-completions";
	/** Dummy or real key forwarded to Pi; defaults to "ollama". */
	apiKey?: string;
	/** Call POST /api/show per model for capabilities + context length. Default true. */
	show?: boolean;
	/** Parallel /api/show requests. */
	showConcurrency?: number;
	/**
	 * Merge the full cloud catalog from ollama.com (local /api/tags only lists cloud
	 * models that have been pulled/used). Catalog entries are registered as
	 * `{name}:cloud` — verified to route to the right remote variant. Default true.
	 */
	cloudCatalog?: boolean;
	/** Cloud catalog URL. Default https://ollama.com/api/tags. */
	cloudCatalogUrl?: string;
	/**
	 * Cap on the context window when the server/Modelfile report nothing usable:
	 *  - "auto" (default): use the smallest of the available reported values
	 *    (num_ctx, tags context_length, GGUF context_length), falling back to
	 *    defaultContextWindow
	 *  - number: fixed value
	 */
	contextWindow?: number | "auto";
	/** Fallback context window when nothing is reported. Default 4096 (Ollama's documented default). */
	defaultContextWindow?: number;
	/** Max output tokens; defaults to min(contextWindow, 32768). Sent as max_tokens → num_predict. */
	maxTokens?: number;
	/**
	 * Catalog freshness threshold: auto-refresh only when the last successful fetch
	 * is older than this. Manual /ollama-refresh always fetches. Default 7 days.
	 */
	refreshAfterMs?: number;
	/** Append parameter size / quantization to the display name. Default true. */
	annotateName?: boolean;
	/** Include embedding models. Default false. */
	includeEmbeddings?: boolean;
	includePatterns?: string[];
	excludePatterns?: string[];
	/** Model filters (glob/regex/field rules, pi-live-models compatible semantics). */
	filters?: FilterSpec;
	/** Reusable named filter specs, referenced via `filters.use`. */
	presets?: Record<string, FilterSpec>;
	/** Global blacklist-only filters, unioned with every exclude rule. */
	defaultFilters?: FilterSpec;
	defaults?: ModelOverrides;
	modelOverrides?: Record<string, ModelOverrides>;
}

/**
 * Filter spec, semantics pinned to match pi-live-models:
 *  - no rules configured → everything passes
 *  - exclude (any rule) always wins
 *  - any include rule present → whitelist: id must hit ≥1 include/includeRegex
 *    pattern AND every includeBy field
 *  - globs are case-insensitive, regexes case-sensitive; invalid regex is
 *    warned about and ignored
 *  - field rules (`*By`) take dotted paths into the /api/tags item (e.g.
 *    `capabilities`, `details.parameter_size`); strings match
 *    case-insensitive globs, arrays match if any element hits, missing /
 *    non-string fields never match excludes and always fail includes
 */
interface FilterSpec {
	/** Glob whitelist on model id. */
	include?: string[];
	/** Glob blacklist on model id. */
	exclude?: string[];
	/** Regex whitelist on model id (case-sensitive). */
	includeRegex?: string[];
	/** Regex blacklist on model id (case-sensitive). */
	excludeRegex?: string[];
	/** Field whitelist: dotted path → globs; a model must match every listed field. */
	includeBy?: Record<string, string[]>;
	/** Field blacklist: dotted path → globs; any hit drops the model. */
	excludeBy?: Record<string, string[]>;
	/** Named presets (from `presets`) to union into this spec. */
	use?: string[];
}

interface CompiledFilters {
	includeGlobs: RegExp[];
	excludeGlobs: RegExp[];
	includeRegexes: RegExp[];
	excludeRegexes: RegExp[];
	includeBy: Array<{ path: string; patterns: RegExp[] }>;
	excludeBy: Array<{ path: string; patterns: RegExp[] }>;
	hasInclude: boolean;
	summary: string[];
}

interface OllamaTagsItem {
	name?: string;
	model?: string;
	size?: number;
	// Newer Ollama versions expose these directly in /api/tags:
	capabilities?: string[];
	context_length?: number;
	details?: {
		parent_model?: string;
		format?: string;
		family?: string;
		families?: string[];
		parameter_size?: string;
		quantization_level?: string;
		context_length?: number;
	};
}

interface OllamaShowResult {
	capabilities?: string[];
	parameters?: string;
	modelfile?: string;
	/** e.g. { values: ["low","high","max"] or [false,"low","high","max"], default: "max" } */
	thinking?: { values?: (string | boolean)[]; default?: string };
	details?: OllamaTagsItem["details"];
	model_info?: Record<string, unknown>;
}

interface ChatModelDef {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Maps pi thinking levels → Ollama reasoning_effort values; null = unsupported. */
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}

interface RefreshSummary {
	baseUrl: string;
	modelsUrl: string;
	providerId: string;
	modelCount: number;
	models: ChatModelDef[];
	fromCache: boolean;
	/** Epoch ms of the last successful network fetch (when known). */
	fetchedAt?: number;
	/** Items seen before filtering (local + cloud catalog). */
	rawCount?: number;
	/** Compiled filter summary lines (empty when no filters configured). */
	filterSummary?: string[];
	errors: string[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function trimSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	const escaped = escapeRegExp(pattern).replace(/\\\*/g, ".*").replace(/\\\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

async function fetchJson(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<unknown> {
	const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
	const response = await fetch(url, {
		...rest,
		headers: { Accept: "application/json", ...(rest.headers ?? {}) },
		signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		let body = "";
		try {
			body = (await response.text()).slice(0, 200);
		} catch {
			// ignore body read errors
		}
		throw new Error(`HTTP ${response.status} from ${url}${body ? `: ${body}` : ""}`);
	}
	return response.json();
}

/** Run an async mapper over items with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Ollama response parsing
// ---------------------------------------------------------------------------

function parseShow(show: OllamaShowResult): {
	capabilities: string[];
	ggufContextLength?: number;
	numCtx?: number;
	thinkingValues?: (string | boolean)[];
} {
	const capabilities = Array.isArray(show.capabilities) ? show.capabilities.map(String) : [];

	// GGUF metadata, e.g. "qwen2.context_length": 32768 / "llama.context_length": 8192
	let ggufContextLength: number | undefined;
	if (isRecord(show.model_info)) {
		for (const [key, value] of Object.entries(show.model_info)) {
			if (key.endsWith(".context_length") && typeof value === "number") {
				ggufContextLength = value;
			}
		}
	}

	// num_ctx set in the Modelfile or via `parameters` — this is what Ollama actually enforces.
	let numCtx: number | undefined;
	const parameterTexts = [show.parameters, show.modelfile].filter(
		(value): value is string => typeof value === "string",
	);
	for (const text of parameterTexts) {
		for (const line of text.split("\n")) {
			const match = line.match(/^\s*(?:PARAMETER\s+)?num_ctx\s+(\d+)\s*$/);
			if (match) numCtx = Number(match[1]);
		}
	}

	return { capabilities, ggufContextLength, numCtx, thinkingValues: show.thinking?.values };
}

/**
 * Map pi thinking levels onto the values /api/show reports for the model
 * (`thinking.values`, e.g. ["low", "high", "max"]; some models also list the
 * boolean `false` meaning a plain on/off switch). Ollama's OpenAI endpoint
 * accepts `reasoning_effort` with model-defined names (including native
 * "xhigh" when the model reports it), plus "none" to disable.
 */
function buildThinkingLevelMap(values: (string | boolean)[] | undefined): Record<string, string | null> | undefined {
	if (!values || values.length === 0) return undefined;
	const supported = values
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.toLowerCase());
	if (supported.length === 0) return undefined;
	// pi level → the strongest supported value that is not stronger than it.
	const order = ["low", "medium", "high", "xhigh", "max"];
	const pickFor = (level: string): string | null => {
		const ceiling = order.indexOf(level);
		for (let index = ceiling; index >= 0; index--) {
			if (supported.includes(order[index])) return order[index];
		}
		return null;
	};
	const map: Record<string, string | null> = { off: "none" };
	for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		map[level] = pickFor(level === "minimal" ? "low" : level);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Filters (pi-live-models compatible semantics)
// ---------------------------------------------------------------------------

const warnedRegexPatterns = new Set<string>();

function compileRegex(pattern: string, label: string): RegExp | undefined {
	try {
		return new RegExp(pattern);
	} catch {
		if (!warnedRegexPatterns.has(pattern)) {
			warnedRegexPatterns.add(pattern);
			console.warn(`[pi-ollama-models] invalid regex in ${label}: ${JSON.stringify(pattern)} — ignored`);
		}
		return undefined;
	}
}

function compileFilters(config: OllamaModelsConfig): CompiledFilters {
	const include: string[] = [];
	const exclude: string[] = [];
	const includeRegex: string[] = [];
	const excludeRegex: string[] = [];
	const includeBy = new Map<string, string[]>();
	const excludeBy = new Map<string, string[]>();
	const summary: string[] = [];

	const unionStrings = (target: Map<string, string[]> | undefined, key: string, values?: string[]) => {
		if (!target || !values) return;
		const merged = new Set(target.get(key) ?? []);
		for (const value of values) if (value) merged.add(value);
		target.set(key, [...merged]);
	};

	const mergeSpec = (spec: FilterSpec | undefined, label: string, blacklistOnly = false): void => {
		if (!spec) return;
		if (blacklistOnly) {
			const includeFields = ["include", "includeRegex", "includeBy", "use"].filter(
				(key) => (spec as Record<string, unknown>)[key] !== undefined,
			);
			if (includeFields.length > 0) {
				console.warn(
					`[pi-ollama-models] ${label} ignores include-type fields (got: ${includeFields.join(", ")}) — global filters are blacklists only`,
				);
			}
		}
		for (const pattern of spec.include ?? []) if (pattern) include.push(pattern);
		for (const pattern of spec.exclude ?? []) if (pattern) exclude.push(pattern);
		for (const pattern of spec.includeRegex ?? []) if (pattern) includeRegex.push(pattern);
		for (const pattern of spec.excludeRegex ?? []) if (pattern) excludeRegex.push(pattern);
		for (const [path, patterns] of Object.entries(spec.includeBy ?? {})) unionStrings(includeBy, path, patterns);
		for (const [path, patterns] of Object.entries(spec.excludeBy ?? {})) unionStrings(excludeBy, path, patterns);	};

	// Expand presets referenced by filters.use, then the spec itself.
	const spec = config.filters;
	for (const presetName of spec?.use ?? []) {
		const preset = config.presets?.[presetName];
		if (!preset) {
			console.warn(`[pi-ollama-models] filters.use references unknown preset "${presetName}" — ignored`);
			continue;
		}
		mergeSpec(preset, `preset:${presetName}`);
	}
	if (spec?.use?.length) summary.push(`presets: ${spec.use.join(", ")}`);
	mergeSpec(spec, "filters");
	// Legacy top-level patterns stay supported and union into the same lists.
	if (config.includePatterns?.length) mergeSpec({ include: config.includePatterns }, "includePatterns");
	if (config.excludePatterns?.length) mergeSpec({ exclude: config.excludePatterns }, "excludePatterns");
	mergeSpec(config.defaultFilters, "defaultFilters", true);

	// Backwards-compatible default: drop embedding models unless the user configures
	// any exclude rule of their own (then they take full control).
	if (exclude.length === 0 && excludeRegex.length === 0 && excludeBy.size === 0) {
		exclude.push("*embed*");
		summary.push("default exclude: *embed* (configure any exclude rule to take over)");
	}

	const compiled: CompiledFilters = {
		includeGlobs: include.map((pattern) => globToRegExp(pattern)),
		excludeGlobs: exclude.map((pattern) => globToRegExp(pattern)),
		includeRegexes: includeRegex
			.map((pattern) => compileRegex(pattern, "filters.includeRegex"))
			.filter((regex): regex is RegExp => regex !== undefined),
		excludeRegexes: excludeRegex
			.map((pattern) => compileRegex(pattern, "filters.excludeRegex"))
			.filter((regex): regex is RegExp => regex !== undefined),
		includeBy: [...includeBy].map(([path, patterns]) => ({
			path,
			patterns: patterns.map((pattern) => globToRegExp(pattern)),
		})),
		excludeBy: [...excludeBy].map(([path, patterns]) => ({
			path,
			patterns: patterns.map((pattern) => globToRegExp(pattern)),
		})),
		hasInclude: false,
		summary,
	};
	compiled.hasInclude =
		compiled.includeGlobs.length > 0 ||
		compiled.includeRegexes.length > 0 ||
		compiled.includeBy.length > 0;

	if (compiled.includeGlobs.length) summary.push(`include: ${include.join(", ")}`);
	if (compiled.excludeGlobs.length) summary.push(`exclude: ${exclude.join(", ")}`);
	if (compiled.includeRegexes.length) summary.push(`includeRegex: ${includeRegex.join(", ")}`);
	if (compiled.excludeRegexes.length) summary.push(`excludeRegex: ${excludeRegex.join(", ")}`);
	if (compiled.includeBy.length) {
		summary.push(`includeBy: ${compiled.includeBy.map((rule) => rule.path).join(", ")}`);
	}
	if (compiled.excludeBy.length) {
		summary.push(`excludeBy: ${compiled.excludeBy.map((rule) => rule.path).join(", ")}`);
	}
	return compiled;
}

/** Dotted-path lookup into the /api/tags item (plus merged capabilities). */
function lookupPath(record: Record<string, unknown>, path: string): unknown {
	let current: unknown = record;
	for (const segment of path.split(".")) {
		if (!isRecord(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function fieldMatches(value: unknown, patterns: RegExp[]): boolean {
	if (typeof value === "string") return patterns.some((pattern) => pattern.test(value));
	if (Array.isArray(value)) {
		return value.some(
			(element) => typeof element === "string" && patterns.some((pattern) => pattern.test(element)),
		);
	}
	return false;
}

/**
 * Returns a drop reason when the model should be filtered out, undefined to keep.
 * Exclude always wins; a non-empty include set acts as a whitelist.
 */
function filterDropReason(id: string, target: Record<string, unknown>, filters: CompiledFilters): string | undefined {
	for (const pattern of filters.excludeGlobs) {
		if (pattern.test(id)) return "exclude";
	}
	for (const pattern of filters.excludeRegexes) {
		if (pattern.test(id)) return "excludeRegex";
	}
	for (const rule of filters.excludeBy) {
		if (fieldMatches(lookupPath(target, rule.path), rule.patterns)) {
			return `excludeBy:${rule.path}`;
		}
	}
	if (filters.hasInclude) {
		const idOk =
			(filters.includeGlobs.length === 0 && filters.includeRegexes.length === 0) ||
			filters.includeGlobs.some((pattern) => pattern.test(id)) ||
			filters.includeRegexes.some((pattern) => pattern.test(id));
		if (!idOk) return "include (id not on whitelist)";
		for (const rule of filters.includeBy) {
			if (!fieldMatches(lookupPath(target, rule.path), rule.patterns)) {
				return `includeBy:${rule.path} (no match)`;
			}
		}
	}
	return undefined;
}

function buildModelDefinition(
	item: OllamaTagsItem,
	show: OllamaShowResult | undefined,
	config: OllamaModelsConfig,
	filters: CompiledFilters,
): ChatModelDef | undefined {
	const id = pickString(item.name, item.model);
	if (!id) return undefined;

	const override = config.modelOverrides?.[id];
	if (override?.enabled === false) return undefined;

	const showParsed = show ? parseShow(show) : undefined;
	// Newer Ollama versions include capabilities + context_length in /api/tags itself;
	// /api/show (when enabled) is the more complete source and wins where both exist.
	const capabilities =
		(showParsed?.capabilities?.length ? showParsed.capabilities : undefined) ??
		(Array.isArray(item.capabilities) ? item.capabilities.map(String) : []);
	if (!config.includeEmbeddings && capabilities.includes("embedding")) return undefined;
	// Classifier / decision-only entries (e.g. cloud `clef:27b`) are not chat models.
	// Only enforced when capabilities are known; capability-less legacy entries pass.
	if (
		capabilities.length > 0 &&
		!capabilities.includes("completion") &&
		!capabilities.includes("chat")
	) {
		return undefined;
	}

	// User filters: field rules see the tags item plus the merged capabilities.
	const filterTarget: Record<string, unknown> = { ...item, id, capabilities };
	const dropReason = filterDropReason(id, filterTarget, filters);
	if (dropReason) return undefined;

	const defaults = config.defaults ?? {};
	const details = isRecord(item.details) ? item.details : {};
	const families = Array.isArray(details.families) ? details.families.map(String) : [];
	const parameterSize = pickString(details.parameter_size);
	const quantization = pickString(details.quantization_level);

	// Vision: /api/show capability, or a CLIP-family vision projector in families.
	const vision =
		capabilities.includes("vision") ||
		families.some((family) => /^(clip|mllama|vision)/i.test(family));

	const reasoning =
		override?.reasoning ??
		(capabilities.includes("thinking") ||
			// Weak heuristic when /api/show is disabled or the Ollama version is old:
			/(^|[-_:])(r1|qwq|thinking|reason)/i.test(id) ||
			(defaults.reasoning ?? false));

	// Effective context: Ollama enforces num_ctx (Modelfile PARAMETER num_ctx,
	// otherwise OLLAMA_CONTEXT_LENGTH / VRAM-based defaults, capped by the model's
	// max). Take the SMALLEST reported value — overstating contextWindow makes Pi
	// skip compaction while Ollama silently shifts older history out of its buffer.
	const reportedContexts = [
		showParsed?.numCtx,
		pickNumber(item.context_length, details.context_length),
		showParsed?.ggufContextLength,
	].filter((value): value is number => typeof value === "number" && value > 0);
	const contextWindow =
		override?.contextWindow ??
		(config.contextWindow !== undefined && config.contextWindow !== "auto"
			? config.contextWindow
			: reportedContexts.length > 0
				? Math.min(...reportedContexts)
				: (config.defaultContextWindow ?? FALLBACK_CONTEXT_WINDOW));

	const maxTokens =
		override?.maxTokens ?? config.maxTokens ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS_CAP);

	const annotated =
		config.annotateName === false || (!parameterSize && !quantization)
			? undefined
			: [parameterSize, quantization].filter(Boolean).join(" ");

	const definition: ChatModelDef = {
		id,
		name: override?.name ?? (annotated ? `${id} · ${annotated}` : id),
		reasoning,
		input: override?.input ?? (vision ? ["text", "image"] : (defaults.input ?? ["text"])),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
	const thinkingLevelMap =
		reasoning && capabilities.includes("thinking")
			? buildThinkingLevelMap(showParsed?.thinkingValues)
			: undefined;
	if (thinkingLevelMap) definition.thinkingLevelMap = thinkingLevelMap;
	if (override?.compat && Object.keys(override.compat).length > 0) definition.compat = override.compat;
	return definition;
}

// ---------------------------------------------------------------------------
// Refresh pipeline
// ---------------------------------------------------------------------------

async function readConfig(): Promise<OllamaModelsConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return isRecord(parsed) ? (parsed as OllamaModelsConfig) : {};
	} catch {
		return {};
	}
}

/**
 * Per-request deadline: combine the caller's signal (pi's 15s /model picker abort)
 * with an individual timeout, so one slow request can't eat the whole budget.
 */
function requestSignal(signal: AbortSignal | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

/**
 * Map an ollama.com catalog entry to the name the local server accepts for cloud
 * models: `{catalog-name}:cloud` (verified: `gemma4:31b:cloud` routes upstream to
 * `gemma4:31b`). Entries already ending in `:cloud` pass through unchanged.
 */
function toCloudLocalItem(item: OllamaTagsItem): OllamaTagsItem | undefined {
	const name = pickString(item.name, item.model);
	if (!name) return undefined;
	const local = name.endsWith(":cloud") ? name : `${name}:cloud`;
	return { ...item, name: local, model: local };
}

/** Raw catalog state: pre-filter items + per-model /api/show results, cacheable. */
interface RawCatalog {
	items: OllamaTagsItem[];
	shows: Record<string, OllamaShowResult>;
}

/**
 * Network half of discovery: local /api/tags + cloud catalog merge + per-model
 * /api/show. Returns raw data only — filtering/building happens in buildFromRaw
 * so cached raw data can be re-filtered with current config without network.
 */
async function fetchCatalog(
	config: OllamaModelsConfig,
	signal?: AbortSignal,
): Promise<RawCatalog> {
	const baseUrl = trimSlashes(config.baseUrl?.trim() || DEFAULT_BASE_URL);
	const tags = (await fetchJson(`${baseUrl}/api/tags`, { signal: requestSignal(signal) })) as {
		models?: OllamaTagsItem[];
	};
	const items = Array.isArray(tags?.models) ? tags.models : [];
	// Merge the full cloud catalog — the local /api/tags only lists cloud models
	// that have been pulled/used, while ollama.com lists everything available.
	if (config.cloudCatalog !== false) {
		const cloudUrl = config.cloudCatalogUrl?.trim() || DEFAULT_CLOUD_CATALOG_URL;
		try {
			const remote = (await fetchJson(cloudUrl, {
				signal: requestSignal(signal, 15_000),
			})) as { models?: OllamaTagsItem[] };
			const localNames = new Set(
				items.map((item) => pickString(item.name, item.model)).filter((name): name is string => Boolean(name)),
			);
			const cloudItems = (Array.isArray(remote?.models) ? remote.models : [])
				.map(toCloudLocalItem)
				.filter((item): item is OllamaTagsItem => item !== undefined && !localNames.has(item.name!));
			items.push(...cloudItems);
		} catch (error) {
			if (signal?.aborted) throw error;
			console.error(
				`[pi-ollama-models] cloud catalog (${cloudUrl}) unavailable, local models only: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	const shows: Record<string, OllamaShowResult> = {};
	if (config.show !== false && items.length > 0) {
		const results = await mapLimit(items, config.showConcurrency ?? DEFAULT_SHOW_CONCURRENCY, async (item) => {
			const id = pickString(item.name, item.model);
			if (!id) return undefined;
			try {
				return [
					id,
					(await fetchJson(`${baseUrl}/api/show`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: id }),
						signal: requestSignal(signal),
					})) as OllamaShowResult,
				] as const;
			} catch (error) {
				if (signal?.aborted) throw error;
				// A single failed /api/show must not drop the model — fall back to tags-only metadata.
				console.error(`[pi-ollama-models] /api/show failed for ${id}: ${error instanceof Error ? error.message : error}`);
				return undefined;
			}
		});
		for (const entry of results) {
			if (entry) shows[entry[0]] = entry[1];
		}
	}

	return { items, shows };
}

/**
 * Build the model list from raw catalog data with the CURRENT config — filters,
 * overrides and defaults are re-applied every time, so config edits take effect
 * even when serving from a fresh cache without any network access.
 */
function buildFromRaw(
	config: OllamaModelsConfig,
	raw: RawCatalog,
): { models: ChatModelDef[]; filterSummary: string[] } {
	const filters = compileFilters(config);
	const models = raw.items
		.map((item) => {
			const id = pickString(item.name, item.model);
			return buildModelDefinition(item, id ? raw.shows[id] : undefined, config, filters);
		})
		.filter((model): model is ChatModelDef => model !== undefined);
	return { models, filterSummary: filters.summary };
}

async function writeCache(payload: {
	providerId: string;
	baseUrl: string;
	raw: RawCatalog;
	models: ChatModelDef[];
}): Promise<void> {
	try {
		await mkdir(dirname(CACHE_PATH), { recursive: true });
		const cachePayload = {
			version: 2,
			savedAt: new Date().toISOString(),
			providerId: payload.providerId,
			baseUrl: payload.baseUrl,
			raw: payload.raw,
			models: payload.models,
		};
		const tmp = `${CACHE_PATH}.tmp`;
		await writeFile(tmp, `${JSON.stringify(cachePayload, null, 2)}\n`, "utf8");
		await rename(tmp, CACHE_PATH);
	} catch (error) {
		console.error(`[pi-ollama-models] failed to write cache: ${error instanceof Error ? error.message : error}`);
	}
}

async function readCache(): Promise<
	{ providerId: string; savedAt: string; raw?: RawCatalog; models: ChatModelDef[] } | undefined
> {
	try {
		const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8")) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.models)) return undefined;
		// v2 caches carry raw items; v1 caches (filtered models only) degrade to
		// using the stored list as-is until the next successful fetch upgrades them.
		const rawRecord = isRecord(parsed.raw) ? parsed.raw : undefined;
		const raw: RawCatalog | undefined =
			rawRecord && Array.isArray(rawRecord.items) && isRecord(rawRecord.shows)
				? {
						items: rawRecord.items as OllamaTagsItem[],
						shows: rawRecord.shows as Record<string, OllamaShowResult>,
					}
				: undefined;
		return {
			providerId: typeof parsed.providerId === "string" ? parsed.providerId : DEFAULT_PROVIDER_ID,
			savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
			raw,
			models: (parsed.models as unknown[]).filter(
				(model): model is ChatModelDef =>
					isRecord(model) && typeof model.id === "string" && typeof model.contextWindow === "number",
			),
		};
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/** Minimal structural view of pi's RefreshModelsContext (from @earendil-works/pi-ai). */
interface RefreshContextLike {
	allowNetwork: boolean;
	force?: boolean;
	signal: AbortSignal;
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let config: OllamaModelsConfig = {};
	let currentProviderId: string | undefined;
	let lastSummary: RefreshSummary | undefined;
	let currentModels: ChatModelDef[] = [];
	let lastFetchAt = 0;
	let inflight: Promise<ChatModelDef[]> | null = null;

	/** Fresh = last successful fetch within the configured threshold (default 7 days). */
	const isFresh = (): boolean => {
		if (lastFetchAt <= 0) return false;
		return Date.now() - lastFetchAt < (config.refreshAfterMs ?? DEFAULT_REFRESH_AFTER_MS);
	};

	const registerModels = (providerId: string, models: ChatModelDef[], baseUrl: string): void => {
		currentModels = models;
		// refreshModels is pi's hook for live catalogs: the /model picker calls it on
		// every open (with a 15s timeout + abort signal), as do interactive startup
		// and /login. Within the freshness threshold it serves the cached list —
		// only an expired catalog (or context.force) triggers a network refresh.
		const refreshModels = async (context: RefreshContextLike): Promise<ChatModelDef[]> => {
			// Restore phase (allowNetwork: false): serve the in-memory list as-is.
			if (!context.allowNetwork) return currentModels;
			if (context.signal.aborted) return currentModels;
			if (!context.force && isFresh()) return currentModels;
			const models = await getLive(context.signal);
			return models;
		};
		pi.registerProvider(providerId, {
			name: config.name ?? "Ollama",
			baseUrl: `${baseUrl}/v1`,
			apiKey: config.apiKey ?? DEFAULT_API_KEY,
			api: config.api ?? "openai-completions",
			models: models as never,
			refreshModels: refreshModels as never,
		});
		if (currentProviderId && currentProviderId !== providerId) {
			pi.unregisterProvider(currentProviderId);
		}
		currentProviderId = providerId;
	};

	const summaryShell = (): RefreshSummary => {
		const baseUrl = trimSlashes(config.baseUrl?.trim() || DEFAULT_BASE_URL);
		return {
			baseUrl,
			modelsUrl: `${baseUrl}/api/tags`,
			providerId: config.providerId?.trim() || DEFAULT_PROVIDER_ID,
			modelCount: 0,
			models: [],
			fromCache: false,
			errors: [],
		};
	};

	/**
	 * Rebuild the in-memory catalog from raw catalog data with the CURRENT config
	 * (filters, overrides, defaults re-applied) — no network involved.
	 */
	const rebuildFromRaw = (raw: RawCatalog, savedAt: number): RefreshSummary => {
		const built = buildFromRaw(config, raw);
		return {
			...summaryShell(),
			modelCount: built.models.length,
			models: built.models,
			fromCache: true,
			fetchedAt: savedAt,
			rawCount: raw.items.length,
			filterSummary: built.filterSummary,
			errors: [],
		};
	};

	/**
	 * Fetch a fresh catalog with in-flight dedup (pi may call refreshModels twice
	 * per refresh cycle and from several UI paths). Throws on failure so pi keeps
	 * the previously published list and surfaces the error in the /model picker.
	 */
	const getLive = (signal?: AbortSignal): Promise<ChatModelDef[]> => {
		if (inflight) return inflight;
		inflight = (async () => {
			try {
				// Per-request timeouts live inside fetchCatalog(); here we only thread the
				// caller's abort signal (pi's /model picker aborts after ~15s).
				const raw = await fetchCatalog(config, signal);
				const built = buildFromRaw(config, raw);
				if (built.models.length === 0) {
					throw new Error(
						`0 models after discovery${raw.items.length > 0 ? ` (${raw.items.length} raw items, all dropped by filters/embedding rules)` : " (is anything pulled? `ollama pull <model>`)"}`,
					);
				}
				currentModels = built.models;
				lastFetchAt = Date.now();
				lastSummary = {
					...summaryShell(),
					modelCount: built.models.length,
					models: built.models,
					fromCache: false,
					fetchedAt: lastFetchAt,
					rawCount: raw.items.length,
					filterSummary: built.filterSummary,
					errors: [],
				};
				await writeCache({
					providerId: lastSummary.providerId,
					baseUrl: lastSummary.baseUrl,
					raw,
					models: built.models,
				});
				return built.models;
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	};

	let currentRaw: RawCatalog | undefined;

	const refresh = async (ctx?: ExtensionContext, force = false): Promise<RefreshSummary> => {
		config = await readConfig();
		const providerId = config.providerId?.trim() || DEFAULT_PROVIDER_ID;
		const baseUrl = trimSlashes(config.baseUrl?.trim() || DEFAULT_BASE_URL);
		const summary = summaryShell();

		// Seed in-memory state from the disk cache on the first run of a session.
		if (currentModels.length === 0) {
			const cached = await readCache();
			if (cached && ((cached.raw?.items.length ?? 0) > 0 || cached.models.length > 0)) {
				lastFetchAt = cached.savedAt ? Date.parse(cached.savedAt) || 0 : 0;
				if (cached.raw && cached.raw.items.length > 0) {
					// v2 cache: raw items — rebuild with the CURRENT config so filters,
					// overrides and defaults always reflect the latest settings.
					currentRaw = cached.raw;
					const rebuilt = rebuildFromRaw(cached.raw, lastFetchAt);
					currentModels = rebuilt.models;
					Object.assign(summary, rebuilt, { errors: [] });
				} else {
					// v1 cache: filtered models only — used as-is until the next fetch.
					currentModels = cached.models;
				}
			}
		}

		if (!force && isFresh() && currentModels.length > 0) {
			// Catalog still fresh — rebuild from raw (re-applying current filters /
			// overrides) without touching the network.
			if (currentRaw && currentRaw.items.length > 0) {
				const rebuilt = rebuildFromRaw(currentRaw, lastFetchAt);
				currentModels = rebuilt.models;
				Object.assign(summary, rebuilt, { errors: [] });
			} else {
				summary.models = currentModels;
				summary.modelCount = currentModels.length;
				summary.fromCache = true;
				summary.fetchedAt = lastFetchAt;
			}
			registerModels(providerId, currentModels, baseUrl);
		} else {
			try {
				const models = await getLive(undefined);
				Object.assign(summary, lastSummary ?? {}, { models, modelCount: models.length, errors: [] });
				registerModels(providerId, models, baseUrl);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				summary.errors.push(message);
				// Fall back to the last-good list so /model is not empty after a restart.
				if (currentModels.length > 0) {
					summary.models = currentModels;
					summary.modelCount = currentModels.length;
					summary.fromCache = true;
					registerModels(providerId, currentModels, baseUrl);
					summary.errors.push(`served ${currentModels.length} models from the last-good list / offline cache (${CACHE_PATH})`);
				}
			}
		}

		if (ctx?.hasUI) {
			ctx.ui.setStatus(
				"ollama-models",
				summary.modelCount > 0
					? `ollama: ${summary.modelCount} model${summary.modelCount === 1 ? "" : "s"}${summary.fromCache ? " (cached)" : ""}`
					: undefined,
			);
			for (const message of summary.errors) {
				ctx.ui.notify(`pi-ollama-models: ${message}`, "warning");
			}
		}
		lastSummary = summary;
		return summary;
	};

	await refresh();

	pi.on("session_start", async (_event, ctx) => {
		await refresh(ctx);
	});

	pi.registerCommand("ollama-refresh", {
		description: "Force-refresh the Ollama model catalog (bypasses the freshness threshold)",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const summary = await refresh(ctx, true);
			if (ctx.hasUI) {
				ctx.ui.notify(
					summary.modelCount > 0
						? `ollama-models: registered ${summary.modelCount} model${summary.modelCount === 1 ? "" : "s"} from ${summary.modelsUrl}${summary.fromCache ? " (from cache)" : ""}`
						: `ollama-models: no models registered${summary.errors.length > 0 ? ` — ${summary.errors[0]}` : ""}`,
					summary.modelCount > 0 ? "info" : "warning",
				);
			}
		},
	});

	pi.registerCommand("ollama-status", {
		description: "Show discovered Ollama models and their metadata",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const lines: string[] = [];
			if (!lastSummary) {
				lines.push("No discovery run yet — try /ollama-refresh.");
			} else {
				lines.push(`Ollama: ${lastSummary.baseUrl}`, `Models endpoint: ${lastSummary.modelsUrl}`);
				if (lastSummary.fetchedAt) {
					const ageMs = Date.now() - lastSummary.fetchedAt;
					const age = ageMs < 3600_000
						? `${Math.max(1, Math.round(ageMs / 60_000))} min`
						: ageMs < 86_400_000
							? `${Math.round(ageMs / 3_600_000)} h`
							: `${(ageMs / 86_400_000).toFixed(1)} d`;
					lines.push(`Catalog age: ${age} (auto-refresh after ${((config.refreshAfterMs ?? DEFAULT_REFRESH_AFTER_MS) / 86_400_000).toFixed(1)} days, /ollama-refresh to force)`);
				}
				if (lastSummary.rawCount !== undefined) {
					lines.push(`Models: ${lastSummary.modelCount} kept of ${lastSummary.rawCount} raw`);
				}
				if (lastSummary.filterSummary && lastSummary.filterSummary.length > 0) {
					lines.push("Filters:", ...lastSummary.filterSummary.map((line) => `  ${line}`));
				}
				if (lastSummary.fromCache) lines.push("(showing offline-cached data)");
				if (lastSummary.models.length === 0) {
					lines.push("No models discovered.");
				} else {
					for (const model of lastSummary.models) {
						const levels = model.thinkingLevelMap
							? Object.entries(model.thinkingLevelMap)
									.filter(([, value]) => value !== null)
									.map(([level, value]) => (level === value ? level : `${level}→${value}`))
									.join("/")
							: undefined;
						lines.push(
							`- ${model.id}`,
							`    input: ${model.input.join(", ")} | reasoning: ${model.reasoning} | ctx: ${model.contextWindow.toLocaleString()} | max out: ${model.maxTokens.toLocaleString()}${levels ? ` | thinking: ${levels}` : ""}`,
						);
					}
				}
				for (const error of lastSummary.errors) lines.push(`Warning: ${error}`);
				lines.push(`Config: ${CONFIG_PATH} (Ollama server default ${DEFAULT_BASE_URL})`);
			}
			const text = lines.join("\n");
			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});

	pi.registerCommand("ollama-reload", {
		description: "Reload ~/.pi/agent/ollama-models.json and force-refresh",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			await refresh(ctx, true);
			if (ctx.hasUI) ctx.ui.notify("ollama-models: config reloaded", "info");
		},
	});
}

// Re-exported for tests / smoke scripts.
export const __internals__ = {
	buildModelDefinition,
	parseShow,
	CACHE_PATH,
	CONFIG_PATH,
};