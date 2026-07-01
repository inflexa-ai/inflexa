/**
 * Bun test preload — sets required env vars that may not be in .env during testing.
 */

// CORTEX_SERVICE_TOKEN is required in all environments. Provide a default for tests.
process.env.CORTEX_SERVICE_TOKEN ??= "test-token";
