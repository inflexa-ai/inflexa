# add-poll-transport-mode

Make the CLI a **poll-mode** embedder: it starts no exec-callback ingress and advertises no `CORTEX_BASE_URL`, because the host polls the sandbox for results. The embedder-side half of the harness `add-poll-transport-mode` change. Closes #27 and #41 for the local CLI.
