## Context

The harness asks one question through the eyes seam: where does a browser come from for one look. The managed deployment answers with a standing sidecar over one shared volume, and the harness ships that realization itself. This host cannot answer the same way, because an anchor puts each workspace root in a different user folder.

## Decisions

### D1. One container for one look

The realization starts a container at the acquire and removes it at the release. A standing container was rejected: it would hold one mount set, and the next analysis makes a root that the set does not carry. A look is rare beside the model turns around it, thus the cold start is affordable.

### D2. The deadline rides inside the container

The image carries `timeout`, and the entrypoint wraps the run script with it. Podman gives a `--timeout` flag and docker gives none, thus a flag would need one rule for each runtime. The in-image bound gives one rule for both, and it holds when this process is already gone.

### D3. The port comes from the kernel, and the publish is loopback

Podman rejects a published port of 0, thus the realization asks the kernel for a free port and publishes that one. A window sits between the release of the probe socket and the bind of the container, and a racing process can take the port. The start then fails loudly, which beats a fixed port that a user must configure.

The publish binds `127.0.0.1`. The browser reads the workspace of the user, thus nothing outside this host must reach it.

### D4. The count bound is a semaphore of this module

The page gate of the harness bounds one endpoint, and each look names a new endpoint. Thus nothing upstream caps the number of browsers, and the cap sits here. The acquire waits rather than refuses, because a busy runtime is not a reason to fail a look.

## Risks / Trade-offs

- [A host path outside the shared tree of a container machine does not mount] → On macOS the podman machine shares the home tree. An anchor outside it gives a look that reads no file, and the tool reports its typed capture failure. Docker Desktop shares a configurable set, and Linux shares the whole host.
- [The realization names two paths of the image] → The image is pinned by digest, thus its contents are fixed.
- [A cold start inflates each look] → Accepted, and the seam design already accepted it.
