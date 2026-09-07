import { registerHooks } from 'node:module';

// Isolated checkout qualification may use a content-hashed copy of the host's
// actual public SDK entry. This substitutes resolution, not coordinator behavior.
if (process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME || process.env.COMMAND_CENTER_TEST_FILE_ACCESS_RUNTIME || process.env.COMMAND_CENTER_TEST_SESSION_STORE_RUNTIME) registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'openclaw/plugin-sdk/sqlite-runtime' && process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME) return { url: process.env.COMMAND_CENTER_TEST_SQLITE_RUNTIME, shortCircuit: true };
    // The actual selected host facade may be source-loaded for a focused
    // diagnostic. This is not a sealed/build qualification claim.
    if (specifier === 'openclaw/plugin-sdk/file-access-runtime' && process.env.COMMAND_CENTER_TEST_FILE_ACCESS_RUNTIME) return { url: process.env.COMMAND_CENTER_TEST_FILE_ACCESS_RUNTIME, shortCircuit: true };
    if (specifier === 'openclaw/plugin-sdk/session-store-runtime' && process.env.COMMAND_CENTER_TEST_SESSION_STORE_RUNTIME) return { url: process.env.COMMAND_CENTER_TEST_SESSION_STORE_RUNTIME, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
