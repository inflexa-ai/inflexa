## Why

The `openai-compatible` arm sends a tool result as JSON text. Thus a tool picture cannot reach the model over that wire, and the loop drops it. The package gained `supportsMultiPartToolContent` in 3.0.62. With the flag, it sends the tool message as a list of parts, and a picture rides as an `image_url` part. A backend must take the parts, thus the flag is a fact that the embedder states.

## What Changes

- The AI SDK packages move to the latest releases, which carry the flag.
- The `openai-compatible` config takes `supportsMultiPartToolContent`, and the arm passes it to the package.
- When the flag is set, the arm asserts `imageToolResults`. A config capability overrides it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-sdk-provider-runtime`: the picture capability of the `openai-compatible` arm.

## Impact

- `src/providers/ai-sdk.ts`, `package.json`, `bun.lock`.
