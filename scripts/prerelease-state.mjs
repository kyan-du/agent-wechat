import { existsSync, readFileSync } from "node:fs";

export function prereleaseEnterRequired(path, expectedTag) {
  if (!existsSync(path)) return true;
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid Changesets prerelease state: ${error.message}`);
  }
  if (!state || state.mode !== "pre" || state.tag !== expectedTag) {
    throw new Error(`Changesets prerelease state must be pre/${expectedTag}; found ${String(state?.mode)}/${String(state?.tag)}`);
  }
  if (!state.initialVersions || typeof state.initialVersions !== "object" || Array.isArray(state.initialVersions)
    || !Array.isArray(state.changesets)) {
    throw new Error("Changesets prerelease state is incomplete");
  }
  return false;
}
