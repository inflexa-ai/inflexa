export const DISGENET_BASE = "https://www.disgenet.org/api";

export function getDisgenetHeaders(apiKey: string): Record<string, string> {
    const key = apiKey;
    if (!key) {
        throw new Error("DISGENET_API_KEY environment variable is not set. " + "Obtain a key from https://www.disgenet.org/api/#/Authorization");
    }
    return {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
    };
}
