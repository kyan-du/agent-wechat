# Formal npm release preparation and rollback runbook

This repository has one target npm release product: formal stable `X.Y.Z` under `latest`, with a final GitHub Release. There is no npm prerelease product flow. Historical `next` validation remains inert evidence only and must not be activated.

Phase 1 is validation-only. Do not create a tag, publish, move `latest`, create a Release, configure Trusted Publishing, or enable write permissions until a separate owner-authorized activation PR passes exact-head review and every blocker in `AGENT-OPERATED-RELEASE.md` has evidence.

## Immutable contract

- Public packages: CLI, OpenClaw extension and Wechaty Puppet; one lockstep stable version.
- Publisher: `.github/workflows/npm-release.yml` bound to `npm-production`.
- Identity: exact `X.Y.Z`, `vX.Y.Z`, full commit/tree, manifest sha256 and three tarball sha256/SRI values.
- npm: `latest` only. `next` and `-next.N` are rejected by the formal publisher.
- GitHub: final non-prerelease Release only.
- GHCR remains separate and cannot be triggered by npm success.

## Validation

From a clean isolated branch:

```bash
pnpm install --frozen-lockfile
pnpm prepare:release-pr
pnpm test:release-plan
pnpm test:release-workflows
pnpm test:prerelease-contract
pnpm typecheck
pnpm -r --if-present test
pnpm turbo run build --filter='!@kyan-du/agent-wechat-docs'
git diff --check
```

From the committed exact Release PR head:

```bash
node scripts/prepare-agent-release.mjs \
  --output /tmp/release/manifest.json \
  --artifacts /tmp/release/tarballs
node scripts/verify-agent-release.mjs \
  --manifest /tmp/release/manifest.json \
  --artifacts /tmp/release/tarballs \
  --version <X.Y.Z> \
  --commit <full-sha> \
  --manifest-sha256 sha256:<digest>
```

Generate twice and compare the complete manifest/tarball set byte-for-byte. Deployment may consume only the uploaded sealed artifact identified by version + full SHA + manifest digest and the producer artifact ID/digest/run.

## Owner authorization

The owner confirms exact repository, stable version/tag, commit/tree, manifest digest, `latest`, every package/tarball integrity, authorization ID, nonce and expiry. A reconciliation run needs a new confirmation bound to the exact reconciliation receipt digest. No owner chat text, token, nonce plaintext or npm credential enters the repository or logs.

## Activation blockers

- npm ownership and Trusted Publisher for each package, all bound to the exact workflow and `npm-production`.
- protected `npm-production` Environment with non-Agent required reviewer.
- protected release/auth/consumption tag rules.
- authenticated external one-time atomic consume/CAS.
- npm/Sigstore provenance verifier for existing-version recovery.
- authenticated owner confirmation integration.
- independent reconciliation of historical `0.12.0-next.0`, `next` and `latest`; use a new absent stable version.
- legal/product approval of exact npm bytes.
- separate exact-head activation PR.

## Non-atomic publish recovery

Stop on every ambiguity. A fresh release requires all exact versions absent. If interrupted:

1. Query every package and verify exact SRI plus provenance.
2. Obtain a new reconciliation authorization.
3. Publish missing tarballs only; zero missing is valid.
4. Repair only `latest` mappings that differ after all package evidence matches.
5. Create or verify the final GitHub Release only after `latest` reconciliation.
6. Clean-install exact registry versions and smoke.

Never overwrite or republish an existing stable version. Integrity/provenance/Release drift requires owner incident review and a new version when appropriate.

## Rollback

Prefer non-destructive correction. Move `latest` back to the last independently verified stable version, deprecate the bad exact version with an actionable message, and verify remote mappings and clean install. Unpublish requires separate owner/legal approval and npm policy eligibility. Rollback does not authorize production runtime or GHCR/WeChat redistribution.
