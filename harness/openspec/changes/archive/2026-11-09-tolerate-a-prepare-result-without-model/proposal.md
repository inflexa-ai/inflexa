# Proposal

## Why

A chat turn that started on harness 0.48.5 or earlier, and that waits across the upgrade to 0.48.6 or later, fails when it continues (issue #859). DBOS replays its stored `chat-turn.prepare` result, and that result has no `model` key. The turn then gives `undefined` to `withModel`, the model call throws, and the user loses the turn.

## What Changes

- A turn workflow reads a missing `model` in a replayed `chat-turn.prepare` result as no model. Thus the turn runs on the provider of the host.
- A recovery test replays a stored prepare result that has no `model`. The test makes sure that the turn completes on the provider of the host.

## Capabilities

### New Capabilities

### Modified Capabilities

- `chat-turn`: the requirement "A turn runs on the model of its thread" gets the rule and a scenario for a replayed prepare result with no model.

## Impact

- `src/app/chat-turn-workflow.ts`: the read of the `chat-turn.prepare` result in `runTurnWorkflow`.
- `src/app/test/chat-turn-workflow.test.ts`: one new recovery test.
- No change to a public interface, a dependency, or the stored data.
