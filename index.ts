import { exec as execCallback } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const exec = promisify(execCallback);

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "dynamic-models.json",
);
const DEFAULT_MODELS_PATH = "models";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_API_KEY = "dynamic-models";
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_INPUT: ("text" | "image")[] = ["text"];
const LOG_PATH = join(homedir(), ".pi", "agent", "dynamic-models.log");
const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.PI_DYNAMIC_MODELS_DEBUG ?? "",
);

// Context window probing constants
const PROBE_CACHE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "dynamic-models-cache.json",
);
const PROBE_LOW_BOUND = 1024;
const PROBE_HIGH_BOUND = 2_097_152; // start probing here: 2M tokens
const PROBE_MAX_BOUND = 8_388_608; // allow upward probing if 2M succeeds
const PROBE_TIMEOUT_MS = 60_000;
const PROBE_MAX_ITERATIONS = 16;
const PROBE_RESOLUTION = 1024;

// Common context window breakpoints (powers of 2 and common deployed sizes)
const COMMON_CONTEXT_SIZES = [
  1024, 2048, 4096, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304,
  131072, 196608, 262144, 393216, 524288, 786432, 1048576, 1572864, 2097152,
];

interface DynamicModelsConfig {
  endpoints?: EndpointConfig[];
}

interface EndpointConfig {
  name: string;
  baseUrl?: string;
  modelsUrl?: string;
  modelsPath?: string;
  api?: "openai-completions" | "openai-responses";
  authHeader?: boolean;
  apiKey?: ResolvableString;
  headers?: Record<string, ResolvableString>;
  timeoutMs?: number;
  enabled?: boolean;
  includeEmbeddings?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  defaults?: ModelDefaults;
  modelOverrides?: Record<string, ModelOverride>;
}

interface ModelDefaults {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<typeof DEFAULT_COST>;
  compat?: Record<string, unknown>;
  headers?: Record<string, ResolvableString>;
}

interface ModelOverride extends ModelDefaults {
  enabled?: boolean;
}

type ResolvableString =
  | string
  | { env?: string; command?: string; literal?: string };

interface RefreshOptions {
  reason: "startup" | "session_start" | "command";
  notify?: boolean;
  ctx?: ExtensionContext;
}

interface ProviderStatus {
  baseUrl: string;
  modelsUrl: string;
  api: "openai-completions" | "openai-responses";
  authHeader: boolean;
}

interface RefreshSummary {
  configPath: string;
  loadedProviders: string[];
  removedProviders: string[];
  providerModelCounts: Record<string, number>;
  providerModels: Record<string, JsonRecord[]>;
  providerStatus: Record<string, ProviderStatus>;
  errors: string[];
  skipped: string[];
}

interface ProbeResult {
  modelId: string;
  contextWindow: number;
  iterations: number;
  durationMs: number;
  fromCache?: boolean;
}

interface ProbeCacheEntry {
  contextWindow: number;
  discoveredAt: string;
  endpointName: string;
  modelId: string;
}

interface ProbeCache {
  [cacheKey: string]: ProbeCacheEntry;
}

