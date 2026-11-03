import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, {
  PROVIDER_ID,
  INTEGRATION_ID,
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
  zoneFromIntegration,
  isDedicatedIntegration,
  dedicatedIntegrationId,
  dedicatedSlotIds,
  dedicatedIntegrationName,
  dedicatedKeyLabel,
  zonesToRegister,
  envZone,
  DEDICATED_INTEGRATION_ID,
  isOnDemandEndpoint,
  type DiscoveryPlan,
} from "../index.ts";

// ============================================================================
// Endpoint resolution
// ============================================================================

test("normalizeEndpoint keeps a bare /v1 URL", () => {
  assert.equal(normalizeEndpoint("https://inference.de-fra-1.exoscale-cloud.com/v1"), "https://inference.de-fra-1.exoscale-cloud.com/v1");
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

test("normalizeEndpoint returns an empty string for empty input", () => {
  assert.equal(normalizeEndpoint(""), "");
  assert.equal(normalizeEndpoint("   "), "");
});

test("endpointFor uses the connect-form answer when present", () => {
  assert.equal(
    endpointFor({ baseURL: "https://dedicated.example.exoscale-cloud.com" }),
    "https://dedicated.example.exoscale-cloud.com/v1",
  );
});

test("endpointFor returns nothing without a form answer", () => {
  assert.equal(endpointFor(undefined), undefined);
  assert.equal(endpointFor({}), undefined);
  assert.equal(endpointFor({ baseURL: "" }), undefined);
  assert.equal(endpointFor({ baseURL: 42 }), undefined);
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
  assert.equal(endpointFor({ endpoint: "" }), undefined);
});

test("endpointForZone builds the on-demand endpoint", () => {
  assert.equal(endpointForZone("de-fra-1"), "https://inference.de-fra-1.exoscale-cloud.com/v1");
  assert.equal(endpointForZone("at-vie-1"), "https://inference.at-vie-1.exoscale-cloud.com/v1");
});

test("integrationForZone prefixes the zone with the legacy integration id", () => {
  assert.equal(integrationForZone("de-fra-1"), "exo-de-fra-1");
  assert.equal(integrationForZone("ch-gva-2"), "exo-ch-gva-2");
});

test("zoneFromIntegration reads a zone row and ignores dedicated slots", () => {
  assert.equal(zoneFromIntegration("exo-at-vie-2"), "at-vie-2");
  assert.equal(zoneFromIntegration("exo"), undefined);
  assert.equal(zoneFromIntegration(DEDICATED_INTEGRATION_ID), undefined);
  assert.equal(zoneFromIntegration("exo-dedicated-2"), undefined);
});

test("dedicatedSlotIds keeps connected rows and one empty row", () => {
  assert.deepEqual(dedicatedSlotIds([]), [DEDICATED_INTEGRATION_ID]);
  assert.deepEqual(dedicatedSlotIds([DEDICATED_INTEGRATION_ID]), [DEDICATED_INTEGRATION_ID, "exo-dedicated-2"]);
  assert.deepEqual(dedicatedSlotIds(["exo-dedicated-2"]), [DEDICATED_INTEGRATION_ID, "exo-dedicated-2"]);
  assert.deepEqual(dedicatedSlotIds([DEDICATED_INTEGRATION_ID, "exo-dedicated-2"]), [
    DEDICATED_INTEGRATION_ID,
    "exo-dedicated-2",
    "exo-dedicated-3",
  ]);
});

test("dedicatedIntegrationId numbers slots after the first", () => {
  assert.equal(dedicatedIntegrationId(1), DEDICATED_INTEGRATION_ID);
  assert.equal(dedicatedIntegrationId(2), "exo-dedicated-2");
  assert.equal(isDedicatedIntegration("exo-at-vie-2"), false);
});

test("dedicatedIntegrationName and key label use the deployment id", () => {
  const endpoint = "https://e72addb9-561b-432b-bd80-a654999e1b06.inference.de-fra-1.exoscale-cloud.com/v1";
  assert.equal(dedicatedIntegrationName(undefined), "Exoscale Dedicated Inference");
  assert.equal(dedicatedIntegrationName(endpoint), "Exoscale de-fra-1 dedicated e72addb9");
  assert.equal(dedicatedKeyLabel(undefined), "Paste Dedicated Inference API key");
  assert.equal(dedicatedKeyLabel(endpoint), "Paste API key for e72addb9");
});

test("zonesToRegister merges the live list, stored keys, and extras, sorted", () => {
  assert.deepEqual(zonesToRegister(undefined, []), []);
  assert.deepEqual(zonesToRegister(undefined, ["exo-at-vie-2"]), ["at-vie-2"]);
  assert.deepEqual(zonesToRegister(["de-fra-1"], []), ["de-fra-1"]);
  assert.deepEqual(zonesToRegister(["de-fra-1", "ch-gva-2"], ["exo-at-vie-2", "exo-de-fra-1"]), [
    "at-vie-2",
    "ch-gva-2",
    "de-fra-1",
  ]);
  assert.deepEqual(zonesToRegister(["de-fra-1", "at-vie-2"], ["exo-at-vie-2"], ["ch-gva-2"]), [
    "at-vie-2",
    "ch-gva-2",
    "de-fra-1",
  ]);
  assert.deepEqual(zonesToRegister(["de-fra-1"], [DEDICATED_INTEGRATION_ID]), ["de-fra-1"]);
});

test("isOnDemandEndpoint matches only the zone host", () => {
  assert.equal(isOnDemandEndpoint("https://inference.at-vie-2.exoscale-cloud.com/v1"), true);
  assert.equal(isOnDemandEndpoint("https://e72addb9.inference.at-vie-2.exoscale-cloud.com/v1"), false);
});

test("envZone reads the zone from an on-demand EXOSCALE_AI_ENDPOINT only", () => {
  assert.equal(envZone({ EXOSCALE_AI_ENDPOINT: "https://inference.ch-gva-2.exoscale-cloud.com/v1" }), "ch-gva-2");
  assert.equal(envZone({ EXOSCALE_AI_ENDPOINT: "https://inference.ch-gva-2.exoscale-cloud.com" }), "ch-gva-2");
  assert.equal(envZone({ EXOSCALE_AI_ENDPOINT: "https://e72addb9.inference.ch-gva-2.exoscale-cloud.com/v1" }), undefined);
  assert.equal(envZone({ EXOSCALE_AI_ENDPOINT: "https://custom.example/v1" }), undefined);
  assert.equal(envZone({}), undefined);
  assert.equal(envZone({ EXOSCALE_AI_ENDPOINT: "   " }), undefined);
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

test("zonesFromApi maps zone names to sorted options", () => {
  assert.deepEqual(zonesFromApi({ zones: [{ name: "de-fra-1", id: "1" }, { name: "ch-gva-2" }] }), [
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
  assert.equal(connectionFingerprint({ type: "env", name: "EXOSCALE_AI_API_KEY" }), "env:EXOSCALE_AI_API_KEY");
});

// ============================================================================
// Discovery planning
// ============================================================================

const envConnection = { type: "env" as const, name: "EXOSCALE_AI_API_KEY" };
const credentialConnection = { type: "credential" as const, id: "cred_1", label: "API key", method: "key" as const };
const zoneIntegration = integrationForZone("de-fra-1");

test("planDiscovery discovers from the named env var on the zone row", () => {
  const plan = planDiscovery(envConnection, undefined, { EXOSCALE_AI_API_KEY: "sk-env" }, zoneIntegration);
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-env",
      endpoint: "https://inference.de-fra-1.exoscale-cloud.com/v1",
      fingerprint: "env:EXOSCALE_AI_API_KEY",
      integrationID: zoneIntegration,
      sourceConnection: envConnection,
    },
  });
});

test("planDiscovery uses EXOSCALE_AI_ENDPOINT for an env connection on the legacy row", () => {
  const plan = planDiscovery(
    envConnection,
    undefined,
    { EXOSCALE_AI_API_KEY: "sk-env", EXOSCALE_AI_ENDPOINT: "https://ondemand.example/v1" },
    INTEGRATION_ID,
  );
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, "https://ondemand.example/v1");
});

test("planDiscovery keeps the inventory for an env connection whose env var is unset", () => {
  assert.deepEqual(planDiscovery(envConnection, undefined, {}, zoneIntegration), { status: "keep" });
});

test("planDiscovery uses the stored key and form endpoint for a legacy credential", () => {
  const plan = planDiscovery(
    credentialConnection,
    {
      type: "key",
      key: "sk-stored",
      configuration: { baseURL: "https://ondemand.example/v1/" },
    },
    {},
    INTEGRATION_ID,
  );
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-stored",
      endpoint: "https://ondemand.example/v1",
      fingerprint: "credential:cred_1",
      integrationID: INTEGRATION_ID,
      sourceConnection: credentialConnection,
    },
  });
});

