/**
 * omp-aihub — metranet AI hub (aihub.metranet.co.id, new-api) provider for omp AND pi.
 *
 * One source, two hosts: no host imports; the plugin detects its host at runtime
 * and calls the matching registration surface.
 *
 *   omp: fetchDynamicModels + usage (UsageProvider) + oauth returning string|object
 *   pi:  refreshModels + oauth returning OAuthCredentials; usage not rendered
 *
 * Data sources:
 *   /v1/models   roster + supported_endpoint_types (auth: API key)
 *   /api/pricing public: model_ratio/completion_ratio/cache_ratio/
 *                create_cache_ratio, context_length, max_output_tokens,
 *                modalities, capabilities, group_ratio
 *   /v1/dashboard/billing/*, /api/usage/token/, /api/log/token → usage
 *
 * Pricing: ratio × $2/M (verified vs official model prices) × group_ratio.
 * Models without context_length fall back to the bundled catalog reference of
 * the same id, then generic defaults (user-requested reference fill).
 *
 * Auto-update: omp refreshes fetchDynamicModels through its model cache
 * (default 24 h TTL); pi calls refreshModels on catalog refresh. /aihub-refresh
 * forces an immediate refresh.
 */

// Runtime globals (Bun/omp host) — keeps the plugin dependency-free.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

const PROVIDER_ID = "aihub";
const DEFAULT_BASE = "https://aihub.metranet.co.id";
/** Visible label (pi provider name). */
const PROVIDER_NAME = "metranet AI hub (aihub)";
/** new-api quota → USD: quota_per_unit quota = $1 (live-verified: 500000). */
const QUOTA_PER_UNIT = 500_000;
/** Ratio → USD/M base: model_ratio 1 = $2/M input (verified vs official cards). */
const RATIO_USD_PER_M = 2;
const FETCH_TIMEOUT_MS = 15_000;
/** Gateway-wide group ratio when /api/pricing omits group_ratio. */
const DEFAULT_GROUP_RATIO = 0.9;

// ---------------------------------------------------------------- gateway types

interface NewApiPricingRow {
	model_name: string;
	quota_type: number; // 0 = per-token, 1 = per-call
	model_ratio?: number;
	completion_ratio?: number;
	cache_ratio?: number;
	create_cache_ratio?: number;
	/** tiered_expr models: real price lives here; model_ratio is junk there. */
	billing_expr?: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	capabilities?: string[];
	supported_endpoint_types?: string[];
}

interface NewApiPricing {
	success?: boolean;
	message?: string;
	data?: NewApiPricingRow[];
	group_ratio?: Record<string, number>;
}

interface V1Model {
	id: string;
	supported_endpoint_types?: string[];
}

interface TokenUsage {
	total_granted?: number;
	total_used?: number;
	total_available?: number;
	unlimited_quota?: boolean;
	name?: string;
}

interface BillingSub {
	hard_limit_usd?: number;
}

interface LogRow {
	type?: number;
	model_name?: string;
	prompt_tokens?: number;
	completion_tokens?: number;
	quota?: number;
	/** JSON blob with the actual billing ratios (model_ratio, group_ratio, …). */
	other?: string;
}

/** Ratios actually charged to this key, learned from /api/log/token rows. */
interface LearnedPricing {
	mode: "ratio" | "expr";
	modelRatio?: number;
	completionRatio?: number;
	cacheRatio?: number;
	/** Actual group ratio billed to this key (may differ from the public catalog). */
	groupRatio: number;
	/** Context the channel verifiably served (live probe) — outranks catalog/borrowed values. */
	contextWindow?: number;
	at: number;
}

const LEARNED_PATH =
	process.env.AIHUB_LEARNED_PATH ?? `${process.env.HOME ?? "~"}/.omp/agent/aihub-pricing-learned.json`;
/** Node fs via runtime require; the bare `require` declaration types as unknown. */
const fs = require("fs") as {
	readFileSync: (path: string, encoding: string) => string;
	writeFileSync: (path: string, data: string) => void;
};

function loadLearned(): Map<string, LearnedPricing> {
	const out = new Map<string, LearnedPricing>();
	try {
		const parsed = JSON.parse(fs.readFileSync(LEARNED_PATH, "utf8")) as {
			learned?: Record<string, LearnedPricing>;
		};
		for (const [id, entry] of Object.entries(parsed.learned ?? {})) {
			if (entry && typeof entry.groupRatio === "number") out.set(id, entry);
		}
	} catch {
		// No store yet / unreadable → estimates only.
	}
	return out;
}

