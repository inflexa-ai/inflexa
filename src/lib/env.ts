import { homedir } from "node:os";
import { join } from "node:path";

function dataDir(): string {
    if (process.platform === "win32") {
        return process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    }
    return process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share");
}

export const env = Object.freeze({
    dbPath: join(dataDir(), "inf", "agent.db"),
});
