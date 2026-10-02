import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, {
  PROVIDER_ID,
  INTEGRATION_ID,
  DEFAULT_ZONE,
  DEFAULT_ENDPOINT,
  ZONE_API,
  normalizeEndpoint,
  endpointFor,
  endpointForZone,
  integrationForZone,
  providerIdentity,
  displayName,
  mapModels,
  fetchModels,
  fetchZones,
  zonesFromApi,
  connectionFingerprint,
  planDiscovery,
  discoverableEndpoints,
  type DiscoveryPlan,
} from "../index.ts";

// ============================================================================
// Endpoint resolution
// ============================================================================

test("normalizeEndpoint keeps a bare /v1 URL", () => {
  assert.equal(normalizeEndpoint("https://inference.de-fra-1.exoscale-cloud.com/v1"), DEFAULT_ENDPOINT);
});

test("normalizeEndpoint appends /v1 when missing", () => {
  assert.equal(normalizeEndpoint("https://e72addb9.example.exoscale-cloud.com"), "https://e72addb9.example.exoscale-cloud.com/v1");
});

test("normalizeEndpoint drops trailing slashes", () => {
  assert.equal(normalizeEndpoint("https://example.com/v1/"), "https://example.com/v1");
});

test("normalizeEndpoint trims whitespace", () => {
  assert.equal(normalizeEndpoint("  https://example.com/v1  "), "https://example.com/v1");
});

test("normalizeEndpoint falls back to the default on empty input", () => {
  assert.equal(normalizeEndpoint(""), DEFAULT_ENDPOINT);
  assert.equal(normalizeEndpoint("   "), DEFAULT_ENDPOINT);
});

test("endpointFor uses the connect-form answer when present", () => {
  assert.equal(
    endpointFor({ baseURL: "https://dedicated.example.exoscale-cloud.com" }),
    "https://dedicated.example.exoscale-cloud.com/v1",
  );
});

test("endpointFor falls back to the default without a form answer", () => {
  assert.equal(endpointFor(undefined), DEFAULT_ENDPOINT);
  assert.equal(endpointFor({}), DEFAULT_ENDPOINT);
  assert.equal(endpointFor({ baseURL: "" }), DEFAULT_ENDPOINT);
  assert.equal(endpointFor({ baseURL: 42 }), DEFAULT_ENDPOINT);
});

test("endpointFor builds the on-demand endpoint from the zone answer", () => {
  assert.equal(endpointFor({ zone: "ch-gva-2" }), "https://inference.ch-gva-2.exoscale-cloud.com/v1");
});

test("endpointFor trims the zone answer", () => {
  assert.equal(endpointFor({ zone: "  de-muc-1 " }), "https://inference.de-muc-1.exoscale-cloud.com/v1");
});

test("endpointFor prefers an explicit endpoint over the zone", () => {
  assert.equal(
    endpointFor({ zone: "de-fra-1", endpoint: "https://e72addb9.example.exoscale-cloud.com" }),
    "https://e72addb9.example.exoscale-cloud.com/v1",
  );
});

test("endpointFor normalizes an explicit endpoint", () => {
  assert.equal(endpointFor({ endpoint: "https://dedicated.example.com/v1/" }), "https://dedicated.example.com/v1");
  assert.equal(endpointFor({ endpoint: "" }), DEFAULT_ENDPOINT);
});

test("endpointForZone builds the on-demand endpoint", () => {
  assert.equal(endpointForZone(DEFAULT_ZONE), DEFAULT_ENDPOINT);
  assert.equal(endpointForZone("at-vie-1"), "https://inference.at-vie-1.exoscale-cloud.com/v1");
});

test("integrationForZone prefixes the zone with the legacy integration id", () => {
  assert.equal(integrationForZone("de-fra-1"), "exo-de-fra-1");
  assert.equal(integrationForZone("ch-gva-2"), "exo-ch-gva-2");
});

// ============================================================================
// Provider identity
// ============================================================================

test("providerIdentity names on-demand providers by zone", () => {
  assert.deepEqual(providerIdentity("https://inference.de-fra-1.exoscale-cloud.com/v1"), {
    id: "exo-de-fra-1",
    name: "Exoscale de-fra-1 (On-demand Inference)",
  });
});

test("providerIdentity names Dedicated Inference providers by zone and deployment", () => {
  assert.deepEqual(
    providerIdentity("https://e72addb9-561b-432b-bd80-a654999e1b06.inference.de-fra-1.exoscale-cloud.com/v1"),
    { id: "exo-de-fra-1-e72addb9", name: "Exoscale de-fra-1 (Dedicated Inference)" },
  );
});

