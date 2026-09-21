## Context

`linkPackagesIntoFarm` resolved each query with `resolvePackageRequest`, over the
pool index of the graph. The harness now gives `resolvePackage`, `imageBaseOf`,
and `EMPTY_IMAGE_BASE`. The plan validation calls `resolvePackage` at the
submit.

## Goals / Non-Goals

**Goals:**

- The seam route gives the answer of the submit for each entry.

**Non-Goals:**

- A change to `store link` or to `store add`. An interactive command asks about
  the pool, and the image is not a part of the pool.

## Decisions

### The seam route calls the rule of the harness

The seam route calls `resolvePackage` over the graph index and the image base.
The cli holds no copy of the rule, thus the seam route and the submit cannot
drift. The host still picks the version of a pool package with `pickVersion`.
`resolvePackageRequest` keeps its body, because `store link` and `store add`
read the graph alone.

### An image package is `present`, not `linked`

The farm links a store directory, and the image package has none. The runtime
of the image already loads it. Thus the outcome is `present`, and its version
is the runtime version of the track in the record. The harness contract states
this meaning of `present`.

### A damaged record is a fault, and an absent record is a normal state

`readImagePackagesFile` gives two errors. `record_unreadable` is a store from
before the record, and it gives the empty image base. `record_invalid` is a
damaged record. It answers `unavailable` for each query, with the path. A false
`absent` for `r:stats` sends the agent after an acquisition that no repository
can give. This is the rule of an unreadable graph.

### The claims of a collision come from both sources

The claim of a track is the head store directory of the pool, or the runtime of
the image. `claimOf` is total: it throws for an identity that neither source
holds, because `resolvePackage` gives `ambiguous` only for two held identities.
A silent fallback to the graph answer would report the pair as unknown.

### The indexes are built one time for the batch

The graph and the record are read one time for the batch. Thus the pool index
and the image base are built one time too, and not for each query.

## Risks / Trade-offs

- [The record of the store and the image of the sandbox come from two builds] →
  The catalog build copies the record of the image that it packs beside. Thus
  the two sets agree for one store.
