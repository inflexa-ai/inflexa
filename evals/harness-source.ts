/**
 * Resolve `@inflexa-ai/harness` and each deep specifier of it to the source of
 * the harness in this repository.
 *
 * The CLI files that the evals import name the harness by its package name, and
 * the install of the CLI resolves that name to the npm release or to the built
 * `dist/`. The evals must run the working copy, and the CLI host tools must see
 * the same module instances as the agent, thus the plugin maps the name for
 * every importer. A deep specifier names the emitted `.js` file, and its source
 * is the `.ts` file beside it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { plugin } from "bun";

const HARNESS = "@inflexa-ai/harness";
const SOURCE = join(import.meta.dir, "..", "harness", "src");

function sourceOf(subpath: string): string {
    if (subpath === "") return join(SOURCE, "index.ts");
    const stem = subpath.endsWith(".js") ? subpath.slice(0, -".js".length) : subpath;
    const file = join(SOURCE, `${stem}.ts`);
    return existsSync(file) ? file : join(SOURCE, stem, "index.ts");
}

plugin({
    name: "harness-source",
    setup(build) {
        build.onResolve({ filter: /^@inflexa-ai\/harness(\/.*)?$/ }, (args) => ({ path: sourceOf(args.path.slice(HARNESS.length + 1)) }));
    },
});