test("providerIdentity slugs unknown hosts deterministically", () => {
  assert.deepEqual(providerIdentity("https://my-gateway.internal/v1"), {
    id: "exo-my-gateway-internal",
    name: "Exoscale",
  });
  assert.deepEqual(
    providerIdentity("https://my-gateway.internal"),
    providerIdentity("https://my-gateway.internal/v1"),
  );
});

// ============================================================================
// Zone list
// ============================================================================

test("zonesFromApi maps zone names to options", () => {
  assert.deepEqual(zonesFromApi({ zones: [{ name: "ch-gva-2", id: "1" }, { name: "de-fra-1" }] }), [
    { value: "ch-gva-2", label: "ch-gva-2" },
    { value: "de-fra-1", label: "de-fra-1" },
  ]);
});

test("zonesFromApi skips malformed entries and duplicates", () => {
  assert.deepEqual(
    zonesFromApi({ zones: [{ name: "de-fra-1" }, null, 42, { name: "de-fra-1" }, { name: "  " }] }),
    [{ value: "de-fra-1", label: "de-fra-1" }],
  );
});

test("zonesFromApi returns no options on unexpected bodies", () => {
  assert.deepEqual(zonesFromApi(undefined), []);
  assert.deepEqual(zonesFromApi({}), []);
  assert.deepEqual(zonesFromApi({ zones: "nope" }), []);
});

test("fetchZones reads the zone list from the API", async () => {
  const lastCall: LastCall = { url: "" };
  const options = await fetchZones({ fetch: stubFetch(lastCall, 200, { zones: [{ name: "at-vie-1" }] }) });
  assert.deepEqual(options, [{ value: "at-vie-1", label: "at-vie-1" }]);
  assert.equal(lastCall.url, ZONE_API);
});

test("fetchZones rejects on a non-OK response", async () => {
  await assert.rejects(
    () => fetchZones({ fetch: stubFetch({ url: "" }, 503, { error: "unavailable" }) }),
    (error: Error) => error.message.includes("503"),
  );
});

// ============================================================================
// Model mapping
// ============================================================================

const vllmBody = {
  object: "list",
  data: [
    {
      id: "nvidia/Qwen3.8-27B-NVFP4",
      object: "model",
      created: 1750000000,
      owned_by: "vllm",
      max_model_len: 32768,
      max_completion_tokens: 8192,
    },
    {
      id: "Qwen/Qwen3.8-27B",
      object: "model",
      created: 1750000001,
      owned_by: "vllm",
    },
    {
      id: "nvidia/Qwen3.8-27B-NVFP4", // duplicate, collapsed
      object: "model",
    },
    { object: "model" }, // missing id, skipped
    "not-an-object", // skipped
  ],
};

test("mapModels maps an OpenAI-compatible list to Model.Info values", () => {
  const models = mapModels(vllmBody);
  assert.equal(models.length, 2);

  const [first, second] = models;
  assert.equal(first.id, "nvidia/Qwen3.8-27B-NVFP4");
  assert.equal(first.modelID, "nvidia/Qwen3.8-27B-NVFP4");
  assert.equal(first.providerID, PROVIDER_ID);
  assert.equal(first.name, "Qwen3.8-27B-NVFP4");
  assert.deepEqual(first.limit, { context: 32768, output: 8192 });
  assert.equal(first.enabled, true);
  assert.equal(first.status, "active");
  assert.deepEqual(first.cost, []);

  assert.equal(second.id, "Qwen/Qwen3.8-27B");
  assert.equal(second.name, "Qwen3.8-27B");
  // No max_* reported: defaults stay intact.
  assert.equal(second.limit.context > 0, true);
  assert.equal(second.limit.output > 0, true);
});

test("mapModels returns an empty list for malformed bodies", () => {
  assert.deepEqual(mapModels(undefined), []);
  assert.deepEqual(mapModels("nope"), []);
  assert.deepEqual(mapModels({}), []);
  assert.deepEqual(mapModels({ data: "nope" }), []);
  assert.deepEqual(mapModels({ data: [null, 42, { name: "no-id" }] }), []);
});

test("mapModels respects the providerID argument", () => {
  const [model] = mapModels({ data: [{ id: "x/y" }] }, "other");
  assert.equal(model.providerID, "other");
});

