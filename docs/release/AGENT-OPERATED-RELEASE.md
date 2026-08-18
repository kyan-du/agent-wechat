# Agent-operated npm release state machine

This architecture is implemented but inactive. Merging it cannot publish npm packages, create or push a release tag, mutate an npm dist-tag, create a GitHub Release, push GHCR, or change a production account. `release/agent-release-contract.json` keeps `deploymentEnabled=false`; both new workflows require `dry_run=true`, use `contents: read` and `id-token: none`, and contain no write command. Activation and first bootstrap require a separate exact-head reviewed owner-authorized change.

## Roles and boundaries

The Agent may inspect `main`, open PRs, changesets, npm state, prepare one Release PR, coordinate exact-head review/CI, merge after normal authorization, prepare an exact release summary, dispatch validation, and verify published state after an independently approved activation. The Agent never decides that a release should happen and never holds an npm password, long-lived `NPM_TOKEN`, Telegram token, owner confirmation text, or locally usable publish credential.

The normal owner interaction is:

1. `Prepare prerelease` authorizes only a Release PR and read-only evidence generation.
2. `Confirm release <version> @ <full commit>` must also identify the repository, `next`, all three package versions and integrity values, authorization ID, one-time nonce, and expiry. This is the irreversible-operation authorization; vague, stale, branch-only, expired, replayed, or drifted confirmation is invalid.

The external owner-chat integration does not exist in this repository. It must convert an authenticated owner confirmation into the documented opaque interface without retaining chat text: random `authorizationId`, `sha256(nonce)`, `sha256(owner confirmation reference)`, issued/expiry timestamps, and the exact v2 receipt. The nonce itself enters only the protected deployment at dispatch. This repository neither fabricates that integration nor stores the nonce.

## State machine

| State | Evidence | Allowed next state |
| --- | --- | --- |
| `PREPARED` | Release PR, exact commit/tree, manifest and tarballs | `AUTHORIZED` after exact review/CI and owner receipt |
| `AUTHORIZED` | unused v2 receipt, nonce match, not expired, registry reconciliation | `PUBLISHING` |
| `PUBLISHING` | Environment-approved run and immutable artifact set | `PARTIAL_PUBLICATION`, `PUBLISHED`, or `FAILED` |
| `PARTIAL_PUBLICATION` | at least one exact SRI exists and at least one package is absent | approved resume of missing-only items, or `FAILED` |
| `PUBLISHED` | all three exact versions/SRI and all target dist-tags verified | `CANARY_PASSED` or `FAILED` |
| `CANARY_PASSED` | immutable canary receipt bound to prerelease manifest | `PROMOTED` through stable flow |
| `PROMOTED` | stable `latest`, non-prerelease GitHub Release, post-install evidence | terminal |
| `FAILED` | drift, unsafe ambiguity, or unrecoverable transaction | new `next.N+1` or owner incident decision |
| `RECONCILED` | exact remote integrity evidence after interruption | resume at the single safe next operation |

An immutable consumption ref named `npm-release-consumed/<release-tag>/<authorization-id>` is the replay marker. The future activated deployment must create it before any registry write under a non-cancelling, per-authorization concurrency group. A missing marker is not proof that npm has no partial state; every run first reconciles all package versions and SRI.

## Prepare a Release PR

Use an isolated clean branch based on exact `origin/main`:

```bash
git fetch origin main
git switch -c release/next-<candidate> origin/main
pnpm prepare:release-pr -- --channel prerelease
pnpm install --frozen-lockfile
pnpm test:release-plan
pnpm test:release-workflows
pnpm typecheck
```

Changesets are reentrant via `.changeset/pre.json`. The five coupled workspaces retain Changesets fixed-group behavior and the three public packages must have one lockstep version. Commit the generated package versions, internal dependency changes, changelogs, lockfile, and prerelease state in the Release PR. Do not run preparation on `main`.

From the clean committed Release PR head, CI creates deterministic evidence from `git archive` rather than checkout residue:

```bash
pnpm prepare:release-candidate -- \
  --channel prerelease \
  --output /tmp/release/manifest.json \
  --artifacts /tmp/release/tarballs
sha256sum /tmp/release/manifest.json
pnpm verify:release-candidate -- \
  --manifest /tmp/release/manifest.json \
  --artifacts /tmp/release/tarballs \
  --channel prerelease \
  --version <X.Y.Z-next.N> \
  --commit <full-sha> \
  --manifest-sha256 sha256:<digest>
```

The manifest binds repository, channel, version/tag, full commit/tree, registry/dist-tag, lockfile, changesets, and each tarball filename/size/sha256/SRI. Publication may only download and re-hash these reviewed artifacts; it must never run `npm pack` in the deployment job.

