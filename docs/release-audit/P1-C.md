# P1-C release licensing and redistribution audit

Audit lineage began at `24a3d6843e627a061f0dd52ee66a8448837efaf7`; evidence is regenerated from the checked-out tree and exact lockfile on 2026-08-15. This is an engineering inventory, not legal advice. **No release artifact is cleared while any blocker below remains.**

## Deterministic release-artifact conclusions

| Artifact | Included material | Evidence and obligations | Conclusion |
|---|---|---|---|
| npm CLI | project/shared code, bundled commander/zod, external qrcode-terminal, and `dist/device_identity.py` | Repository and all three public package manifests contain no `license`; repository has no `LICENSE`/`NOTICE`. No authoritative grant from the upstream copyright holder was found in repository history or GitHub's license endpoint (404). Bundling also makes dependency notices a release input. | **BLOCKED**: obtain/document an authoritative source-code license, add package license metadata and ship the applicable license/notices. |
| npm OpenClaw extension | project/shared code, bundled zod/qrcode-terminal, `openclaw.plugin.json`; OpenClaw is external | Same absent upstream grant. | **BLOCKED** for the same reason. |
| npm Wechaty puppet | project/shared code and bundled zod; peer `wechaty-puppet` and runtime `file-box` remain external | Same absent upstream grant. | **BLOCKED** for the same reason. |
| GHCR runtime image | project Rust binary/tools, Ubuntu packages, noVNC, websockify/frida/silk Python packages, SQLCipher CLI plus vendored SQLCipher/OpenSSL in Rust, and proprietary WeChat | Base/package licenses must be captured from the exact built image. noVNC v1.5.0 is mixed-license (MPL-2.0 core plus BSD-2-Clause/OFL-1.1/CC-BY-SA-3.0 assets and embedded components) per its tagged `LICENSE.txt`; SQLCipher v4.6.1 is BSD-3-Clause per tagged `LICENSE.md`, requiring the notice in binary redistribution materials. The Dockerfile neither pins base images by digest nor retains these notices. WeChat is downloaded from Tencent but no authoritative redistribution terms/version/hash are recorded. | **BLOCKED**: no image publication. Resolve every condition below and generate an exact-image SBOM/license report. |
| source archive / GitHub release attachment | repository source | No repository license/grant. GitHub-generated archives are hosting conveniences, not evidence of redistribution permission. | **BLOCKED**: do not attach or describe source as redistributable until an authoritative grant exists. |

Private workspaces (`agent-server`, `shared`, `wechaty-gateway`, root/docs) are not npm release artifacts. If P1-A changes `private`, names, `files`, build output, or image identity, rerun this audit against that exact commit.

## Authoritative evidence

* Upstream source: `https://github.com/thisnick/agent-wechat` license API returned 404; this fork also has no detected license. Absence of a license means no redistribution permission is inferred.
* noVNC: tagged source `https://github.com/novnc/noVNC/blob/v1.5.0/LICENSE.txt` (the Dockerfile fetches that tag). Preserve the complete tagged distribution and notices; review MPL source-availability and asset attribution/share-alike duties before shipping.
* SQLCipher: tagged source `https://github.com/sqlcipher/sqlcipher/blob/v4.6.1/LICENSE.md`. Binary distributions must reproduce its copyright, conditions, and disclaimer in documentation/materials.
* WeChat: payload URL `https://dldir1v6.qq.com/weixin/Universal/Linux/WeChatLinux_{x86_64,arm64}.deb` proves origin only. It is mutable, unhashed, unversioned in the build, and is not a redistribution grant.
* `rust:1.93-bookworm` and `ubuntu:22.04` are mutable tags. Their exact digest and installed package set cannot be concluded from source alone.

## Release blockers

1. Written, authoritative licensing provenance for upstream project code and the fork's right to redistribute it; then an approved root `LICENSE`/`NOTICE` and matching package metadata.
2. WeChat terms that explicitly permit the intended third-party container redistribution. If permission cannot be established, redesign release artifacts to require user-side acquisition; a Tencent download URL alone is insufficient.
3. Pin every base image and remote input by immutable digest/hash. Record WeChat package version, SHA-256, architecture and retrieval source without committing its binary/cache.
4. Preserve complete noVNC and SQLCipher notices in the image and release materials; establish and satisfy noVNC's file-level mixed-license obligations.
5. Produce an SBOM and license report from each exact final multi-arch image, including apt, pip, Rust/vendored C/OpenSSL, noVNC/web assets, SQLCipher and WeChat package contents. Review all `NOASSERTION`, unknown and copyleft entries.
6. Produce dependency license evidence for the exact npm lock/build graph and include notices required by code bundled by esbuild.
7. P1-A release identities/manifests are not final. Re-run `scripts/audit-release.sh` after its merge and review the resulting tarball lists before release approval.

## Required exclusions

The npm check fails on binaries, archives, native libraries, source maps, environment names, credential/secret/token substrings, bounded key/certificate filename categories, QR/image captures, databases, logs, caches, fixtures, coverage and temporary paths. `docker/.dockerignore` now explicitly excludes local `wechat.deb`/other debs, environment and credential-like files, databases, captures, caches, logs and test tools. This intentionally removes the prior local-payload build path from release context; local builds must use the Dockerfile download path. `.gitignore` is not treated as Docker-context protection. CI must build from a clean checkout and verify `git status --porcelain` is empty. Runtime volumes (`/data`, `/home/wechat`) and their credentials, QR codes, databases, media/cache/local state are never image or release inputs.

## Reproduction

Run `corepack pnpm install --frozen-lockfile`, build the three public packages, then `scripts/audit-release.sh`. The script obtains the complete workspace inventory from pnpm, audits every non-private workspace, and compares it with the explicit expected release set so drift fails closed. It validates all declared `bin`/`main`/`types`/`exports` and positive `files` entries against `npm pack --dry-run --json`, rejects forbidden paths, and requires exact-build metafiles. `scripts/test-release-audit.sh` performs a clean positive build/pack check, a missing-CLI-build negative check, and per-public-package sensitive-filename probes (including `mysecret.txt`, `mycredential.txt`, and `mytoken.txt`) that verify even `--write` fails closed. CI and release validation regenerate the committed inventory, require zero diff, and enforce clean-tree checks. Rebase/rerun after P1-A PR #17; this PR deliberately does not rename release identities.

## Exact evidence model

`npm-materials.json` is generated from the exact `pnpm-lock.yaml`, package manifests, dry-run tarball manifests, and esbuild metafiles. It records packed paths plus bundled, external runtime, peer, and dev dependencies with resolved version/license metadata. In particular: CLI bundles commander and zod, leaves qrcode-terminal external, and ships project file `dist/device_identity.py`; OpenClaw bundles zod and qrcode-terminal; Wechaty puppet bundles zod while file-box is external and wechaty-puppet is a peer. `NOASSERTION` is a blocker, not a permissive conclusion. MIT components (commander/zod) require preservation of their license notice; Apache-2.0 components (file-box/wechaty-puppet) require license/notice handling. The repository currently ships none of these notices, so npm release remains blocked.

The committed inventory describes the tree content, not a self-referential commit SHA. CI proves the exact audited head by regenerating it and requiring a zero diff. The GitHub Actions run and head SHA are the external immutable evidence pair.