test("displayName drops vendor prefixes", () => {
  assert.equal(displayName("nvidia/Qwen3.8-27B-NVFP4"), "Qwen3.8-27B-NVFP4");
  assert.equal(displayName("plain-model"), "plain-model");
  assert.equal(displayName("a/b/"), "b");
});

// ============================================================================
// Discovery fetch
// ============================================================================

type LastCall = { url: string; headers?: Record<string, string> };

function stubFetch(lastCall: LastCall, status: number, body: unknown) {
  return (url: string | URL | Request, init?: RequestInit) => {
    lastCall.url = String(url);
    lastCall.headers = init?.headers as Record<string, string> | undefined;
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

test("fetchModels calls {endpoint}/models with the bearer key", async () => {
  const lastCall: LastCall = { url: "" };
  const body = { data: [{ id: "a/b" }] };
  const out = await fetchModels({
    endpoint: "https://dedicated.example/v1/",
    key: "sk-test",
    fetch: stubFetch(lastCall, 200, body),
  });
  assert.deepEqual(out, body);
  assert.equal(lastCall.url, "https://dedicated.example/v1/models");
  assert.equal(lastCall.headers?.authorization, "Bearer sk-test");
});

test("fetchModels throws on non-2xx with the status and detail", async () => {
  const lastCall: LastCall = { url: "" };
  await assert.rejects(
    () =>
      fetchModels({
        endpoint: "https://dedicated.example/v1",
        key: "sk-bad",
        fetch: stubFetch(lastCall, 401, { error: { message: "missing or malformed Authorization header" } }),
      }),
    (error: Error) =>
      error.message.includes("401") && error.message.includes("missing or malformed Authorization header"),
  );
});

test("fetchModels throws on a network error", async () => {
  await assert.rejects(
    () =>
      fetchModels({
        endpoint: "https://unreachable.invalid/v1",
        key: "sk-test",
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    /fetch failed/,
  );
});

// ============================================================================
// Connection fingerprint
// ============================================================================

test("connectionFingerprint distinguishes credential and env connections", () => {
  assert.equal(connectionFingerprint({ type: "credential", id: "c1", label: "API key", method: "key" }), "credential:c1");
  assert.equal(connectionFingerprint({ type: "env", name: "EXOSCALE_API_KEY" }), "env:EXOSCALE_API_KEY");
});

// ============================================================================
// Discovery planning
// ============================================================================

const envConnection = { type: "env" as const, name: "EXOSCALE_API_KEY" };
const credentialConnection = { type: "credential" as const, id: "cred_1", label: "API key", method: "key" as const };
const zoneIntegration = integrationForZone(DEFAULT_ZONE);

test("planDiscovery discovers from the named env var for an active env connection", () => {
  const plan = planDiscovery(
    envConnection,
    undefined,
    {
      EXOSCALE_API_KEY: "sk-env",
      EXOSCALE_ENDPOINT: "https://dedicated.example",
    },
    zoneIntegration,
  );
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-env",
      endpoint: "https://dedicated.example/v1",
      fingerprint: "env:EXOSCALE_API_KEY",
      integrationID: zoneIntegration,
      sourceConnection: envConnection,
    },
  });
});

test("planDiscovery defaults the endpoint for an env connection without EXOSCALE_ENDPOINT", () => {
  const plan = planDiscovery(envConnection, undefined, { EXOSCALE_API_KEY: "sk-env" }, zoneIntegration);
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, DEFAULT_ENDPOINT);
});

test("planDiscovery keeps the inventory for an env connection whose env var is unset", () => {
  assert.deepEqual(planDiscovery(envConnection, undefined, {}, zoneIntegration), { status: "keep" });
});

test("planDiscovery uses the stored key and form endpoint for a credential connection", () => {
  const plan = planDiscovery(
    credentialConnection,
    {
      type: "key",
      key: "sk-stored",
      configuration: { baseURL: "https://ondemand.example/v1/" },
    },
    {},
    zoneIntegration,
  );
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-stored",
      endpoint: "https://ondemand.example/v1",
      fingerprint: "credential:cred_1",
      integrationID: zoneIntegration,
      sourceConnection: credentialConnection,
    },
  });
});

test("planDiscovery defaults the endpoint when the stored credential has no configuration", () => {
  const plan = planDiscovery(credentialConnection, { type: "key", key: "sk-stored" }, {}, zoneIntegration);
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, DEFAULT_ENDPOINT);
});

