# Building a Merkle tree transparency log in Go with PostgreSQL

A Merkle tree transparency log for your provenance system is entirely buildable without depending on Trillian — the key is using the **`transparency-dev/merkle` package** for compact range operations, a **PostgreSQL schema modeled on Trillian's subtree/tile pattern**, and a **single-writer sequencer** that batches leaf integration. The approach taken by production systems like Certificate Transparency (17 billion entries logged since 2013), Sigstore Rekor, and the Go module checksum database proves this architecture scales to billions of entries with ~64 bytes of hash overhead per record and sub-millisecond proof generation. This report covers every layer of the stack — from RFC 6962 algorithms to concrete Go code and PostgreSQL DDL — so you can build a production-grade implementation.

## Production systems reveal two architectural generations

Understanding how existing systems work is essential context. **Trillian v1** (now in maintenance mode) is a gRPC microservice with a MySQL/PostgreSQL backend. It queues leaves into an `Unsequenced` table, then a separate `trillian_log_signer` process dequeues batches, assigns monotonic sequence numbers, integrates them into the Merkle tree, and signs a new tree head. The tree itself is stored as **subtrees** — 8-level-deep tiles of 256 hashes each, serialized as protobuf blobs. Only the leaf-level hashes within each subtree are persisted; internal nodes are recomputed on load. This subtree approach reduces storage row count by **~256×** compared to storing individual nodes.

**Trillian Tessera** (the successor, production-ready mid-2025) abandons the microservice model entirely. It is a **Go library** embedded directly in your application — no separate gRPC server, no signer process. It separates three phases: sequencing (durable assignment of a sequence number), integration (building the Merkle tree from tiles), and publishing (signing a checkpoint). Multiple write frontends can run concurrently. Reads are served as static tiles from object storage or filesystem, making them infinitely cacheable via CDN. For a custom implementation, **Tessera's library-embedded approach is the model to follow**.

Other notable systems include **Sigstore Rekor** (wraps Trillian with entry-type abstractions and Redis indexing, transitioning to Tessera for v2), **Sunlight** (Let's Encrypt's CT log — a single Go process writing tiles to S3 or filesystem with SQLite for deduplication), **immudb** (two-level Merkle tree — per-transaction inner tree + main append-only hash tree, custom embedded storage), and **Go SumDB** (tile-based log at `sum.golang.org`, the original tile design by Russ Cox). **Amazon QLDB** uses hash-chained journal blocks as Merkle leaves with sorted-order hash concatenation, but is being sunset in favor of Aurora PostgreSQL.

The clear industry trajectory is **tiles as the read API** (static, cacheable, client-side proof construction) and **embedded library rather than microservice** for the write path.

## RFC 6962 algorithms are the foundation

### Tree construction

The Merkle hash tree defined in RFC 6962 uses SHA-256 with domain-separated prefixes to prevent second-preimage attacks. The algorithm is recursive and deterministic:

```
MTH({})      = SHA-256("")                                    // empty tree
MTH({d(0)})  = SHA-256(0x00 || d(0))                         // single leaf
MTH(D[n])    = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))  // n > 1
```

where `k` is the largest power of 2 less than `n`. This means a 7-leaf tree splits into a perfect 4-leaf left subtree and a 3-leaf right subtree (which itself splits 2+1). Odd leaves are **promoted**, not duplicated — unlike Bitcoin's Merkle tree. The `0x00` prefix on leaves and `0x01` prefix on internal nodes ensures an attacker cannot substitute a leaf for an internal node.

### Inclusion proofs

An inclusion proof for leaf at index `m` in a tree of size `n` is an ordered list of **⌈log₂(n)⌉ sibling hashes** along the path from leaf to root. For 1 million leaves, that is ~20 hashes (640 bytes). The generation algorithm recursively decomposes the tree:

