import { fail } from "../../lib/cli.ts";
import type { StoreEcosystem } from "../../types/store.ts";
import { DEFAULT_CLIENT_OPTS, describeClientError, type ClientOpts } from "../api.ts";
import { createFarmLink } from "../store.ts";

/**
 * `inflexa store link` — link packages that the pool already holds into the farm of `analysis`, through
 * `POST {A}/farm/link`. A both-hit refuses with the `--lang` remedy.
 */
export async function storeLink(
    analysis: { id: string; name: string },
    packages: string[],
    lang: StoreEcosystem | undefined,
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<void> {
    const outcome = (await createFarmLink(analysis.id, { packages, ...(lang === undefined ? {} : { lang }) }, opts)).match(
        (v) => v,
        (e) => fail(describeClientError(e)),
    );
    for (const item of outcome.linked) console.log(`Linked ${item} into the farm of "${analysis.name}".`);
    console.log(`That farm links ${outcome.storeDirs} store directories now.`);
    console.log("A live sandbox of the analysis resolves them at its next import, thus no restart is necessary.");
}
