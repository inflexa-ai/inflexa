export const DRUGBANK_BASE = "https://api.drugbank.com/v1";

export function getDrugbankHeaders(apiKey: string): Record<string, string> {
    const key = apiKey;
    if (!key) {
        throw new Error("DRUGBANK_API_KEY environment variable is not set. " + "Obtain a key from https://go.drugbank.com/");
    }
    return {
        Authorization: key,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
}
