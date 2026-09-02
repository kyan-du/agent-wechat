# npm production release

This repository has one stable npm production workflow: `.github/workflows/npm-release.yml`.
It is intentionally small enough for a one-person project while keeping the important safety
boundaries: exact version input, current `main`, CI evidence, package build/test/pack, one
human approval gate, npm provenance, public registry verification, and an exact GitHub tag
and Release.

## Dispatch contract

Run the workflow manually with one input:

- `version`: exact stable `X.Y.Z`, matching `@kyan-du/agent-wechat-cli` and `@kyan-du/agent-wechat-openclaw`.

The workflow checks out `main` and fails unless the dispatch SHA equals the current
origin/main SHA. It also requires at least one successful `CI` run for that commit on
main before it packs or publishes.

Before packing, the workflow runs `scripts/validate-release-consistency.mjs`. This
checks that the three public npm package manifests, the Rust package manifest, the
built CLI's `--version`, and its generated compatibility metadata all agree with the
requested stable version. It also binds the check to the exact dispatch SHA. A release
candidate must therefore be built from the same commit whose source metadata is being
published.

## Approval and publishing

The `verify` job has read-only permissions. It installs dependencies, checks package
metadata, typechecks, runs package tests, builds, creates npm tarballs, and clean-installs
the packed tarballs.

The `publish` job is bound to the `npm-production` GitHub Environment. Only after that
environment is approved does the job receive `contents: write` and `id-token: write`.
It verifies the downloaded tarballs, then publishes in this order with npm provenance:

1. `@kyan-du/agent-wechat-cli`
2. `@kyan-du/agent-wechat-openclaw`

After publication it queries both exact public registry versions, clean-installs them in
a fresh project, imports both packages, and runs the `wx --version` binary smoke.

## Finalization

After registry verification succeeds, the workflow creates or verifies:

- exact tag `vX.Y.Z` pointing at the dispatch/current-main SHA;
- GitHub Release `vX.Y.Z`.

The same approved `npm-production` workflow then builds the Rust server for both
`linux/amd64` and `linux/arm64`, passing the exact `X.Y.Z` as the Docker `VERSION`
build argument, and publishes the exact GHCR tag `ghcr.io/kyan-du/agent-wechat:X.Y.Z`.
The tag is assembled from content-addressed digests and verified to contain both
architectures. The workflow is not successful until this GHCR publication succeeds.
The existing prerelease and commit-verification workflows remain separate and do not
publish stable semver tags.

There is no manifest summary protocol, cross-job producer identity protocol, byte-for-byte
 double build, release/reconcile state machine, or partial-publication auto-recovery. If npm
 publishing or GHCR publishing is interrupted, stop and decide manually whether to use a new
 version or perform a targeted operator repair outside this workflow.
