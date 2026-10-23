# Design

## Context

The harness change `add-web-research-tools` declares `ConversationAgentDeps.searxngBaseUrl` and gates `web_search` on it. The CLI owns the compose stack (`src/modules/infra/compose.ts`), the channel-aware ports and paths (`src/lib/env.ts`), and the composition root that fills the harness deps (`src/modules/harness/runtime.ts`). The research (`docs/web-search-research.md` §4–5) fixes the SearXNG facts: image `docker.io/searxng/searxng` with dated tags, container port 8080, config at `/etc/searxng/settings.yml`, JSON format off by default (403 for an unlisted format), the container stops on the shipped `ultrasecretkey`, the limiter is off by default, and no Valkey is needed.

## Goals / Non-Goals

**Goals:**

- One more stack service that `inflexa up` starts and `inflexa down` stops, in every connection mode.
- A settings file whose secret key is made one time, so a re-setup changes nothing.
- The harness URL derived from the channel port, with no user-facing knob.

**Non-Goals:**

- The Valkey/Redis service (the limiter is off).
- A readiness probe or a health gate for SearXNG: the tool treats an absent engine as a normal error result.
- A config field or an environment variable for the URL.

## Decisions

### The service is mode-independent, the Postgres position

The proxy comes and goes with the connection mode; Postgres is always defined. SearXNG takes the Postgres position: always defined, after the Postgres block in the template, on the shared network, `restart: unless-stopped`. Port publishing copies the proxy and Postgres form — `"127.0.0.1:${env.searxngPort}:8080"` — because the engine answers anyone who reaches the port, and the only listener that must reach it is the harness on the same host.

### The image pin copies `PROXY_IMAGE`, with a dated tag

`SEARXNG_IMAGE = "docker.io/searxng/searxng:<dated-tag>@sha256:<digest>"`. The tag is the dated release tag (`2026.10.19-81371861f` form), never `latest`, and the digest is the manifest digest of that tag, resolved from the Docker Hub registry at pin time. The bump procedure comment mirrors the proxy's: change tag and digest together. The pin site carries no calibration points — the proxy's launch-gate calibration does not apply — so the comment says what a bump is and drops the re-verification step. `composePullIfMissing` lists `SEARXNG_IMAGE` in every mode; `composePull`/`composePullInteractive` error text names it.

### The settings file is a provisioned `file` mount source

The classify-and-heal logic of `proxy_config.ts` (absent, our file, an empty engine-made directory that heals, an occupant that stays inviolable) is the same logic the settings file needs, so the helpers (`classifyPath`, `tryFs`, and a shared `ensureFileMountSource`) lift to one new file `src/modules/infra/mount_source.ts` and both provisioners call it — no second copy. A new `src/modules/infra/searxng_config.ts` holds `writeSearxngSettings()` on the `writeProxyConfig()` pattern: write the canonical bytes, return the `InfraStateError` Result. The canonical file:

```yaml
use_default_settings: true
server:
  secret_key: "<32-byte random hex>"
  limiter: false
  public_instance: false
search:
  formats:
    - html
    - json
```

The key is `randomBytes(32).toString("hex")` of `node:crypto`, minted once, written to a per-call temporary file and published with an exclusive `link` (the first writer wins; a concurrent call that loses the race keeps the winner's file and its key). A provisioner run that finds an existing regular file keeps it untouched, whatever it holds — the file is the user's to edit after the first run, and the guard's job is to make it exist, not to police it. An empty directory at the path heals to the file (the engine-manufactured case); any other occupant stays inviolable and names itself in the error. `inflexa down --delete-data` keeps the SearXNG settings directory: the secret key is configuration, not user data. The settings path is a member of the `ComposeHost` seam, so tests control it like the other mount sources. `mountManifest` pushes the `file` source in every mode, mounted read-only (`:ro`) at `/etc/searxng/settings.yml`; the mount-source coverage test keeps the manifest and the template in lock-step, and its exact-equality assertions gain the new source in every mode.

### The path is channel-aware in `stackPaths`

`stackPaths` gains `searxngSettingsPath`: `searxng/settings.yml` in production, `searxng-dev/settings.yml` in development, under the data dir — the sibling-name rule of every stack path, so the two channels never share one secret key.

### The port family grows, not moves

`StackPorts` gains `searxng`; `stackPorts` returns 28437 (production) and 28438 (development). Both are outside the historical 831x/843x blocks and below the ephemeral ranges, per the research; the port-family comment in `env.ts` gains the two ports in its bound-set enumeration. `env.searxngPort` and `env.searxngBaseUrl` (`http://127.0.0.1:<port>`) follow the `cliproxyPort`/`cliproxyApiUrl` shape, derived, excluded from `envDoc`/`--help`.

### The URL enters the harness at the conversation assembly

The harness runtime passes `searxngBaseUrl: env.searxngBaseUrl` into the conversation deps bag it fills at boot, next to the knowledge block. No gate, no notice: an engine that is down is a normal `web_search` error result, and `web_fetch` never needed the URL. One coupling stays: the engine is a first-class stack service, so a failed image pull or a port conflict stops `inflexa up` and the boot the same way a Postgres failure does — the accepted trade-off of treating it as stack infrastructure rather than an optional sidecar.

The tool sends no URL credentials: a `user:pass@` prefix is stripped before a hop, because the authenticated fetch is out of scope and node would otherwise derive a Basic Authorization header from the URL.

## Risks / Trade-offs

- [A dated tag pins an engine set that drifts] → The digest makes a republished tag inert; a bump is a deliberate change, the same trade the proxy pin already makes.
- [SearXNG has no readiness gate in `up`] → The first search after a cold boot can fail; the tool reports the error and the model retries. Adding a gate would couple the boot to a service the harness treats as optional.
- [The settings file is user-editable and the provisioner keeps it] → Deliberate: the one-time secret key is the only generated value, and the guard's contract is existence, not content policing.