## Exact one-time authorization

PR #49's one-hop protected annotated authorization tag, strict JSON, exact ancestry, mode-`100644` receipt blob, main containment, package intent, and fail-closed npm error rules remain the foundation. Schema v2 adds:

- repository and `prerelease`/`stable` channel;
- opaque 128-bit authorization ID;
- nonce digest and confirmation-reference digest, never their secret/plaintext source;
- issued/expiry with a maximum 30-minute lifetime;
- release tag/full commit/tree/manifest sha256;
- exact tarball filenames, sha256 and npm SRI;
- deterministic consumption ref identity and unused state.

The protected receipt ref is `npm-release-auth/<release-tag>/<authorization-id>`. The release tag does not exist yet: after receipt verification and Environment approval, the future workflow creates one annotated `vX.Y.Z-next.N` or `vX.Y.Z` tag targeting the exact dispatch SHA. Protected tag rules must reject move, overwrite, deletion and reuse.

## Prerelease transaction and reconciliation

The future activated `npm-prerelease` job uses only OIDC Trusted Publishing (`id-token: write`) and environment-scoped `contents: write` for consumption/release tags and the GitHub prerelease. It must not accept a token fallback. Staging is:

1. Verify explicit channel/version/full SHA/manifest sha256/authorization ID and nonce; verify exact main ancestry and protected receipt.
2. Reconcile all three exact npm versions. Auth/network/rate-limit/5xx/malformed output fails closed.
3. Create the consumption marker and exact annotated release tag.
4. Publish only absent reviewed `.tgz` files with provenance under a non-user-facing temporary tag unique to the version; never republish an exact existing version.
5. After every write, query the public registry and compare exact SRI. Record `PARTIAL_PUBLICATION` if interrupted.
6. Only after all three SRI values match, update all three `next` mappings. If that sequence is interrupted, reconciliation repairs only incorrect mappings after rechecking every package SRI.
7. Create the GitHub prerelease only after package and dist-tag reconciliation.
8. Clean-install exact versions from the public registry and run CLI/import smoke checks. Record `PUBLISHED` only after this passes.

`PARTIAL_PUBLICATION` is not success. `scripts/release-reconciliation.mjs` returns published-exact and missing sets; a protected resume publishes missing-only. Any existing version with different SRI, unknown package evidence, or unprovable state becomes `FAILED`. For prerelease, abandon that number and prepare `next.N+1`; do not overwrite or automatically retry. GitHub Release creation and dist-tag advancement remain prohibited while partial.

## Stable separation

Stable is not a mode switch on the prerelease deployment. `.github/workflows/npm-agent-stable.yml` has a separate input surface and future `npm-production` Environment. It accepts only `X.Y.Z`, targets `latest`, creates a non-prerelease GitHub Release, and permanently requires both owner exact confirmation and a non-Agent GitHub Environment approval.

Stable must reference the last immutable `CANARY_PASSED` prerelease manifest and canary receipt. `release/stable-promotion.json` and `scripts/verify-stable-promotion.mjs` restrict differences to version/changelog/release metadata. Any source difference requires a new Release PR, review, prerelease and canary; it cannot be called a promotion.

GHCR remains a separate workflow, Environment, digest and legal/redistribution decision. npm success never dispatches GHCR and a container is not part of this transaction.

## First bootstrap and activation blockers

None of these are complete merely because this PR merges:

- **Owner/product:** choose exact candidate, issue exact one-time confirmation, judge canary, and decide stable promotion.
- **Legal/product:** approve the exact npm contents; separately decide WeChat/container redistribution.
- **Repository admin:** create `npm-prerelease` and `npm-production` Environments, configure required reviewers so the Agent cannot approve its own deployment, protect release/auth/consumption tags, and approve minimal write permissions.
- **npm owner:** bootstrap package ownership if needed and bind each package's Trusted Publisher to the exact activated workflow. No long-lived token fallback is accepted.
- **Registry reconciliation:** the three `0.12.0-next.0` packages already exist and historical `next`/`latest` mappings require independent correction evidence. Stable must not proceed while `latest` is unexplained.
- **External integration:** implement authenticated owner-confirmation-to-receipt/nonce transfer without repository secrets or chat text.
- **Activation PR:** replace only the inactive deployment boundary with reviewed Environment/OIDC jobs and executable contract tests. Merging this implementation is not activation.

The first real prerelease additionally keeps GitHub Environment approval. Whether later prereleases may rely on owner exact confirmation without that GitHub approval is a later explicit owner decision; stable approval is permanent.
