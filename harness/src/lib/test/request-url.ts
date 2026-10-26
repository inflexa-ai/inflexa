/**
 * The URL text of a fetch target, for test doubles that record what a client
 * asked for: each member of the `fetch` input union names its URL itself.
 */
export function requestUrlText(input: string | URL | Request): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}