```
PATH(m, D[n]):
  if n == 1: return {}
  k = largest_pow2_less_than(n)
  if m < k:  return PATH(m, D[0:k])    ++ [MTH(D[k:n])]
  if m >= k: return PATH(m-k, D[k:n])  ++ [MTH(D[0:k])]
```

Verification walks the proof bottom-up, combining hashes using the leaf index bits to determine left/right placement, and checks that the result equals the trusted root hash.

### Consistency proofs

A consistency proof demonstrates that a tree of size `m` is a prefix of a tree of size `n` — the append-only guarantee. It provides **O(log n)** hashes that allow verifying both the old root and the new root. The algorithm uses `SUBPROOF(m, D[n], startFromOld)` which recursively decomposes the tree, emitting hash commitments at subtree boundaries. The verifier maintains two running hashes — one for the old root, one for the new root — and checks both match at the end.

### Compact ranges — the critical optimization

Rather than storing the full tree, you only need to persist the **compact range**: the minimal set of perfect subtree root hashes that cover the current leaves. For a tree of `N` leaves, the compact range contains exactly as many hashes as there are 1-bits in the binary representation of `N`. A tree of 13 leaves (binary `1101`) stores just **3 hashes** representing perfect subtrees of sizes 8, 4, and 1.

Appending a leaf to a compact range costs **O(1) amortized** hash operations. The new leaf hash is pushed onto a stack; if the top two entries are at the same level, they combine into their parent. This cascading merge is identical to incrementing a binary counter. The root hash is computed by folding the compact range right-to-left with the internal node hash function.

This is the core state you persist between restarts: the compact range hashes plus the tree size. Everything else can be derived.

## PostgreSQL schema design follows Trillian's patterns

The schema below is modeled on Trillian's production MySQL schema, adapted for PostgreSQL idioms. It uses the **subtree/tile storage optimization** where groups of 256 leaf-level hashes are serialized into a single row, and internal nodes within each tile are recomputed on load.

