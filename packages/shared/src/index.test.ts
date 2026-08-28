import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.includes("/packages/shared/src/")) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const shared = await import("./index.ts");

test("package root does not expose authenticated trust-root construction", () => {
  assert.equal("createAuthenticatedSenderBoundary" in shared, false);
  assert.equal("issueTrustedSenderProvenance" in shared, false);
  assert.equal("createAuthenticatedSessionAdapter" in shared, false);
  assert.equal("createAuthenticatedSessionStore" in shared, false);
  assert.equal("restoreAuthenticatedSessionAdapter" in shared, false);
  assert.equal("issueAuthenticatedSessionCapability" in shared, false);
});
