/**
 * OpenCode plugin: Exoscale inference providers.
 *
 * Registers one Exoscale integration per zone (live zone list) so each
 * shows up in /connect. API keys are zone-local and the server keeps one
 * active credential per integration, so each zone is its own integration:
 * connect several zones and they all stay active at once, each with its
 * own key.
 *
 * Each endpoint gets its own provider: exo-<zone> for on-demand inference
 * in <zone>, exo-<zone>-<id> for a Dedicated Inference deployment. Models
 * are discovered live from {endpoint}/models with the zone's active
 * credential and registered as that provider's inventory.
 *
 * Discovery re-runs when a credential is added, replaced, or the active
 * account switches; a transient failure keeps the last good inventory for
 * that endpoint and reports the error on the connection.
 *
 * EXOSCALE_API_KEY works as an environment method on the default zone
 * (de-fra-1) too; before any account is connected it (optionally with
 * EXOSCALE_ENDPOINT) drives discovery.
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
// empty. Zone integrations are integrationForZone(zone).
export const INTEGRATION_ID = "exo";
export const DEFAULT_ZONE = "de-fra-1";
export const DEFAULT_ENDPOINT = endpointForZone(DEFAULT_ZONE);
export const ZONE_API = "https://api-ch-gva-2.exoscale.com/v2/zone";
const RUNTIME_PACKAGE = "@opencode/ai/providers/openai-compatible";
const ENV_KEY = "EXOSCALE_API_KEY";
const ENV_ENDPOINT = "EXOSCALE_ENDPOINT";

// ============================================================================
// Endpoint resolution
// ============================================================================

// Normalizes an endpoint pasted into the connect form: trims whitespace,
// drops trailing slashes, and appends /v1 when the path lacks it.
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_ENDPOINT;
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

// Endpoint used for an account, from its connect-form answers:
// 1. endpoint - explicit Dedicated Inference deployment URL
// 2. zone     - on-demand inference in the picked zone
// 3. baseURL  - legacy answers from accounts connected before the zone
//               picker existed
// 4. default  - de-fra-1 on-demand
export function endpointFor(configuration: Record<string, unknown> | undefined): string {
  const explicit = configuration?.endpoint;
  if (typeof explicit === "string" && explicit.trim()) return normalizeEndpoint(explicit);
  const zone = configuration?.zone;
  if (typeof zone === "string" && zone.trim()) return endpointForZone(zone.trim());
  const legacy = configuration?.baseURL;
  if (typeof legacy === "string" && legacy.trim()) return normalizeEndpoint(legacy);
  return DEFAULT_ENDPOINT;
}

// ============================================================================
// Provider identity
// ============================================================================

export type ProviderIdentity = { id: string; name: string };

// One provider per endpoint. Keys are zone-local, so the provider ID is
// derived from the endpoint host:
// - inference.<zone>.exoscale-cloud.com           -> exo-<zone>
// - <deployment>.inference.<zone>....exoscale.com -> exo-<zone>-<deployment8>
// Unknown hosts get a deterministic slug so the ID is stable across runs.
export function providerIdentity(endpoint: string): ProviderIdentity {
  const labels = hostnameOf(endpoint).split(".");
  if (
    labels.length >= 4 &&
    labels[labels.length - 1] === "com" &&
    labels[labels.length - 2] === "exoscale-cloud" &&
    labels[labels.length - 4] === "inference"
  ) {
    const zone = labels[labels.length - 3];
    const deployment = labels.length > 4 ? labels[0] : undefined;
    if (!deployment)
      return { id: `exo-${zone}`, name: `Exoscale ${zone} (On-demand Inference)` };
    return { id: `exo-${zone}-${deployment.slice(0, 8)}`, name: `Exoscale ${zone} (Dedicated Inference)` };
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

// Maps the zone API response to connect-form options. The endpoint is
// unauthenticated; when the fetch fails the picker offers free typing only
// (the zone field is custom).
export function zonesFromApi(body: unknown): { value: string; label: string }[] {
  const zones = body && typeof body === "object" ? (body as { zones?: unknown }).zones : undefined;
  if (!Array.isArray(zones)) return [];
  const names: string[] = [];
  for (const zone of zones) {
    const name = zone && typeof zone === "object" ? (zone as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.trim() && !names.includes(name.trim())) names.push(name.trim());
  }
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
type ResolvedCredential =
  | { type: "key"; key: string; configuration?: Record<string, unknown> }
  | { type: "oauth" };

// What discovery should use:
// - discover: proceed with this key/endpoint/fingerprint
// - keep:     a connection exists but no key is usable right now; keep the
//             last good inventory (no fetch)
// - reset:    nothing is configured; clear any inventory
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
  | { status: "reset" };

// Decides, from a connection, its resolved credential, and the server
// environment, what discovery should use for that connection. With no
// connection at all the environment is the plan source. Pure so each branch
// is unit-testable without a live service.
export function planDiscovery(
  connection: ConnectionInfo | undefined,
  credential: ResolvedCredential | undefined,
  env: Record<string, string | undefined>,
  integrationID: string,
): DiscoveryPlan {
  if (connection) {
    if (connection.type === "env") {
      const key = env[connection.name] ?? "";
      if (!key) return { status: "keep" };
      return {
        status: "discover",
        input: {
          key,
          endpoint: endpointFor({ baseURL: env[ENV_ENDPOINT] }),
          fingerprint: connectionFingerprint(connection),
          integrationID,
          sourceConnection: connection,
        },
      };
    }
    if (credential?.type !== "key" || !credential.key) return { status: "keep" };
    return {
      status: "discover",
      input: {
        key: credential.key,
        endpoint: endpointFor(credential.configuration),
        fingerprint: connectionFingerprint(connection),
        integrationID,
        sourceConnection: connection,
      },
    };
  }
  // No account connected (fresh install): fall back to the environment so
  // the provider works before the first /connect.
  const key = env[ENV_KEY] ?? "";
  if (!key) return { status: "reset" };
  return {
    status: "discover",
    input: {
      key,
      endpoint: endpointFor({ baseURL: env[ENV_ENDPOINT] }),
      fingerprint: `env:${integrationID}`,
      integrationID,
    },
  };
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

    // Zone list for the per-zone integrations, fetched live. On failure no
    // zone integration is created; the error is logged.
    const zoneOptions = await fetchZones({ signal: AbortSignal.timeout(5000) }).catch((error) => {
      console.error("[opencode-exoscale] zone list fetch failed:", error);
      return [] as { value: string; label: string }[];
    });

    // The legacy integration, kept only while it still has accounts.
    const legacy = await ctx.integration.get({ integrationID: INTEGRATION_ID }).catch(() => undefined);
    const legacyHasAccounts = (legacy?.data?.connections?.length ?? 0) > 0;

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

    // Integrations: one per zone (key + optional Dedicated Inference
    // endpoint), the env method on the default zone, and the legacy
    // integration kept (or removed) based on whether it still has accounts.
    await ctx.integration.transform((editor) => {
      try {
        for (const { value: zone } of zoneOptions) {
          const id = integrationForZone(zone);
          editor.update(id, (integration) => {
            integration.name = `Exoscale ${zone}`;
          });
          editor.method.update({
            integrationID: id,
            method: {
              type: "key",
              label: "Paste Exoscale API key",
              form: [
                {
                  type: "string",
                  key: "endpoint",
                  title: "Dedicated Inference endpoint",
                  description:
                    "Optional. Deployment URL for Exoscale Dedicated Inference. Leave empty for on-demand inference.",
                  placeholder: `https://<deployment>.inference.${zone}.exoscale-cloud.com/v1`,
                },
              ],
            },
          });
        }
        editor.method.update({
          integrationID: integrationForZone(DEFAULT_ZONE),
          method: { type: "env", names: [ENV_KEY] },
        });
        if (legacyHasAccounts) {
          // Legacy pre-zone accounts keep working until reconnected on a
          // zone integration.
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
                  default: DEFAULT_ZONE,
                  custom: true,
                  options: zoneOptions,
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
          // The env method moved to the default zone integration.
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

    const refresh = async (signal?: AbortSignal) => {
      // Every exo* integration, zone integrations first, legacy last: for a
      // duplicate endpoint the zone integration's plan wins.
      const listed = await ctx.integration.list().catch(() => undefined);
      const integrations = (listed?.data ?? [])
        .filter((integration) => integration.id === INTEGRATION_ID || integration.id.startsWith(`${INTEGRATION_ID}-`))
        .sort((a, b) => (a.id === INTEGRATION_ID ? 1 : b.id === INTEGRATION_ID ? -1 : 0));

      // One plan per connection (per integration, active account first). An
      // integration without connections contributes an env bootstrap plan
      // only when it carries the env method (the default zone).
      const plans: DiscoveryPlan[] = [];
      for (const integration of integrations) {
        const detail = await ctx.integration.get({ integrationID: integration.id }).catch(() => undefined);
        const connections = detail?.data?.connections ?? [];
        if (connections.length === 0) {
          plans.push(
            integration.id === integrationForZone(DEFAULT_ZONE)
              ? planDiscovery(undefined, undefined, process.env, integration.id)
              : { status: "reset" },
          );
          continue;
        }
        plans.push(
          ...(await Promise.all(
            connections.map(async (connection) =>
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

      if (plans.every((plan) => plan.status === "reset")) {
        if (inventory) inventory = undefined;
        await ctx.provider.reload();
        return;
      }
      const endpoints = discoverableEndpoints(plans);
      if (endpoints.length === 0) return; // nothing usable right now; last good inventory stands

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

    await refresh().catch((error) => console.error("[opencode-exoscale] refresh failed:", error));

    // Re-discover when a credential is added, replaced, or the active
    // connection switches. The endpoint lives in the credential
    // configuration, so these cover every input that can change the
    // discovery result. We deliberately do NOT react to
    // integration.updated: our own integration transform marks that
    // registry dirty on every replay, which would turn each refresh into
    // a new event into a new refresh into an unbounded loop.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          void refresh(controller.signal).catch((error) =>
            console.error("[opencode-exoscale] refresh failed:", error),
          );
        }
      }
    })();

    return () => controller.abort();
  },
});
