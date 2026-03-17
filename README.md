# pi-dynamic-models

Pi extension that discovers models from OpenAI-compatible endpoints and registers them as Pi providers dynamically.

Instead of maintaining a static `~/.pi/agent/models.json`, you keep a small endpoint list in `~/.pi/agent/dynamic-models.json` and let the extension refresh provider/model registration automatically.

## Getting started

1. Install or symlink the extension into Pi.
2. Create `~/.pi/agent/dynamic-models.json`.
3. Add a minimal endpoint config.
4. Run `/dynamic-models-reload` in Pi.

Minimal config example:

```json
{
  "endpoints": [
    {
      "name": "my-provider",
      "baseUrl": "http://localhost:8000/v1"
    }
  ]
}
```

If your endpoint requires bearer auth, the smallest useful version is:

```json
{
  "endpoints": [
    {
      "name": "my-provider",
      "baseUrl": "http://localhost:8000/v1",
      "apiKey": "env:MY_PROVIDER_API_KEY",
      "authHeader": true
    }
  ]
}
```

## Features

- discovers models from OpenAI-compatible `GET /v1/models` endpoints
- registers one Pi provider per configured endpoint with `pi.registerProvider()`
- removes providers that disappear from config on the next refresh
- filters out embedding models by default
- supports provider-level defaults and per-model overrides
- supports auth via bearer token, custom headers, env vars, and shell commands
- exposes commands for reload, status, and context probing
- logs refresh/probe activity to `~/.pi/agent/dynamic-models.log`
- supports verbose debug logging with `PI_DYNAMIC_MODELS_DEBUG=1`

## Commands

- `/dynamic-models-reload`
  - reloads endpoints from config and re-registers providers
- `/dynamic-models-status`
  - shows all currently discovered providers and models, including known metadata
  - includes cached probed context windows when available
- `/dynamic-models-probe-context`
  - WARNING: do not casually try this command
  - it has a high chance of keeping your backend very busy for 15-30 minutes
  - prompt cancellation does not work reliably on many backends
  - probes the currently selected model if it belongs to a provider managed by this extension
  - always performs a fresh probe when explicitly invoked
  - updates the cached probe result used by status output

## How it works

At startup and on `session_start`, the extension:

1. reads `~/.pi/agent/dynamic-models.json`
2. fetches each endpoint's model list
3. normalizes the returned model metadata
4. applies defaults and per-model overrides
5. registers a Pi provider for that endpoint

If an endpoint is removed from config, its provider is unregistered on the next refresh.

## Installation

### Quick test

```bash
pi -e ~/Documents/code/pi-dynamic-models
```

### Recommended

Put the project in Pi's extension discovery directory so `/reload` works naturally:

```bash
ln -s ~/Documents/code/pi-dynamic-models ~/.pi/agent/extensions/pi-dynamic-models
```

## Configuration

Default config path:

```text
~/.pi/agent/dynamic-models.json
```

Override it with:

```bash
export PI_DYNAMIC_MODELS_CONFIG=/path/to/dynamic-models.json
```

### Top-level shape

```json
{
  "endpoints": []
}
```

### Endpoint fields

Each endpoint supports:

- `name`: provider name as shown in Pi
- `baseUrl`: base API URL, usually ending in `/v1`
- `modelsUrl`: optional full URL for model discovery
- `modelsPath`: optional path appended to `baseUrl`, default: `models`
- `api`: Pi provider API type, default: `openai-completions`
  - allowed values:
    - `openai-completions`
    - `openai-responses`
- `apiKey`: optional auth value
  - literal string: `"abc123"`
  - env var: `"env:MY_API_KEY"`
  - shell command: `"!security find-generic-password -ws my-key"`
- `authHeader`: when `true`, sends `Authorization: Bearer <apiKey>`
- `headers`: additional request headers using the same value formats as `apiKey`
- `timeoutMs`: request timeout for model discovery
- `enabled`: enable/disable endpoint
- `includeEmbeddings`: include embedding models, default `false`
- `includePatterns`: only include matching model IDs, glob syntax
- `excludePatterns`: exclude matching model IDs, glob syntax
- `defaults`: fallback metadata for discovered models
- `modelOverrides`: exact model-id overrides

### `defaults` and `modelOverrides`

Supported fields:

- `name`
- `reasoning`
- `input`
- `contextWindow`
- `maxTokens`
- `cost`
- `compat`
- `headers`

