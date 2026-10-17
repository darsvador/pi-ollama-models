# pi-ollama-models

English · [简体中文](README.zh-CN.md)

**Ollama cloud models × Pi** — plug the entire ollama.com cloud model catalog into Pi's `/model`. No `ollama pull`, no hand-written `models.json`; zero network requests while the catalog is fresh, automatic sync once it expires. Local models are supported as a bonus.

## Positioning

| | Scope |
| --- | --- |
| ☁️ **Cloud models (`*:cloud`)** | **The core goal.** Full catalog discovery, real context windows, thinking levels, precise max_tokens — all verified against real requests |
| 💾 Local models (GGUF) | Bonus. Same discovery/filter pipeline; see `num_ctx` notes below |
| 🚫 Non-goals | Billing/cost tracking (cost is always 0 — cloud models bill via your Ollama account), local `num_ctx` tuning tools, non-chat models (classifiers / embeddings are dropped automatically) |

## Why

- ollama.com serves 20+ cloud models (GLM, Kimi, DeepSeek, gpt-oss, Nemotron, mistral-large, …), but your local `/api/tags` only lists models you have pulled or used, and a static `models.json` needs manual maintenance every time the catalog changes.
- Pi natively supports Ollama's OpenAI-compatible endpoint. What's missing is a **complete model catalog with correct metadata** — exactly what this extension provides.

## Quick start

```bash
pi install npm:pi-ollama-models     # or a local path / git
```

Start pi → `/model` → pick a cloud model under Ollama (e.g. `ollama/glm-5.3-flash:cloud`). Requires being signed in on the Ollama side (`ollama signin`).

Works with no configuration; optional config file at `~/.pi/agent/ollama-models.json` (see below, example in `ollama-models.example.json`).

## Cloud models (core)

Cloud models are proxied through your local Ollama to ollama.com. The extension merges the **full cloud catalog** from `https://ollama.com/api/tags` by default (`cloudCatalog: false` to disable); catalog entries are registered as `{name}:cloud` and deduplicated against local entries. Everything below was verified against real requests (2026-10, Ollama 0.40.6):

- **Catalog mapping**: `{catalog-name}:cloud` routes to the correct remote variant (verified: `gemma4:31b:cloud` → upstream `gemma4:31b`).
- **Context**: cloud models default to their maximum context; real per-model values (128k–1M) are filled in from `/api/show` (the cloud catalog itself does not carry ctx). No `num_ctx` truncation issues.
- **max_tokens**: honored precisely (verified: `max_tokens=20` → `completion_tokens=20`, `finish_reason=length`); the extension always sends an explicit cap (default `min(ctx, 32768)`), raise via `modelOverrides[id].maxTokens`.
- **Thinking**: `reasoning_effort` works (verified: `none` → zero thinking output; `low`/`max` scale thinking); `thinking.values` from `/api/show` is mapped to pi's `thinkingLevelMap` (handles boolean-switch models and native `xhigh`), selectable via `/thinking`.
- **Tools / vision**: `tools` / `vision` capabilities are reflected; non-chat entries (e.g. the `clef:27b` classifier) are dropped automatically.
- **Cost**: reported as 0 (cloud models bill through your Ollama account subscription; no per-token pricing data available).

## Refresh policy

The extension registers the provider with pi's `refreshModels` hook — pi calls it every time you open `/model`, on interactive startup, and after `/login` (15s timeout, with a cancellation signal). The extension does **not** hit the network every time:

- **While fresh (default 7 days, `refreshAfterMs`): zero network requests** — served from cache (the cache file records the fetch time and survives restarts);
- **After expiry**: the next `/model` open (or startup) triggers a single fetch and resets the clock;
- **Manual**: `/ollama-refresh` bypasses the threshold at any time (e.g. to sync the cloud catalog immediately);
- Concurrent calls are deduplicated; `refreshAfterMs: 0` restores fetch-on-every-open behavior.

> Trade-off: catalog changes during the freshness window (new models coming online) do not appear immediately — run `/ollama-refresh` or wait for the threshold.

## Filters

Semantics aligned with pi-live-models:

- **Nothing configured** → everything passes (plus a built-in default `*embed*` blacklist); configuring any exclude rule takes full control.
- **Exclude always wins**: an excluded model cannot be rescued by any include rule.
- **A non-empty include set is a whitelist**: the id must match ≥1 `include`/`includeRegex` pattern AND match every `includeBy` field (AND).
- **Globs are case-insensitive** (`*kimi*`), **regexes case-sensitive** (use `(?i)` if needed); invalid regexes are warned about and ignored — they never break startup.
- **Field rules (`*By`)**: dotted paths into the `/api/tags` item (cloud entries include merged `capabilities`). Strings match case-insensitive globs; arrays match if any element hits; missing/non-string fields never match excludes and always fail includes.

