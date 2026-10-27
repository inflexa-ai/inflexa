## Why

A direct connection with a real OpenAI key spoke chat completions, which carries a tool result as text. Thus the model never got a tool picture, for example the page picture of `examine_page`. A direct OpenAI-compatible endpoint that takes a tool message of parts had no way to say so.

## What Changes

- A new protocol `openai` binds the Responses wire of the harness `openai` arm. It carries a tool picture.
- The provider `openai` at `api.openai.com` implies `openai`. Each other host keeps `openai-compatible`.
- A direct connection takes `supportsMultiPartToolContent`, and boot passes it to the harness.
- Setup offers the protocol, and the env adoption of an OpenAI key at the OpenAI API writes `openai`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `model-connection`: the `openai` protocol, its implication, and the multipart flag.

## Impact

- `src/lib/config.ts`, `src/modules/harness/config.ts`, `src/modules/harness/runtime.ts`.
- `src/modules/infra/setup.ts`, `src/modules/infra/setup_answers.ts`, `src/cli/index.ts`.
- A config with provider `openai` at `api.openai.com` and no `protocol` moves to the Responses wire.
