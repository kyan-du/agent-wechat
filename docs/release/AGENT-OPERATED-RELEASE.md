# Agent-operated formal npm release

This is a **stable-only** Phase 1 architecture. There is no npm prerelease product flow: no `-next.N`, no `next` dist-tag, no GitHub prerelease, no prerelease Environment, and no canary-to-stable promotion. Future prerelease work requires a new owner-approved design.

Merging this PR cannot publish npm, create a release tag, move `latest`, create a GitHub Release, obtain OIDC, or deploy. `deploymentEnabled=false`; reachable jobs use read-only permissions; the only write blueprint has literal `if: false`.

## One production publisher

Each public package has exactly one Trusted Publisher identity:

- repository: `kyan-du/agent-wechat`
- workflow: `.github/workflows/npm-release.yml`
- Environment: `npm-production`
- version/tag: `X.Y.Z` / `vX.Y.Z`
- npm dist-tag: `latest`
- GitHub Release: final, never prerelease

The Agent never holds npm credentials or a long-lived token. The future production deployment permanently requires a non-Agent Environment approval plus a new exact owner authorization.

## Deterministic production candidate

A clean Release PR exits any old Changesets prerelease state and generates one lockstep stable version for the three public packages. The candidate job:

1. checks out the exact full SHA;
2. generates manifest and real tarballs twice from `git archive`;
3. compares all bytes;
4. verifies exact stable version, commit and supplied manifest sha256;
5. uploads only the sealed manifest and three `.tgz` files.

Artifact name binds complete intent: stable version, full commit, and manifest digest. Upload exposes artifact ID/digest/run/attempt; deploy downloads from that exact producer run and re-hashes without rebuilding.

The manifest binds publisher workflow, repository, stable version/tag, commit/tree, registry/`latest`, lockfile, Changesets and each tarball filename/size/sha256/SRI.

## Exact owner authorization

Strict v3 authorization reuses PR #49's protected annotated receipt, exact tag-object/commit ancestry, regular mode-`100644` blob, strict JSON and fail-closed registry rules. It binds:

- repository and exact `X.Y.Z` / `vX.Y.Z`;
- full commit/tree and manifest digest;
- npm registry and `latest`;
- exact package/version/tarball/sha256/SRI;
- operation (`release` or `reconcile`) and reconciliation digest;
- authorization ID, nonce digest, confirmation-reference digest and expiry;
- production Environment, Trusted Publisher, protected tags and registry reconciliation approvals;
- deterministic consumption identity.

Fresh release requires all three exact versions absent. Partial state requires a new reconcile authorization. Receipt, artifact, registry or operation drift invalidates authorization.

## Atomic consume and recovery

A normal protected Git tag and Actions concurrency group are not a global one-time lock. Activation requires an authenticated external CAS that atomically consumes the authorization and creates exact consumption/release refs before npm write. `consume-release-authorization.mjs` intentionally fails until this exists.

Publishing is non-atomic and phase-specific:

1. **Packages:** publish only missing sealed tarballs under a temporary non-user tag. Existing versions require exact SRI and npm provenance for repository/workflow/source commit/tarball. The provenance verifier remains fail-closed until implemented.
2. **Latest:** only after all package evidence matches, repair only incorrect `latest` mappings.
3. **GitHub Release:** create or verify the exact final Release only after `latest` reconciles.
4. **Post-install:** clean-install exact registry versions and smoke without replaying writes.

Zero missing packages is a valid recovery state. Integrity/provenance/Release identity drift enters owner incident review; an existing formal version is never overwritten or republished.

## State machine

`PREPARED → AUTHORIZED → PUBLISHING → PARTIAL_PUBLICATION/RECONCILED → PUBLISHED` or `FAILED`.

- `PREPARED`: reviewed Release PR and sealed bytes.
- `AUTHORIZED`: fresh exact versions absent and one-time receipt valid.
- `PARTIAL_PUBLICATION`: some exact bytes exist; new reconcile authorization required.
- `RECONCILED`: package, `latest`, Release or post-install phase has one bounded next action.
- `PUBLISHED`: package integrity/provenance, three `latest` mappings, final Release and registry smoke verified.
- `FAILED`: ambiguity or drift; owner incident decision.

## Phase 2 blockers

None are completed by this PR:

- owner exact irreversible authorization;
- legal/product approval of exact npm contents;
- npm package ownership and Trusted Publisher binding to the one workflow + `npm-production`;
- protected `npm-production` Environment with non-Agent reviewer;
- protected release/auth/consumption tag rules;
- authenticated owner-confirmation transport without chat/secret leakage;
- global atomic consume/CAS integration;
- npm/Sigstore provenance verifier;
- reconciliation of historical `0.12.0-next.0`, `next`, and `latest` state; a new absent stable `X.Y.Z` is required;
- separate activation PR with exact-head CI and independent formal review.

GHCR and WeChat redistribution remain independent legal/product gates and are never triggered by npm success.