```sql
-- Transparency log schema for PostgreSQL
-- Based on Google Trillian patterns, simplified for single-tree use

CREATE TABLE leaves (
    leaf_index          BIGINT PRIMARY KEY,
    leaf_hash           BYTEA NOT NULL,         -- SHA-256(0x00 || data), 32 bytes
    leaf_identity_hash  BYTEA NOT NULL,         -- App-defined hash for dedup
    leaf_value          BYTEA NOT NULL,         -- Full leaf payload
    extra_data          BYTEA DEFAULT '',       -- Metadata not in the hash
    queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    integrated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leaves_hash ON leaves (leaf_hash);
CREATE INDEX idx_leaves_identity ON leaves (leaf_identity_hash);

CREATE TABLE tree_heads (
    tree_size           BIGINT PRIMARY KEY,
    root_hash           BYTEA NOT NULL,         -- 32 bytes
    timestamp_nanos     BIGINT NOT NULL,
    signature           BYTEA NOT NULL,         -- Ed25519 signature over (tree_size || root_hash || timestamp)
    compact_range       BYTEA NOT NULL,         -- Serialized compact range hashes for crash recovery
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subtrees/tiles: 8 levels deep = 256 leaves per tile
-- Only leaf-level hashes stored; internal nodes recomputed on load
CREATE TABLE subtrees (
    subtree_id          BYTEA PRIMARY KEY,      -- Encodes position: level prefix + index
    nodes               BYTEA NOT NULL          -- Serialized array of up to 256 leaf hashes
);

-- Pending queue for async leaf integration
CREATE TABLE pending_leaves (
    id                  BIGSERIAL PRIMARY KEY,
    leaf_data           BYTEA NOT NULL,
    identity_hash       BYTEA NOT NULL UNIQUE,  -- Dedup
    extra_data          BYTEA DEFAULT '',
    queued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key design decisions in this schema:**

The `leaves` table uses `leaf_index` as the primary key — a contiguous, 0-based sequence number assigned by the sequencer. The `leaf_hash` is `SHA-256(0x00 || leaf_value)` following RFC 6962. The `leaf_identity_hash` is application-defined for deduplication (for your provenance system, this might be a hash of the artifact ID + operation type). The `extra_data` column stores metadata that travels with the leaf but is not incorporated into the Merkle hash — useful for storing the original provenance record's foreign key.

The `subtrees` table stores tiles of **256 leaf-level hashes** as a single serialized blob. For 1 million leaves, this produces ~3,907 subtree rows instead of ~2 million individual node rows. The `subtree_id` encodes the tile's position in the tree (level prefix concatenated with the horizontal index). When generating a proof, you fetch the O(log₂ N / 8) tiles along the audit path, deserialize them, recompute the needed internal hashes in memory, and extract the sibling hashes. This dramatically reduces I/O.

The `tree_heads` table stores signed snapshots. Each new integration batch creates a new row. The `compact_range` column persists the compact range state for crash recovery — on restart, you load the latest tree head's compact range to reconstruct the in-memory tree state without reprocessing all leaves.

For **concurrency**, use PostgreSQL advisory locks on the sequencer:

```sql
-- In the sequencer transaction:
SELECT pg_advisory_xact_lock(42);  -- Lock ID for the single tree
-- Read current tree size, assign sequence numbers, integrate batch
-- Lock auto-released on COMMIT
```

This is lightweight and avoids the table bloat of row-level locks. The sequencer is a single-writer goroutine; reads (proof generation, tree head queries) run concurrently without locks.

**Performance expectations**: Trillian achieves **400–500 writes/sec** on MySQL, similar on PostgreSQL. Tessera reaches **~2,000 writes/sec** on CloudSQL. Proof generation is sub-millisecond — fetching 3–4 subtree rows and computing ~30 hashes in memory for a billion-entry tree.

For **same-database versus separate**: co-locate for simplicity if you expect fewer than 10 million entries. Use a dedicated schema (`CREATE SCHEMA merkle_log`) for isolation. Separate databases only become necessary at high throughput where the append-heavy write pattern of the log conflicts with your application's read patterns.

## Go implementation using transparency-dev/merkle

The `transparency-dev/merkle` package is the canonical standalone library — used internally by Trillian itself. It provides compact ranges, RFC 6962 hashing, and proof verification without pulling in the full Trillian gRPC server.

### Core compact range operations

```go
package merkle

import (
    "github.com/transparency-dev/merkle/compact"
    "github.com/transparency-dev/merkle/rfc6962"
)

// TransparencyLog maintains an append-only Merkle tree using compact ranges.
type TransparencyLog struct {
    mu      sync.RWMutex
    factory compact.RangeFactory
    cr      *compact.Range
    hasher  *rfc6962.Hasher
    store   LogStorage
}

func NewTransparencyLog(store LogStorage) (*TransparencyLog, error) {
    hasher := rfc6962.DefaultHasher
    factory := compact.RangeFactory{Hash: hasher.HashChildren}

    // Recover compact range from last persisted tree head
    hashes, size, err := store.LoadCompactRange()
    if err != nil {
        return nil, err
    }
    var cr *compact.Range
    if size > 0 {
        cr, err = factory.NewRange(0, size, hashes)
    } else {
        cr = factory.NewEmptyRange(0)
    }
    return &TransparencyLog{
        factory: factory, cr: cr,
        hasher: hasher, store: store,
    }, err
}

// Append adds a leaf and returns its index. Called by the sequencer goroutine.
func (tl *TransparencyLog) Append(data []byte) (uint64, error) {
    tl.mu.Lock()
    defer tl.mu.Unlock()

    leafHash := tl.hasher.HashLeaf(data)
    idx := tl.cr.End()

    // visitor is called for each new node computed during append
    visitor := func(id compact.NodeID, hash []byte) {
        tl.store.StoreNode(id.Level, id.Index, hash)
    }
    if err := tl.cr.Append(leafHash, visitor); err != nil {
        return 0, err
    }
    return idx, nil
}