```jsonc
{
	"presets": {
		"vision-only": { "includeBy": { "capabilities": ["vision"] } }
	},
	"filters": {
		"use": ["vision-only"],
		"exclude": ["*embed*", "*audio*"],
		"excludeRegex": ["^gpt-oss"],
		"excludeBy": { "details.parameter_size": ["321B"] }
	}
}
```

Useful field paths: `capabilities` (array: `completion`/`thinking`/`tools`/`vision`), `details.family`, `details.parameter_size`, `details.quantization_level`, `name`/`id`.

Important: filters/overrides are **re-applied to the cached raw items on every load** (cache v2 stores raw items + `/api/show` results), so config edits take effect on `/reload` immediately — no need to wait for the threshold or force a fetch. Legacy `includePatterns`/`excludePatterns` are still supported and unioned with `filters`.

## Local models (secondary)

Local GGUF models go through the same discovery/filter pipeline, but their context semantics differ from cloud models:

- The context Ollama actually enforces is `num_ctx`: a Modelfile `PARAMETER num_ctx` wins, otherwise `OLLAMA_CONTEXT_LENGTH` or VRAM-based defaults (<24GiB→4k, 24–48GiB→32k, ≥48GiB→256k), capped by the model's maximum.
- The extension takes the **smallest** of `num_ctx`, tags `context_length` and GGUF `context_length` — overstating it would make Pi skip compaction while Ollama silently shifts old history out of its buffer. If nothing is reported it falls back to `defaultContextWindow` (default 4096).
- To run coding agents on local models, set `OLLAMA_CONTEXT_LENGTH=64000 ollama serve` or add `PARAMETER num_ctx 64000` in the Modelfile, then `/ollama-refresh`; `/ollama-status` shows the effective value per model.

## Configuration reference

Optional file `~/.pi/agent/ollama-models.json` (`PI_OLLAMA_MODELS_CONFIG` overrides the path):

| Field | Default | Description |
| --- | --- | --- |
| `baseUrl` | `http://localhost:11434` | Ollama root URL (do NOT append `/v1`) |
| `providerId` | `ollama` | Provider id in Pi → `ollama/<model>` |
| `cloudCatalog` | `true` | Merge the full ollama.com cloud catalog |
| `cloudCatalogUrl` | ollama.com/api/tags | Cloud catalog URL |
| `refreshAfterMs` | 7 days | Catalog freshness threshold; 0 = fetch every time |
| `show` / `showConcurrency` | `true` / 6 | Per-model `/api/show` metadata enrichment |
| `contextWindow` | `"auto"` | `"auto"` = smallest of the reported sources; or a fixed number |
| `defaultContextWindow` | 4096 | Fallback when nothing is reported |
| `maxTokens` | `min(ctx, 32768)` | Output cap |
| `annotateName` | `true` | Show "321B FP8"-style annotations in `/model` |
| `filters` / `presets` / `defaultFilters` | — | See the Filters section |
| `includePatterns` / `excludePatterns` | — | Legacy syntax, still supported (unioned with `filters`) |
| `defaults` / `modelOverrides` | — | Metadata fallbacks / per-model overrides (`name`, `reasoning`, `input`, `contextWindow`, `maxTokens`, `compat`, `enabled`) |

## Commands

(Slash commands inside the TUI, not CLI subcommands)

| Command | Action |
| --- | --- |
| `/ollama-refresh` | **Force** re-discovery (bypasses the freshness threshold) and re-register the provider |
| `/ollama-status` | List discovered models with metadata (ctx / maxOut / reasoning / input / thinking levels), catalog age, filter summary |
| `/ollama-reload` | Re-read the config file and force-refresh |

## Failure behavior

- Refresh failure while opening `/model`: pi keeps the current list and shows the error in the picker.
- Ollama unreachable at startup / `session_start`: falls back to the in-memory last-good list or the disk cache (`~/.pi/agent/ollama-models-cache.json`), warns in the UI, and retries automatically.
- Cloud catalog fetch failure: degrades to local models only, with a warning.
- Single `/api/show` failure: only that model degrades to tags-only metadata.
- Zero models discovered: treated as a failure (same fallback), hinting to `ollama pull` first.

## Relationship with `models.json`

The extension registers a provider with the same id (default `ollama`) and replaces its static model list; if you previously hand-wrote an ollama entry in `models.json`, consider removing it. Registration carries a dummy key (`"ollama"`) which Ollama ignores; cloud models require being signed in on the Ollama side.

## Development

```bash
npm install          # installs typescript + pi types (dev only — zero runtime deps)
npm run typecheck    # tsc --noEmit
node --experimental-strip-types scripts/smoke.ts   # dry-run registration + refreshModels against a local Ollama
```

The extension has zero runtime dependencies: Pi loads `src/index.ts` directly via jiti.

## License

MIT