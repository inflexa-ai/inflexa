/**
 * listAvailablePackages — list R/Python/CLI packages available in the sandbox.
 */

import { readFile } from "node:fs/promises";

import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";

const PACKAGES_FILE = "/mnt/libs/current/packages.txt";

export const listAvailablePackagesTool = defineTool({
    id: "list_available_packages",
    description:
        "List all R, Python, and CLI packages available in the sandbox environment. Use this before writing analysis scripts to verify which packages you can import. No packages can be installed at runtime — only what this tool returns is available.",
    inputSchema: z.object({}),
    execute: async () => {
        // A missing library-store mount is an expected environment state — model
        // it as an `available: false` data variant with a helpful fallback note.
        try {
            const content = await readFile(PACKAGES_FILE, "utf-8");
            return ok({ available: true, content });
        } catch {
            return ok({
                available: false,
                content:
                    "Package list not available. The library store may not be mounted. Assume standard bioinformatics packages (numpy, pandas, scanpy, DESeq2, etc.) are available, but do not attempt to install anything.",
            });
        }
    },
});
