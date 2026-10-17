# pi-ollama-models

[English](README.md) · 简体中文

**Ollama cloud models × Pi**：把 ollama.com 云模型目录整体接入 Pi 的 `/model` —— 无需 `ollama pull`、无需手写 `models.json`，新鲜度阈值内零网络请求，过期自动同步。本地模型顺带支持。

## 定位

| | 支持 |
| --- | --- |
| ☁️ **云模型（`*:cloud`）** | **核心目标**。完整目录实时发现、真实上下文长度、thinking 档位、精确的 max_tokens —— 全部经真实请求验证 |
| 💾 本地模型（GGUF） | 顺带支持。同一套发现/过滤流程；`num_ctx` 相关的注意事项见下文 |
| 🚫 非目标 | 计费追踪（cost 恒为 0，云模型按 Ollama 账号订阅计费）、本地 `num_ctx` 调优工具、非聊天模型（分类器 / embedding 自动剔除） |

## 为什么需要

- ollama.com 有 20+ 云模型（GLM、Kimi、DeepSeek、gpt-oss、Nemotron、mistral-large…），但本地 `/api/tags` 只列出你拉取或用过的，`models.json` 里的静态列表每次目录变化都要手动维护。
- Pi 原生支持 Ollama 的 OpenAI 兼容端点，缺的只是一份**完整且元数据正确**的模型目录 —— 这正是本插件做的事。

## 快速开始

```bash
pi install npm:pi-ollama-models     # 或本地路径 / git
```

启动 pi → `/model` → Ollama 下直接选云模型（如 `ollama/glm-5.3-flash:cloud`）。要求 Ollama 侧已登录（`ollama signin`）。

无配置即可使用；可选配置文件 `~/.pi/agent/ollama-models.json`（见下文，示例见 `ollama-models.example.json`）。

## 云模型（核心）

云模型经本地 Ollama 代理到 ollama.com。扩展默认合并 `https://ollama.com/api/tags` 的**完整云目录**（`cloudCatalog: false` 可关），目录条目注册为 `{name}:cloud`，与本地已有条目去重。以下各项均经真实请求验证（2026-10，Ollama 0.40.6）：

- **目录映射**：`{目录名}:cloud` 注册后正确路由到对应远端变体（实测 `gemma4:31b:cloud` → 上游 `gemma4:31b`）。
- **上下文**：云模型默认使用其最大上下文，各模型真实值（128k–1M）由 `/api/show` 补齐（云目录本身不带 ctx），无本地模型的 `num_ctx` 截断问题。
- **max_tokens**：被精确尊重（实测 `max_tokens=20` → `completion_tokens=20`、`finish_reason=length`）；扩展始终发送显式上限（默认 `min(ctx, 32768)`），可用 `modelOverrides[id].maxTokens` 调高。
- **thinking**：`reasoning_effort` 实测生效（`none` → 零思考输出，`low`/`max` 思考量递增）；`/api/show` 报告的 `thinking.values` 自动映射为 pi 的 `thinkingLevelMap`（含布尔开关型模型与原生 `xhigh` 档），`/thinking` 直接选档。
- **工具 / 视觉**：capabilities 中的 `tools` / `vision` 正确反映；非聊天条目（如分类器 `clef:27b`）自动剔除。
- **cost**：报告为 0（计费走 Ollama 账号订阅，无按 token 价格数据可查）。

## 刷新策略

扩展注册 provider 时挂上 pi 的 `refreshModels` 钩子 —— pi 在每次打开 `/model`、交互模式启动、`/login` 时自动调用它（15 秒超时、带取消信号）。扩展并不每次都打网络：

- **新鲜期内（默认 7 天，`refreshAfterMs`）零网络请求**：直接用缓存（缓存文件记录拉取时间，跨重启生效）；
- **过期后自动刷新**：下一次打开 `/model`（或启动）时拉取一次并重置计时；
- **手动强制**：`/ollama-refresh` 随时绕过阈值（比如想立刻同步云目录）；
- 并发调用自动去重；`refreshAfterMs: 0` 可退回"每次都拉"。

> 注意权衡：新鲜期内云目录的变化（新模型上线）不会立即出现，需 `/ollama-refresh` 或等阈值到期。

## 过滤器（filters）

语义对齐 pi-live-models：

- **什么都不配** → 全部保留（仅内置默认黑名单 `*embed*`）；配置了任意 exclude 规则后即完全接管。
- **exclude 永远优先**：被排除的模型不能被任何 include 规则救回。
- **include 非空即白名单**：id 必须命中 ≥1 条 `include`/`includeRegex`，且命中每一条 `includeBy` 字段（AND）。
- **通配符大小写不敏感**（`*kimi*`），**正则大小写敏感**（需要不敏感用 `(?i)`）；非法正则警告后忽略，不会弄坏启动。
- **字段规则（`*By`）**：对 `/api/tags` 条目取点路径（云模型条目含合并后的 `capabilities`）。字符串按大小写不敏感通配匹配；数组任一元素命中即命中；字段缺失/非字符串永不命中 exclude、必然未命中 include。

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