test("planDiscovery rejects a legacy account whose answers name no zone or endpoint", () => {
  const plan = planDiscovery(credentialConnection, { type: "key", key: "sk-stored" }, {}, INTEGRATION_ID);
  assert.equal(plan.status, "invalid");
  if (plan.status !== "invalid") return;
  assert.match(plan.message, /zone/);
  assert.equal(plan.sourceConnection, credentialConnection);
});

test("planDiscovery reads a legacy endpoint from metadata", () => {
  const plan = planDiscovery(
    credentialConnection,
    { type: "key", key: "sk-stored", metadata: { endpoint: "https://dedicated.example/v1" } },
    {},
    INTEGRATION_ID,
  );
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, "https://dedicated.example/v1");
});

test("planDiscovery uses the zone from the integration id when the key has no endpoint", () => {
  const plan = planDiscovery(credentialConnection, { type: "key", key: "sk-vie" }, {}, integrationForZone("at-vie-2"));
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, "https://inference.at-vie-2.exoscale-cloud.com/v1");
});

test("planDiscovery ignores a dedicated URL stored on a zone integration", () => {
  const plan = planDiscovery(
    credentialConnection,
    {
      type: "key",
      key: "sk-vie",
      metadata: { endpoint: "https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1" },
    },
    {},
    integrationForZone("at-vie-2"),
  );
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, endpointForZone("at-vie-2"));
});

