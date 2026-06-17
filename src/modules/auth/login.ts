import { type Auth0Config, describeAuthError, pollForToken, requestDeviceCode, resolveAuth0Config, saveAuth } from "./auth.ts";

export async function login(): Promise<void> {
    const config = resolveAuth0Config().match(
        (value): Auth0Config | null => value,
        (error) => {
            console.error(`  ${describeAuthError(error)}`);
            process.exitCode = 1;
            return null;
        },
    );
    if (config === null) return;

    const device = await requestDeviceCode(config);
    if (device.isErr()) {
        console.error(`  ${describeAuthError(device.error)}`);
        process.exitCode = 1;
        return;
    }

    console.log("\n  To log in, open this URL in your browser:\n");
    console.log(`    ${device.value.verificationUriComplete}\n`);
    console.log(`  and confirm the code: ${device.value.userCode}\n`);
    openBrowser(device.value.verificationUriComplete);
    console.log("  Waiting for confirmation...");

    const grant = await pollForToken(config, device.value);
    if (grant.isErr()) {
        console.error(`  ${describeAuthError(grant.error)}`);
        process.exitCode = 1;
        return;
    }

    saveAuth(grant.value).match(
        () => {
            const expires = new Date(grant.value.expiresAt).toLocaleString();
            console.log(`  Logged in. Access token expires ${expires}; the session renews automatically while you keep using inf.`);
        },
        (error) => {
            console.error(`  ${describeAuthError(error)}`);
            process.exitCode = 1;
        },
    );
}

/**
 * Best-effort sugar — the URL is always printed, so headless/SSH sessions
 * just open it manually.
 */
function openBrowser(url: string): void {
    const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    try {
        // unref: the opener must not keep the CLI's event loop alive.
        Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" }).unref();
    } catch {
        // Missing opener binary (e.g. no xdg-open) — the printed URL covers it.
    }
}
