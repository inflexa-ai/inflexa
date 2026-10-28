/**
 * Resolve `@inflexa-ai/harness` and each deep specifier of it to the source of
 * the harness in this repository.
 *
 * The plugin maps each deep specifier, from each importer, to the source. A deep
 * specifier names the emitted `.js` file, and its source is the `.ts` file
 * beside it.
 *
 * Bun resolves the bare `@inflexa-ai/harness` through the package install of the
 * importer before it asks a plugin. Thus the CLI host tools, which import the bare
 * name, load the harness that `cli/node_modules` holds. The npm release there
 * drops the approval hooks of the host tools, and `lib/agent.ts` refuses it.
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
