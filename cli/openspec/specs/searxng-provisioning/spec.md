# searxng-provisioning Specification

## Purpose
Run the SearXNG metasearch engine as one more service of the CLI compose stack, provision its settings file with a one-time secret key, publish it on the loopback address, and give the harness the URL of the engine.

## Requirements

### Requirement: SearXNG runs as a compose service of the stack

The CLI SHALL define a SearXNG service in the generated compose file for every connection mode, on the shared stack network. The service SHALL publish its container port 8080 on `127.0.0.1` only, at the channel port (28437 in production, 28438 in development). The image SHALL be pinned by dated tag AND manifest digest, the same pin form as the proxy image (a bump changes the tag and the digest together), and SHALL NOT be user-overridable. The service SHALL mount the provisioned settings file read-only at `/etc/searxng/settings.yml`. The service SHALL join the pull list of every compose-pull path in both connection modes.

#### Scenario: The service is in the compose file in every mode

- **WHEN** the compose file is generated in cliproxy mode or in direct mode
- **THEN** the file defines the SearXNG service on the shared network, with the settings-file mount and a loopback-only published port

#### Scenario: The published port answers on loopback

- **WHEN** the stack runs and `GET http://127.0.0.1:<port>/search?q=test&format=json` is issued
- **THEN** the request answers HTTP 200 with a JSON body

#### Scenario: The image is pinned

- **WHEN** the compose file is generated in any mode or channel
- **THEN** the SearXNG image reference carries a dated version tag and a manifest digest

### Requirement: The SearXNG settings file is provisioned once and kept

The CLI SHALL provision the SearXNG settings file as a `file` mount source through the mount-source integrity guard, before the engine runs. The file SHALL set `use_default_settings: true`, `search.formats` to `html` and `json`, `server.limiter` to `false`, `public_instance` to `false`, and `server.secret_key` to a random value made with the platform crypto. The provisioner SHALL make the key one time: a later run that finds a settings file SHALL keep the file as it is. The path SHALL be channel-aware, the same as every stack path, so a dev stack and an installed stack hold different files.

#### Scenario: The first run makes the file with a random key

- **WHEN** a compose entry point runs and the settings file does not exist
- **THEN** the file is written before the engine runs, with the four fixed settings and a random `secret_key` that is not the shipped `ultrasecretkey`

#### Scenario: A later run keeps the key

- **WHEN** `inflexa setup` runs a second time after a first run provisioned the file
- **THEN** the `secret_key` of the file is byte-identical to the value of the first run

#### Scenario: `json` is an accepted search format

- **WHEN** SearXNG starts with the provisioned settings
- **THEN** `format=json` is an accepted search format, because the settings list it and SearXNG refuses an unlisted format with 403

### Requirement: The boot hands the SearXNG URL to the harness

The CLI SHALL derive the SearXNG base URL from the channel port and SHALL give it to the conversation assembly of the harness as the SearXNG base URL, so the conversation agent roster holds `web_search`. The URL is a stack constant the CLI owns: there SHALL be no config field and no environment variable for it, the same rule as the proxy endpoint.

#### Scenario: The conversation deps carry the URL

- **WHEN** the harness runtime boots the conversation assembly
- **THEN** the SearXNG base URL is `http://127.0.0.1:<channel port>`