/** Persist the learned store (created by learnFromLogs / learnFromProbe). */
function saveLearned(learned: Map<string, LearnedPricing>): void {
	try {
		fs.writeFileSync(LEARNED_PATH, JSON.stringify({ version: 1, learned: Object.fromEntries(learned) }, null, 1));
	} catch {
		// Persistence is best-effort; in-session learning still applies.
	}
}

/** Upsert learned ratios from consume-log rows; persists when anything changed. */
function learnFromLogs(rows: LogRow[], learned: Map<string, LearnedPricing>): boolean {
	// Merge into the persisted store, not just the passed map, so probe-verified
	// contextWindows survive even when the caller's map predates the probe write.
	const persisted = loadLearned();
	for (const [id, entry] of persisted) if (!learned.has(id)) learned.set(id, entry);
	let changed = false;
	for (const r of rows) {
		if (r.type !== 2 || !r.model_name) continue;
		let other: Record<string, unknown>;
		try {
			other = JSON.parse(r.other ?? "{}") as Record<string, unknown>;
		} catch {
			continue;
		}
		const group = other.group_ratio;
		if (typeof group !== "number" || group <= 0) continue;
		const mode: "ratio" | "expr" = other.billing_mode === "tiered_expr" ? "expr" : "ratio";
		const mr = typeof other.model_ratio === "number" ? other.model_ratio : 0;
		if (mode === "ratio" && !(mr > 0 && typeof other.completion_ratio === "number" && other.completion_ratio > 0))
			continue;
		const prev = learned.get(r.model_name);
		const entry: LearnedPricing = {
			mode,
			groupRatio: group,
			// Probe-verified context survives log refreshes (logs carry no context data).
			...(prev?.contextWindow !== undefined ? { contextWindow: prev.contextWindow } : {}),
			...(mode === "ratio"
				? {
						modelRatio: mr,
						completionRatio: other.completion_ratio as number,
						cacheRatio: typeof other.cache_ratio === "number" ? other.cache_ratio : 0,
					}
				: {}),
			at: Date.now(),
		};
		if (!prev || prev.groupRatio !== entry.groupRatio || prev.modelRatio !== entry.modelRatio) changed = true;
		learned.set(r.model_name, entry);
	}
	if (changed) saveLearned(learned);
	return changed;
}

/** Cost from ratios actually billed to this key (authoritative over catalog estimates). */
function costFromLearned(l: LearnedPricing): CostCard {
	const base = (l.modelRatio ?? 0) * RATIO_USD_PER_M;
	return {
		input: base * l.groupRatio,
		output: base * (l.completionRatio ?? 1) * l.groupRatio,
		cacheRead: base * (l.cacheRatio ?? 0) * l.groupRatio,
		cacheWrite: 0,
	};
}

/** Record a verified context window from a live probe; persists immediately. */
function learnFromProbe(modelId: string, contextWindow: number): void {
	const learned = loadLearned();
	const prev = learned.get(modelId);
	learned.set(modelId, {
		mode: prev?.mode ?? "ratio",
		...(prev?.modelRatio !== undefined ? { modelRatio: prev.modelRatio } : {}),
		...(prev?.completionRatio !== undefined ? { completionRatio: prev.completionRatio } : {}),
		...(prev?.cacheRatio !== undefined ? { cacheRatio: prev.cacheRatio } : {}),
		...(prev?.groupRatio !== undefined ? { groupRatio: prev.groupRatio } : { groupRatio: DEFAULT_GROUP_RATIO }),
		contextWindow,
		at: Date.now(),
	});
	saveLearned(learned);
}

/** Probe one model's served context: send ~1 token-pair per claimed 16k of window.
 * HTTP 4xx = channel rejects that size (definitive); timeout/network error = retry once,
 * then skip the size as inconclusive. Returns the largest window verifiably served. */
