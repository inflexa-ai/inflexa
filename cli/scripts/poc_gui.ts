// Dev: print the URL of the proof-of-concept web GUI of the running dev server, and open it on request.
//   bun scripts/poc_gui.ts          → print the URL
//   bun scripts/poc_gui.ts --open   → print the URL, then open it in the default browser
//
// The server serves the page in the dev channel only (`bun run dev serve`). The URL carries the bearer token of
// the discovery file in its fragment, which a browser never sends to the server.
import { release } from "node:os";

// `readServerDiscovery` uses `JSON.parseWith`, which src/index.ts installs for the CLI.
import "../src/extensions/index.ts";
import { readServerDiscovery, serverBaseUrl } from "../src/client/api.ts";
import { env } from "../src/lib/env.ts";

/** The URL of the web GUI of the server on `port`, with `token` in the fragment, where the page reads it. */
export function guiUrl(port: number, token: string): string {
    return `${serverBaseUrl(port)}/gui/#token=${encodeURIComponent(token)}`;
}

/** The command that opens `url` in the default browser of this host, or `null` when the host has none. */
function openCommand(url: string): string[] | null {
    if (process.platform === "darwin") return ["open", url];
    // The empty argument is the window title of `start`: without it, `start` reads a quoted URL as the title.
    if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
    // WSL reports a Linux platform, and the browser is on the Windows side.
    if (release().toLowerCase().includes("microsoft")) {
        if (Bun.which("wslview") !== null) return ["wslview", url];
        if (Bun.which("cmd.exe") !== null) return ["cmd.exe", "/c", "start", "", url];
    }
    return Bun.which("xdg-open") !== null ? ["xdg-open", url] : null;
}

async function main(): Promise<void> {
    const discovery = readServerDiscovery().match(
        (found) => found,
        (e) => {
            console.error(`Could not read the server discovery file ${env.serverFilePath}: ${String(e.cause)}`);
            process.exit(1);
        },
    );
    if (discovery === null) {
        console.error(`No server runs: ${env.serverFilePath} does not exist. Start the dev server with \`bun run dev serve\`.`);
        process.exit(1);
    }

    const url = guiUrl(discovery.port, discovery.token);
    console.log(url);
    if (!process.argv.includes("--open")) return;

    const command = openCommand(url);
    if (command === null) {
        console.error("No command to open a browser was found. Open the URL above by hand.");
        process.exit(1);
    }
    const code = await Bun.spawn(command, { stdout: "ignore", stderr: "inherit" }).exited;
    if (code !== 0) console.error(`\`${command[0]}\` exited with code ${code}. Open the URL above by hand.`);
}

if (import.meta.main) await main();