test("planDiscovery uses metadata.endpoint for a dedicated slot", () => {
  const endpoint = "https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1";
  const plan = planDiscovery(
    credentialConnection,
    { type: "key", key: "sk-ded", metadata: { endpoint } },
    {},
    DEDICATED_INTEGRATION_ID,
  );
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, endpoint);
  assert.notEqual(plan.input.endpoint, endpointForZone("de-fra-1"));
});

test("planDiscovery uses configuration.endpoint for a dedicated slot", () => {
  const endpoint = "https://e72addb9.inference.at-vie-2.exoscale-cloud.com";
  const plan = planDiscovery(
    credentialConnection,
    { type: "key", key: "sk-ded", configuration: { endpoint } },
    {},
    "exo-dedicated-2",
  );
  assert.equal(plan.status, "discover");
  if (plan.status !== "discover") return;
  assert.equal(plan.input.endpoint, "https://e72addb9.inference.at-vie-2.exoscale-cloud.com/v1");
});

test("planDiscovery rejects an on-demand host on a dedicated slot", () => {
  const plan = planDiscovery(
    credentialConnection,
    { type: "key", key: "sk-ded", metadata: { endpoint: "https://inference.de-fra-1.exoscale-cloud.com/v1" } },
    {},
    DEDICATED_INTEGRATION_ID,
  );
  assert.equal(plan.status, "invalid");
  if (plan.status !== "invalid") return;
  assert.match(plan.message, /on-demand/);
  assert.equal(plan.sourceConnection, credentialConnection);
});

test("planDiscovery rejects a dedicated slot with no endpoint", () => {
  const plan = planDiscovery(credentialConnection, { type: "key", key: "sk-ded" }, {}, DEDICATED_INTEGRATION_ID);
  assert.equal(plan.status, "invalid");
  if (plan.status !== "invalid") return;
  assert.match(plan.message, /missing/);
});

test("planDiscovery does not bootstrap a dedicated slot from the environment", () => {
  assert.deepEqual(
    planDiscovery(undefined, undefined, { EXOSCALE_AI_API_KEY: "sk-boot" }, DEDICATED_INTEGRATION_ID),
    { status: "reset" },
  );
});

