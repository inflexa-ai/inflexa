# Proposal: add-image-user-message-fallback

## Why

A wire that carries no picture inside a tool result drops the picture today, with a warn (`src/loop/run-agent.ts:679`). But almost every vision-capable wire accepts a picture inside a user message. Thus the cli-proxy path and a compatible endpoint lose the `examine_page` screenshot without a reason.

## What Changes

- Add a second capability to the provider seam: `imageUserMessages`. It says that the wire renders a picture inside a user message.
- Add the fallback to the loop. When `imageToolResults` is absent and `imageUserMessages` is set, the tool result keeps its JSON text. The loop then appends one user message after the tool message of the round. That message carries each dropped picture of the round, with a text part that names its tool call.
- Keep the drop-with-warn path when both capabilities are absent.
- Propagate the new flag through `createAiSdkProvider`, which copies the capability set explicitly (`src/providers/ai-sdk.ts:519`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the capability set of the provider seam gains the picture-placement flags and their meaning.
- `harness-agent-loop`: the tool-result encoding gains the user-message fallback, with the round-batched placement rule.

## Impact

- `harness/src/providers/types.ts`: the new capability flag.
- `harness/src/providers/ai-sdk.ts`: the capability copy.
- `harness/src/loop/run-agent.ts`: the encoding mode and the round assembly.
- Tests beside the loop and the providers.
- No CLI change here. The cli-proxy arm and the compatible arm declare the flag at the composition root of the CLI, in a companion change.
