import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function createTempHome(config: unknown): Promise<{
  homeDir: string;
  agentDir: string;
  configPath: string;
}> {
  const homeDir = await mkdtemp(join(tmpdir(), "pi-dynamic-models-"));
  const agentDir = join(homeDir, ".pi", "agent");
  const configPath = join(agentDir, "dynamic-models.json");
  await mkdir(agentDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  return { homeDir, agentDir, configPath };
}

async function loadModule(config: unknown) {
  const paths = await createTempHome(config);
  vi.resetModules();
  vi.stubEnv("HOME", paths.homeDir);
  vi.stubEnv("PI_DYNAMIC_MODELS_CONFIG", paths.configPath);
  const mod = await import("../index.ts");
  return { ...paths, mod };
}

function createPiMock() {
  const providers = new Map<string, any>();
  const commands = new Map<string, any>();
  const events = new Map<string, any>();

  return {
    providers,
    commands,
    events,
    registerProvider: vi.fn((name: string, config: any) => {
      providers.set(name, config);
    }),
    unregisterProvider: vi.fn((name: string) => {
      providers.delete(name);
    }),
    registerCommand: vi.fn((name: string, command: any) => {
      commands.set(name, command);
    }),
    on: vi.fn((event: string, handler: any) => {
      events.set(event, handler);
    }),
  };
}

function createCommandContext(overrides: Record<string, unknown> = {}) {
  const ui = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
  };

  return {
    hasUI: true,
    ui,
    model: undefined,
    isIdle: vi.fn(() => true),
    waitForIdle: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("pi-dynamic-models", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds model definitions with defaults, overrides, and resolved headers", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("MODEL_HEADER_TOKEN", "secret-token");
    const { mod } = await loadModule({ endpoints: [] });
    const { buildModelDefinition } = mod.__test__;

    const definition = await buildModelDefinition(
      {
        id: "gpt-pro",
        name: "Raw Name",
        modalities: ["text", "image"],
        metadata: { context_length: "262144" },
        pricing: { prompt: "0.1", completion: "0.2" },
        compat: { rawCompat: true },
      },
      {
        name: "demo",
        baseUrl: "https://example.com/v1",
        defaults: {
          reasoning: false,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 8192,
          cost: { input: 1, output: 2 },
          compat: { defaultCompat: true },
          headers: { "x-default": "env:MODEL_HEADER_TOKEN" },
        },
        modelOverrides: {
          "gpt-pro": {
            name: "GPT Pro",
            reasoning: true,
            maxTokens: 16384,
            compat: { overrideCompat: "yes" },
            headers: { "x-override": { literal: "override-value" } },
          },
        },
      },
    );

    expect(definition).toEqual({
      id: "gpt-pro",
      name: "GPT Pro",
      reasoning: true,
      input: ["text", "image"],
      cost: {
        input: 0.1,
        output: 0.2,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 262144,
      maxTokens: 16384,
      compat: {
        rawCompat: true,
        defaultCompat: true,
        overrideCompat: "yes",
      },
      headers: {
        "x-default": "secret-token",
        "x-override": "override-value",
      },
    });
  });

  it("filters embeddings and applies include/exclude glob patterns", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { mod } = await loadModule({ endpoints: [] });
    const { buildModelDefinition } = mod.__test__;
    const endpoint = {
      name: "demo",
      baseUrl: "https://example.com/v1",
      includePatterns: ["gpt-*"],
      excludePatterns: ["*mini"],
    };

    await expect(
      buildModelDefinition({ id: "text-embedding-3-small" }, endpoint),
    ).resolves.toBeUndefined();

    await expect(
      buildModelDefinition({ id: "gpt-4o-mini" }, endpoint),
    ).resolves.toBeUndefined();

    await expect(
      buildModelDefinition({ id: "gpt-4o", modalities: ["text"] }, endpoint),
    ).resolves.toMatchObject({ id: "gpt-4o" });
  });

  it("builds model discovery URLs, headers, and parses common payload shapes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { mod } = await loadModule({ endpoints: [] });
    const { buildModelsUrl, buildFetchHeaders, parseModelsPayload } = mod.__test__;

    expect(
      buildModelsUrl({
        name: "demo",
        baseUrl: "https://example.com/v1/",
        modelsPath: "/catalog/models",
      }),
    ).toBe("https://example.com/v1/catalog/models");

    expect(
      buildFetchHeaders({ "x-api-version": "2026-03-17" }, "secret", true),
    ).toEqual({
      Accept: "application/json",
      Authorization: "Bearer secret",
      "x-api-version": "2026-03-17",
    });

    expect(parseModelsPayload({ data: [1] })).toEqual([1]);
    expect(parseModelsPayload({ models: [2] })).toEqual([2]);
    expect(parseModelsPayload({ items: [3] })).toEqual([3]);
    expect(parseModelsPayload("invalid")).toEqual([]);
  });

  it("returns cached probe results without making network requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { agentDir, mod } = await loadModule({ endpoints: [] });

    await mod.__test__.writeProbeCache({
      "demo:model-a": {
        contextWindow: 8192,
        discoveredAt: "2026-03-17T12:00:00.000Z",
        endpointName: "demo",
        modelId: "model-a",
      },
    });

    expect(agentDir.endsWith(join(".pi", "agent"))).toBe(true);

    const result = await mod.__test__.probeContextWindow("model-a", {
      name: "demo",
      baseUrl: "https://example.com/v1",
    });

    expect(result).toEqual({
      modelId: "model-a",
      contextWindow: 8192,
      iterations: 0,
      durationMs: 0,
      fromCache: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("registers providers on startup and shows rich status output", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: "gpt-4o",
            name: "GPT 4o",
            modalities: ["text", "image"],
            reasoning: true,
            context_window: 128000,
            max_tokens: 4096,
            pricing: { input: 0.1, output: 0.2 },
            compat: { supportsTools: true },
          },
          {
            id: "text-embedding-3-small",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { agentDir, mod } = await loadModule({
      endpoints: [
        {
          name: "demo",
          baseUrl: "https://example.com/v1",
          authHeader: true,
          apiKey: "env:DEMO_API_KEY",
        },
      ],
    });
    vi.stubEnv("DEMO_API_KEY", "secret-key");

    const pi = createPiMock();
    mod.default(pi as any);

    await vi.waitFor(() => {
      expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );

    expect(pi.providers.get("demo")).toMatchObject({
      baseUrl: "https://example.com/v1",
      apiKey: "secret-key",
      authHeader: true,
      api: "openai-completions",
      models: [
        expect.objectContaining({
          id: "gpt-4o",
          name: "GPT 4o",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 4096,
        }),
      ],
    });

    await writeFile(
      join(agentDir, "dynamic-models-cache.json"),
      JSON.stringify(
        {
          "demo:gpt-4o": {
            contextWindow: 262144,
            discoveredAt: "2026-03-17T12:34:56.000Z",
            endpointName: "demo",
            modelId: "gpt-4o",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const statusHandler = pi.commands.get("dynamic-models-status")?.handler;
    const ctx = createCommandContext();
    await statusHandler([], ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Loaded providers: demo"),
      "info",
    );

    const statusText = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(statusText).toContain("demo: 1 models");
    expect(statusText).toContain("api: openai-completions");
    expect(statusText).toContain("baseUrl: https://example.com/v1");
    expect(statusText).toContain("modelsUrl: https://example.com/v1/models");
    expect(statusText).toContain("- gpt-4o (GPT 4o)");
    expect(statusText).toContain("probedContextWindow: 262,144");
  });

  it("shows skipped endpoints and refresh errors in status output", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("skip.example")) {
        return jsonResponse({ data: [{ id: "text-embedding-3-small" }] });
      }
      return new Response("boom", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { mod } = await loadModule({
      endpoints: [
        {
          name: "skip-me",
          baseUrl: "https://skip.example/v1",
        },
        {
          name: "broken",
          baseUrl: "https://broken.example/v1",
        },
      ],
    });
    const pi = createPiMock();
    mod.default(pi as any);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const statusHandler = pi.commands.get("dynamic-models-status")?.handler;
    const ctx = createCommandContext();
    await statusHandler([], ctx);

    const statusText = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(statusText).toContain("Skipped:");
    expect(statusText).toContain("- skip-me: no matching chat models");
    expect(statusText).toContain("Errors:");
    expect(statusText).toContain("- broken: HTTP 500: boom");
  });

  it("unregisters providers removed from config and reports them in status", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "gpt-4o", modalities: ["text"] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const initialConfig = {
      endpoints: [
        {
          name: "demo",
          baseUrl: "https://example.com/v1",
        },
      ],
    };
    const { configPath, mod } = await loadModule(initialConfig);
    const pi = createPiMock();
    mod.default(pi as any);

    await vi.waitFor(() => {
      expect(pi.registerProvider).toHaveBeenCalledTimes(1);
    });

    await writeFile(configPath, JSON.stringify({ endpoints: [] }, null, 2), "utf8");

    const sessionStartHandler = pi.events.get("session_start");
    const refreshCtx = createCommandContext();
    await sessionStartHandler?.({}, refreshCtx);

    expect(pi.unregisterProvider).toHaveBeenCalledWith("demo");

    const statusHandler = pi.commands.get("dynamic-models-status")?.handler;
    const statusCtx = createCommandContext();
    await statusHandler([], statusCtx);

    const statusText = statusCtx.ui.notify.mock.calls.at(-1)?.[0] as string;
    expect(statusText).toContain("Removed providers:");
    expect(statusText).toContain("- demo");
  });

  it("warns clearly when probing a model not managed by the extension", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: [] })));
    const { mod } = await loadModule({ endpoints: [] });
    const pi = createPiMock();
    mod.default(pi as any);

    const probeHandler = pi.commands.get("dynamic-models-probe-context")?.handler;
    const ctx = createCommandContext({
      model: {
        provider: "other",
        id: "model-a",
        contextWindow: 8192,
      },
    });

    await probeHandler([], ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "dynamic models: current model other/model-a is not managed by this extension; no probing was attempted",
      "warning",
    );
  });
});
