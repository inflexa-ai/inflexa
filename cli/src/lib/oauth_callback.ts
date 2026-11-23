import { createInterface } from "node:readline";

import { err, ok, ResultAsync, type Result } from "neverthrow";

import { describeCause } from "./cause.ts";

// An OAuth sign-in redirects the browser to a callback on a loopback port of the machine that waits for it. When
// the person runs inflexa through SSH, the browser runs on a different computer, and the redirect fails there.
// The address bar of the browser still holds the full callback URL. The person pastes it into the terminal, and
// this module sends the same request to the loopback port of this machine, where the listener waits.

/** The loopback host names that a callback URL can name. */
const LOOPBACK_HOST_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** How long a delivery of a pasted callback waits for the listener. A loopback listener answers in milliseconds. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** The port of a callback URL, with the default port of `http` when the URL names none. */
function portOf(url: URL): number {
    return url.port === "" ? 80 : Number(url.port);
}

/**
 * The request that a pasted callback URL stands for, sent to the port of `callback` on this machine, or why the
 * text is not such a URL. `callback` is the redirect URL of the sign-in, and the messages name its address. The
 * host of the request is always `127.0.0.1`: a listener that publishes on IPv4 only does not answer `localhost`
 * when it resolves to `::1`.
 */
export function pastedCallbackUrl(pasted: string, callback: URL): Result<URL, string> {
    const port = portOf(callback);
    const text = pasted.trim();
    if (!URL.canParse(text)) return err("the text is not a URL. Paste the full URL from the address bar of the browser.");
    const url = new URL(text);
    if (url.protocol !== "http:" || !LOOPBACK_HOST_NAMES.includes(url.hostname)) {
        return err(`the URL does not point at the sign-in callback. Paste the URL that starts with ${callback.origin}/.`);
    }
    if (portOf(url) !== port) return err(`the URL names port ${url.port || "80"}, but the sign-in waits on port ${port}.`);
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
        return err("the URL holds no `code`. Paste the URL from the address bar after the sign-in, not the sign-in link.");
    }
    url.hostname = "127.0.0.1";
    return ok(url);
}

/** Send the request of a pasted callback to the listener. A redirect counts as a delivery: a listener sends one to its own page of success. */
export async function deliverCallback(url: URL, fetchFn: (url: URL, init: RequestInit) => Promise<Response> = fetch): Promise<Result<void, string>> {
    const sent = await ResultAsync.fromPromise(
        fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) }),
        (cause) => `nothing answered on port ${url.port} (${describeCause(cause)}). The sign-in can be over already.`,
    );
    if (sent.isErr()) return err(sent.error);
    const response = sent.value;
    if (response.status < 400) return ok(undefined);
    const text = (await ResultAsync.fromPromise(response.text(), () => null)).unwrapOr("").trim();
    return err(`the sign-in refused the callback (HTTP ${response.status})${text === "" ? "" : `: ${text}`}`);
}

/** What {@link acceptPastedCallbacks} reads and where it says what it did. Tests replace each one. */
export type PastedCallbackOpts = {
    readonly input: NodeJS.ReadableStream;
    readonly say: (line: string) => void;
    readonly deliver: (url: URL) => Promise<Result<void, string>>;
};

/**
 * Read lines from the terminal while a sign-in waits, and send each pasted callback URL to the port of
 * `callback` on this machine. Gives the stop, which the caller runs when the sign-in settles. An empty line is ignored.
 */
export function acceptPastedCallbacks(callback: URL, opts: PastedCallbackOpts): () => void {
    const lines = createInterface({ input: opts.input, terminal: false });
    lines.on("line", (line) => {
        if (line.trim() === "") return;
        const url = pastedCallbackUrl(line, callback);
        if (url.isErr()) {
            opts.say(`Not sent: ${url.error}`);
            return;
        }
        void opts.deliver(url.value).then((delivered) =>
            delivered.match(
                () => opts.say("The callback reached the sign-in on this machine."),
                (reason) => opts.say(`Not sent: ${reason}`),
            ),
        );
    });
    return () => lines.close();
}

/** The line that tells the person how to paste the callback URL, for the sign-in that redirects to `callback`. */
export function pasteCallbackHint(callback: URL): string {
    return (
        `If the browser cannot reach ${callback.origin}/ after the sign-in (an error page), copy the URL from its ` +
        "address bar, paste it here, and push Enter."
    );
}