async function probeModelContext(
	base: string,
	apiKey: string,
	modelId: string,
	claimed: number,
	log: (m: string) => void,
): Promise<number | null> {
	// Candidates: the claim itself, then common catalog sizes.
	const ladder = [claimed, 1_000_000, 262_144, 131_072, 128_000, 65_536, 32_768]
		.filter((v, i, a) => v > 0 && a.indexOf(v) === i)
		.sort((a, b) => b - a);
	for (const size of ladder) {
		// ~2 tokens per "word"; pad to size-64 so the request fits exactly size if served.
		const words = Math.max(64, Math.floor((size - 64) / 2));
		const body = {
			model: modelId,
			max_tokens: 8,
			messages: [{ role: "user", content: `Repeat the single word: ping. Context filler: ${"x ".repeat(words)}` }],
		};
		let accepted = false;
		let definitiveReject = false;
		// Attempt 1 + 1 retry for timeouts (large fills can exceed a first attempt).
		for (let attempt = 0; attempt < 2 && !accepted && !definitiveReject; attempt++) {
			try {
				const res = await fetch(`${base}/v1/chat/completions`, {
					method: "POST",
					headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(120_000),
				});
				if (res.ok) {
					accepted = true;
					break;
				}
				// 4xx at this size: the channel definitively refuses it.
				definitiveReject = res.status >= 400 && res.status < 500;
				if (attempt === 0 && !definitiveReject) continue;
				log(`${definitiveReject ? "reject" : "http-error"} @ ${size.toLocaleString()} (HTTP ${res.status})`);
			} catch (e) {
				if (attempt === 0) continue; // timeout/network → retry once
				log(`timeout @ ${size.toLocaleString()} (inkonklusif, dilewati)`);
			}
		}
		if (accepted) {
			log(`ok @ ${size.toLocaleString()}`);
			return size;
		}
		if (definitiveReject) continue;
	}
	return null;
}

