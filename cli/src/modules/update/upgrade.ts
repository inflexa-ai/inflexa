import { log, spinner as clackSpinner } from "@clack/prompts";

import pkg from "../../../package.json";
import { fail } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import { applyErrorMessage, applyUpdate } from "./apply.ts";
import { installChannel, upgradeInstruction } from "./channel.ts";
import { fetchLatestVersion, isNewerVersion } from "./latest.ts";

/**
 * `inflexa upgrade` — install the newest release, or name the command that does.
 *
 * The version read here is unconditional, and its answer is not under the once-a-day ask record that the
 * startup notice keeps (see notice.ts). A person who types this command is asking NOW, and the answer
 * must show every time.
 */
export async function upgrade(): Promise<void> {
    const channel = installChannel();

    // A development build's version is not on the release page, so every comparison against it would be
    // meaningless. Reported before the network read, because no answer from that read could change it.
    if (channel === "source" || env.isDevelopment) {
        log.info(`This is a development build (${pkg.version}), which no release replaces. Update the checkout instead.`);
        return;
    }

    const progress = clackSpinner();
    progress.start("Reading the newest release");
    const latest = await fetchLatestVersion();
    progress.stop("Read the newest release");

    const version = latest.match(
        (value) => value,
        (error) => fail(`Could not read the newest release: ${error.type}`, "cause" in error ? error.cause : undefined),
    );

    if (!isNewerVersion(version, pkg.version)) {
        log.success(`inflexa ${pkg.version} is the newest release.`);
        return;
    }

    const instruction = upgradeInstruction(channel);
    if (instruction !== null) {
        log.info(`inflexa ${version} is out. This install is managed by another tool, so update it with:\n\n  ${instruction}`);
        return;
    }

    const install = clackSpinner();
    install.start(`Downloading inflexa ${version}`);
    const applied = await applyUpdate(version, {
        onProgress: (event) => {
            if (event.type === "bytes") install.message(`Downloading inflexa ${version} — ${Math.round(event.bytes / 1_000_000)} MB`);
        },
    });
    install.stop(`Downloaded inflexa ${version}`);

    applied.match(
        () => log.success(`Updated to inflexa ${version}. It takes effect the next time you start inflexa.`),
        (error) => fail(applyErrorMessage(error)),
    );
}
