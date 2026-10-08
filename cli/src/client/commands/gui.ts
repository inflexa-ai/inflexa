import { ok, type Result } from "neverthrow";

import { NONCE_LIFETIME_MS } from "../../api/browser_session.ts";
import { fail } from "../../lib/cli.ts";
import { openExternal, type OpenExternalError } from "../../lib/open_external.ts";
import { DEFAULT_CLIENT_OPTS, describeClientError, type ClientOpts } from "../api.ts";
import { requestSessionNonce } from "../browser_session.ts";

/** What `inflexa gui` reads, prints, and opens. Tests replace each one. */
export type GuiOpts = ClientOpts & {
    readonly open: (target: string) => Result<void, OpenExternalError>;
    readonly write: (line: string) => void;
};

/** The production {@link GuiOpts}. */
export const DEFAULT_GUI_OPTS: GuiOpts = {
    ...DEFAULT_CLIENT_OPTS,
    open: (target) => openExternal(target),
    write: (line) => console.log(line),
};

/**
 * `inflexa gui` — get a nonce from the server, print the sign-in link of `/gui/`, and open it in the default
 * browser. The discovery is read one time, thus the nonce and the origin of the link come from one server, also
 * when a restart occurs between two reads. The link is always printed, because `openExternal` gives `ok` when the
 * opener starts, not when a browser shows the page.
 */
export async function gui(opts: GuiOpts = DEFAULT_GUI_OPTS): Promise<void> {
    const endpoint = opts.discover().match(
        (found) => found,
        (e) => fail(describeClientError(e)),
    );
    const { nonce } = (await requestSessionNonce({ ...opts, discover: () => ok(endpoint) })).match(
        (found) => found,
        (e) => fail(describeClientError(e)),
    );
    const link = `${endpoint.baseUrl}/api/v1/session?nonce=${nonce}&next=/gui/`;
    opts.write(link);
    opts.write(`This link works one time, within ${NONCE_LIFETIME_MS / 1000} s.`);
    opts.open(link).match(
        () => undefined,
        () => opts.write("The command could not open a browser. Open the link above by hand."),
    );
}
