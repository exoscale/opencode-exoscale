# opencode-exoscale

OpenCode plugin that registers Exoscale as an inference provider. Once
installed, Exoscale shows up in `/connect` — no provider or model
configuration needed in `opencode.json`.

## Setup

1. Clone the repo:

   ```sh
   git clone https://github.com/exoscale/opencode-exoscale ~/path/to/opencode-exoscale
   ```

2. Install its dependencies (from the committed lockfile):

   ```sh
   cd ~/path/to/opencode-exoscale
   npm ci
   ```

   The server loads the plugin as-is and does not install its
   dependencies, so this step is required.

3. Add the plugin to `opencode.json`:

   ```jsonc
   {
     "plugins": ["~/path/to/opencode-exoscale"]
   }
   ```

## Behavior

- Registers one integration per zone so each shows up in `/connect` as
  **Exoscale `<zone>`** (zones come from the zone API at startup, plus any
  zone you already connected, which stays listed even if that fetch fails):
  - **Paste API key for `<zone>`** — on-demand only.
  - A zone also gets an **Environment** method reading `EXOSCALE_AI_API_KEY`
    when `EXOSCALE_AI_ENDPOINT` names it. Keys are zone-local: the endpoint
    picks the zone, there is no default zone.
- Dedicated Inference uses its own key, not the zone key. `/connect` always
  has one empty **Exoscale Dedicated Inference** row (deployment URL, then
  key). Connecting it keeps that row — named from the deployment — and adds
  the next empty row, so another deployment does not replace a zone key or
  another deployment.
- API keys are per integration, and each request is signed with that
  integration's active credential. Connect several zones and several
  deployments and they all stay active at once — no switching, and one
  row's accounts never invalidate another's.
- One provider per endpoint:
  - `exo-<zone>` for on-demand inference in `<zone>`
    (model refs like `exo-de-fra-1/nvidia/Qwen3.8-27B-NVFP4`),
  - `exo-<zone>-<id>` for a Dedicated Inference deployment in `<zone>`,
    signed with that deployment's key, not the zone key.
- After a connection is stored, models are discovered live from
  `{endpoint}/models` with the account's credential and appear in `/models`.
- Discovery re-runs when credentials are added, replaced, or the active
  account is switched. Each row is discovered with its active key. A failed
  discovery keeps the last good model list for that endpoint and reports the
  error on the connection. A dedicated row with no deployment URL, or with
  an on-demand zone URL, is not discovered.
- `EXOSCALE_AI_API_KEY` also works before any account is connected (fresh
  install), for the zone named by `EXOSCALE_AI_ENDPOINT` (an on-demand
  endpoint). Without `EXOSCALE_AI_ENDPOINT` the env key is not used — there
  is no default zone to guess.
- A pre-zone `exo` integration is kept while it still has accounts and is
  removed automatically once empty. A pre-zone account that recorded no
  zone or endpoint is not discovered and must be reconnected.
- Model context/output limits are taken from `max_model_len` /
  `max_completion_tokens` when the backend reports them.

## Development

```sh
npm ci          # exact deps from the committed lockfile
npm test        # node --test
npm run typecheck
```

Plugin code changes require a full `opencode service restart`;
`opencode reload` re-runs plugin setup with the previously loaded module.
