# Agent-operated npm release state machine

This is Phase 1: implemented but inactive. Merging it cannot publish npm packages, create or push a release tag, mutate a dist-tag, create a GitHub Release, push GHCR, obtain an OIDC token, or change production. `release/agent-release-contract.json` keeps `deploymentEnabled=false`; reachable jobs use `contents: read` and `id-token: none`; the sole write-capable blueprint has literal `if: ${{ false }}`. Bootstrap and activation require a separate exact-head reviewed owner-authorized PR.

## One Trusted Publisher

npm permits one GitHub Actions Trusted Publisher configuration per package. All three public packages must therefore bind one npm-trusted publisher workflow identity: `.github/workflows/npm-agent-release.yml`. That workflow owns both channel inputs:

- `channel=prerelease`: `X.Y.Z-next.N`, `next`, GitHub prerelease, `npm-prerelease` Environment.
- `channel=stable`: `X.Y.Z`, `latest`, final GitHub Release, `npm-production` Environment and canary provenance.

Sharing the npm-trusted workflow does not merge authorization or approval. Each channel has a new exact owner receipt, fixed version grammar/dist-tag/Release type, and a channel-selected Environment. Stable permanently requires a non-Agent `npm-production` approval. `.github/workflows/npm-agent-stable.yml` is read-only contract validation and cannot be registered as a second publisher.

Before activation, npm owner/admin must verify that one Trusted Publisher workflow can be used with both GitHub Environments under npm's Environment binding rules. If not, activation remains blocked; no long-lived token fallback is allowed.

## Roles and authorization

The Agent may inspect `main`, prepare a Release PR, coordinate exact-head review/CI, prepare exact evidence, dispatch an approved workflow, and verify remote state. The Agent never decides to publish and never holds npm credentials, Telegram tokens, owner confirmation text, or a locally usable publish secret.

Normal owner interaction is:

1. `Prepare prerelease`: Release PR and read-only evidence only.
2. `Confirm release <version> @ <full commit>`: exact repository/channel/version/tag/commit/tree/manifest/dist-tag/package/tarball/integrity, operation, authorization ID, nonce and expiry.

Partial recovery and stable promotion require new explicit confirmation; an old receipt is never reused. The external owner-chat integration must emit only an opaque authorization ID, operation, reconciliation digest when applicable, nonce digest, confirmation-reference digest and timestamps. It must not persist private chat text or nonce plaintext.

## State machine

| State | Evidence | Safe next action |
| --- | --- | --- |
| `PREPARED` | Release PR, exact commit/tree, sealed manifest/tarballs | exact review/CI then authorization |
| `AUTHORIZED` | unused receipt; all exact package versions absent | atomic consume then publish |
| `PUBLISHING` | Environment-approved run and sealed bytes | partial, reconciled, or failed |
| `PARTIAL_PUBLICATION` | some exact SRI/provenance verified, some absent | separately authorized missing-only resume |
| `RECONCILED` | all package bytes verified; phase names dist-tags, Release, or post-install | repair that phase only |
| `PUBLISHED` | package SRI/provenance, target dist-tags, exact Release, post-install | canary |
| `CANARY_PASSED` | immutable manifest and canary receipt bytes | stable authorization |
| `PROMOTED` | stable `latest`, final Release, post-install | terminal |
| `FAILED` | integrity/provenance/identity ambiguity | next prerelease or owner incident decision |

## Deterministic Release candidate

Use a clean isolated branch and Changesets:

```bash
git fetch origin main
git switch -c release/next-<candidate> origin/main
pnpm prepare:release-pr -- --channel prerelease
pnpm install --frozen-lockfile
pnpm test:release-plan
pnpm test:release-workflows
pnpm typecheck
```

The candidate job checks out the full immutable SHA, generates the manifest and real `.tgz` files twice from `git archive`, compares both complete outputs byte-for-byte, verifies the exact supplied manifest digest/commit/channel/version, then uploads only:

- `agent-release-manifest.json`
- the three exact tarballs

as `npm-release-<full-sha>`. Deployment downloads and re-hashes that exact artifact; it never rebuilds or runs `npm pack`. The manifest binds the single publisher workflow, repository/channel/version/tag, commit/tree, registry/dist-tag, lockfile, changesets, and every tarball filename/size/sha256/SRI.

