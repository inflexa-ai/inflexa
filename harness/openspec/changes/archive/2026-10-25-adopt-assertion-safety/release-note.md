# Release note — the chat-part check types of `@inflexa-ai/harness`

This text ships in the pull-request description and in the body of the next
GitHub Release of `@inflexa-ai/harness`. It is written in Simplified Technical
English, as the repository rules ask for GitHub text.

---

## The check of a chat part takes each value

`checkChatPart` now takes a value of type `unknown`. Before this release, the
parameter type was `ChatPartFrame`. Code that passes a `ChatPartFrame` still
compiles, because `ChatPartFrame` is part of `unknown`. You can now pass a
value that comes from outside the program directly, with no type assertion.

## A part of an unknown type rides in the check result as it is

The runtime behavior does not change. A part whose type the registry does not
know passed through unchanged before this release, and it still does. What
changes is the type of the result:

- The `frame` field of the ok arm of `ChatPartCheck` now holds a
  `ChatPartFrame` or a passthrough part record. A passthrough part record
  has a `type` of type `` `data-${string}` `` and fields of unknown shape.
- The part-frame arm of `ChatFrame` admits the same passthrough record.

Before this release, these types said `ChatPartFrame` only. That was not
true at runtime for a part of an unknown type. If your code narrows on the
`frame` field, make sure that it handles a record that is not one of the
known part types. A `switch` on the `type` field with a `default` arm keeps
working.

Do this instead of a type assertion when you build a test value:

```ts
import { checkChatPart } from "@inflexa-ai/harness";

const checked = checkChatPart({ type: "data-from-a-newer-emitter", id: "x-1" });
```

## The input schema of a tool names its input type

`Tool.inputSchema` is now `z.ZodType<Input>`. Before this release, the field
held the erased `z.ZodType`. A call of `parse` on the schema now returns the
input type of the tool. An implementer of the type must give a schema whose
output matches the `Input` parameter. Before this release, a mismatch
compiled without a word.

## The description hooks of a tool can give no text

The optional hooks `describeCall` and `describeResult` of a tool now return
`string | undefined`. Before this release, they returned `string`. An
implementation that returns a string still compiles. A direct caller of the
hooks now sees `string | undefined` and handles the absent value. The
consumer of the harness already treated an absent value as no detail.

## The name of a package identity is a plain string

`PackageIdentity.name` is now `string`. Before this release, the field held
a branded string type. The brand had no runtime value and its only producer
was a type assertion, so it gave no guarantee that a cast could not undo.
The validation and the folding of each name stay in the module that owns
them. Assignability widens. The runtime does not change. A later change can
bring nominal typing back as a wrapper value.

## The situation type of the knowledge tools follows the schema

`KnowledgeSituation` is now derived from the schema that parses the situation
(`z.infer`). Before this release, the hand-written type went stale: the
`question` field gained six values (`clustering`, `coexpression`,
`deconvolution`, `signature_scoring`, `survival`, `tf_activity`), and the
fields `extra_analyses` and `enrichment_input` were absent from the type
while the service already accepted them. The runtime behavior does not
change. The type now tells what already rides.

## A chat response keeps a finish reason the SDK type does not model

`ChatResponse.finishReason` is now `FinishReason | "aborted" | (string & {})`.
Before this release, the field admitted only the finish reasons that the AI
SDK type models. A provider can send a newer reason. The loop settles what
arrives, and a consumer that switches on the field must hold a default arm.

## BREAKING: the fetch option of the provider config takes the global fetch

`AiSdkProviderConfig.fetch` is now `typeof fetch`. Before this release, it
was a fetch-like type without `preconnect`. A custom fetch function that an
embedder passes must now carry the `preconnect` member. Build one with
`Object.assign(fn, { preconnect: fetch.preconnect })`.

## More public types admit what the runtime already carries

Each of the following widenings is additive. An embedder that passes a
narrower value still compiles. A consumer that narrows or switches on these
types must handle the wider shape:

- `ChatPart` and, through it, `MessagePart` admit a part record of a type
  the registry does not know. Narrow with the exported `isKnownPartFrame`
  guard or arm for the passthrough record.
- `AgentFinish.reason` admits a reason the provider types do not model.
- `CreateThreadInput.type` admits a thread type the store does not know.
  The store still refuses an unknown type at runtime.
- `createThreadStore` takes the structural `ThreadStorePool` in place of
  `pg.Pool`. A real `Pool` still satisfies it.
- The `dimensionScope` parameter admits a category the vocabulary does not
  know.
- `ReportSnapshot.artifacts[].rows` cells admit `null` and `undefined`, and
  `UnresolvedReference.reference` admits the authored pre-parse record.
  The resolver parses rows at its entry and keeps its internal view narrow.

## A guard narrows the widened union back to the known parts

This release adds one export to the barrel: the type guard `isKnownPartFrame`.
The guard reads the `type` field of a value of the widened part union. It
tells you whether the value is one of the known part frames. Use it where
your code needs a known part frame, and the value can hold a passthrough
record. The payload of a known part was checked where the part
arrived. The guard narrows by the registry key, and its doc comment states
that invariant.
