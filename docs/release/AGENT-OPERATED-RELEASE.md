# Agent-operated formal npm release

This is a **stable-only** production flow: no npm prerelease, no canary promotion, and no mutable tag/SHA input. The only publisher is `.github/workflows/npm-release.yml` in `kyan-du/agent-wechat`, protected by the `npm-production` GitHub Environment and npm Trusted Publishing.

## Exact dispatch contract

Dispatch the workflow from the exact release commit on `main` with:

- `version`: exact stable `X.Y.Z` matching all three public package manifests;
- `release_sha`: full 40-character immutable commit SHA, required to be an ancestor of `origin/main`;
- `operation`: `release` when all exact versions are absent, otherwise `reconcile`;
- `reconciliation_sha256`: empty for `release`; for `reconcile`, the exact digest of the reviewed partial publication receipt.

GitHub Environment approval is the human authorization boundary. There is deliberately no bespoke one-time receipt, nonce, owner-confirmation transport, or unsupported external CAS service.

## Sealed artifacts and provenance

The candidate job checks out only `release_sha`, builds the manifest and tarballs twice on the pinned runner toolchain, compares all bytes, verifies version/commit/artifact integrity, computes the manifest digest, and uploads one artifact whose name binds version, SHA, and that runner-generated manifest digest. Deploy downloads by the exact artifact ID from the same run and re-hashes it against the candidate job output; it never rebuilds.

The deploy job receives `id-token: write` only after the `npm-production` Environment gate. Every missing tarball is published under a temporary staging tag using npm Trusted Publishing and `--provenance`. Existing versions fail closed unless their SRI and provenance match the manifest repository, workflow, source commit, and artifact.

## Fail-closed reconciliation and partial publication recovery

Before any write, registry and GitHub Release state is reconciled against the sealed manifest.

- `release` is accepted only when all three exact versions are absent.
- A partial publication requires a new explicit `reconcile` dispatch bound to the exact reconciliation receipt digest.
- Drift in package integrity, provenance, source identity, or GitHub Release identity stops the run.
- Recovery publishes only missing sealed tarballs. Zero missing tarballs is valid.
- `latest` moves only after every package is verified; GitHub Release creation and clean-install smoke happen afterward.

The immutable `vX.Y.Z` ref is created or verified against `release_sha` immediately before package writes. Environment concurrency prevents overlapping runs for the same exact intent; npm version immutability plus registry reconciliation is the durable write boundary.

## Platform setup required before dispatch

1. `npm-production` Environment must require an authorized reviewer and protected-branch deployment.
2. Each public npm package must trust repository `kyan-du/agent-wechat`, workflow `.github/workflows/npm-release.yml`, Environment `npm-production`.
3. The workflow needs repository contents write for `vX.Y.Z` and the final GitHub Release; tag rules must permit the GitHub Actions identity while preventing mutable release tags.
4. Dispatch from `main` only after the activation PR is merged and the exact version, release SHA, operation, and reconciliation receipt requirement are independently reviewed.

GHCR is independent and is not triggered by this workflow.
