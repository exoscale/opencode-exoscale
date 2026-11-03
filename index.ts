/**
 * OpenCode plugin: Exoscale inference providers.
 *
 * Registers one Exoscale integration per zone so each shows up in /connect.
 * API keys are zone-local and the server keeps one active credential per
 * integration, so each zone is its own integration: connect several zones
 * and they all stay active at once, each with its own key.
 *
 * Dedicated Inference is not a field on the zone row. A deployment key is
 * a different credential from the zone's on-demand key, so each deployment
 * is its own integration too. One empty "Exoscale Dedicated Inference" row
 * is always there; connecting it keeps that row and adds the next empty one.
 *
 * Each endpoint gets its own provider: exo-<zone> for on-demand inference
 * in <zone>, exo-<zone>-<id> for a Dedicated Inference deployment. Models
 * are discovered live from {endpoint}/models with that integration's active
 * credential and registered as that provider's inventory.
 *
 * Discovery re-runs when a credential is added, replaced, or the active
 * account switches; a transient failure keeps the last good inventory for
 * that endpoint and reports the error on the connection.
 *
 * EXOSCALE_AI_API_KEY works as an environment method too. Keys are
 * zone-local, so it belongs to the zone named by EXOSCALE_AI_ENDPOINT
 * (an on-demand endpoint); before any account is connected it drives
 * discovery there. There is no default zone.
 *
 * The pre-zone "exo" integration is kept while it still has accounts and
 * removed once empty.
 *
 * No provider or model configuration is needed in opencode.json.
 */

import { Model, Plugin, Provider, Integration } from "@opencode/plugin";
import type { ConnectionInfo } from "@opencode/client";

// ============================================================================
// Constants
// ============================================================================

export const PROVIDER_ID = "exo";
// The pre-zone integration: kept while it still has accounts, removed once
// empty. Zone integrations are integrationForZone(zone). Dedicated
// deployments are dedicatedIntegrationId(n), never a zone row.
export const INTEGRATION_ID = "exo";
export const DEDICATED_INTEGRATION_ID = "exo-dedicated";
export const ZONE_API = "https://api-ch-gva-2.exoscale.com/v2/zone";
const RUNTIME_PACKAGE = "@opencode/ai/providers/openai-compatible";
const ENV_KEY = "EXOSCALE_AI_API_KEY";
const ENV_ENDPOINT = "EXOSCALE_AI_ENDPOINT";
const DEDICATED_ENDPOINT_MISSING = "Dedicated Inference endpoint is missing.";
const DEDICATED_ENDPOINT_ON_DEMAND =
  "Dedicated Inference needs a deployment URL, not an on-demand zone endpoint.";
const NO_ENDPOINT = "No zone or endpoint recorded for this account. Reconnect it on its Exoscale zone row.";
// Plugin storage key holding the zone integration ids that had a stored key
// the last time discovery saw them. The integration registry starts empty on
// every boot, so this seeds those rows back and keeps connected zones usable
// even when the zone list fetch fails or lands late.
const CONNECTED_ZONES_KEY = "connected-zones";

// ============================================================================
// Endpoint resolution
// ============================================================================

// Normalizes an endpoint pasted into the connect form: trims whitespace,
// drops trailing slashes, and appends /v1 when the path lacks it.
// Empty input yields an empty string: there is no default endpoint.
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v1$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

// On-demand inference endpoint for a zone.
export function endpointForZone(zone: string): string {
  return `https://inference.${zone}.exoscale-cloud.com/v1`;
}

// Integration for a zone. Keys are zone-local and the server keeps one
// active credential per integration, so each zone is its own integration:
// a zone's key never crosses zones, and every connected zone stays active.
export function integrationForZone(zone: string): string {
  return `${INTEGRATION_ID}-${zone}`;
}

// Dedicated slots. exo-dedicated is the first; exo-dedicated-2, ... follow.
// A deployment key must not share a zone row: that row's one active
// credential is the on-demand key.
export function isDedicatedIntegration(integrationID: string): boolean {
  return integrationID === DEDICATED_INTEGRATION_ID || integrationID.startsWith(`${DEDICATED_INTEGRATION_ID}-`);
}

export function dedicatedIntegrationId(index: number): string {
  if (index <= 1) return DEDICATED_INTEGRATION_ID;
  return `${DEDICATED_INTEGRATION_ID}-${index}`;
}

