# Design: give-the-eyes-shared-memory

## Context

The eyes realization starts one container for one look (`src/modules/harness/eyes.ts:168-222`). The run args carry the port publication, the mount, the lifetime entrypoint, and the image. No `--shm-size` is present, thus the runtime default applies. Under podman that default is 64 MiB.

Chrome composes a full-page capture in shared memory. A 1440 px wide capture of an 11,189 px page is a ~64 MB RGBA bitmap, at the ceiling. The capture then fails with `Protocol error (Page.captureScreenshot): Unable to capture screenshot`, and the look reports `capture-failed`.

## Decisions

### D1: One gigabyte, as a constant beside the lifetime

The size rides as a module constant, beside `DEFAULT_LIFETIME_SECONDS`. One gigabyte holds a page an order of magnitude taller than the observed one, and the memory is only committed while a look runs. A smaller bound would invite the same fault on a longer report. The value is not configurable, because no user-facing knob exists for the eyes, and a knob without a consumer is surface without a need.

### D2: The flag lands in the `run` args, not in the image

`--shm-size` is a runtime allocation flag, and the pinned image cannot carry it. The arg joins the array between the detach flags and the port publication, thus the arg-order assertions of the tests stay readable.

### D3: The proof is an arg assertion, not a container run

The failure only shows under the default `/dev/shm` of a real container runtime. A test that started a real container would be slow and environment-bound. The durable proof asserts the argument in the composed run args, through the injected `run` seam that the existing tests already use.

## Risks / Trade-offs

- A machine with less than 1 GiB free swaps during a look. The lifetime bound caps the exposure, and the gate bounds two browsers at one time.
