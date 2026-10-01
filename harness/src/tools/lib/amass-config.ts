export const AMASS_BASE = "https://api.amass.tech/api/v1";

export function getAmassHeaders(apiKey: string): Record<string, string> {
    if (!apiKey) {
        throw new Error("AMASS_API_KEY environment variable is not set. " + "Obtain a key from https://platform.amass.tech/api-keys");
    }
    return {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
    };
}
