# unit-test-coverage Specification

## Purpose
TBD - created by archiving change add-test-suite. Update Purpose after archive.
## Requirements
### Requirement: String value-type validation is tested
The suite SHALL verify `str256`/`asStr256` (`lib/types.ts`): trimming, code-point counting
(multi-code-point emoji count once), and the boundaries empty / 256-ok / 257-too-long.

#### Scenario: boundary lengths
- **WHEN** `str256` is given `""`, `"   "`, a 256-code-point string, and a 257-code-point string
- **THEN** the first two yield the empty error, 256 succeeds, and 257 yields the too-long error

#### Scenario: code-point counting
- **WHEN** `str256` is given a string of multi-code-unit emoji
- **THEN** length is counted by code points (`[...s].length`), not UTF-16 units

### Requirement: Global extensions are tested
The suite SHALL verify the `src/extensions/*` methods: `JSON.parseWith` (null on parse-throw and on
schema-mismatch), `Response.prototype.jsonWith`, `Date.relativeAge` (s/m/h/d buckets and negative
clamp to `0s`), and `Promise.sleep` (under fake timers).

#### Scenario: parseWith fails closed
- **WHEN** `JSON.parseWith` receives malformed JSON or JSON failing the schema
- **THEN** it returns `null` rather than throwing

#### Scenario: relativeAge negative clamp
- **WHEN** `Date.relativeAge` is given a future timestamp
- **THEN** it returns `"0s"` (clamped), not a negative value

### Requirement: Auth pure helpers are tested
The suite SHALL verify `describeAuthError` (all variants), `decodeIdTokenClaims` (valid /
missing-segment / malformed / schema-mismatch → null), `isExpiring` (expiry buffer), and
`tokenWireToStoredAuth` (refresh-token merge/validation). Time-dependent helpers run with a
controlled clock.

#### Scenario: every auth error variant maps to a message
- **WHEN** `describeAuthError` is called with each `AuthError` variant
- **THEN** it returns a non-empty message for every variant (exhaustive)

#### Scenario: JWT decode rejects malformed input
- **WHEN** `decodeIdTokenClaims` receives a token with a missing/garbled payload segment
- **THEN** it returns `null` without throwing

### Requirement: Chat message-shaping is tested
The suite SHALL verify `toModelMessages` (history → `ModelMessage[]`, text parts only, empty turns
dropped) and `pickDefaultModel` (preference order `claude>gpt>gemini>qwen`, fallback to first id).

#### Scenario: empty turns dropped
- **WHEN** `toModelMessages` receives a turn with no text parts
- **THEN** that turn is omitted from the output

#### Scenario: default model preference and fallback
- **WHEN** `pickDefaultModel` is given a model list with and without a preferred id
- **THEN** it returns the highest-preference match, else the first id

### Requirement: Analysis pure helpers are tested
The suite SHALL verify `contains`/`canWrite`/`canRead` (`analysis/boundary.ts`, boundary-safe
containment so `/a/bc` is not inside `/a/b`), `makeBaseSlug` (NFKD kebab + symbol-only fallback),
`describeContext`/`plural` (per `ResolvedContext` variant), and `openerArgv` (darwin/win32/xdg incl.
the empty Windows title arg).

#### Scenario: containment is boundary-safe
- **WHEN** `contains("/a/b", "/a/bc")` is evaluated
- **THEN** it returns false (prefix-but-not-descendant is rejected)

#### Scenario: slug symbol-only fallback
- **WHEN** `makeBaseSlug` is given a symbol-only name
- **THEN** it returns the `analysis-<6 chars>` fallback form

### Requirement: Config and data-table invariants are tested
The suite SHALL verify `configSchema` self-healing (`theme`/`runtime`/`leaderTimeout` coerce bad
values via `.catch`, while `telemetry` does not self-heal), and the `design_system.ts` cross-table
invariants (every theme has all `ThemeColors` keys; every `MARKERS[k].role` is a valid
`ThemeColors` key; `DEFAULT_THEME_ID` ∈ theme ids).

#### Scenario: config self-heals non-strict fields
- **WHEN** `configSchema` parses an object with an invalid `theme` value
- **THEN** it coerces to the default theme (does not reject the whole config)

#### Scenario: every marker role is a real theme color
- **WHEN** the design-system invariants run
- **THEN** every `MARKERS` entry's `role` is a key of `ThemeColors` and every theme defines all keys

### Requirement: Container and proxy builders are tested
The suite SHALL verify `runtimes.*.mountArg` (docker `host:ctr` vs podman `host:ctr:z`) and the
`proxyConfig` YAML builder + `generateApiKey` structure (`sk-` prefix, length, charset).

#### Scenario: podman appends the :z mount flag
- **WHEN** the podman runtime builds a mount arg
- **THEN** the result ends in `:z` and the docker runtime's does not