常用字段路径：`capabilities`（数组：`completion`/`thinking`/`tools`/`vision`）、`details.family`、`details.parameter_size`、`details.quantization_level`、`name`/`id`。

重要：过滤器/overrides 在**每次加载时对缓存的原始条目重新应用**（缓存 v2 存 raw items + /api/show 结果），所以改配置后 `/reload` 立即生效，无需等目录过期或强制拉取。旧版 `includePatterns`/`excludePatterns` 仍支持，与 `filters` 取并集。

## 本地模型（次要）

本地 GGUF 模型走同一套发现/过滤流程，但要注意上下文语义与云模型不同：

- Ollama 实际生效的上下文是 `num_ctx`：Modelfile 的 `PARAMETER num_ctx` 优先，否则 `OLLAMA_CONTEXT_LENGTH` 或按显存自动档（<24GiB→4k，24–48GiB→32k，≥48GiB→256k），且不超过模型上限。
- 扩展按**最小值原则**取 `num_ctx`、tags `context_length`、GGUF `context_length` 三者中最小的 —— 高估会让 Pi 跳过压缩而 Ollama 静默移除旧历史。都拿不到时回落 `defaultContextWindow`（默认 4096）。
- 本地模型要跑编码 agent，建议 `OLLAMA_CONTEXT_LENGTH=64000 ollama serve` 或 Modelfile 里设 `PARAMETER num_ctx 64000`，然后 `/ollama-refresh`，`/ollama-status` 可核对。

## 配置参考

可选文件 `~/.pi/agent/ollama-models.json`（`PI_OLLAMA_MODELS_CONFIG` 可覆盖路径）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://localhost:11434` | Ollama 根地址（不要加 `/v1`） |
| `providerId` | `ollama` | Pi 里的 provider id → `ollama/模型名` |
| `cloudCatalog` | `true` | 合并 ollama.com 完整云目录 |
| `cloudCatalogUrl` | ollama.com/api/tags | 云目录地址 |
| `refreshAfterMs` | 7 天 | 目录新鲜度阈值；0 = 每次都拉 |
| `show` / `showConcurrency` | `true` / 6 | 每模型 `/api/show` 补全元数据 |
| `contextWindow` | `"auto"` | `"auto"` = 取各来源最小值；或固定数字 |
| `defaultContextWindow` | 4096 | 无任何报告值时的回落 |
| `maxTokens` | `min(ctx, 32768)` | 输出上限 |
| `annotateName` | `true` | `/model` 里显示 "321B FP8" 之类标注 |
| `filters` / `presets` / `defaultFilters` | — | 见过滤器一节 |
| `includePatterns` / `excludePatterns` | — | 旧版写法，仍支持（与 filters 取并集） |
| `defaults` / `modelOverrides` | — | 元数据兜底 / 按模型 id 覆盖（`name`、`reasoning`、`input`、`contextWindow`、`maxTokens`、`compat`、`enabled`） |

## 命令

（TUI 内输入 `/` 后的斜杠命令，非 CLI 子命令）

| 命令 | 作用 |
| --- | --- |
| `/ollama-refresh` | **强制**重新发现（绕过新鲜度阈值）并重新注册 provider |
| `/ollama-status` | 列出已发现的模型及元数据（ctx / maxOut / reasoning / input / thinking 档位）、目录年龄、过滤器摘要 |
| `/ollama-reload` | 重读配置文件并强制刷新 |

## 故障行为

- `/model` 打开时刷新失败：pi 保留当前列表并在选择器里显示错误。
- 启动 / `session_start` 时 Ollama 不可达：回落到内存中上一次的好列表或磁盘缓存（`~/.pi/agent/ollama-models-cache.json`），UI 提示，之后自动重试。
- 云目录拉取失败：降级为仅本地模型并告警。
- 单个 `/api/show` 失败：仅该模型退化为 tags-only 元数据。
- 发现结果为 0：视为失败（同上回落），提示先 `ollama pull`。

## 与 `models.json` 的关系

本扩展注册同名 provider（默认 `ollama`）会替换其静态模型列表；如果之前在 `models.json` 里手写过 ollama 条目，建议删掉。注册时带一个哑 key（`"ollama"`），Ollama 忽略它；云模型需 Ollama 侧已登录。

## 开发

```bash
npm install          # 安装 typescript + pi 类型（仅开发用，运行时零依赖）
npm run typecheck    # tsc --noEmit
node --experimental-strip-types scripts/smoke.ts   # 对本机 Ollama 干跑注册 + refreshModels 流程
```

扩展运行时零依赖：Pi 通过 jiti 直接加载 `src/index.ts`。

## License

MIT