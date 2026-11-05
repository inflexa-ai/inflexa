import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import type { FarmLinkView } from "../../../api/store.ts";
import type { ClientOpts } from "../../api.ts";
import { storeLink } from "../store.ts";
import { parsedJson } from "../../../test_support/json.ts";
import { requestBodyText } from "../../../test_support/request_body.ts";
import { captureConsole } from "../../../test_support/console_capture.ts";

describe("store link", () => {
    test("links through the farm route of the analysis, and prints each link", async () => {
        const sent: { url: string; body: unknown }[] = [];
        const linked: FarmLinkView = { linked: ["igraph==0.11.8"], storeDirs: 3 };
        const opts: ClientOpts = {
            discover: () => ok({ baseUrl: "http://store.test", token: "t" }),
            fetch: (url, init) =>
                Promise.try(() => {
                    sent.push({ url, body: parsedJson(requestBodyText(init), z.json()) });
                    return new Response(JSON.stringify(linked), { status: 200, headers: { "Content-Type": "application/json" } });
                }),
        };
        const run = await captureConsole(() => storeLink({ id: "ana-1", name: "Tumor atlas" }, ["igraph"], "python", opts));
        expect(sent).toEqual([{ url: "http://store.test/api/v1/analyses/ana-1/farm/link", body: { packages: ["igraph"], lang: "python" } }]);
        expect(run.stdout).toContain('Linked igraph==0.11.8 into the farm of "Tumor atlas".\nThat farm links 3 store directories now.');
        expect(run.exitCode ?? 0).toBe(0);
    });
});