function dedicatedIndex(integrationID: string): number {
  if (integrationID === DEDICATED_INTEGRATION_ID) return 1;
  const suffix = integrationID.slice(DEDICATED_INTEGRATION_ID.length + 1);
  const index = Number(suffix);
  return Number.isInteger(index) && index > 1 && String(index) === suffix ? index : Number.MAX_SAFE_INTEGER;
}

function nextDedicatedId(taken: Set<string>): string {
  if (!taken.has(DEDICATED_INTEGRATION_ID)) return DEDICATED_INTEGRATION_ID;
  for (let index = 2; ; index++) {
    const id = dedicatedIntegrationId(index);
    if (!taken.has(id)) return id;
  }
}

// Connected dedicated rows, plus exactly one empty row so the next
// deployment can be connected without replacing an existing key.
export function dedicatedSlotIds(connectedIds: readonly string[]): string[] {
  const taken = new Set(connectedIds.filter(isDedicatedIntegration));
  taken.add(nextDedicatedId(taken));
  return [...taken].sort((a, b) => dedicatedIndex(a) - dedicatedIndex(b));
}

// Zone encoded in a zone integration id. Dedicated slots are not zones.
export function zoneFromIntegration(integrationID: string): string | undefined {
  if (isDedicatedIntegration(integrationID) || !integrationID.startsWith(`${INTEGRATION_ID}-`)) return undefined;
  const zone = integrationID.slice(INTEGRATION_ID.length + 1);
  return zone || undefined;
}

// The live zone list, zones that already have a key and would be lost if
// the API dropped them or the list has not arrived yet, and extra zones
// (the one named by EXOSCALE_AI_ENDPOINT). Sorted: OpenCode sorts the
// /connect rows by name itself, this feeds the legacy zone picker options.
export function zonesToRegister(
  live: readonly string[] | undefined,
  connectedZoneIds: readonly string[],
  extra: readonly string[] = [],
): string[] {
  const zones = new Set<string>(live ?? []);
  for (const id of connectedZoneIds) {
    const zone = zoneFromIntegration(id);
    if (zone) zones.add(zone);
  }
  for (const zone of extra) zones.add(zone);
  return [...zones].sort();
}

// Endpoint used for a legacy account, from its connect-form answers:
// 1. endpoint - explicit Dedicated Inference deployment URL
// 2. zone     - on-demand inference in the picked zone
// 3. baseURL  - answers from accounts connected before the zone picker
// Undefined when the answers carry none of these: there is no default
// zone, so such an account cannot be discovered and must be reconnected.
// Zone integrations do not use this: their endpoint comes from the
// integration id. Dedicated slots use dedicatedEndpoint.
export function endpointFor(configuration: Record<string, unknown> | undefined): string | undefined {
  const explicit = configuration?.endpoint;
  if (typeof explicit === "string" && explicit.trim()) return normalizeEndpoint(explicit);
  const zone = configuration?.zone;
  if (typeof zone === "string" && zone.trim()) return endpointForZone(zone.trim());
  const legacy = configuration?.baseURL;
  if (typeof legacy === "string" && legacy.trim()) return normalizeEndpoint(legacy);
  return undefined;
}

