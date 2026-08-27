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

test("package root exports the authenticated delivery boundary", () => {
  assert.equal(typeof shared.createAuthenticatedSenderBoundary, "function");
  assert.equal(typeof shared.issueTrustedSenderProvenance, "function");
});