interface ModelsListResponse {
  data?: unknown[];
  models?: unknown[];
  items?: unknown[];
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getConfigPath(): string {
  return process.env.PI_DYNAMIC_MODELS_CONFIG || DEFAULT_CONFIG_PATH;
}

function debugLog(message: string, details?: unknown): void {
  if (!DEBUG_ENABLED) return;
  if (details !== undefined) {
    console.error(`[pi-dynamic-models:debug] ${message}`, details);
  } else {
    console.error(`[pi-dynamic-models:debug] ${message}`);
  }
}

async function appendLogLine(
  level: "info" | "warning" | "error",
  message: string,
): Promise<void> {
  try {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await appendFile(
      LOG_PATH,
      `${new Date().toISOString()} [${level}] ${message}\n`,
      "utf8",
    );
  } catch (error) {
    debugLog(
      `failed to append log line to ${LOG_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function pickBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern)
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPatterns(value: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function matchesExcludePatterns(value: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function isLikelyEmbeddingModel(id: string, raw: JsonRecord): boolean {
  const objectType = pickString(
    raw.object,
    raw.type,
    raw.task,
    raw.kind,
  )?.toLowerCase();
  if (objectType?.includes("embedding")) return true;

  const idLower = id.toLowerCase();
  if (idLower.includes("embedding") || idLower.includes("embed")) return true;

  const modalities = [
    raw.modalities,
    raw.input_modalities,
    raw.input,
    raw.capabilities,
  ]
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      if (isRecord(value))
        return Object.keys(value).filter((key) =>
          Boolean((value as JsonRecord)[key]),
        );
      return [];
    })
    .map((value) => String(value).toLowerCase());

  return modalities.includes("embedding") || modalities.includes("embeddings");
}

function normalizeInputTypes(
  raw: JsonRecord,
  defaults?: ModelDefaults,
  override?: ModelOverride,
): ("text" | "image")[] {
  if (override?.input && override.input.length > 0) {
    return uniqueStrings(override.input) as ("text" | "image")[];
  }

  const capabilities = isRecord(raw.capabilities)
    ? raw.capabilities
    : undefined;
  const sourceValues: unknown[] = [
    raw.input,
    raw.inputs,
    raw.modalities,
    raw.input_modalities,
    raw.inputModalities,
    capabilities
      ? Object.keys(capabilities).filter((key) => Boolean(capabilities[key]))
      : undefined,
  ];

  const normalized = new Set<"text" | "image">();
  for (const source of sourceValues) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const value = String(item).toLowerCase();
      if (value.includes("image") || value.includes("vision"))
        normalized.add("image");
      if (value.includes("text") || value.includes("chat"))
        normalized.add("text");
    }
  }

  if (normalized.size > 0) return [...normalized];
  if (defaults?.input && defaults.input.length > 0) {
    return uniqueStrings(defaults.input) as ("text" | "image")[];
  }
  return [...DEFAULT_INPUT];
}

function normalizeCost(
  raw: JsonRecord,
  defaults?: ModelDefaults,
  override?: ModelOverride,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const pricing = isRecord(raw.pricing) ? raw.pricing : undefined;
  const rawCost = {
    input: pickNumber(
      raw.input_cost,
      raw.inputCost,
      pricing?.input,
      pricing?.prompt,
      pricing?.input_cost,
    ),
    output: pickNumber(
      raw.output_cost,
      raw.outputCost,
      pricing?.output,
      pricing?.completion,
      pricing?.output_cost,
    ),
    cacheRead: pickNumber(
      raw.cache_read_cost,
      raw.cacheReadCost,
      pricing?.cache_read,
      pricing?.cacheRead,
    ),
    cacheWrite: pickNumber(
      raw.cache_write_cost,
      raw.cacheWriteCost,
      pricing?.cache_write,
      pricing?.cacheWrite,
    ),
  };

  return {
    input:
      override?.cost?.input ??
      rawCost.input ??
      defaults?.cost?.input ??
      DEFAULT_COST.input,
    output:
      override?.cost?.output ??
      rawCost.output ??
      defaults?.cost?.output ??
      DEFAULT_COST.output,
    cacheRead:
      override?.cost?.cacheRead ??
      rawCost.cacheRead ??
      defaults?.cost?.cacheRead ??
      DEFAULT_COST.cacheRead,
    cacheWrite:
      override?.cost?.cacheWrite ??
      rawCost.cacheWrite ??
      defaults?.cost?.cacheWrite ??
      DEFAULT_COST.cacheWrite,
  };
}

function normalizeCompat(
  raw: JsonRecord,
  defaults?: ModelDefaults,
  override?: ModelOverride,
): Record<string, unknown> | undefined {
  const compat = {
    ...(isRecord(raw.compat) ? raw.compat : {}),
    ...(defaults?.compat ?? {}),
    ...(override?.compat ?? {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

async function buildModelDefinition(
  rawModel: unknown,
  endpoint: EndpointConfig,
): Promise<JsonRecord | undefined> {
  const raw = isRecord(rawModel) ? rawModel : { id: String(rawModel) };
  const id = pickString(raw.id, raw.model, raw.name);
  if (!id) return undefined;

  const override = endpoint.modelOverrides?.[id];
  if (override?.enabled === false) return undefined;
  if (!endpoint.includeEmbeddings && isLikelyEmbeddingModel(id, raw))
    return undefined;
  if (!matchesPatterns(id, endpoint.includePatterns)) return undefined;
  if (matchesExcludePatterns(id, endpoint.excludePatterns)) return undefined;

  const defaults = endpoint.defaults;
  const architecture = isRecord(raw.architecture)
    ? raw.architecture
    : undefined;
  const limits = isRecord(raw.limits) ? raw.limits : undefined;
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const capabilities = isRecord(raw.capabilities)
    ? raw.capabilities
    : undefined;
  const contextWindow =
    override?.contextWindow ??
    pickNumber(
      raw.contextWindow,
      raw.context_window,
      raw.max_context_tokens,
      raw.maxContextTokens,
      architecture?.context_length,
      architecture?.max_context_length,
      limits?.context_window,
      limits?.contextWindow,
      metadata?.context_length,
      metadata?.context_window,
    ) ??
    defaults?.contextWindow ??
    128000;

  const maxTokens =
    override?.maxTokens ??
    pickNumber(
      raw.maxTokens,
      raw.max_tokens,
      raw.max_completion_tokens,
      raw.maxCompletionTokens,
      limits?.max_tokens,
      limits?.max_output_tokens,
      metadata?.max_tokens,
    ) ??
    defaults?.maxTokens ??
    16384;

  const reasoning =
    override?.reasoning ??
    pickBoolean(
      raw.reasoning,
      raw.supports_reasoning,
      raw.supportsReasoning,
      raw.reasoning_capable,
      capabilities?.reasoning,
      capabilities?.thinking,
    ) ??
    defaults?.reasoning ??
    false;

  const modelHeaders = await resolveHeaders({
    ...(defaults?.headers ?? {}),
    ...(override?.headers ?? {}),
  });
  const compat = normalizeCompat(raw, defaults, override);
  const definition: JsonRecord = {
    id,
    name: override?.name ?? pickString(raw.name) ?? defaults?.name ?? id,
    reasoning,
    input: normalizeInputTypes(raw, defaults, override),
    cost: normalizeCost(raw, defaults, override),
    contextWindow,
    maxTokens,
  };

  if (compat) definition.compat = compat;
  if (modelHeaders && Object.keys(modelHeaders).length > 0)
    definition.headers = modelHeaders;

  return definition;
}

function parseModelsPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const typed = payload as ModelsListResponse;
  if (Array.isArray(typed.data)) return typed.data;
  if (Array.isArray(typed.models)) return typed.models;
  if (Array.isArray(typed.items)) return typed.items;
  return [];
}

async function resolveValue(
  value: ResolvableString | undefined,
): Promise<string | undefined> {
  if (value === undefined) return undefined;

  if (typeof value === "string") {
    if (value.startsWith("env:")) {
      return process.env[value.slice(4)] || undefined;
    }
    if (value.startsWith("!")) {
      const { stdout } = await exec(value.slice(1), { shell: true });
      const trimmed = stdout.trim();
      return trimmed || undefined;
    }
    return value;
  }

  if (value.literal !== undefined) return value.literal;
  if (value.env) return process.env[value.env] || undefined;
  if (value.command) {
    const { stdout } = await exec(value.command, { shell: true });
    const trimmed = stdout.trim();
    return trimmed || undefined;
  }

  return undefined;
}

async function resolveHeaders(
  headers?: Record<string, ResolvableString>,
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const headerValue = await resolveValue(value);
    if (headerValue) resolved[key] = headerValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

async function readConfig(configPath: string): Promise<DynamicModelsConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as DynamicModelsConfig;
  return parsed;
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildModelsUrl(endpoint: EndpointConfig): string {
  if (endpoint.modelsUrl) return endpoint.modelsUrl;
  const baseUrl = ensureTrailingSlash(trimTrailingSlashes(endpoint.baseUrl));
  const modelsPath = (endpoint.modelsPath || DEFAULT_MODELS_PATH).replace(
    /^\/+/,
    "",
  );
  return new URL(modelsPath, baseUrl).toString();
}

function buildFetchHeaders(
  resolvedHeaders: Record<string, string> | undefined,
  resolvedApiKey: string | undefined,
  authHeader: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(resolvedHeaders ?? {}),
  };

  if (authHeader && resolvedApiKey && !headers.Authorization) {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  return headers;
}

// Context window probing utilities
function getProbeCacheKey(endpoint: EndpointConfig, modelId: string): string {
  return `${endpoint.name}:${modelId}`;
}

function isContextLimitError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("context length") ||
    msg.includes("maximum context") ||
    msg.includes("too many tokens") ||
    msg.includes("context window") ||
    msg.includes("input is too long") ||
    msg.includes("prompt is too long") ||
    msg.includes("maximum prompt length") ||
    msg.includes("context_limit") ||
    msg.includes("token limit")
  );
}

function generateTestPrompt(tokenCount: number): string {
  const chunkSize = 256;
  const chunks = Math.max(1, Math.ceil(tokenCount / chunkSize));
  return Array.from(
    { length: chunks },
    (_, index) =>
      `chunk ${index}: ${Array.from({ length: chunkSize }, () => "token").join(" ")}`,
  ).join("\n");
}

function clampProbeSize(value: number): number {
  return Math.max(PROBE_LOW_BOUND, Math.min(PROBE_MAX_BOUND, value));
}

function snapProbeSize(value: number): number {
  const clamped = clampProbeSize(value);
  return Math.max(
    PROBE_LOW_BOUND,
    Math.round(clamped / PROBE_RESOLUTION) * PROBE_RESOLUTION,
  );
}

function getProbeBreakpoints(): number[] {
  return COMMON_CONTEXT_SIZES.filter(
    (size) => size >= PROBE_LOW_BOUND && size <= PROBE_HIGH_BOUND,
  );
}

function getProbeBreakpointsDescending(): number[] {
  return [...getProbeBreakpoints()].sort((a, b) => b - a);
}

async function readProbeCache(): Promise<ProbeCache> {
  try {
    const content = await readFile(PROBE_CACHE_PATH, "utf8");
    return JSON.parse(content) as ProbeCache;
  } catch {
    return {};
  }
}

async function writeProbeCache(cache: ProbeCache): Promise<void> {
  await mkdir(dirname(PROBE_CACHE_PATH), { recursive: true });
  await writeFile(PROBE_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
}

async function resolveProbeHeaders(
  endpoint: EndpointConfig,
  modelId: string,
): Promise<Record<string, string>> {
  const override = endpoint.modelOverrides?.[modelId];
  const defaultHeaders = await resolveHeaders(endpoint.defaults?.headers);
  const overrideHeaders = await resolveHeaders(override?.headers);
  return {
    ...(defaultHeaders ?? {}),
    ...(overrideHeaders ?? {}),
  };
}

async function testModelContext(
  modelId: string,
  endpoint: EndpointConfig,
  tokenCount: number,
): Promise<void> {
  debugLog(
    `probe request endpoint=${endpoint.name} model=${modelId} tokens≈${tokenCount.toLocaleString()}`,
  );
  const prompt = generateTestPrompt(tokenCount);
  const authHeader = endpoint.authHeader === true;
  const resolvedApiKey = await resolveValue(endpoint.apiKey);
  const resolvedHeaders = await resolveHeaders(endpoint.headers);
  const modelHeaders = await resolveProbeHeaders(endpoint, modelId);
  const fetchHeaders = buildFetchHeaders(
    { ...(resolvedHeaders ?? {}), ...modelHeaders },
    resolvedApiKey,
    authHeader,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const baseUrl = trimTrailingSlashes(endpoint.baseUrl);

  try {
    const url =
      endpoint.api === "openai-responses"
        ? `${baseUrl}/responses`
        : `${baseUrl}/chat/completions`;
    const body =
      endpoint.api === "openai-responses"
        ? {
            model: modelId,
            input: [
              { role: "user", content: [{ type: "input_text", text: prompt }] },
            ],
            max_output_tokens: 1,
            stream: true,
          }
        : {
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1,
            stream: true,
          };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...fetchHeaders,
        "Content-Type": "application/json",
        Connection: "close",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    debugLog(
      `probe accepted endpoint=${endpoint.name} model=${modelId} tokens≈${tokenCount.toLocaleString()} aborting connection aggressively`,
    );
    controller.abort();
    const cancelPromise = response.body?.cancel();
    if (cancelPromise) {
      void cancelPromise.catch((error) =>
        debugLog(
          `probe body cancel endpoint=${endpoint.name} model=${modelId} ignored error=${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function probeContextWindow(
  modelId: string,
  endpoint: EndpointConfig,
  options?: { force?: boolean },
): Promise<ProbeResult> {
  const force = options?.force === true;
  const cacheKey = getProbeCacheKey(endpoint, modelId);
  const cache = await readProbeCache();
  const cached = cache[cacheKey];
  if (!force && cached) {
    debugLog(
      `probe cache hit endpoint=${endpoint.name} model=${modelId} contextWindow=${cached.contextWindow}`,
    );
    return {
      modelId,
      contextWindow: cached.contextWindow,
      iterations: 0,
      durationMs: 0,
      fromCache: true,
    };
  }

  if (force && cached) {
    debugLog(
      `probe force refresh endpoint=${endpoint.name} model=${modelId} cachedContextWindow=${cached.contextWindow}`,
    );
  }

  debugLog(
    `probe start endpoint=${endpoint.name} model=${modelId} initial=${PROBE_HIGH_BOUND}`,
  );
  const startedAt = Date.now();
  let iterations = 0;
  let low = 0;
  let high: number | undefined;

  const runProbe = async (size: number): Promise<boolean> => {
    iterations++;
    try {
      await testModelContext(modelId, endpoint, size);
      return true;
    } catch (error) {
      if (!isContextLimitError(error)) {
        throw new Error(
          `Probe failed at ${size.toLocaleString()} tokens: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  };

  if (await runProbe(PROBE_HIGH_BOUND)) {
    low = PROBE_HIGH_BOUND;
    while (iterations < PROBE_MAX_ITERATIONS && low < PROBE_MAX_BOUND) {
      const larger = snapProbeSize(Math.min(PROBE_MAX_BOUND, low * 2));
      if (larger <= low) break;
      debugLog(
        `probe top-down success at ${low.toLocaleString()} tokens, trying larger ${larger.toLocaleString()}`,
      );
      if (await runProbe(larger)) {
        low = larger;
      } else {
        high = larger;
        break;
      }
    }
  } else {
    let failedAbove = PROBE_HIGH_BOUND;
    for (const size of getProbeBreakpointsDescending()) {
      if (size >= PROBE_HIGH_BOUND) continue;
      debugLog(
        `probe top-down failure above ${failedAbove.toLocaleString()} tokens, trying smaller ${size.toLocaleString()}`,
      );
      if (await runProbe(size)) {
        low = size;
        high = failedAbove;
        break;
      }
      failedAbove = size;
    }
  }

  if (low === 0) {
    throw new Error(
      `Probe failed even at ${PROBE_LOW_BOUND.toLocaleString()} tokens`,
    );
  }

  while (
    high !== undefined &&
    high - low > PROBE_RESOLUTION &&
    iterations < PROBE_MAX_ITERATIONS
  ) {
    const mid = snapProbeSize(Math.floor((low + high) / 2));
    if (mid <= low || mid >= high) break;
    debugLog(
      `probe refine low=${low.toLocaleString()} high=${high.toLocaleString()} trying=${mid.toLocaleString()}`,
    );
    if (await runProbe(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const closestBreakpoint = getProbeBreakpoints().find(
    (size) => Math.abs(size - low) <= PROBE_RESOLUTION / 2,
  );
  const contextWindow = closestBreakpoint ?? low;
  const result: ProbeResult = {
    modelId,
    contextWindow,
    iterations,
    durationMs: Date.now() - startedAt,
  };
  cache[cacheKey] = {
    contextWindow,
    discoveredAt: new Date().toISOString(),
    endpointName: endpoint.name,
    modelId,
  };
  await writeProbeCache(cache);
  debugLog(
    `probe complete endpoint=${endpoint.name} model=${modelId} contextWindow=${contextWindow} iterations=${iterations}`,
  );
  await appendLogLine(
    "info",
    `probe ${endpoint.name}/${modelId}: ${formatProbeResult(result)}`,
  );
  return result;
}

function formatProbeResult(result: ProbeResult): string {
  return result.fromCache
    ? `Context window: ${result.contextWindow.toLocaleString()} tokens (cached)`
    : `Context window: ${result.contextWindow.toLocaleString()} tokens (probed in ${result.durationMs}ms, ${result.iterations} requests)`;
}

async function findConfiguredEndpoint(
  providerName: string,
): Promise<EndpointConfig | undefined> {
  const config = await readConfig(getConfigPath());
  return config.endpoints?.find(
    (endpoint) =>
      endpoint?.enabled !== false && endpoint.name?.trim() === providerName,
  );
}

function formatPrimitive(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function formatModelStatusLines(
  providerName: string,
  model: JsonRecord,
  probeCache: ProbeCache,
): string[] {
  const id = pickString(model.id) ?? "<unknown>";
  const name = pickString(model.name) ?? id;
  const reasoning = pickBoolean(model.reasoning);
  const input = Array.isArray(model.input)
    ? model.input.map((value) => String(value)).join(", ")
    : undefined;
  const contextWindow = pickNumber(model.contextWindow);
  const maxTokens = pickNumber(model.maxTokens);
  const cost = isRecord(model.cost) ? model.cost : undefined;
  const compat = isRecord(model.compat) ? model.compat : undefined;
  const headers = isRecord(model.headers) ? model.headers : undefined;
  const probe = probeCache[`${providerName}:${id}`];

  const lines = [`- ${id}${name !== id ? ` (${name})` : ""}`];
  if (input) lines.push(`  input: ${input}`);
  if (reasoning !== undefined) lines.push(`  reasoning: ${reasoning}`);
  if (contextWindow !== undefined) {
    lines.push(`  contextWindow: ${contextWindow.toLocaleString()}`);
  }
  if (probe) {
    lines.push(
      `  probedContextWindow: ${probe.contextWindow.toLocaleString()} (${probe.discoveredAt})`,
    );
  }
  if (maxTokens !== undefined) {
    lines.push(`  maxTokens: ${maxTokens.toLocaleString()}`);
  }
  if (cost) {
    lines.push(
      `  cost: input=${pickNumber(cost.input) ?? 0} output=${pickNumber(cost.output) ?? 0} cacheRead=${pickNumber(cost.cacheRead) ?? 0} cacheWrite=${pickNumber(cost.cacheWrite) ?? 0}`,
    );
  }
  if (compat && Object.keys(compat).length > 0) {
    lines.push(
      `  compat: ${Object.entries(compat)
        .map(([key, value]) => `${key}=${formatPrimitive(value)}`)
        .join(", ")}`,
    );
  }
  if (headers && Object.keys(headers).length > 0) {
    lines.push(`  headerKeys: ${Object.keys(headers).join(", ")}`);
  }
  return lines;
}

function formatProviderStatusLines(
  provider: string,
  summary: RefreshSummary,
  probeCache: ProbeCache,
): string[] {
  const status = summary.providerStatus[provider];
  const models = [...(summary.providerModels[provider] ?? [])].sort((a, b) => {
    const aName = pickString(a.name, a.id) ?? "";
    const bName = pickString(b.name, b.id) ?? "";
    return aName.localeCompare(bName);
  });

  const lines = [
    `${provider}: ${summary.providerModelCounts[provider] ?? models.length} models`,
  ];

  if (status) {
    lines.push(
      `  api: ${status.api}  authHeader: ${status.authHeader}  baseUrl: ${status.baseUrl}`,
      `  modelsUrl: ${status.modelsUrl}`,
    );
  }

  for (const model of models) {
    lines.push(...formatModelStatusLines(provider, model, probeCache));
  }

  return lines;
}

function formatSummary(summary: RefreshSummary): string {
  const loaded = summary.loadedProviders
    .map(
      (provider) =>
        `${provider}(${summary.providerModelCounts[provider] ?? 0})`,
    )
    .join(", ");
  const removed =
    summary.removedProviders.length > 0
      ? ` removed=${summary.removedProviders.join(",")}`
      : "";
  const errors =
    summary.errors.length > 0 ? ` errors=${summary.errors.length}` : "";
  return loaded
    ? `dynamic models: ${loaded}${removed}${errors}`
    : `dynamic models: none${removed}${errors}`;
}

export default function (pi: ExtensionAPI) {
  let managedProviders = new Set<string>();
  let lastSummary: RefreshSummary = {
    configPath: getConfigPath(),
    loadedProviders: [],
    removedProviders: [],
    providerModelCounts: {},
    providerModels: {},
    providerStatus: {},
    errors: [],
    skipped: [],
  };
  let refreshPromise: Promise<RefreshSummary> | null = null;

  const runRefresh = async ({
    reason,
    notify = false,
    ctx,
  }: RefreshOptions): Promise<RefreshSummary> => {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      const configPath = getConfigPath();
      debugLog(`refresh start reason=${reason} config=${configPath}`);
      const loadedProviders: string[] = [];
      const removedProviders: string[] = [];
      const providerModelCounts: Record<string, number> = {};
      const providerModels: Record<string, JsonRecord[]> = {};
      const providerStatus: Record<string, ProviderStatus> = {};
      const errors: string[] = [];
      const skipped: string[] = [];
      const nextManagedProviders = new Set<string>();

      try {
        const config = await readConfig(configPath);
        const endpoints =
          config.endpoints?.filter((endpoint) => endpoint?.enabled !== false) ??
          [];

        for (const endpoint of endpoints) {
          try {
            if (!endpoint.name?.trim())
              throw new Error("Endpoint is missing 'name'");
            if (!endpoint.baseUrl?.trim() && !endpoint.modelsUrl?.trim()) {
              throw new Error(
                `Endpoint ${endpoint.name} is missing 'baseUrl' or 'modelsUrl'`,
              );
            }

            const providerName = endpoint.name.trim();
            const authHeader = endpoint.authHeader === true;
            const resolvedApiKey = await resolveValue(endpoint.apiKey);
            const resolvedHeaders = await resolveHeaders(endpoint.headers);
            const fetchHeaders = buildFetchHeaders(
              resolvedHeaders,
              resolvedApiKey,
              authHeader,
            );
            const modelsUrl = buildModelsUrl(endpoint);
            const timeoutMs = endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            debugLog(
              `discover provider=${providerName} modelsUrl=${modelsUrl} timeoutMs=${timeoutMs}`,
            );
            const payload = await fetchJson(modelsUrl, fetchHeaders, timeoutMs);
            const rawModels = parseModelsPayload(payload);
            const models = (
              await Promise.all(
                rawModels.map((rawModel) =>
                  buildModelDefinition(rawModel, endpoint),
                ),
              )
            ).filter((model): model is JsonRecord => Boolean(model));

            if (models.length === 0) {
              skipped.push(`${providerName}: no matching chat models`);
              debugLog(
                `discover provider=${providerName} no matching chat models`,
              );
              continue;
            }

            debugLog(
              `discover provider=${providerName} matchedModels=${models.length}`,
            );

            const runtimeApiKey = resolvedApiKey ?? DEFAULT_API_KEY;
            pi.registerProvider(providerName, {
              baseUrl: trimTrailingSlashes(
                endpoint.baseUrl || new URL(".", modelsUrl).toString(),
              ),
              apiKey: runtimeApiKey,
              authHeader,
              headers: resolvedHeaders,
              api: endpoint.api ?? "openai-completions",
              models: models as never,
            });

            nextManagedProviders.add(providerName);
            loadedProviders.push(providerName);
            providerModelCounts[providerName] = models.length;
            providerModels[providerName] = models;
            providerStatus[providerName] = {
              baseUrl: trimTrailingSlashes(
                endpoint.baseUrl || new URL(".", modelsUrl).toString(),
              ),
              modelsUrl,
              api: endpoint.api ?? "openai-completions",
              authHeader,
            };
          } catch (error) {
            const message = `${endpoint.name || "<unnamed>"}: ${error instanceof Error ? error.message : String(error)}`;
            errors.push(message);
            debugLog(
              `discover provider=${endpoint.name || "<unnamed>"} failed`,
              error,
            );
            await appendLogLine("error", `refresh ${reason}: ${message}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        debugLog(
          `refresh failed before endpoint processing reason=${reason}`,
          error,
        );
        await appendLogLine("error", `refresh ${reason}: ${message}`);
      }

      for (const providerName of managedProviders) {
        if (!nextManagedProviders.has(providerName)) {
          pi.unregisterProvider(providerName);
          removedProviders.push(providerName);
        }
      }

      managedProviders = nextManagedProviders;
      lastSummary = {
        configPath,
        loadedProviders,
        removedProviders,
        providerModelCounts,
        providerModels,
        providerStatus,
        errors,
        skipped,
      };

      if (ctx?.hasUI) {
        ctx.ui.setStatus(
          "dynamic-models",
          loadedProviders.length > 0 || errors.length > 0
            ? formatSummary(lastSummary)
            : undefined,
        );
        if (notify) {
          ctx.ui.notify(
            formatSummary(lastSummary),
            errors.length > 0 ? "warning" : "info",
          );
          for (const error of errors)
            ctx.ui.notify(`dynamic models: ${error}`, "warning");
        }
      }

      if (errors.length > 0) {
        for (const error of errors)
          console.error(`[pi-dynamic-models] ${error}`);
      }

      debugLog(
        `refresh complete reason=${reason} summary=${formatSummary(lastSummary)}`,
      );
      await appendLogLine(
        errors.length > 0 ? "warning" : "info",
        `refresh ${reason}: ${formatSummary(lastSummary)}`,
      );

      return lastSummary;
    })().finally(() => {
      refreshPromise = null;
    });

    return refreshPromise;
  };

  void runRefresh({ reason: "startup" });

  pi.on("session_start", async (_event, ctx) => {
    await runRefresh({ reason: "session_start", ctx });
  });

  pi.registerCommand("dynamic-models-reload", {
    description: "Reload dynamic model providers from dynamic-models.json",
    handler: async (_args, ctx) => {
      await runRefresh({ reason: "command", ctx, notify: true });
    },
  });

  pi.registerCommand("dynamic-models-probe-context", {
    description:
      "WARNING: may keep your backend busy for 15-30 minutes; prompt cancellation is unreliable",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const model = ctx.model;
      if (!model) {
        if (ctx.hasUI)
          ctx.ui.notify("dynamic models: no current model selected", "warning");
        return;
      }

      if (!managedProviders.has(model.provider)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `dynamic models: current model ${model.provider}/${model.id} is not managed by this extension; no probing was attempted`,
            "warning",
          );
        }
        return;
      }

      const endpoint = await findConfiguredEndpoint(model.provider);
      if (!endpoint) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `dynamic models: provider ${model.provider} is not in ${getConfigPath()}`,
            "warning",
          );
        return;
      }

      if (!ctx.isIdle()) await ctx.waitForIdle();
      if (ctx.hasUI)
        ctx.ui.setWorkingMessage(
          `Probing context window for ${model.provider}/${model.id}...`,
        );

      try {
        const result = await probeContextWindow(model.id, endpoint, {
          force: true,
        });
        const lines = [
          `Model: ${model.provider}/${model.id}`,
          formatProbeResult(result),
          `Configured contextWindow in Pi: ${model.contextWindow.toLocaleString()} tokens`,
        ];
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        const message = `dynamic models: probe failed for ${model.provider}/${model.id}: ${error instanceof Error ? error.message : String(error)}`;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        console.error(`[pi-dynamic-models] ${message}`);
        debugLog(
          `probe command failed provider=${model.provider} model=${model.id}`,
          error,
        );
        await appendLogLine("error", message);
      } finally {
        if (ctx.hasUI) ctx.ui.setWorkingMessage();
      }
    },
  });