`modelOverrides` also supports:

- `enabled`

## Example config

```json
{
  "endpoints": [
    {
      "name": "octopus-oMLX",
      "baseUrl": "http://octopus:8000/v1",
      "apiKey": "env:OCTOPUS_API_KEY",
      "authHeader": true,
      "defaults": {
        "reasoning": true,
        "input": ["text"],
        "contextWindow": 262144,
        "maxTokens": 32768,
        "compat": {
          "supportsDeveloperRole": false,
          "supportsReasoningEffort": false,
          "thinkingFormat": "qwen-chat-template"
        }
      },
      "excludePatterns": ["text-embedding-*", "*embedding*", "*embed*"],
      "modelOverrides": {
        "Qwen3.5-122B-A10B-5bit": {
          "name": "Qwen3.5 122B A10B 5bit",
          "maxTokens": 65536
        }
      }
    }
  ]
}
```

A more minimal example is also available in:

- `dynamic-models.example.json`

## Authentication

### Standard bearer auth

If your endpoint expects:

```http
Authorization: Bearer <token>
```

use:

```json
{
  "apiKey": "env:OCTOPUS_API_KEY",
  "authHeader": true
}
```

### Custom header auth

If your endpoint expects something like `x-api-key`:

```json
{
  "authHeader": false,
  "headers": {
    "x-api-key": "env:OCTOPUS_API_KEY"
  }
}
```

### Shell-command-backed secrets

```json
{
  "apiKey": "!security find-generic-password -ws octopus-api-key",
  "authHeader": true
}
```

## Model normalization

Many OpenAI-compatible `/v1/models` endpoints only return a model id and very little metadata.

This extension tries to infer or normalize from several common field names, including:

- model id/name
- context window
- max output tokens
- reasoning support
- input modalities
- cost/pricing
- compat flags

When an endpoint does not return enough metadata, `defaults` and `modelOverrides` fill the gap.

## Status output

`/dynamic-models-status` shows:

- config path
- loaded providers
- per-provider metadata such as base URL, models URL, API type, authHeader
- every discovered model
- known metadata for each model
- cached probed context window if available
- skipped providers
- errors from the last refresh

## Context probing

### Warning

Do **not** casually try `/dynamic-models-probe-context`.

It has a high chance of keeping your backend very busy for 15-30 minutes, because prompt cancellation does not work reliably on many backends.

`/dynamic-models-probe-context` tries to estimate the effective context window of the currently selected dynamic model.

What it does:

- probes only the current model
- refuses to probe models not managed by this extension
- writes the result to the local probe cache
- logs the result to the extension log file

Probe cache path:

```text
~/.pi/agent/dynamic-models-cache.json
```

### Important caveats

Context probing is inherently approximate.

Why:

- providers validate actual tokenizer tokens, while the extension sends a synthetic prompt
- some providers expose a hard context error, others fail in less predictable ways
- some backends may continue processing after the client disconnects
- some failures are memory/load-related rather than pure context-length failures

In other words, the probe result is best interpreted as an **effective operational context window**, not an exact architectural maximum.

### Backend caveat: disconnect behavior

The extension aggressively aborts successful probe requests on the client side, but not all backends stop immediately when the client disconnects.

For some servers, especially large local inference backends, a large probe request may still continue prompt processing briefly even after the client has aborted the request.

If your backend behaves this way, avoid relying on probe results as a zero-cost operation.

## Logging

Log file:

```text
~/.pi/agent/dynamic-models.log
```

The extension appends:

- refresh summaries
- discovery errors
- probe successes
- probe failures

Enable verbose console debugging with:

```bash
export PI_DYNAMIC_MODELS_DEBUG=1
```

This adds debug output for:

- refresh start/finish
- endpoint discovery attempts
- model counts
- probe requests and refinement steps
- cache hits / forced reprobes
- error context

## Notes

- embedding models are excluded by default because Pi expects chat/tool-capable models
- the extension refreshes on startup and on `session_start`
- disappearing endpoints are unregistered automatically
- the probe command re-probes even if a cached result already exists
- the status command shows cached probed context if available

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Coverage:

```bash
npm run test:coverage
```

## Repository structure

- `index.ts`: extension implementation
- `dynamic-models.example.json`: minimal example config
- `test/`: tests
- `package.json`: extension package metadata and scripts

## License

No license has been added yet.
