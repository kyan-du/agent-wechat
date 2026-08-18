#!/usr/bin/env node
// Repository code cannot provide a global compare-and-create transaction across
// concurrent GitHub runs. Activation must replace this fail-closed interface with
// an authenticated external CAS that atomically consumes the authorization and
// creates both protected refs before any registry write.
if (!process.argv.includes("--atomic-cas-required")) throw new Error("atomic authorization consume contract flag is required");
throw new Error("atomic external authorization consume/CAS is not configured; release deployment remains inactive");
