# npm production release

This repository has one stable npm production workflow: `.github/workflows/npm-release.yml`.
It is intentionally small enough for a one-person project while keeping the important safety
boundaries: exact version input, current `main`, CI evidence, package build/test/pack, one
human approval gate, npm provenance, public registry verification, and an exact GitHub tag
and Release.

## Dispatch contract

Run the workflow manually with one input:

- `version`: exact stable `X.Y.Z`, matching `@agent-wechat/cli` and `@agent-wechat/wechat`.

The workflow checks out `main` and fails unless the dispatch SHA equals the current
`origin/main` SHA. It also requires at least one successful `CI` run for that commit on
`main` before it packs or publishes.

## Approval and publishing

The `verify` job has read-only permissions. It installs dependencies, checks package
metadata, typechecks, runs package tests, builds, creates npm tarballs, and clean-installs
the packed tarballs.

The `publish` job is bound to the `npm-production` GitHub Environment. Only after that
environment is approved does the job receive `contents: write` and `id-token: write`.
It verifies the downloaded tarballs, then publishes in this order with npm provenance:

1. `@agent-wechat/cli`
2. `@agent-wechat/wechat`

After publication it queries both exact public registry versions, clean-installs them in
a fresh project, imports both packages, and runs the `wx --version` binary smoke.

## Finalization

Only after registry verification succeeds, the workflow creates or verifies:

- exact tag `vX.Y.Z` pointing at the dispatch/current-main SHA;
- GitHub Release `vX.Y.Z`.

There is no manifest summary protocol, cross-job producer identity protocol, byte-for-byte
double build, release/reconcile state machine, or partial-publication auto-recovery. If npm
publishing is interrupted, stop and decide manually whether to use a new version or perform
a targeted operator repair outside this workflow.

GHCR remains independent and is not triggered by this npm workflow.
