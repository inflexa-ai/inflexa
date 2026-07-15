# add-bundled-content-assets

Bundle the shared `skills/` and `templates/` trees **inside the release binary** so an installed OSS user gets a fully working install from one `curl | bash` — no separate download step (unlike sandbox images). The binary embeds a single content archive and, on first run, extracts it to a hash-keyed directory under the data dir that `skillsDir`/`templatesDir` resolve to. A new binary version carries new content and re-extracts automatically, so updates ride the install.