// Root returns the current root hash and tree size.
func (tl *TransparencyLog) Root() ([]byte, uint64, error) {
    tl.mu.RLock()
    defer tl.mu.RUnlock()
    root, err := tl.cr.GetRootHash(nil)
    return root, tl.cr.End(), err
}
```

### RFC 6962 hashing (the leaf/node distinction)

```go
// From rfc6962 package — this is the complete hashing logic:
func HashLeaf(leaf []byte) []byte {
    h := sha256.New()
    h.Write([]byte{0x00})  // Domain separation: leaf prefix
    h.Write(leaf)
    return h.Sum(nil)
}

func HashChildren(left, right []byte) []byte {
    h := sha256.New()
    h.Write([]byte{0x01})  // Domain separation: node prefix
    h.Write(left)
    h.Write(right)
    return h.Sum(nil)
}
```

### Inclusion proof generation and verification

```go
// Generate an inclusion proof for leafIndex in a tree of treeSize.
// Requires access to stored node hashes.
func (tl *TransparencyLog) InclusionProof(leafIndex, treeSize uint64) ([][]byte, error) {
    tl.mu.RLock()
    defer tl.mu.RUnlock()

    // Use the proof package from transparency-dev/merkle
    nodes, err := proof.Inclusion(leafIndex, treeSize)
    if err != nil {
        return nil, err
    }
    // Fetch the required node hashes from storage
    hashes := make([][]byte, len(nodes.IDs))
    for i, id := range nodes.IDs {
        hashes[i], err = tl.store.GetNode(id.Level, id.Index)
        if err != nil {
            return nil, fmt.Errorf("missing node (%d,%d): %w", id.Level, id.Index, err)
        }
    }
    return hashes, nil
}

// Client-side verification of an inclusion proof:
func VerifyInclusion(leafHash []byte, leafIndex, treeSize uint64,
    proof [][]byte, rootHash []byte) error {
    hasher := rfc6962.DefaultHasher
    // Walk from leaf to root
    hash := leafHash
    idx := leafIndex
    size := treeSize
    proofIdx := 0

    for size > 1 {
        k := largestPow2LessThan(size)
        if idx < k {
            // Leaf is in left subtree; sibling is right subtree hash
            hash = hasher.HashChildren(hash, proof[proofIdx])
            size = k
        } else {
            // Leaf is in right subtree; sibling is left subtree hash
            hash = hasher.HashChildren(proof[proofIdx], hash)
            idx -= k
            size -= k
        }
        proofIdx++
    }
    if !bytes.Equal(hash, rootHash) {
        return fmt.Errorf("proof verification failed")
    }
    return nil
}

func largestPow2LessThan(n uint64) uint64 {
    k := uint64(1)
    for k < n { k <<= 1 }
    return k >> 1
}
```

### Batching sequencer with channel-based write coalescing

```go
type writeRequest struct {
    data   []byte
    result chan writeResult
}
type writeResult struct {
    index uint64
    err   error
}

func (tl *TransparencyLog) RunSequencer(ctx context.Context) {
    ticker := time.NewTicker(200 * time.Millisecond)
    defer ticker.Stop()
    var batch []writeRequest

    for {
        select {
        case req := <-tl.pending:
            batch = append(batch, req)
            if len(batch) >= 256 {
                tl.integrateBatch(batch)
                batch = nil
            }
        case <-ticker.C:
            if len(batch) > 0 {
                tl.integrateBatch(batch)
                batch = nil
            }
        case <-ctx.Done():
            return
        }
    }
}