/** Per-token USD/M rate card for one model. */
interface CostCard {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Host-agnostic model row the gateway data resolves to. */
interface ModelMeta {
	id: string;
	api: string;
	isImage: boolean;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost?: CostCard;
	longContext?: { inputThreshold: number; input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Bundled-catalog reference (another provider's row for the same id). */
interface BundledModelRef {
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
}

// ---------------------------------------------------------------- helpers

async function fetchJson<T>(url: string, apiKey?: string): Promise<T> {
	const res = await fetch(url, {
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return (await res.json()) as T;
}

/** new-api /api/* handlers answer failures with HTTP 200 + {success:false} (aihub-usage trap). */
function assertApiOk(body: NewApiPricing, what: string): void {
	if (body.success === false) throw new Error(`${what} ditolak gateway: ${body.message ?? "unknown"}`);
}

/** new-api endpoint type → runner api (mirrors omp's own proxy-discovery rule). */
const EP_TYPE_TO_API: Record<string, string> = {
	anthropic: "anthropic-messages",
	"openai-response": "openai-responses",
	openai: "openai-completions",
	gemini: "google-generative-ai",
};

const IMAGE_KIND_ENDPOINTS: Record<string, true> = {
	"image-generation": true,
	"openai-image-edit": true,
};

/** One linear price branch inside a billing_expr, already in USD/M (p=input, c=output, cr=cache read). */
interface ExprBranch {
	input: number;
	output: number;
	cacheRead: number;
}

/**
 * tiered_expr rows carry junk model_ratio (e.g. deepseek-v4-1-flash 37.5); their real
 * price lives in billing_expr as `p * A + c * B + cr * C` branches (optionally scaled by
 * a time multiplier). Coefficients are USD/M — verified against the gateway pricing page.
 */
const EXPR_BRANCH_RE = /p\s*\*\s*([\d.]+)\s*\+\s*c\s*\*\s*([\d.]+)\s*\+\s*cr\s*\*\s*([\d.]+)/g;
/** Multiplier alternatives from `cond ? 0.5 : 1` time-discount forms. */
const EXPR_FACTOR_RE = /\?\s*([\d.]+)\s*:\s*([\d.]+)/g;

/** Peak-safe cost from a billing_expr (null when unparseable). Length-split exprs
 * (`len <= N ? tier(A) : tier(B)`) map to omp's cost.longContext: base = tier A,
 * longContext = tier B at threshold N. Time-discount exprs keep the priciest branch. */
function costFromBillingExpr(
	expr: string,
	groupRatio: number,
): { cost: CostCard; longContext?: { inputThreshold: number; input: number; output: number; cacheRead: number; cacheWrite: number } } | null {
	const branches: ExprBranch[] = [];
	for (const m of expr.matchAll(EXPR_BRANCH_RE)) {
		branches.push({ input: Number(m[1]), output: Number(m[2]), cacheRead: Number(m[3]) });
	}
	if (branches.length === 0) return null;
	const scale = (b: ExprBranch, f: number) => ({
		input: b.input * f * groupRatio,
		output: b.output * f * groupRatio,
		cacheRead: b.cacheRead * f * groupRatio,
	});

	// `len <= N ? tierA : tierB` → two real context tiers.
	const lenGuard = expr.match(/len\s*<=\s*(\d+)\s*\?/);
	if (lenGuard && branches.length >= 2) {
		const threshold = Number(lenGuard[1]);
		return {
			cost: { ...scale(branches[0], 1), cacheWrite: 0 },
			longContext: { inputThreshold: threshold, ...scale(branches[1], 1), cacheWrite: 0 },
		};
	}

	let maxFactor = 1;
	for (const m of expr.matchAll(EXPR_FACTOR_RE)) {
		maxFactor = Math.max(maxFactor, Number(m[1]), Number(m[2]));
	}
	const priciest = branches.reduce((a, b) => (b.input > a.input ? b : a));
	return { cost: { ...scale(priciest, maxFactor), cacheWrite: 0 } };
}

function costForRow(row: NewApiPricingRow | undefined, groupRatio: number): CostCard | null {
	if (!row || row.quota_type === 1) return null; // per-call image models: no token rate card
	const base = (row.model_ratio ?? 0) * RATIO_USD_PER_M;
	return {
		input: base * groupRatio,
		output: base * (row.completion_ratio ?? 1) * groupRatio,
		cacheRead: base * (row.cache_ratio ?? 0) * groupRatio,
		cacheWrite: base * (row.create_cache_ratio ?? 0) * groupRatio,
	};
}

/** Cheapest group ratio the gateway applies on top of model ratios. */
function groupRatioOf(pricing: NewApiPricing): number {
	const ratios = Object.values(pricing.group_ratio ?? {});
	return ratios.length ? Math.min(...ratios) : DEFAULT_GROUP_RATIO;
}

/** Read a string prop off an unknown object without casting. */
function readString(value: unknown, prop: string): string | undefined {
	if (value && typeof value === "object" && prop in value) {
		const candidate = (value as Record<string, unknown>)[prop];
		if (typeof candidate === "string" && candidate) return candidate;
	}
	return undefined;
}

/** Bundled-catalog references for context/output gap-filling. */
function bundledReference(): Map<string, BundledModelRef> {
	const out = new Map<string, BundledModelRef>();
	try {
		// Legacy specifier: omp's loader rewrites it onto the host-bundled catalog.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional compat surface
		const mod = require("@mariozechner/pi-ai") as { getModels?: () => unknown[] };
		const models = typeof mod.getModels === "function" ? mod.getModels() : [];
		for (const m of models) {
			const ctx = readNumber(m, "contextWindow");
			const max = readNumber(m, "maxTokens");
			if (!m || typeof m !== "object" || ctx === undefined) continue;
			const input = readStringArray(m, "input");
			out.set(readString(m, "id") ?? "", {
				contextWindow: ctx,
				maxTokens: max ?? 32_768,
				input: input.filter((s): s is "text" | "image" => s === "text" || s === "image"),
				reasoning: readBool(m, "reasoning"),
			});
		}
	} catch {
		// Reference unavailable → context gaps keep generic defaults instead of failing load.
	}
	return out;
}

function readNumber(value: unknown, prop: string): number | undefined {
	if (value && typeof value === "object" && prop in value) {
		const candidate = (value as Record<string, unknown>)[prop];
		if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
	}
	return undefined;
}

function readBool(value: unknown, prop: string): boolean {
	if (value && typeof value === "object" && prop in value) {
		return (value as Record<string, unknown>)[prop] === true;
	}
	return false;
}

function readStringArray(value: unknown, prop: string): string[] {
	if (value && typeof value === "object" && prop in value) {
		const candidate = (value as Record<string, unknown>)[prop];
		if (Array.isArray(candidate)) return candidate.filter((s): s is string => typeof s === "string");
	}
	return [];
}

// ---------------------------------------------------------------- model builder

async function fetchPricing(base: string): Promise<NewApiPricing> {
	const pricing = await fetchJson<NewApiPricing>(`${base}/api/pricing`);
	assertApiOk(pricing, "/api/pricing");
	return pricing;
}

async function buildModelMetas(base: string, apiKey: string | undefined): Promise<ModelMeta[]> {
	const [roster, pricing, logs] = await Promise.all([
		fetchJson<{ data?: V1Model[] }>(`${base}/v1/models`, apiKey),
		fetchPricing(base),
		// Learning pass: consume logs carry the ratios actually billed to this key.
		apiKey
			? fetchJson<{ data?: LogRow[] }>(`${base}/api/log/token`, apiKey).catch(() => ({}) as { data?: LogRow[] })
			: Promise.resolve({} as { data?: LogRow[] }),
	]);
	const learned = loadLearned();
	if (logs.data?.length) learnFromLogs(logs.data, learned);
	const rows = new Map<string, NewApiPricingRow>();
	for (const row of pricing.data ?? []) rows.set(row.model_name, row);
	/** Roster/katalog kadang beda ejaan versi: deepseek-v4.1-flash vs deepseek-v4-1-flash. */
	const norm = (id: string) => id.toLowerCase().replaceAll(".", "-");
	const rowsByNorm = new Map<string, NewApiPricingRow>();
	for (const row of pricing.data ?? []) rowsByNorm.set(norm(row.model_name), row);
	const rowFor = (id: string): NewApiPricingRow | undefined => rows.get(id) ?? rowsByNorm.get(norm(id));
	const groupRatio = groupRatioOf(pricing);
	const refs = bundledReference();

	const metas: ModelMeta[] = [];
	for (const m of roster.data ?? []) {
		const row = rowFor(m.id);
		const epTypes = m.supported_endpoint_types ?? row?.supported_endpoint_types ?? [];
		const isImage = epTypes.some((t) => IMAGE_KIND_ENDPOINTS[t] === true);
		const api = isImage
			? "openai-images"
			: (EP_TYPE_TO_API[epTypes.find((t) => EP_TYPE_TO_API[t] !== undefined) ?? ""] ?? "openai-completions");

		// Context/output gaps: verified-by-probe value wins, then catalog field, then
		// bundled reference of the same id, then generic chat defaults.
		const ref = refs.get(m.id);
		const learnedEntry = learned.get(m.id);
		const contextWindow = learnedEntry?.contextWindow ?? row?.context_length ?? ref?.contextWindow ?? 128_000;
		const maxTokens = Math.min(row?.max_output_tokens ?? ref?.maxTokens ?? 32_768, contextWindow);

		const input: ("text" | "image")[] = [];
		const modalities = row?.input_modalities;
		if (modalities) {
			if (modalities.includes("text")) input.push("text");
			if (modalities.includes("image")) input.push("image");
		} else {
			input.push("text");
			if (ref?.input.includes("image") || row?.capabilities?.includes("vision")) input.push("image");
		}

		metas.push({
			id: m.id,
			api,
			isImage,
			reasoning: row?.capabilities?.includes("reasoning") ?? ref?.reasoning ?? true,
			input,
			// Cost precedence: (1) ratios actually billed to this key (learned from logs),
			// (2) tiered_expr billing_expr, (3) catalog ratios × group ratio, (4) omit →
			// host falls back to the bundled catalog reference instead of showing free.
			...((): { cost?: CostCard; longContext?: ModelMeta["longContext"] } => {
				const learnedEntry = learned.get(m.id);
				if (learnedEntry && learnedEntry.mode === "ratio") return { cost: costFromLearned(learnedEntry) };
				if (!row) return {};
				if (row.billing_expr) {
					const parsed = costFromBillingExpr(row.billing_expr, learnedEntry?.groupRatio ?? groupRatio);
					return parsed ? { cost: parsed.cost, longContext: parsed.longContext } : {};
				}
				return { cost: costForRow(row, learnedEntry?.groupRatio ?? groupRatio) ?? undefined };
			})(),
			contextWindow,
			maxTokens,
		});
	}
	return metas;
}

/** metas → host model rows. pi: type:"image"+output; omp: kind:"image". */
function metasToProviderModels(isPi: boolean, metas: ModelMeta[]): Record<string, unknown>[] {
	return metas.map((m) => {
		const base: Record<string, unknown> = { id: m.id, name: m.id, input: m.input };
		if (m.cost) base.cost = m.cost; // omitted → host applies its bundled-reference fallback
		if (m.longContext) base.cost = { ...(base.cost as CostCard | undefined), longContext: m.longContext };
		if (m.isImage) {
			return isPi ? { ...base, type: "image", api: "openai-images", output: ["image"] } : { ...base, kind: "image", api: "openai-images" };
		}
		return { ...base, api: m.api, reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
	});
}

// ---------------------------------------------------------------- usage (omp)

interface UsageCredentialShape {
	apiKey?: string;
}

function makeUsageProvider(base: string) {
	return {
		id: PROVIDER_ID,
		cacheVersion: 1,
		validatesCredentials: true,
		usesRequestKey: true,
		async fetchUsage(params: { credential?: UsageCredentialShape }): Promise<Record<string, unknown> | null> {
			const key = params?.credential?.apiKey;
			if (!key) return null;
			const get = async <T>(path: string): Promise<T | null> => {
				try {
					return await fetchJson<T>(`${base}${path}`, key);
				} catch {
					return null;
				}
			};
			const [sub, use, tok] = await Promise.all([
				get<BillingSub>("/v1/dashboard/billing/subscription"),
				get<{ total_usage?: number }>("/v1/dashboard/billing/usage"),
				get<{ data?: TokenUsage }>("/api/usage/token/"),
			]);
			if (!sub && !tok) return null;
			const limits: Record<string, unknown>[] = [];
			const total = sub?.hard_limit_usd;
			const used = (use?.total_usage ?? 0) / 100; // endpoint reports cents
			if (total !== undefined) {
				const remaining = total - used;
				limits.push({
					id: "account-credit",
					label: "Account credit",
					scope: { provider: PROVIDER_ID },
					amount: { used, limit: total, remaining, unit: "usd" },
					status: total > 0 && remaining / total <= 0.1 ? "warning" : "ok",
				});
			}
			const t = tok?.data;
			if (t) {
				const amount: Record<string, unknown> = { used: (t.total_used ?? 0) / QUOTA_PER_UNIT, unit: "usd" };
				if (!t.unlimited_quota) {
					amount.limit = (t.total_granted ?? 0) / QUOTA_PER_UNIT;
					amount.remaining = (t.total_available ?? 0) / QUOTA_PER_UNIT;
				}
				limits.push({
					id: "key-quota",
					label: `Key quota${t.name ? ` (${t.name})` : ""}`,
					scope: { provider: PROVIDER_ID },
					amount,
					status: "ok",
				});
			}
			return { provider: PROVIDER_ID, fetchedAt: Date.now(), limits };
		},
	};
}

// ---------------------------------------------------------------- host commands

/** ui.notify where available (command ctx carries it on both hosts). */
function notify(ctx: unknown, message: string, level: "info" | "warning" | "error"): void {
	const ui = (ctx as { ui?: { notify?: (m: string, t?: string) => void } } | null)?.ui;
	ui?.notify?.(message, level);
}

interface RegistryWithRefresh {
	refresh?: (strategy?: unknown, options?: unknown) => Promise<unknown>;
	refreshAll?: () => Promise<unknown>;
	/** omp: takes a Model, not a provider id. */
	getApiKey?: (model: unknown) => Promise<string | undefined> | string | undefined;
}

/** Session model rows of this provider (ctx.models is omp-only; absent elsewhere). */
function providerSessionModels(ctx: unknown): { provider: unknown; id: unknown; contextWindow: unknown }[] {
	const modelsList = (ctx as { models?: unknown } | null)?.models;
	if (!modelsList || typeof modelsList !== "object" || !("list" in modelsList)) return [];
	const listed = (modelsList as { list: () => unknown }).list();
	if (!Array.isArray(listed)) return [];
	return listed.filter(
		(m): m is { provider: unknown; id: unknown; contextWindow: unknown } =>
			!!m && typeof m === "object" && "provider" in m && "id" in m && "contextWindow" in m,
	);
}

function registryOf(ctx: unknown): RegistryWithRefresh | undefined {
	const reg = (ctx as { modelRegistry?: RegistryWithRefresh } | null)?.modelRegistry;
	return reg && typeof reg === "object" ? reg : undefined;
}

async function resolveApiKey(ctx: unknown): Promise<string | undefined> {
	const reg = registryOf(ctx);
	const model = providerSessionModels(ctx).find((m) => m.provider === PROVIDER_ID);
	try {
		// omp resolves the stored /login credential (or configured key) per model row.
		if (model && typeof reg?.getApiKey === "function") {
			const k = await reg.getApiKey(model);
			if (typeof k === "string" && k) return k;
		}
	} catch {
		// fall through to env
	}
	const env = process.env.AIHUB_API_KEY;
	return env || undefined;
}

// ---------------------------------------------------------------- extension

export default function aihubExtension(pi: object) {
	const base = (process.env.AIHUB_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
	// pi exposes registerVirtualModel; omp does not. Kept as a structural check.
	const isPi = "registerVirtualModel" in pi;
	const host = pi as {
		registerProvider: (name: string, config: Record<string, unknown>) => void;
		registerCommand: (name: string, def: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => void;
	};

	async function fetchModels(apiKey: string | undefined): Promise<Record<string, unknown>[]> {
		try {
			const metas = await buildModelMetas(base, apiKey);
			return metasToProviderModels(isPi, metas);
		} catch (e) {
			// Keep the provider usable offline: stale/empty roster beats a failed registration.
			console.error(`[aihub] model fetch failed: ${(e as Error).message}`);
			return [];
		}
	}

	const config: Record<string, unknown> = {
		baseUrl: `${base}/v1`,
		apiKey: isPi ? "$AIHUB_API_KEY" : "AIHUB_API_KEY", // fallback; stored /login credential wins
		authHeader: true,
		api: "openai-completions",
		// omp: plain API-key shaping for the anthropic-messages rows (new-api gateway, not OAuth upstream),
		// and its anthropic route rejects the strict-tools field.
		...(isPi ? {} : { auth: "apiKey", disableStrictTools: true }),
		oauth: {
			name: PROVIDER_NAME,
			async login(callbacks: { onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string> }): Promise<unknown> {
				const key = await callbacks.onPrompt({ message: `API key dari ${base} (sk-…)`, placeholder: "sk-…" });
				const trimmed = key?.trim();
				if (!trimmed) throw new Error("API key kosong");
				// pi requires OAuthCredentials ({refresh, access, expires}); omp accepts the object too.
				return { refresh: "", access: trimmed, expires: Number.MAX_SAFE_INTEGER };
			},
			// omp: apiKey stays the fallback because oauth is present; key never expires → no refreshToken.
			getApiKey(credentials: { access?: string }): string {
				return credentials.access ?? "";
			},
		},
	};
	if (!isPi) config.usage = makeUsageProvider(base); // omp-only surface
	if (isPi) {
		config.refreshModels = async (context: { credential?: unknown }) => {
			const cred = context?.credential as { key?: unknown; access?: unknown } | undefined;
			const key = typeof cred?.key === "string" ? cred.key : typeof cred?.access === "string" ? cred.access : process.env.AIHUB_API_KEY;
			return fetchModels(key);
		};
	} else {
		config.fetchDynamicModels = (apiKey: string | undefined) => fetchModels(apiKey);
	}

	host.registerProvider(PROVIDER_ID, config);

	host.registerCommand("aihub-refresh", {
		description: "Refresh metra models/pricing/context from the gateway now",
		handler: async (_args, ctx) => {
			const reg = registryOf(ctx);
			try {
				if (typeof reg?.refresh === "function") {
					await reg.refresh("online");
					notify(ctx, "aihub: model metra di-refresh (harga + konteks terbaru)", "info");
				} else if (typeof reg?.refreshAll === "function") {
					await reg.refreshAll();
					notify(ctx, "aihub: model metra di-refresh", "info");
				} else {
					notify(ctx, "aihub: registry tidak mendukung refresh — restart sesi untuk refresh", "warning");
				}
			} catch (e) {
				notify(ctx, `aihub refresh gagal: ${(e as Error).message}`, "error");
			}
		},
	});

	host.registerCommand("aihub-probe", {
		description: "Probe the actually-served context window (args: <model-id …> | all [--max N])",
		handler: async (args: string, ctx: unknown) => {
			const key = await resolveApiKey(ctx);
			if (!key) {
				notify(ctx, "aihub: /login aihub atau set AIHUB_API_KEY dulu", "warning");
				return;
			}
			const reg = registryOf(ctx);
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const all = argv[0] === "all";
			const maxCount = all ? Math.max(1, Number(argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? 5)) : argv.length;
			if (!all && argv.length === 0) {
				notify(ctx, "pakai: /aihub-probe <model-id> … | all [--max=N]", "warning");
				return;
			}
			try {
				// Build the claimed-context map the same way the builder does.
				const pricing = await fetchPricing(base);
				const catalogCtx = new Map<string, number>();
				for (const row of pricing.data ?? []) {
					if (row.context_length) catalogCtx.set(row.model_name, row.context_length);
				}
				const refs = bundledReference();
				const sessionModels = providerSessionModels(ctx)
					.filter((m) => m.provider === PROVIDER_ID && typeof m.id === "string" && typeof m.contextWindow === "number")
					.map((m) => ({ id: m.id as string, contextWindow: m.contextWindow as number }));
				const targetIds = all
					? sessionModels.map((m) => ({ id: m.id, claimed: m.contextWindow }))
					: argv.map((id) => {
							const norm = id.toLowerCase().replaceAll(".", "-");
							const claimed =
								catalogCtx.get(id) ??
								[...catalogCtx.entries()].find(([k]) => k.toLowerCase().replaceAll(".", "-") === norm)?.[1] ??
								refs.get(id)?.contextWindow ??
								128_000;
							return { id, claimed };
						});
				const learned = loadLearned();
				const results: string[] = [];
				for (const { id, claimed } of targetIds.slice(0, all ? maxCount : undefined)) {
					const line = (s: string) => notify(ctx, `/aihub-probe ${id}: ${s}`, "info");
					const served = await probeModelContext(base, key, id, claimed, line);
					if (served !== null) {
						learnFromProbe(id, served);
						results.push(`${id}: ${served.toLocaleString()} verified (claimed ${claimed.toLocaleString()})`);
					} else {
						results.push(`${id}: probe gagal (semua claim ditolak)`);
					}
				}
				notify(ctx, `Hasil probe:\n${results.join("\n")}\n→ /aihub-refresh untuk menerapkan.`, "info");
				void reg;
			} catch (e) {
				notify(ctx, `aihub probe gagal: ${(e as Error).message}`, "error");
			}
		},
	});

	host.registerCommand("aihub-usage", {
		description: "metranet AI hub: saldo akun, kuota key, pemakaian per model",
		handler: async (_args, ctx) => {
			const key = await resolveApiKey(ctx);
			if (!key) {
				notify(ctx, "aihub: /login metra atau set AIHUB_API_KEY dulu", "warning");
				return;
			}
			try {
				const [sub, use, tok, logs] = await Promise.all([
					fetchJson<BillingSub>(`${base}/v1/dashboard/billing/subscription`, key),
					fetchJson<{ total_usage?: number }>(`${base}/v1/dashboard/billing/usage`, key),
					fetchJson<{ data?: TokenUsage }>(`${base}/api/usage/token/`, key),
					fetchJson<{ data?: LogRow[] }>(`${base}/api/log/token`, key),
				]);
				const total = sub.hard_limit_usd ?? 0;
				const usedAcc = (use.total_usage ?? 0) / 100;
				const t = tok.data ?? {};
				const rows = (logs.data ?? []).filter((r) => r.type === 2);
				const learnedNow = learnFromLogs((logs.data ?? []).filter((r) => r.type === 2), loadLearned());
				/** model → jendela-log aggregate (dynamic keys). */
				const byModel = new Map<string, { req: number; inTok: number; outTok: number; quota: number }>();
				for (const r of rows) {
					const name = r.model_name ?? "?";
					const b = byModel.get(name) ?? { req: 0, inTok: 0, outTok: 0, quota: 0 };
					b.req++;
					b.inTok += r.prompt_tokens ?? 0;
					b.outTok += r.completion_tokens ?? 0;
					b.quota += r.quota ?? 0;
					byModel.set(name, b);
				}
				const windowCost = rows.reduce((s, r) => s + (r.quota ?? 0), 0) / QUOTA_PER_UNIT;
				const lines = [
					`Kredit akun: $${(total - usedAcc).toFixed(2)} sisa / $${total.toFixed(2)}`,
					t.unlimited_quota
						? `Key ${t.name ?? ""}: tanpa batas kuota, terpakai $${((t.total_used ?? 0) / QUOTA_PER_UNIT).toFixed(2)}`
						: `Key ${t.name ?? ""}: $${((t.total_available ?? 0) / QUOTA_PER_UNIT).toFixed(2)} sisa / $${((t.total_granted ?? 0) / QUOTA_PER_UNIT).toFixed(2)}`,
					`Jendela ${rows.length} request terakhir: $${windowCost.toFixed(4)} —`,
					...[...byModel.entries()]
						.sort((a, b) => b[1].quota - a[1].quota)
						.slice(0, 15)
						.map(
							([name, b]) =>
								`  ${name}: ${b.req} req, ${b.inTok.toLocaleString()} in / ${b.outTok.toLocaleString()} out, $${(b.quota / QUOTA_PER_UNIT).toFixed(4)}`,
						),
					`Harga terpelajari dari log: ${loadLearned().size} model${learnedNow ? " (baru disimpan)" : ""} — pakai model tanpa harga sekali, lalu /aihub-refresh.`,
				];
				notify(ctx, lines.join("\n"), "info");
			} catch (e) {
				notify(ctx, `aihub usage gagal: ${(e as Error).message}`, "error");
			}
		},
	});
}
