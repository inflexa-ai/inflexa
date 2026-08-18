# Design

## The registry classification

The part is `emitter: conversation`, `consumer: conversation`, not transient, and not reconciling. The classification is the whole persistence mechanism: the conversation display recorder keeps each durable conversation part in the position of its emission, thus the part needs no storage code of its own. Each render is its own event, thus the part does not reconcile and each emission mints a fresh `id`.

## The payload is minimal

The part carries `id`, `renderedAt`, and `title` only. No path, no format field, no version internals, and no minted URL ride it: each of those goes stale or names a lifetime the part cannot own. The version store and the session-page mint stay the authority for what is viewable, thus the part places and signals, and a consumer reads the viewable state from those surfaces. The `title` rides because the finished document holds it on the success arm; it is display sugar, never authority.

## The rendered arm only

Each degraded arm — a refusal, a gap list, a resolver absence, an unresolvable root, an unresolved reference, a bridge mismatch, a render problem, an out-of-scope figure, a failed write, and a failed stamp — shows no fresh page, thus it emits nothing. The stamp-failed arm has a page on disk, but the tool tells the agent to preview again, and that pass emits.