  pi.registerCommand("dynamic-models-status", {
    description: "Show the last dynamic model discovery result",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const probeCache = await readProbeCache();
      const lines = [
        `Config: ${lastSummary.configPath}`,
        `Loaded providers: ${lastSummary.loadedProviders.length > 0 ? lastSummary.loadedProviders.join(", ") : "none"}`,
      ];

      for (const provider of lastSummary.loadedProviders) {
        lines.push(
          ...formatProviderStatusLines(provider, lastSummary, probeCache),
        );
      }

      if (lastSummary.removedProviders.length > 0) {
        lines.push(
          "Removed providers:",
          ...lastSummary.removedProviders.map((entry) => `- ${entry}`),
        );
      }

      if (lastSummary.skipped.length > 0) {
        lines.push(
          "Skipped:",
          ...lastSummary.skipped.map((entry) => `- ${entry}`),
        );
      }

      if (lastSummary.errors.length > 0) {
        lines.push(
          "Errors:",
          ...lastSummary.errors.map((entry) => `- ${entry}`),
        );
      }

      if (ctx.hasUI) {
        ctx.ui.notify(
          lines.join("\n"),
          lastSummary.errors.length > 0 ? "warning" : "info",
        );
      }
    },
  });
}

export const __test__ = {
  appendLogLine,
  buildFetchHeaders,
  buildModelDefinition,
  buildModelsUrl,
  clampProbeSize,
  findConfiguredEndpoint,
  formatModelStatusLines,
  formatProbeResult,
  formatProviderStatusLines,
  formatSummary,
  generateTestPrompt,
  getProbeBreakpoints,
  getProbeBreakpointsDescending,
  globToRegExp,
  isContextLimitError,
  isLikelyEmbeddingModel,
  matchesExcludePatterns,
  matchesPatterns,
  normalizeCompat,
  normalizeCost,
  normalizeInputTypes,
  parseModelsPayload,
  pickBoolean,
  pickNumber,
  pickString,
  probeContextWindow,
  readProbeCache,
  readConfig,
  resolveHeaders,
  resolveValue,
  snapProbeSize,
  testModelContext,
  trimTrailingSlashes,
  uniqueStrings,
  writeProbeCache,
};
