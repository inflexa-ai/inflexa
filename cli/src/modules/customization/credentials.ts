import { credentialSourceSchema, readConfig, type CredentialSourceConfig } from "../../lib/config.ts";
import { createCredentialSource, credentialErrorMessage, type CredentialSource } from "../../lib/credential.ts";
import { getLogger } from "../../lib/log.ts";

/** Reads the value of a named credential from its source in the config. */
export type CredentialReader = {
    /** The value of the credential, or `undefined` when the config names no such credential or its source gives none. */
    readonly read: (name: string) => Promise<string | undefined>;
};

/**
 * A reader over the `credentials` block of the config. Each credential keeps one cached source for as long as its
 * declaration stays the same, thus a helper command runs only when its token ages out. A source that fails gives
 * `undefined`, and the tool that needs the key reports the missing key.
 */
export function createCredentialReader(read: () => Record<string, unknown> | undefined = () => readConfig().credentials): CredentialReader {
    const sources = new Map<string, { readonly declaration: string; readonly source: CredentialSource }>();
    const log = getLogger("credentials");
    return {
        read: async (name) => {
            const raw = read()?.[name];
            if (raw === undefined) return undefined;
            const parsed = credentialSourceSchema.safeParse(raw);
            if (!parsed.success) {
                log.warn({ credential: name }, "the declaration of a credential does not parse");
                return undefined;
            }
            const declaration = JSON.stringify(parsed.data);
            let entry = sources.get(name);
            if (entry === undefined || entry.declaration !== declaration) {
                entry = { declaration, source: createCredentialSource(asAuthConfig(parsed.data)) };
                sources.set(name, entry);
            }
            const credential = await entry.source.get();
            return credential.match(
                (value) => value.token,
                (error) => {
                    log.warn({ credential: name, reason: credentialErrorMessage(error) }, "a credential gave no value");
                    return undefined;
                },
            );
        },
    };
}

/** A credential source of the config as the source of a model credential: the scheme names only a wire header, and no consumer here sends one. */
function asAuthConfig(source: CredentialSourceConfig): Parameters<typeof createCredentialSource>[0] {
    return { ...source, scheme: "bearer" };
}

const REFERENCE_OPEN = "${cred:";

/**
 * The text with each `${cred:<name>}` reference replaced by the value of the credential. A reference whose credential
 * has no value becomes an empty string, and the server that needs it reports its own failure.
 */
export async function resolveCredentialReferences(text: string, reader: CredentialReader): Promise<string> {
    let out = "";
    let from = 0;
    for (;;) {
        const start = text.indexOf(REFERENCE_OPEN, from);
        if (start === -1) return out + text.slice(from);
        const end = text.indexOf("}", start + REFERENCE_OPEN.length);
        if (end === -1) return out + text.slice(from);
        out += text.slice(from, start) + ((await reader.read(text.slice(start + REFERENCE_OPEN.length, end))) ?? "");
        from = end + 1;
    }
}
