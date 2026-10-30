# Proposal

## Why

The value of a tool call has two defects:

- The cost to make a value grows with the size of a result. The secret rules read each string of the whole result before the cut. A JSON result of 10,000,000 characters takes about 1.3 s on the path of a chat turn.
- An assignment or a quoted field with no closing quote keeps its secret. Thus `API_KEY="abc123` passes unchanged.

## What Changes

- A text longer than 24,576 code units gets the control-character step and the secret step only on two windows: the first 11,264 and the last 13,312 code units. Each window reaches 8,192 code units past its shown part.
- A long JSON value gets the two steps only on a copy of each end of the value. Only the serialization of the whole value grows with its size, and the model path does that serialization already.
- The marker line of such a text counts the original text, because the harness does not clean the part that it does not show.
- A quoted value with no closing quote holds the rest of the text, for an assignment and for a quoted field.

## Capabilities

### Modified Capabilities

- `tool-call-values`: the bound of the steps on a long value, the count of the marker line, and a quoted value with no closing quote.

## Impact

- `harness/src/loop/tool-value.ts` and `harness/src/input-sanitization.ts`, with their tests.
- A secret longer than 8,192 code units at the edge of a shown part of a long text can show in part. A secret of that length is not a known format.
