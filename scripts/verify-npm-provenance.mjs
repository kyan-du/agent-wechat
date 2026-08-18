#!/usr/bin/env node
// npm provenance verification is an activation prerequisite. npm CLI/API
// attestation retrieval and Sigstore verification must be implemented and
// independently reviewed before any existing registry bytes can be resumed.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 === 0 ? [...pairs, [value, all[index + 1]]] : pairs, []));
for (const name of ["--package", "--version", "--repository", "--workflow", "--commit"]) if (!args[name]) throw new Error(`missing ${name}`);
throw new Error("npm provenance/attestation verifier is not configured; existing package recovery fails closed");
