/**
 * The Discovery API of DrugBank. The Clinical API (`/v1`) serves no `?q=` search
 * on its drug resource, thus only Discovery answers a name search and a target
 * search.
 */
export const DRUGBANK_BASE = "https://api.drugbank.com/discovery/v1";

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
