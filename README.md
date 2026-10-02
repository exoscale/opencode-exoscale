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

- Registers one integration per zone (from the live zone list) so each
  shows up in `/connect` as **Exoscale `<zone>`**:
  - **Paste Exoscale API key** — plus an optional *Dedicated Inference
    endpoint* field for a dedicated deployment URL.
  - The default zone (de-fra-1) also has an **Environment** method:
    `EXOSCALE_API_KEY` on the OpenCode server.
- API keys are zone-local, so each zone is its own integration and each
  request is signed with that zone's active credential. Connect several
  zones and they all stay active at once — no switching, and one zone's
  accounts never invalidate another's.
- One provider per endpoint:
  - `exo-<zone>` for on-demand inference in `<zone>`
    (model refs like `exo-de-fra-1/nvidia/Qwen3.8-27B-NVFP4`),
  - `exo-<zone>-<id>` for a Dedicated Inference deployment in `<zone>`.
- After a connection is stored, models are discovered live from
  `{endpoint}/models` with the account's credential and appear in `/models`.
- Discovery re-runs when credentials are added, replaced, or the active
  account is switched (every connected account is discovered). A failed
  discovery keeps the last good model list for that endpoint and reports the
  error on the connection.
- `EXOSCALE_API_KEY` also works before any account is connected (fresh
  install): it drives discovery against the default zone's on-demand
  endpoint (de-fra-1), or against `EXOSCALE_ENDPOINT` when set.
- A pre-zone `exo` integration is kept while it still has accounts and is
  removed automatically once empty.
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
