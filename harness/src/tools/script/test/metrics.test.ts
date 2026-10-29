import { afterEach, beforeEach, expect, test } from "bun:test";

import { captureMetrics, type MetricsCapture } from "../../../__tests__/setup/metrics.js";
import { recordReadBytes, SCRIPT_READ_BOUNDS_BYTES } from "../metrics.js";

let capture: MetricsCapture;

beforeEach(() => {
    capture = captureMetrics();
});

afterEach(async () => {
    await capture.dispose();
});

test("a read above 10 kB lands in a bucket below the overflow bucket", async () => {
    recordReadBytes(3 * 1024 * 1024);

    const [point] = await capture.buckets("cortex.harness.script.read_bytes");
    expect(point?.boundaries).toEqual([...SCRIPT_READ_BOUNDS_BYTES]);
    // The bucket at index i counts the values up to boundaries[i]: 3 MiB is in (1 MiB, 4 MiB].
    const index = SCRIPT_READ_BOUNDS_BYTES.indexOf(4_194_304);
    expect(point?.counts[index]).toBe(1);
    expect(point?.counts.at(-1)).toBe(0);
});
