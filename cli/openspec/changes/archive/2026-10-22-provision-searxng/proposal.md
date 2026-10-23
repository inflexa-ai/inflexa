# Provision SearXNG in the compose stack and give the harness its URL

## Why

The harness gains `web_search` and `web_fetch` in its own change. `web_search` reads a SearXNG instance, and the harness is host-agnostic: the embedder gives the URL. The CLI is the embedder, thus it runs the engine as one more service of its compose stack, on the loopback address, and hands the URL to the conversation assembly at its composition root. The research in `docs/web-search-research.md` fixes the image, the settings file, and the ports.

## What Changes

- A SearXNG service in `generateComposeFile`, independent of the connection mode, on the shared network. The image is pinned by tag and digest, the same form as `PROXY_IMAGE`; the port publishes on `127.0.0.1` only. The container port is 8080.
- The image joins the pull lists of `composePullIfMissing` and the error text of `composePull`, for both connection modes.
- A channel-aware `settings.yml` path under the data dir (`searxng/` in production, `searxng-dev/` in development), provisioned as a `file` mount source in `mountManifest`: `use_default_settings: true`, `search.formats: [html, json]`, `server.limiter: false`, `public_instance: false`, and a random `secret_key`. The key is made one time and later runs keep it (SearXNG stops on the shipped `ultrasecretkey`, and a new key each run would log every user out of nothing but would churn the file the user may inspect). The mount is read-only at `/etc/searxng/settings.yml`.
- A `searxng` member of `StackPorts` (28437 in production, 28438 in development) and the derived URL `http://127.0.0.1:<port>` in `env`.
- The boot passes the URL to the conversation assembly as the SearXNG base URL of the harness deps, so `web_search` attaches. No config block and no environment variable: the CLI owns the container, so the endpoint is not user-overridable, the same rule as the proxy URL.

## Capabilities

### New Capabilities

- `searxng-provisioning`: the compose service, the image pin, the settings-file provisioner with its one-time secret key, the loopback-only port, and the URL hand-off.

### Modified Capabilities

- `postgres-provisioning`: the compose stack and the container-name/ports requirement gain the SearXNG service and its port; `inflexa up` and `inflexa down` cover it.
- `infra-state-resilience`: the mount-source integrity manifest gains the settings-file source, provisioned before the engine runs.

## Impact

- `src/modules/infra/compose.ts`: `SEARXNG_IMAGE`, the service template, `mountManifest`, the pull lists, the pull error text.
- `src/modules/infra/mount_source.ts` (new): the classify/heal helpers lifted from `proxy_config.ts`, shared by both file provisioners.
- `src/modules/infra/searxng_config.ts` (new): the settings provisioner.
- `src/modules/infra/proxy_config.ts`: the lift turns its private helpers into calls of the shared module.
- `src/lib/env.ts`: `StackPorts.searxng`, `stackPorts`, the stack paths, `env.searxngPort`, `env.searxngBaseUrl`, the bound-port-set comment.
- `src/modules/harness/runtime.ts` (and the deps bag it fills): the SearXNG base URL into the conversation assembly.
- Tests: `compose.test.ts` snapshots and the manifest-coverage test, the port table test, the provisioner tests, and the roster-visible boot test.