test("planDiscovery keeps the inventory when the credential cannot be resolved", () => {
  assert.deepEqual(planDiscovery(credentialConnection, undefined, {}, zoneIntegration), { status: "keep" });
});

test("planDiscovery keeps the inventory for a non-key credential", () => {
  const plan = planDiscovery(credentialConnection, { type: "oauth" }, {}, zoneIntegration);
  assert.deepEqual(plan, { status: "keep" });
});

test("planDiscovery keeps the inventory for an empty stored key", () => {
  const plan = planDiscovery(credentialConnection, { type: "key", key: "" }, {}, zoneIntegration);
  assert.deepEqual(plan, { status: "keep" });
});

test("planDiscovery bootstraps from EXOSCALE_API_KEY when no account is connected", () => {
  const plan = planDiscovery(
    undefined,
    undefined,
    {
      EXOSCALE_API_KEY: "sk-boot",
      EXOSCALE_ENDPOINT: "https://dedicated.example/v1",
    },
    zoneIntegration,
  );
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-boot",
      endpoint: "https://dedicated.example/v1",
      fingerprint: `env:${zoneIntegration}`,
      integrationID: zoneIntegration,
    },
  });
});

test("planDiscovery bootstraps against the default endpoint without EXOSCALE_ENDPOINT", () => {
  const plan = planDiscovery(undefined, undefined, { EXOSCALE_API_KEY: "sk-boot" }, zoneIntegration);
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, DEFAULT_ENDPOINT);
  assert.equal(plan.input.sourceConnection, undefined);
});

test("planDiscovery resets when no account is connected and no env key is set", () => {
  assert.deepEqual(planDiscovery(undefined, undefined, {}, zoneIntegration), { status: "reset" });
  assert.deepEqual(planDiscovery(undefined, undefined, { EXOSCALE_API_KEY: "" }, zoneIntegration), { status: "reset" });
});

const zoneAConnection = { type: "credential" as const, id: "cred_a", label: "zone a", method: "key" as const };
const zoneBConnection = { type: "credential" as const, id: "cred_b", label: "zone b", method: "key" as const };
const endpointA = "https://inference.ch-gva-2.exoscale-cloud.com/v1";
const endpointB = "https://inference.de-fra-1.exoscale-cloud.com/v1";

test("discoverableEndpoints keeps one input per endpoint, in plan order", () => {
  const plans: DiscoveryPlan[] = [
    {
      status: "discover",
      input: {
        key: "k-a",
        endpoint: endpointA,
        fingerprint: "credential:cred_a",
        integrationID: "exo-ch-gva-2",
        sourceConnection: zoneAConnection,
      },
    },
    {
      status: "discover",
      // second account in the same zone: same endpoint, loses the binding
      input: { key: "k-a2", endpoint: endpointA, fingerprint: "credential:cred_a2", integrationID: "exo-ch-gva-2" },
    },
    {
      status: "discover",
      input: {
        key: "k-b",
        endpoint: endpointB,
        fingerprint: "credential:cred_b",
        integrationID: "exo-de-fra-1",
        sourceConnection: zoneBConnection,
      },
    },
    { status: "keep" },
    { status: "reset" },
  ];
  const endpoints = discoverableEndpoints(plans);
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].endpoint, endpointA);
  assert.equal(endpoints[0].key, "k-a"); // first (active) connection wins
  assert.deepEqual(endpoints[0].sourceConnection, zoneAConnection);
  assert.equal(endpoints[1].endpoint, endpointB);
});

test("discoverableEndpoints lets the zone integration win over the legacy one", () => {
  // refresh() orders plans zone-first, legacy-last; the zone plan for the
  // same endpoint must win so the provider rebinds to the zone integration.
  const plans: DiscoveryPlan[] = [
    {
      status: "discover",
      input: {
        key: "k-new",
        endpoint: endpointB,
        fingerprint: "credential:cred_new",
        integrationID: "exo-de-fra-1",
      },
    },
    {
      status: "discover",
      input: {
        key: "k-legacy",
        endpoint: endpointB,
        fingerprint: "credential:cred_legacy",
        integrationID: INTEGRATION_ID,
      },
    },
  ];
  const [winner] = discoverableEndpoints(plans);
  assert.equal(winner.key, "k-new");
  assert.equal(winner.integrationID, "exo-de-fra-1");
});

// ============================================================================
// Plugin definition
// ============================================================================

test("plugin is a valid definition with a unique id", () => {
  assert.equal(plugin.id, "opencode-exoscale");
  assert.equal(typeof plugin.setup, "function");
});
