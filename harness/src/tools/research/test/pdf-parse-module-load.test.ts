/**
 * The module-load guard of the PDF path of `web_fetch`.
 *
 * `pdf-parse` makes `os.availableParallelism()` return `undefined` process-wide under Bun when its module loads, and a
 * `Math.max(1, undefined)` machine budget becomes `NaN` in the CLI. The tool therefore imports `pdf-parse` lazily at
 * the first PDF. This suite loads the public barrel, the import every CLI embedder makes, in a pristine child process;
 * a static import fails here deterministically, because the runner's own process cannot stay clean of the PDF
 * extraction tests.
 */

import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { parseJsonAs } from "../../../lib/parse-json.js";

describe("web_fetch pdf-parse module load", () => {
    it("keeps os.availableParallelism() finite after the public barrel loads", () => {
        const child = Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "../__fixtures__/barrel-load-probe.ts")] });
        expect(child.stderr.toString()).toBe("");
        const report = z
            .object({ agent: z.boolean(), parallelism: z.union([z.number(), z.literal("undefined")]) })
            .parse(parseJsonAs(child.stdout.toString(), z.json()));
        expect(report.agent).toBe(true);
        expect(report.parallelism).not.toBe("undefined");
        expect(report.parallelism).toBeGreaterThan(0);
    });
});
