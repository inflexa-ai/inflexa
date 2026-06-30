export const EPA_CCTE_BASE = "https://comptox.epa.gov/ctx-api";

export function getEpaCcteHeaders(apiKey: string): Record<string, string> {
    const key = apiKey;
    if (!key) {
        throw new Error("EPA_CCTE_API_KEY environment variable is not set. " + "Obtain a free key from https://api.epa.gov/");
    }
    return {
        "x-api-key": key,
        Accept: "application/json",
    };
}
