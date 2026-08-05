# @inflexa-ai/prov-kernel

`@inflexa-ai/prov-kernel` is the Inflexa provenance format kernel. It carries the
Inflexa PROV dialect: the document model (QName derivation, tsprov statement
builders, unify options, and an injectable digest), the chain-hash and Ed25519
sign/verify primitives, the signed-sidecar schema, and the actor and ref value
types that the builders accept. [`SPEC.md`](SPEC.md) gives the exact wire
format, sufficient for an independent implementation.

The package is a kernel, not a recorder. The three-layer rule divides the work:

- **The harness observes.** It reports facts: a run started, a command ran, a
  file appeared.
- **The kernel represents.** It turns each fact into PROV statements with
  deterministic identifiers, and it signs and verifies the result.
- **Hosts decide.** Each host owns its event vocabulary, its recorder
  lifecycle, its storage, and its key custody.

Thus the package deliberately does NOT contain an event union, an event
reducer, or a recorder (sink, flush, queue). Those are host-owned.

## Use

```bash
npm install @inflexa-ai/prov-kernel

npm run build   # tsc -p tsconfig.json — emit dist/ from src/
bun test        # run the test suite (Node is the runtime; bun runs tests only)
```

```ts
import { createProvDocumentModel, PROV_UNIFY_OPTIONS, createKeypairSigner, buildSidecar, verifySidecar } from "@inflexa-ai/prov-kernel";

const model = createProvDocumentModel(); // or inject a historical digest
const doc = model.freshDocument({ analysisId: "a1" });
model.appendRunStarted(doc, "a1", actor, { runId: "r1", startedAtMs });
const json = doc.unified(PROV_UNIFY_OPTIONS).serialize("json");
```

The digest that derives every QName suffix is injectable, because it is
identity-load-bearing: a host with existing documents must inject its
historical digest function, or its identifier space forks. The default digest
is canonical for new documents.

## License

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