func (tl *TransparencyLog) integrateBatch(batch []writeRequest) {
    tl.mu.Lock()
    defer tl.mu.Unlock()

    tx, _ := tl.db.Begin()
    defer tx.Rollback()

    // Advisory lock ensures only one sequencer runs
    tx.Exec("SELECT pg_advisory_xact_lock(42)")

    for _, req := range batch {
        leafHash := tl.hasher.HashLeaf(req.data)
        idx := tl.cr.End()

        tl.cr.Append(leafHash, func(id compact.NodeID, hash []byte) {
            tx.Exec(`INSERT INTO subtrees (subtree_id, nodes) VALUES ($1, $2)
                      ON CONFLICT (subtree_id) DO UPDATE SET nodes = $2`,
                encodeSubtreeID(id), hash)
        })

        tx.Exec(`INSERT INTO leaves (leaf_index, leaf_hash, leaf_value, integrated_at)
                  VALUES ($1, $2, $3, NOW())`, idx, leafHash, req.data)
        req.result <- writeResult{index: idx}
    }

    // Sign and persist new tree head
    root, _ := tl.cr.GetRootHash(nil)
    tl.signAndStoreTreeHead(tx, tl.cr.End(), root)
    tx.Commit()
}
```

### HTTP handler integration

```go
func (h *LogHandler) HandleAddEntry(w http.ResponseWriter, r *http.Request) {
    data, _ := io.ReadAll(r.Body)
    resultCh := make(chan writeResult, 1)
    h.log.pending <- writeRequest{data: data, result: resultCh}
    res := <-resultCh
    if res.err != nil {
        http.Error(w, res.err.Error(), 500)
        return
    }
    json.NewEncoder(w).Encode(map[string]uint64{"leaf_index": res.index})
}

func (h *LogHandler) HandleGetInclusionProof(w http.ResponseWriter, r *http.Request) {
    index, _ := strconv.ParseUint(r.URL.Query().Get("index"), 10, 64)
    treeSize, _ := strconv.ParseUint(r.URL.Query().Get("tree_size"), 10, 64)
    proof, err := h.log.InclusionProof(index, treeSize)
    if err != nil {
        http.Error(w, err.Error(), 400)
        return
    }
    json.NewEncoder(w).Encode(map[string]interface{}{
        "leaf_index": index, "tree_size": treeSize, "audit_path": proof,
    })
}