// OpenCode 2.1 stores form answers on metadata. Older credentials stored
// them on configuration. Metadata wins when both are set.
export function answersFrom(
  credential: { configuration?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined,
): Record<string, unknown> | undefined {
  const configuration = recordOf(credential?.configuration);
  const metadata = recordOf(credential?.metadata);
  if (!configuration && !metadata) return undefined;
  return { ...configuration, ...metadata };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// ============================================================================
// Provider identity
// ============================================================================

export type ProviderIdentity = { id: string; name: string };

type InferenceHost = { zone: string; deployment?: string };

// inference.<zone>.exoscale-cloud.com is on-demand.
// <deployment>.inference.<zone>.exoscale-cloud.com is Dedicated Inference.
function exoscaleInference(endpoint: string): InferenceHost | undefined {
  const labels = hostnameOf(endpoint).split(".");
  if (
    labels.length < 4 ||
    labels[labels.length - 1] !== "com" ||
    labels[labels.length - 2] !== "exoscale-cloud" ||
    labels[labels.length - 4] !== "inference"
  ) {
    return undefined;
  }
  return {
    zone: labels[labels.length - 3],
    deployment: labels.length > 4 ? labels[0] : undefined,
  };
}

export function isOnDemandEndpoint(endpoint: string): boolean {
  const host = exoscaleInference(endpoint);
  return host !== undefined && !host.deployment;
}

// Zone the environment API key belongs to. Keys are zone-local, so
// EXOSCALE_AI_ENDPOINT must name an on-demand zone endpoint to claim
// EXOSCALE_AI_API_KEY for that zone. A dedicated deployment URL is a
// different key and never lands on a zone row.
export function envZone(env: Record<string, string | undefined>): string | undefined {
  const raw = env[ENV_ENDPOINT];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const endpoint = normalizeEndpoint(raw);
  if (!isOnDemandEndpoint(endpoint)) return undefined;
  return exoscaleInference(endpoint)?.zone;
}

// Deployment URL for a dedicated slot. An on-demand host is rejected:
// that key belongs on the zone row, not here.
export function dedicatedEndpoint(answers: Record<string, unknown> | undefined): string | undefined {
  const raw = answers?.endpoint;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const endpoint = normalizeEndpoint(raw);
  if (isOnDemandEndpoint(endpoint)) return undefined;
  return endpoint;
}

export function dedicatedEndpointError(answers: Record<string, unknown> | undefined): string {
  const raw = answers?.endpoint;
  if (typeof raw === "string" && raw.trim() && isOnDemandEndpoint(normalizeEndpoint(raw))) {
    return DEDICATED_ENDPOINT_ON_DEMAND;
  }
  return DEDICATED_ENDPOINT_MISSING;
}

export function dedicatedIntegrationName(endpoint: string | undefined): string {
  const host = endpoint ? exoscaleInference(endpoint) : undefined;
  if (!host?.deployment) return "Exoscale Dedicated Inference";
  return `Exoscale ${host.zone} dedicated ${host.deployment.slice(0, 8)}`;
}

export function dedicatedKeyLabel(endpoint: string | undefined): string {
  const host = endpoint ? exoscaleInference(endpoint) : undefined;
  if (!host?.deployment) return "Paste Dedicated Inference API key";
  return `Paste API key for ${host.deployment.slice(0, 8)}`;
}

// One provider per endpoint. Keys are zone-local, so the provider ID is
// derived from the endpoint host:
// - inference.<zone>.exoscale-cloud.com           -> exo-<zone>
// - <deployment>.inference.<zone>....exoscale.com -> exo-<zone>-<deployment8>
// Unknown hosts get a deterministic slug so the ID is stable across runs.
export function providerIdentity(endpoint: string): ProviderIdentity {
  const host = exoscaleInference(endpoint);
  if (host) {
    if (!host.deployment) return { id: `exo-${host.zone}`, name: `Exoscale ${host.zone} (On-demand Inference)` };
    return {
      id: `exo-${host.zone}-${host.deployment.slice(0, 8)}`,
      name: `Exoscale ${host.zone} (Dedicated Inference)`,
    };
  }
  const slug = hostnameOf(endpoint)
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return { id: `exo-${slug || "custom"}`, name: "Exoscale" };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

// ============================================================================
// Zone list (connect form)
// ============================================================================

// Maps the zone API response to sorted connect-form options. The endpoint
// is unauthenticated; when the fetch fails the picker offers free typing
// only (the zone field is custom).
export function zonesFromApi(body: unknown): { value: string; label: string }[] {
  const zones = body && typeof body === "object" ? (body as { zones?: unknown }).zones : undefined;
  if (!Array.isArray(zones)) return [];
  const names: string[] = [];
  for (const zone of zones) {
    const name = zone && typeof zone === "object" ? (zone as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.trim() && !names.includes(name.trim())) names.push(name.trim());
  }
  names.sort();
  return names.map((name) => ({ value: name, label: name }));
}

// Fetches the active zone list for the connect form options.
export async function fetchZones(input: {
  fetch?: typeof fetch;
  signal?: AbortSignal;
} = {}): Promise<{ value: string; label: string }[]> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(ZONE_API, { signal: input.signal });
  if (!response.ok) throw new Error(`zone list failed: ${ZONE_API} responded ${response.status}`);
  return zonesFromApi(await response.json());
}

// ============================================================================
// Model mapping
// ============================================================================

// Display name for a model ID: the last path segment (vendor prefixes like
// nvidia/ are dropped).
export function displayName(modelID: string): string {
  const parts = modelID.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] || modelID;
}

// Maps an OpenAI-compatible /models response body to Model.Info values.
// Unknown or malformed entries are skipped; duplicate IDs are collapsed.
// limit.context / limit.output are taken from max_model_len /
// max_completion_tokens when the backend reports them.
export function mapModels(body: unknown, providerID: string = PROVIDER_ID): Model.Info[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const id = Provider.ID.make(providerID);
  const seen = new Set<string>();
  const models: Model.Info[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const modelID =
      typeof entry.id === "string" ? entry.id : typeof entry.modelID === "string" ? entry.modelID : undefined;
    if (!modelID || seen.has(modelID)) continue;
    seen.add(modelID);
    const model = { ...Model.Info.default(id, Model.ID.make(modelID)) };
    model.name = Model.ID.make(displayName(modelID));
    if (typeof entry.max_model_len === "number" && Number.isFinite(entry.max_model_len) && entry.max_model_len > 0) {
      model.limit = { ...model.limit, context: Math.floor(entry.max_model_len) };
    }
    if (
      typeof entry.max_completion_tokens === "number" &&
      Number.isFinite(entry.max_completion_tokens) &&
      entry.max_completion_tokens > 0
    ) {
      model.limit = { ...model.limit, output: Math.floor(entry.max_completion_tokens) };
    }
    models.push(model);
  }
  return models;
}

// ============================================================================
// Discovery
// ============================================================================

// Fetches the model list from an endpoint. Returns the parsed body; the
// caller maps it with mapModels.
export async function fetchModels(input: {
  endpoint: string;
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const url = `${input.endpoint.replace(/\/+$/, "")}/models`;
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${input.key}` },
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`model discovery failed: ${url} responded ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return await response.json();
}

// Stable identity of a connection, used to skip redundant refreshes.
export function connectionFingerprint(connection: ConnectionInfo): string {
  return connection.type === "env" ? `env:${connection.name}` : `credential:${connection.id}`;
}

// ============================================================================
// Discovery planning (pure)
// ============================================================================

// The subset of a resolved credential that discovery cares about.
// configuration is the pre-2.1 field; metadata is where 2.1 stores the
// connect-form answer.
type ResolvedCredential =
  | { type: "key"; key: string; configuration?: Record<string, unknown>; metadata?: Record<string, unknown> }
  | { type: "oauth" };

// What discovery should use:
// - discover: proceed with this key/endpoint/fingerprint
// - keep:     a connection exists but no key is usable right now; keep the
//             last good inventory (no fetch)
// - reset:    nothing is configured; clear any inventory
// - invalid:  the connection is present but its endpoint is unusable; drop
//             any inventory it owned and report the error on the connection
export type DiscoveryInput = {
  key: string;
  endpoint: string;
  fingerprint: string;
  integrationID: string;
  sourceConnection?: ConnectionInfo;
};

export type DiscoveryPlan =
  | { status: "discover"; input: DiscoveryInput }
  | { status: "keep" }
  | { status: "reset" }
  | { status: "invalid"; message: string; integrationID: string; sourceConnection: ConnectionInfo };

function discoverPlan(
  key: string,
  endpoint: string,
  connection: ConnectionInfo | undefined,
  integrationID: string,
  fingerprint: string,
): DiscoveryPlan {
  return {
    status: "discover",
    input: {
      key,
      endpoint,
      fingerprint,
      integrationID,
      ...(connection ? { sourceConnection: connection } : {}),
    },
  };
}

// Zone rows always discover against that zone. A dedicated URL stored on
// the row is ignored: that key belongs on a dedicated slot. Undefined when
// the integration is not a zone row and the answers name no endpoint.
function zoneEndpoint(integrationID: string, answers: Record<string, unknown> | undefined): string | undefined {
  const zone = zoneFromIntegration(integrationID);
  if (zone) return endpointForZone(zone);
  return endpointFor(answers);
}

function planDedicated(
  connection: ConnectionInfo | undefined,
  credential: ResolvedCredential | undefined,
  integrationID: string,
): DiscoveryPlan {
  // An empty slot is not the env bootstrap. A deployment key is explicit.
  if (!connection) return { status: "reset" };
  if (connection.type === "env" || credential?.type !== "key" || !credential.key) return { status: "keep" };
  const answers = answersFrom(credential);
  const endpoint = dedicatedEndpoint(answers);
  if (!endpoint) {
    return {
      status: "invalid",
      message: dedicatedEndpointError(answers),
      integrationID,
      sourceConnection: connection,
    };
  }
  return discoverPlan(credential.key, endpoint, connection, integrationID, connectionFingerprint(connection));
}

// Decides, from a connection, its resolved credential, and the server
// environment, what discovery should use for that connection. With no
// connection at all the environment is the plan source, but only for the
// zone named by EXOSCALE_AI_ENDPOINT, and never on a dedicated slot. Pure
// so each branch is unit-testable without a live service.
export function planDiscovery(
  connection: ConnectionInfo | undefined,
  credential: ResolvedCredential | undefined,
  env: Record<string, string | undefined>,
  integrationID: string,
): DiscoveryPlan {
  if (isDedicatedIntegration(integrationID)) return planDedicated(connection, credential, integrationID);
  if (connection) {
    if (connection.type === "env") {
      const key = env[connection.name] ?? "";
      if (!key) return { status: "keep" };
      const endpoint = zoneEndpoint(integrationID, { baseURL: env[ENV_ENDPOINT] });
      if (!endpoint) return { status: "invalid", message: NO_ENDPOINT, integrationID, sourceConnection: connection };
      return discoverPlan(key, endpoint, connection, integrationID, connectionFingerprint(connection));
    }
    if (credential?.type !== "key" || !credential.key) return { status: "keep" };
    const endpoint = zoneEndpoint(integrationID, answersFrom(credential));
    if (!endpoint) return { status: "invalid", message: NO_ENDPOINT, integrationID, sourceConnection: connection };
    return discoverPlan(credential.key, endpoint, connection, integrationID, connectionFingerprint(connection));
  }
  // No account connected (fresh install): fall back to the environment so
  // the provider works before the first /connect. Keys are zone-local, so
  // the env key only bootstraps the zone named by EXOSCALE_AI_ENDPOINT.
  const zone = zoneFromIntegration(integrationID);
  const key = env[ENV_KEY] ?? "";
  if (!zone || !key || envZone(env) !== zone) return { status: "reset" };
  return discoverPlan(key, endpointForZone(zone), undefined, integrationID, `env:${integrationID}`);
}

// Collects one discovery input per distinct endpoint. Inputs are considered
// in plan order (zone integrations first, active account first), so the
// first input for an endpoint wins: its key is used for the fetch and its
// integration owns the provider.
export function discoverableEndpoints(plans: DiscoveryPlan[]): DiscoveryInput[] {
  const byEndpoint = new Map<string, DiscoveryInput>();
  for (const plan of plans) {
    if (plan.status !== "discover") continue;
    if (!byEndpoint.has(plan.input.endpoint)) byEndpoint.set(plan.input.endpoint, plan.input);
  }
  return [...byEndpoint.values()];
}

// ============================================================================
// Plugin
// ============================================================================

export default Plugin.define({
  id: "opencode-exoscale",
  async setup(ctx) {
    type Inventory = {
      providerID: string;
      name: string;
      endpoint: string;
      models: Model.Info[];
      connectionFingerprint: string;
      integrationID: string;
      signature: string;
    };
    // One entry per discovered endpoint (one provider per endpoint), keyed
    // by endpoint.
    let inventory: Map<string, Inventory> | undefined;

    // undefined until the live zone list arrives. Until then only the
    // zones seeded from storage below are registered; a connect before
    // that 404s and the user retries once the rows appear.
    let liveZones: string[] | undefined;
    let connectedZoneIds: string[] = [];
    // Seed zones that had a stored key the last time discovery saw them.
    // Seeding before the transforms register means the first registry build
    // already has those rows, their stored credentials resolve onto them,
    // and boot-time discovery works in every location even if the zone
    // list never arrives. syncAccounts below re-derives (and re-persists)
    // the list as soon as the rows can be inspected.
    const seededZones = await ctx.storage?.get(CONNECTED_ZONES_KEY).catch(() => undefined);
    if (Array.isArray(seededZones) && seededZones.every((zone) => typeof zone === "string")) {
      connectedZoneIds = seededZones as string[];
    }
    // Dedicated rows that already have a key, with the deployment URL used
    // to name the row. The transform adds one empty slot beyond these.
    let dedicatedConnected: { id: string; endpoint?: string }[] = [];
    let legacyHasAccounts = false;

    // Provider: published one per discovered endpoint on the zone
    // integration that produced it. No sourceConnection binding: every
    // connected zone stays available at once, and requests are signed with
    // that zone's active credential.
    await ctx.provider.transform((editor) => {
      for (const [endpoint, entry] of inventory ?? new Map<string, Inventory>()) {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(entry.providerID)),
            integrationID: Integration.ID.make(entry.integrationID),
            name: entry.name,
            activation: "enabled",
            package: RUNTIME_PACKAGE,
            settings: { baseURL: endpoint },
          },
          models: entry.models,
        });
      }
    });

    // Zones to register: live list, zones with a stored key, and the zone
    // named by EXOSCALE_AI_ENDPOINT.
    const registeredZones = (connected: readonly string[] = connectedZoneIds) => {
      const zone = envZone(process.env);
      return zonesToRegister(liveZones, connected, zone ? [zone] : []);
    };
    const zoneOptions = () => registeredZones().map((zone) => ({ value: zone, label: zone }));

    // Integrations: one per zone (on-demand key only), one per connected
    // dedicated deployment plus one empty slot, the env method on the zone
    // named by EXOSCALE_AI_ENDPOINT, and the legacy integration kept while
    // it has accounts.
    await ctx.integration.transform((editor) => {
      try {
        for (const zone of registeredZones()) {
          const id = integrationForZone(zone);
          editor.update(id, (integration) => {
            integration.name = `Exoscale ${zone}`;
          });
          editor.method.update({
            integrationID: id,
            method: { type: "key", label: `Paste API key for ${zone}` },
          });
        }
        const zoneFromEnv = envZone(process.env);
        if (zoneFromEnv) {
          editor.method.update({
            integrationID: integrationForZone(zoneFromEnv),
            method: { type: "env", names: [ENV_KEY] },
          });
        }
        for (const id of dedicatedSlotIds(dedicatedConnected.map((slot) => slot.id))) {
          const connected = dedicatedConnected.find((slot) => slot.id === id);
          editor.update(id, (integration) => {
            integration.name = dedicatedIntegrationName(connected?.endpoint);
          });
          editor.method.update({
            integrationID: id,
            method: {
              type: "key",
              label: dedicatedKeyLabel(connected?.endpoint),
              form: [
                {
                  type: "string",
                  key: "endpoint",
                  title: "Dedicated Inference endpoint",
                  description: "Deployment URL for this key. Not an on-demand zone endpoint.",
                  required: true,
                  placeholder: "https://<deployment>.inference.<zone>.exoscale-cloud.com/v1",
                },
              ],
            },
          });
        }
        if (legacyHasAccounts) {
          // Legacy pre-zone accounts keep working until reconnected on a
          // zone integration or a dedicated slot.
          editor.update(INTEGRATION_ID, (integration) => {
            integration.name = "Exoscale";
          });
          editor.method.update({
            integrationID: INTEGRATION_ID,
            method: {
              type: "key",
              label: "Paste Exoscale API key",
              form: [
                {
                  type: "string",
                  key: "zone",
                  title: "Zone",
                  description: "The zone your API key belongs to (keys are zone-local).",
                  required: true,
                  custom: true,
                  options: zoneOptions(),
                },
                {
                  type: "string",
                  key: "endpoint",
                  title: "Dedicated Inference endpoint",
                  description:
                    "Optional. Deployment URL for Exoscale Dedicated Inference. Leave empty for on-demand inference in the picked zone.",
                  placeholder: "https://<deployment>.inference.<zone>.exoscale-cloud.com/v1",
                },
              ],
            },
          });
          // Drop an env method an older version left on the legacy row.
          editor.method.remove(INTEGRATION_ID, { type: "env", names: [ENV_KEY] });
        } else {
          // Nothing left on the legacy integration: drop it from /connect.
          if (editor.get(INTEGRATION_ID)) editor.remove(INTEGRATION_ID);
        }
      } catch (error) {
        console.error("[opencode-exoscale] integration transform failed:", error);
      }
    });

    // Surface a discovery failure on a connection. Some plugin adapter
    // versions do not implement status(); tolerate that.
    const setConnectionStatus = async (
      integrationID: string,
      connection: ConnectionInfo,
      status: { status: string; message?: string } | undefined,
    ) => {
      const connectionApi = ctx.integration.connection as {
        status?: (input: {
          integrationID: string;
          connection: ConnectionInfo;
          status: { status: string; message?: string } | undefined;
        }) => Promise<void>;
      };
      if (typeof connectionApi.status !== "function") return;
      await connectionApi.status({ integrationID, connection, status }).catch(() => {});
    };

    let reloading: Promise<void> = Promise.resolve();
    const reloadIntegrations = () => {
      reloading = reloading.then(() => ctx.integration.reload()).catch((error) => {
        console.error("[opencode-exoscale] integration reload failed:", error);
      });
      return reloading;
    };

    const sameSlots = (next: { id: string; endpoint?: string }[]) =>
      next.length === dedicatedConnected.length &&
      next.every((slot, index) => slot.id === dedicatedConnected[index]?.id && slot.endpoint === dedicatedConnected[index]?.endpoint);

    // Reads which rows already have a key so the transform can keep a zone
    // that dropped off the API and can name dedicated rows. Reloads only
    // when that set changes, which is what adds the next empty dedicated slot.
    const syncAccounts = async () => {
      const legacy = await ctx.integration.get({ integrationID: INTEGRATION_ID }).catch(() => undefined);
      const nextLegacy = (legacy?.data?.connections?.length ?? 0) > 0;

      const zoneIds = new Set<string>();
      const listed = await ctx.integration.list().catch(() => undefined);
      for (const integration of listed?.data ?? []) {
        if (zoneFromIntegration(integration.id)) zoneIds.add(integration.id);
      }
      for (const zone of registeredZones([])) zoneIds.add(integrationForZone(zone));
      const nextZones: string[] = [];
      for (const id of zoneIds) {
        const detail = await ctx.integration.get({ integrationID: id }).catch(() => undefined);
        if ((detail?.data?.connections?.length ?? 0) > 0) nextZones.push(id);
      }

      const nextDedicated: { id: string; endpoint?: string }[] = [];
      for (let index = 1; index < 32; index++) {
        const id = dedicatedIntegrationId(index);
        const detail = await ctx.integration.get({ integrationID: id }).catch(() => undefined);
        if (!detail?.data) break;
        const connection = detail.data.connections?.find((item) => item.type === "credential");
        if (!connection) continue;
        const credential = await ctx.integration.connection.resolve(connection).catch(() => undefined);
        nextDedicated.push({ id, endpoint: dedicatedEndpoint(answersFrom(credential)) });
      }

      const zonesChanged =
        nextZones.length !== connectedZoneIds.length || nextZones.some((id) => !connectedZoneIds.includes(id));
      const changed = nextLegacy !== legacyHasAccounts || zonesChanged || !sameSlots(nextDedicated);
      legacyHasAccounts = nextLegacy;
      connectedZoneIds = nextZones;
      dedicatedConnected = nextDedicated;
      if (zonesChanged) await ctx.storage?.set(CONNECTED_ZONES_KEY, nextZones).catch(() => {});
      if (changed) await reloadIntegrations();
    };

    const refresh = async (signal?: AbortSignal) => {
      await syncAccounts();
      // Every exo* integration, zone integrations first, legacy last: for a
      // duplicate endpoint the zone integration's plan wins.
      const listed = await ctx.integration.list().catch(() => undefined);
      const integrations = (listed?.data ?? [])
        .filter((integration) => integration.id === INTEGRATION_ID || integration.id.startsWith(`${INTEGRATION_ID}-`))
        .sort((a, b) => (a.id === INTEGRATION_ID ? 1 : b.id === INTEGRATION_ID ? -1 : 0));

      // One plan per connection (per integration, active account first). An
      // integration without connections gets an env bootstrap plan only for
      // the zone named by EXOSCALE_AI_ENDPOINT; planDiscovery decides.
      const plans: DiscoveryPlan[] = [];
      for (const integration of integrations) {
        const detail = await ctx.integration.get({ integrationID: integration.id }).catch(() => undefined);
        const connections = detail?.data?.connections ?? [];
        if (connections.length === 0) {
          plans.push(planDiscovery(undefined, undefined, process.env, integration.id));
          continue;
        }
        // A dedicated slot has one active key. Later accounts on the same
        // row share it; discovering them would publish a provider signed
        // with the wrong key. Active is first.
        const planned = isDedicatedIntegration(integration.id) ? connections.slice(0, 1) : connections;
        plans.push(
          ...(await Promise.all(
            planned.map(async (connection) =>
              planDiscovery(
                connection,
                connection.type === "credential"
                  ? await ctx.integration.connection.resolve(connection).catch(() => undefined)
                  : undefined,
                process.env,
                integration.id,
              ),
            ),
          )),
        );
      }

      for (const plan of plans) {
        if (plan.status !== "invalid") continue;
        await setConnectionStatus(plan.integrationID, plan.sourceConnection, {
          status: "needs_auth",
          message: plan.message,
        });
      }

      if (plans.every((plan) => plan.status === "reset")) {
        if (inventory) inventory = undefined;
        await ctx.provider.reload();
        return;
      }
      const endpoints = discoverableEndpoints(plans);
      if (endpoints.length === 0) {
        // A dedicated row with a bad URL owns no endpoint. Drop whatever
        // it published last time instead of keeping it.
        if (!plans.some((plan) => plan.status === "invalid") || !inventory) return;
        const invalid = new Set(plans.flatMap((plan) => (plan.status === "invalid" ? [plan.integrationID] : [])));
        for (const [endpoint, entry] of inventory) {
          if (invalid.has(entry.integrationID)) inventory.delete(endpoint);
        }
        if (inventory.size === 0) inventory = undefined;
        await ctx.provider.reload();
        return;
      }

      const next = new Map<string, Inventory>();
      for (const plan of endpoints) {
        let body: unknown;
        try {
          body = await fetchModels({ endpoint: plan.endpoint, key: plan.key, signal });
        } catch (error) {
          console.error(`[opencode-exoscale] model discovery failed for ${plan.endpoint}:`, error);
          // Keep the last good inventory for this endpoint; surface the
          // failure on the connection that owns it.
          const previous = inventory?.get(plan.endpoint);
          if (previous) next.set(plan.endpoint, previous);
          if (plan.sourceConnection) {
            await setConnectionStatus(plan.integrationID, plan.sourceConnection, {
              status: "needs_auth",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          continue;
        }
        // Discovery succeeded: clear any error status from a previous attempt.
        if (plan.sourceConnection) await setConnectionStatus(plan.integrationID, plan.sourceConnection, undefined);
        const identity = providerIdentity(plan.endpoint);
        const models = mapModels(body, identity.id);
        next.set(plan.endpoint, {
          providerID: identity.id,
          name: identity.name,
          endpoint: plan.endpoint,
          models,
          connectionFingerprint: plan.fingerprint,
          integrationID: plan.integrationID,
          signature: models.map((model) => model.id).join(","),
        });
      }

      const changed =
        next.size !== inventory?.size ||
        [...next.entries()].some(([endpoint, entry]) => {
          const previous = inventory?.get(endpoint);
          return (
            !previous ||
            previous.signature !== entry.signature ||
            previous.connectionFingerprint !== entry.connectionFingerprint ||
            previous.integrationID !== entry.integrationID
          );
        });
      if (!changed) return;
      inventory = next;
      await ctx.provider.reload();
    };

    // refresh runs from boot, the zone-list arrival, and credential events;
    // serialize the runs so they never overlap (same pattern as reloading).
    let refreshing: Promise<void> = Promise.resolve();
    const scheduleRefresh = (signal?: AbortSignal) => {
      refreshing = refreshing
        .then(() => refresh(signal))
        .catch((error) => console.error("[opencode-exoscale] refresh failed:", error));
      return refreshing;
    };

    const controller = new AbortController();

    // Do not await: registration and discovery must not wait on the zone
    // API. Zone rows appear when this lands; the refresh then picks up the
    // stored keys on those rows and publishes their providers. A single
    // attempt: zones are either here at boot time or not, and zones with a
    // stored key stay registered from the storage seed regardless.
    void fetchZones({ signal: AbortSignal.timeout(5000) })
      .then(async (options) => {
        if (options.length === 0 || controller.signal.aborted) return;
        liveZones = options.map((option) => option.value);
        await reloadIntegrations();
        await scheduleRefresh(controller.signal);
      })
      .catch((error) => console.error("[opencode-exoscale] zone list fetch failed:", error));

    await scheduleRefresh();

    // Re-discover when a credential is added, replaced, or the active
    // connection switches. The endpoint lives in the credential
    // configuration, so these cover every input that can change the
    // discovery result. We deliberately do NOT react to
    // integration.updated: our own integration transform marks that
    // registry dirty on every replay, which would turn each refresh into
    // a new event into a new refresh into an unbounded loop.
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          void scheduleRefresh(controller.signal);
        }
      }
    })();

    return () => controller.abort();
  },
});
