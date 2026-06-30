# Target autocomplete

Target autocomplete is an embedder/UI concern. Core does not expose an HTTP
autocomplete endpoint.

Core does contain the target identifier resolution logic used by target
assessment Phase 0. Hosts that want a typeahead should call their own endpoint
or UI action and may reuse the same resolver behavior so autocomplete and
workflow resolution stay consistent:

- Query public identifier sources such as HGNC, UniProt, and Ensembl.
- Deduplicate hits by canonical target identity.
- Return enough identifiers for users to distinguish the intended gene/protein.
- Treat empty results as a normal response; Phase 0 remains the canonical hard
  validation path when the workflow starts.

The concrete transport shape, auth policy, caching, and fallback catalog are not
part of `@inflexa-ai/harness`.
