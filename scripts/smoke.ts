/**
 * Smoke test: run the extension factory against a stubbed ExtensionAPI and a
 * real Ollama server (default http://localhost:11434), print what would be
 * registered, then exercise the refreshModels hook the /model picker calls.
 * Usage: node --experimental-strip-types scripts/smoke.ts
 */
const registered = new Map();
const fetchCalls = { tags: 0, show: 0 };

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const target = String(url instanceof URL ? url : url);
	if (target.endsWith("/api/tags")) fetchCalls.tags++;
	else if (target.endsWith("/api/show")) fetchCalls.show++;
	return realFetch(url, init);
};

const pi = {
	registerProvider(name, config) {
		registered.set(name, config);
	},
	unregisterProvider(name) {
		registered.delete(name);
	},
	registerCommand() {},
	on() {},
};

const { default: factory } = await import("../src/index.ts");
await factory(pi);

for (const [name, config] of registered) {
	console.log(`provider "${name}"  baseUrl=${config.baseUrl}  api=${config.api}  refreshModels=${typeof config.refreshModels}`);
	for (const model of config.models) {
		console.log(
			`  - ${model.id}\n      name=${model.name} | ctx=${model.contextWindow} | maxOut=${model.maxTokens} | reasoning=${model.reasoning} | input=${model.input.join("+")}${model.thinkingLevelMap ? ` | thinking=${JSON.stringify(model.thinkingLevelMap)}` : ""}`,
		);
	}
}

const provider = registered.get("ollama");
if (!provider?.refreshModels) {
	console.log("FAIL: provider has no refreshModels hook (auto-refresh would not work)");
	process.exitCode = 1;
} else {
	const signal = AbortSignal.timeout(15_000);

	// 1. Restore phase (allowNetwork: false) must not hit the network.
	const before = { ...fetchCalls };
	const restored = await provider.refreshModels({ allowNetwork: false, signal });
	console.log(`restore phase: returned ${restored.length} models, network calls: tags=${fetchCalls.tags - before.tags} show=${fetchCalls.show - before.show}`);

	// 2. Network phase (what /model open triggers) fetches fresh.
	const beforeNetwork = { ...fetchCalls };
	try {
		const live = await provider.refreshModels({ allowNetwork: true, signal, force: true });
		console.log(`network phase: returned ${live.length} models, network calls: tags=${fetchCalls.tags - beforeNetwork.tags} show=${fetchCalls.show - beforeNetwork.show}`);
		if (live.length < restored.length) {
			console.log(`WARN: network phase returned fewer models than the last-good list (${live.length} < ${restored.length})`);
		} else if (live.length > restored.length) {
			// Legit after a transient startup failure: restore phase served the smaller
			// last-good list while the network phase picked up the fuller catalog.
			console.log(`note: network phase discovered ${live.length - restored.length} more model(s) than the startup last-good list`);
		}
	} catch (error) {
		// Correct behavior: throw so pi keeps the previous list and surfaces the error.
		console.log(`network phase: throws on failure (pi keeps previous list): ${error?.message ?? error}`);
	}

	// 3. Freshness threshold: a non-forced call while the catalog is fresh must not fetch.
	const beforeThrottle = { ...fetchCalls };
	try {
		await provider.refreshModels({ allowNetwork: true, signal });
		console.log(
			`throttle check: non-forced call network calls: tags=${fetchCalls.tags - beforeThrottle.tags} show=${fetchCalls.show - beforeThrottle.show} (expected 0 while the catalog is fresh, i.e. within refreshAfterMs)`,
		);
	} catch (error) {
		console.log(`throttle check: throws while Ollama is unreachable: ${error?.message ?? error}`);
	}
	console.log("OK");
}
if (registered.size === 0) {
	console.log("No provider registered (is Ollama running and does it have models?)");
	process.exitCode = 1;
}