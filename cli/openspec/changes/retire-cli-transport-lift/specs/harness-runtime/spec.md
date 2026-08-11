# harness-runtime Delta

## REMOVED Requirements

### Requirement: The provider fetch honors the configured request timeout

**Reason**: The harness guard now supplies the transport lift itself, so a CLI-side lift duplicates it.
**Migration**: The composition root passes only the auth-injecting fetch. The connection values still reach the provider config, and the harness enforces the windows.
