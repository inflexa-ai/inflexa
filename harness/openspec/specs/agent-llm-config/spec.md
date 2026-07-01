## Purpose

Defines the per-model capability gate at the harness provider edge that silently strips request fields the target model would reject (e.g., Anthropic Opus 4.7+ rejects `temperature`). Lives at `harness/providers/llm-capabilities.ts`. Callers pass per-call overrides (`temperature`, `thinking`, tool config, …) as native `ChatRequest` fields; the gate is pattern-based on the bare model name, with no network calls or runtime probing.

## Requirements

### Requirement: Capability probe module

The system SHALL provide a `harness/providers/llm-capabilities.ts` module exposing pure functions that classify a model name and decide whether a model accepts a given request field. The module SHALL classify models by static pattern matching on the model name string, with no network calls or runtime probing.

#### Scenario: Anthropic temperature acceptance

- **WHEN** `anthropicAcceptsTemperature(modelName)` is called
- **THEN** it returns `false` for any name matching `claude-(opus|sonnet|haiku)-4-7` or later
- **AND** it returns `true` for `claude-opus-4-6`, `claude-sonnet-4-6`, and `claude-3-*`

### Requirement: Drop-on-reject at the provider edge

The Anthropic provider SHALL strip `temperature` from the outbound request when `anthropicAcceptsTemperature(modelName)` is `false`, so calls succeed instead of returning HTTP 400.

#### Scenario: Temperature stripped on Opus 4.7

- **WHEN** `ChatProvider.chat` is invoked with `{ model: "claude-opus-4-7", temperature: 0.2 }`
- **THEN** the outbound Anthropic call omits `temperature`
- **AND** the call succeeds

#### Scenario: Temperature passed through on Opus 4.6

- **WHEN** `ChatProvider.chat` is invoked with `{ model: "claude-opus-4-6", temperature: 0.2 }`
- **THEN** the outbound Anthropic call includes `temperature: 0.2`
