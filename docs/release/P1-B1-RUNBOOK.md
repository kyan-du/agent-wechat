# P1-B1 prerelease and rollback runbook

This document is a preparation checklist, not release authorization. P1-B1 is validation-only. Do not run any command in a **Publish-only** section until a separate publish-enablement PR has passed exact-head review, the repository owner has approved the exact manifest, legal/redistribution approval is recorded, npm Trusted Publishing and a protected release environment are configured, and the proposed image digest has been independently verified.

## Immutable contract

- The only prerelease identifier and npm dist-tag is `next`; never create or move `latest`.
- The three public packages are `@kyan-du/agent-wechat-cli`, `@kyan-du/agent-wechat-openclaw`, and `@kyan-du/agent-wechat-wechaty-puppet`.
- GHCR references use `ghcr.io/kyan-du/agent-wechat:<exact-next-version>` and are recorded with an immutable `@sha256:...` digest.
- PR, push, and manual-dispatch workflows remain read-only and cannot publish npm, push an image, create a tag, or create a GitHub Release.
- A manifest with `approvals.owner=false` or `approvals.legalRedistribution=false` is evidence only and must never be consumed by a publisher.

## Validation-only evidence

Run from a clean checkout of the exact proposed commit:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test:prerelease-contract
pnpm validate:prerelease
```

Build the proposed image without loading or pushing it. Use a clean Docker context and save its OCI descriptor digest from BuildKit metadata. This is still blocked until P1-C permits building the redistributed payload:

```bash
# Validation-only example after P1-C has approved all image inputs.
docker buildx build --platform linux/amd64 \
  --output type=oci,dest=/tmp/agent-wechat-amd64.oci.tar \
  --metadata-file /tmp/agent-wechat-amd64.metadata.json \
  -f docker/Dockerfile docker
jq -r '."containerimage.digest"' /tmp/agent-wechat-amd64.metadata.json
```

Generate a new, read-only evidence file with an explicit digest. The output path must not already exist:

```bash
node scripts/generate-prerelease-manifest.mjs \
  --image-digest sha256:<64-lowercase-hex> \
  --output /tmp/prerelease-manifest.json
```

Review package names, proposed `-next.N` versions, tarball filenames and SRI integrity, exact commit, lockfile hash, changeset hashes, image tag/digest, and both false approval fields. Do not treat a manifest as proof of npm ownership, legal clearance, registry upload, or remote availability.

## First prerelease

### Required human gates

1. Owner verifies the exact commit, manifest, package ownership, Trusted Publishing configuration, protected release environment, required reviewers, `next` dist-tag, and image digest.
2. Legal/redistribution reviewer approves upstream source licensing, bundled notices, dependency obligations, and WeChat redistribution for the exact npm/image contents.
3. Violet and Audrey submit exact-head formal approvals; the implementer does not self-approve.
4. Required CI is green and the manifest is regenerated from the same commit.

### Publish-only procedure

These commands are deliberately not present in any workflow or executable repository script. In a separately approved release environment, publish the three exact tarballs with the `next` dist-tag, push the exact versioned image, and verify every remote artifact by digest/integrity. Never create or move `latest`. Create a GitHub prerelease only if the separately approved plan requires one; attach no source/binaries until licensing permits it.

Record remote npm SRI values, `next` mappings, GHCR digest, GitHub run/release identifiers if any, actor, timestamps, and the manifest used.

## Upgrade validation

1. Install the prior known-good npm versions and run package smoke tests.
2. Upgrade all three public packages to the exact proposed `next` versions; do not resolve an unconstrained dist-tag in durable automation.
3. Run isolated low-risk canary checks and record the npm SRI and GHCR digest actually used.
4. Pull/run the image by digest, never by a floating tag.
5. Verify downgrade remains possible before expanding the canary.

## npm rollback and correction

Prefer non-destructive correction:

- Move `next` back to the previous known-good version; verify the remote mapping anonymously.
- Deprecate the bad exact version with a redacted, actionable message that points users to the known-good version.
- Do not move `latest` during prerelease response.

Use npm unpublish only if owner/legal explicitly approve it and npm policy permits it. Unpublish is destructive, time-limited, and can break consumers; record the reason, actor, exact package/version, and remote result. If unpublish is unavailable, retain the artifact, deprecate it, and correct `next`.

## GHCR rollback

1. Stop canary expansion.
2. Restore consumers to the previous known-good immutable digest.
3. Move only the version-specific prerelease tag if policy explicitly permits correction; otherwise publish a new corrected prerelease version. Never introduce `latest`.
4. Retain the bad digest for incident evidence unless owner/legal approve deletion; record all tag-to-digest mappings before and after.
5. Verify the previous digest can be pulled and started in the isolated canary environment.

## Failed first publish

If one npm package or image succeeds while another fails, stop immediately. Do not retry blindly and do not promote partial artifacts. Capture remote state, correct `next` to known-good/absent as appropriate, deprecate any partial npm version, and restore consumers to the previous GHCR digest. Open an incident record and require a new version plus a new exact manifest for retry.

## Boundaries after rollback

Rollback does not grant production approval. Repeat exact-head validation and P2 canary/rollback evidence. Main-account or production use remains blocked until all P0-D fixture-limited observations, P1-C legal/redistribution gates, and owner approval are complete.