func (h *LogHandler) HandleGetTreeHead(w http.ResponseWriter, r *http.Request) {
    root, size, _ := h.log.Root()
    json.NewEncoder(w).Encode(map[string]interface{}{
        "tree_size": size, "sha256_root_hash": base64.StdEncoding.EncodeToString(root),
    })
}
```

### Testing strategies

Test against **RFC 6962 test vectors** from `transparency-dev/merkle/testonly`. The critical property tests are:

- **Round-trip inclusion**: for every leaf index 0..N-1, generate an inclusion proof and verify it against the root. This catches off-by-one errors in proof generation.
- **Incremental consistency**: build the tree one leaf at a time, save the root at each size, then verify consistency proofs between all size pairs (i, j) where i < j. This validates the append-only property.
- **Compact range recovery**: serialize the compact range after N appends, deserialize it, append more leaves, and verify the root matches a tree built from scratch with all leaves.
- **Empty tree edge case**: verify that `MTH({})` equals `SHA-256("")` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

## Architectural decisions for your provenance system

### Embed the library, don't run a microservice

For a provenance system where you control the application, **embed the Merkle tree logic directly** in your Go web server. This eliminates the operational burden of running Trillian's separate `trillian_log_server` and `trillian_log_signer` processes plus their database. You own the entire write path: accept a provenance record via HTTP, persist it to your application database, queue it for Merkle tree integration, and return the leaf index. The sequencer runs as a background goroutine in the same process.

### Tree head signing with Ed25519

Sign tree heads with **Ed25519** — it produces deterministic signatures (no nonce-reuse vulnerabilities), generates **64-byte signatures** (smaller than ECDSA P-256's ~71 bytes), and is the dominant choice in the transparency-dev ecosystem. The signed tree head binds `tree_size + root_hash + timestamp_nanos` together. Sign after every integration batch. Store the signing key in a KMS or HSM for production; for development, an in-memory Ed25519 key works.

### The witness pattern for external verification

Witnesses are lightweight third parties that verify your log's append-only property. The protocol: after publishing a new tree head, you send it plus a consistency proof to each witness via HTTP POST. The witness checks the proof against its stored checkpoint for your log, and if valid, returns a **cosignature**. Your clients check these cosignatures to confirm they're seeing a globally consistent view — defeating split-view attacks where you might show different tree states to different users. The `transparency-dev` ecosystem provides a witness network and the C2SP `tlog-witness` specification. A witness stores only **O(1) data per log** (the latest verified checkpoint) and never inspects leaf contents.

### Disaster recovery is straightforward

The Merkle tree is a **deterministic function of the ordered leaf data**. Given all N leaves in sequence order and the hash algorithm, the entire tree can be rebuilt. Back up the `leaves` table; the `subtrees` and `tree_heads` tables are derivable. For crash recovery without full rebuild, persist the compact range hashes in the `tree_heads` table — on restart, load the latest tree head's compact range to reconstruct in-memory state in O(log N) time.

## Storage overhead and scaling characteristics

The Merkle tree adds approximately **64 bytes of hash overhead per entry** (32 bytes for the leaf hash, ~32 bytes amortized for internal nodes since a tree of N leaves has exactly N-1 internal nodes). For leaf payloads averaging 1 KB, this is a **6.4% storage increase**. For smaller payloads (100 bytes), overhead rises to ~64%. With the subtree/tile optimization, the `subtrees` table contains roughly N/256 rows — **~3,900 rows per million leaves** versus ~2 million rows for individual node storage.

| Scale | Leaf rows | Subtree rows | Hash overhead | Proof size |
|---|---|---|---|---|
| 1M entries | 1M | ~3,900 | ~64 MB | ~20 hashes (640 B) |
| 100M entries | 100M | ~390K | ~6.4 GB | ~27 hashes (864 B) |
| 1B entries | 1B | ~3.9M | ~64 GB | ~30 hashes (960 B) |

Write throughput on PostgreSQL should reach **400–2,000 entries/sec** depending on batch size and hardware, based on Trillian and Tessera benchmarks. Proof generation is dominated by I/O (fetching ~4 subtree rows) plus in-memory hashing (~30 SHA-256 operations) — expect **sub-millisecond latency** for both inclusion and consistency proofs with warm caches.

For very large trees (billions of entries), **temporal sharding** is the standard approach: each shard accepts records for a bounded time period, limiting individual tree size. When a shard is full, freeze it (set state to `FROZEN`) and start a new tree. Certificate Transparency logs have operated this way for years across **17 billion total entries**.

## Conclusion

Build the transparency log as an **embedded Go library** using `transparency-dev/merkle` for compact range operations and RFC 6962 hashing. Store leaves in PostgreSQL with the subtree/tile pattern (256 leaves per tile blob) to minimize row count. Run a single-writer sequencer goroutine that batches appends using channel-based coalescing, acquires a PostgreSQL advisory lock, integrates the batch, and signs a new Ed25519 tree head. Expose three HTTP endpoints: add-entry, get-inclusion-proof, and get-tree-head.

The compact range is the central data structure — it reduces your persistent tree state to O(log N) hashes, makes appends O(1) amortized, and enables crash recovery without reprocessing all leaves. Proof generation requires fetching O(log N / 8) subtree rows — negligible even at billion-entry scale.

Two insights from studying production systems are worth emphasizing. First, **the industry has moved from server-computed proofs to client-computed proofs via static tiles** — if you anticipate external verifiers, consider serving subtree tiles as static resources (cacheable, CDN-friendly) rather than computing proofs server-side. Second, **correctness matters more than speed** — fsync before acknowledging writes, never issue a signed commitment before data is durable, and run consistency proof verification on every new tree head as a self-check. A single bit-flip or missed write has caused production CT logs to be permanently disqualified.
