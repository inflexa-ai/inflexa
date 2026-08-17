# Design

## The registry classification

The part is `emitter: conversation`, `consumer: conversation`, not transient, and not reconciling. The classification is the whole persistence mechanism: the conversation display recorder keeps each durable conversation part in the position of its emission, thus the part needs no storage code of its own. One spawn makes one part, thus the part does not reconcile and it carries no `id`.

## The payload is minimal

The part carries `threadId` and `parentThreadId` only. The title of a session is seeded after the spawn, and the store can archive the session later. A snapshot of either in the part would go stale in the transcript. Thus the part names the thread, and a consumer reads the live state from the thread listing. This is the one authority rule of the change: the part places and signals, and the store decides what exists.

## The started arm only

The existing-session arm names a session that an earlier turn announced, and that turn already holds the part. A second part would put a second entry into the transcript for one session. A refusal starts nothing, thus it emits nothing.
