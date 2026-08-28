export const DISGENET_BASE = "https://api.disgenet.com/api/v1";

export function getDisgenetHeaders(apiKey: string): Record<string, string> {
    const key = apiKey;
    if (!key) {
        throw new Error("DISGENET_API_KEY environment variable is not set. " + "Obtain a key from https://disgenet.com/plans");
    }
    // The v1 API reads the raw key out of `Authorization`. A `Bearer ` prefix
    // makes the key unreadable, and every data path then answers 401.
    return {
        Authorization: key,
        Accept: "application/json",
    };
}