## Exact authorization and atomic consumption

The v2 receipt reuses PR #49's strict JSON, protected one-hop annotated receipt tag, exact tag-object/commit ancestry, regular mode-`100644` blob, main containment, and fail-closed intent gates. It adds channel, operation, manifest/tarball integrity, opaque ID, nonce digest, confirmation-reference digest, expiry, reconciliation digest and deterministic consumption identity.

A normal protected Git tag and per-input Actions concurrency group are not a global one-time lock. Two runs can race an absence probe. The activation design therefore requires an authenticated external atomic compare-and-create boundary that:

1. authenticates the exact receipt before replay lookup;
2. atomically consumes the authorization ID and creates the protected consumption/release refs, or proves the exact prior result;
3. returns failure to every competing run before registry write.

`scripts/consume-release-authorization.mjs` is intentionally fail-closed until that CAS service exists. A normal `git push`, even with `--atomic`, is not accepted as the one-time consumption implementation.

## Publication and phase recovery

Before any release marker, tag, or registry write, the workflow reconciles remote state and checks it against the authorized operation:

- `operation=release` requires all three exact versions absent.
- `operation=reconcile` requires the exact separately authorized reconciliation artifact digest and partial/reconciled state.
- Existing bytes count as verified only when version, SRI, repository, publisher workflow, source commit and npm provenance/attestation all match. `scripts/verify-npm-provenance.mjs` intentionally blocks activation until a real Sigstore/npm attestation verifier is implemented.

The publisher then uploads missing sealed tarballs under a non-user staging tag. Zero missing items is a valid resume: publishing is skipped. After each phase it re-queries public npm and records a receipt.

Recovery is phase-specific:

1. **Packages:** publish only missing items; never republish an existing exact version.
2. **Dist-tags:** after all package SRI/provenance match, repair only package mappings not equal to `next` or `latest`.
3. **GitHub Release:** after all target mappings match, create or verify the exact prerelease/final Release idempotently.
4. **Post-install:** registry exact-version clean-install/import/CLI smoke; no earlier write is repeated.

Fresh `operation=release` is rejected for every partial package state. Any SRI/provenance/GitHub Release identity drift fails closed. The crash matrix covers before/after each package, each dist-tag, release/consumption tag boundary, and GitHub Release creation.

## Stable promotion

Stable validation binds actual immutable bytes, not digest-shaped strings. `release/stable-promotion.json` identifies the prerelease manifest and canary receipt paths and hashes. `scripts/verify-stable-promotion.mjs`:

- re-hashes and structurally verifies the prerelease manifest;
- re-hashes strict canary JSON and requires `CANARY_PASSED` with exact repository, single publisher workflow, version, commit, tree and manifest digest;
- verifies both Git commit trees;
- uses a code-owned fixed path allowlist plus package version/changelog metadata. The receipt cannot expand policy.

Any source difference requires another prerelease review/canary and cannot be called promotion.

## Phase 2 blockers

None are completed by this PR:

- **Owner/product:** candidate choice, exact irreversible authorization, canary decision and stable promotion.
- **Legal/product:** exact npm content approval; GHCR/WeChat redistribution remains separate.
- **npm owner:** package ownership/bootstrap and one Trusted Publisher per package bound to `.github/workflows/npm-agent-release.yml`; verify dual-Environment compatibility.
- **Repository admin:** protected `npm-prerelease`/`npm-production` Environments with non-Agent stable reviewer; release/auth/consumption rulesets.
- **Atomic consume integration:** authenticated global CAS before registry writes.
- **Provenance integration:** retrieve and cryptographically verify npm attestation against repository/workflow/commit/tarball.
- **Registry state:** independently reconcile existing `0.12.0-next.0` and historical `next`/`latest` mappings.
- **Owner-confirmation integration:** authenticated private confirmation to opaque receipt/nonce transport without secret/chat leakage.
- **Activation PR:** enable only after all blockers have evidence, exact-head CI and independent formal review.

The first real prerelease still requires GitHub Environment approval. Stable approval is permanent. GHCR remains independent and is never dispatched by npm success.