test("a zone key and two dedicated URLs are three providers", () => {
  const zone = planDiscovery(credentialConnection, { type: "key", key: "sk-zone" }, {}, integrationForZone("at-vie-2"));
  const first = planDiscovery(
    { type: "credential", id: "cred_d1", label: "d1", method: "key" },
    { type: "key", key: "sk-d1", metadata: { endpoint: "https://aaaaaaaa.inference.de-fra-1.exoscale-cloud.com/v1" } },
    {},
    DEDICATED_INTEGRATION_ID,
  );
  const second = planDiscovery(
    { type: "credential", id: "cred_d2", label: "d2", method: "key" },
    { type: "key", key: "sk-d2", configuration: { endpoint: "https://bbbbbbbb.inference.at-vie-2.exoscale-cloud.com/v1" } },
    {},
    "exo-dedicated-2",
  );
  const endpoints = discoverableEndpoints([zone, first, second]);
  assert.deepEqual(
    endpoints.map((input) => input.endpoint),
    [
      "https://inference.at-vie-2.exoscale-cloud.com/v1",
      "https://aaaaaaaa.inference.de-fra-1.exoscale-cloud.com/v1",
      "https://bbbbbbbb.inference.at-vie-2.exoscale-cloud.com/v1",
    ],
  );
  assert.deepEqual(
    endpoints.map((input) => input.key),
    ["sk-zone", "sk-d1", "sk-d2"],
  );
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

test("planDiscovery bootstraps from EXOSCALE_AI_API_KEY for the zone named by EXOSCALE_AI_ENDPOINT", () => {
  const plan = planDiscovery(
    undefined,
    undefined,
    {
      EXOSCALE_AI_API_KEY: "sk-boot",
      EXOSCALE_AI_ENDPOINT: "https://inference.de-fra-1.exoscale-cloud.com",
    },
    zoneIntegration,
  );
  assert.deepEqual(plan, {
    status: "discover",
    input: {
      key: "sk-boot",
      endpoint: "https://inference.de-fra-1.exoscale-cloud.com/v1",
      fingerprint: `env:${zoneIntegration}`,
      integrationID: zoneIntegration,
    },
  });
});

test("planDiscovery does not bootstrap without an endpoint naming the zone", () => {
  // No endpoint: the key's zone is unknown.
  assert.deepEqual(planDiscovery(undefined, undefined, { EXOSCALE_AI_API_KEY: "sk-boot" }, zoneIntegration), {
    status: "reset",
  });
  // Endpoint names another zone.
  assert.deepEqual(
    planDiscovery(
      undefined,
      undefined,
      { EXOSCALE_AI_API_KEY: "sk-boot", EXOSCALE_AI_ENDPOINT: "https://inference.ch-gva-2.exoscale-cloud.com/v1" },
      zoneIntegration,
    ),
    { status: "reset" },
  );
  // Endpoint is a dedicated deployment, not a zone.
  assert.deepEqual(
    planDiscovery(
      undefined,
      undefined,
      {
        EXOSCALE_AI_API_KEY: "sk-boot",
        EXOSCALE_AI_ENDPOINT: "https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1",
      },
      zoneIntegration,
    ),
    { status: "reset" },
  );
});

test("planDiscovery resets when no account is connected and no env key is set", () => {
  assert.deepEqual(planDiscovery(undefined, undefined, {}, zoneIntegration), { status: "reset" });
  assert.deepEqual(planDiscovery(undefined, undefined, { EXOSCALE_AI_API_KEY: "" }, zoneIntegration), {
    status: "reset",
  });
  // The legacy row never bootstraps from the environment.
  assert.deepEqual(
    planDiscovery(
      undefined,
      undefined,
      { EXOSCALE_AI_API_KEY: "sk-boot", EXOSCALE_AI_ENDPOINT: "https://inference.de-fra-1.exoscale-cloud.com/v1" },
      INTEGRATION_ID,
    ),
    { status: "reset" },
  );
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

// ============================================================================
// Setup: boot seeding, zone list arrival, and discovery
// ============================================================================

// Stands in for the server: registries rebuild from empty on every read by
// replaying the registered transforms, connections resolve from fixtures, and
// storage is a plain map. Zone and model HTTP calls are routed through a
// global fetch stub restored by restore().
function fakeServer(input: {
  storage?: Record<string, unknown>;
  connections?: Record<string, { type: string; id?: string; name?: string }[]>;
  credentials?: Record<string, unknown>;
  zones?: unknown;
  models?: unknown;
}) {
  const rows = new Map<string, { name: string; methods: unknown[] }>();
  const providers = new Map<string, { integrationID: string; models: { id: string }[] }>();
  const integrationTransforms: ((editor: any) => void)[] = [];
  const providerTransforms: ((editor: any) => void)[] = [];
  const storage = new Map<string, unknown>(Object.entries(input.storage ?? {}));
  const connectionsFor = (id: string) => input.connections?.[id] ?? [];

  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    provider: {
      transform: async (fn: (editor: any) => void) => {
        providerTransforms.push(fn);
      },
      reload: async () => {
        providers.clear();
        for (const run of providerTransforms) {
          run({
            add: (entry: any) =>
              providers.set(entry.info.settings.baseURL, {
                integrationID: entry.info.integrationID,
                models: entry.models,
              }),
          });
        }
      },
    },
    integration: {
      transform: async (fn: (editor: any) => void) => {
        integrationTransforms.push(fn);
        rebuild();
      },
      reload: async () => rebuild(),
      list: async () => {
        rebuild();
        return {
          data: [...rows.entries()].map(([id, row]) => ({
            id,
            name: row.name,
            methods: row.methods,
            connections: connectionsFor(id),
          })),
        };
      },
      get: async ({ integrationID }: { integrationID: string }) => {
        rebuild();
        const row = rows.get(integrationID);
        return row ? { data: { id: integrationID, name: row.name, connections: connectionsFor(integrationID) } } : undefined;
      },
      connection: {
        active: async () => undefined,
        resolve: async (connection: { id?: string }) => input.credentials?.[connection.id ?? ""],
        status: async () => {},
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal }) =>
        (async function* () {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) return resolve();
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        })(),
    },
  };

  const rebuild = () => {
    rows.clear();
    for (const run of integrationTransforms) {
      run({
        list: () => [...rows.entries()].map(([id, row]) => ({ id, name: row.name })),
        get: (id: string) => {
          const row = rows.get(id);
          return row ? { id, name: row.name } : undefined;
        },
        update: (id: string, update: (ref: any) => void) => {
          const row = rows.get(id) ?? { name: id, methods: [] };
          rows.set(id, row);
          update(row);
        },
        remove: (id: string) => {
          rows.delete(id);
        },
        method: {
          list: (id: string) => rows.get(id)?.methods ?? [],
          update: ({ integrationID, method }: { integrationID: string; method: unknown }) => {
            const row = rows.get(integrationID) ?? { name: integrationID, methods: [] };
            rows.set(integrationID, row);
            row.methods = [method];
          },
          remove: () => {},
        },
      });
    }
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.startsWith(ZONE_API)) {
      if (input.zones === undefined) throw new Error("zone api down");
      return new Response(JSON.stringify(input.zones), { status: 200 });
    }
    if (href.endsWith("/models")) {
      return new Response(JSON.stringify(input.models ?? { data: [{ id: "nvidia/model-x" }] }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;

  return {
    ctx,
    rows,
    providers,
    storage,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("setup registers and discovers a seeded zone even when the zone API is down", async () => {
  const harness = fakeServer({
    storage: { "connected-zones": ["exo-de-fra-1"] },
    connections: { "exo-de-fra-1": [{ type: "credential", id: "cred_1" }] },
    credentials: { cred_1: { type: "key", key: "k1", metadata: { zone: "de-fra-1" } } },
    // no zones: the zone list fetch fails.
  });
  const errors: unknown[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    const cleanup = await plugin.setup(harness.ctx as never);
    assert.ok(harness.rows.has("exo-de-fra-1"), "seeded zone row exists without the live list");
    assert.ok(!harness.rows.has("exo-de-muc-1"), "zones from the failed list stay absent");
    const published = [...harness.providers.values()];
    assert.equal(published.length, 1);
    assert.equal(published[0].integrationID, "exo-de-fra-1");
    assert.deepEqual(
      published[0].models.map((model) => model.id),
      ["nvidia/model-x"],
    );
    // The seed still matches: nothing re-persisted.
    assert.deepEqual(harness.storage.get("connected-zones"), ["exo-de-fra-1"]);
    await waitFor(() => errors.length > 0);
    assert.ok(errors.some((error) => String(error).includes("zone list fetch failed")));
    cleanup?.();
  } finally {
    console.error = realError;
    harness.restore();
  }
});

test("setup persists zones with stored keys once the zone list lands", async () => {
  const harness = fakeServer({
    zones: { zones: [{ name: "at-vie-2" }] },
    connections: { "exo-at-vie-2": [{ type: "credential", id: "cred_2" }] },
    credentials: { cred_2: { type: "key", key: "k2", metadata: { zone: "at-vie-2" } } },
  });
  try {
    const cleanup = await plugin.setup(harness.ctx as never);
    // The zone list lands after the boot refresh; the follow-up refresh
    // finds the stored key and persists it.
    await waitFor(() => harness.storage.get("connected-zones") !== undefined);
    assert.deepEqual(harness.storage.get("connected-zones"), ["exo-at-vie-2"]);
    assert.ok(harness.rows.has("exo-at-vie-2"));
    // Discovery runs after persistence; wait for the provider to appear.
    await waitFor(() => [...harness.providers.values()].some((provider) => provider.integrationID === "exo-at-vie-2"));
    assert.ok([...harness.providers.values()].some((provider) => provider.integrationID === "exo-at-vie-2"));
    cleanup?.();
  } finally {
    harness.restore();
  }
});
