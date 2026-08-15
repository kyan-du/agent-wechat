# Fork-owned artifact identities

This document records the P1-A naming decision. It does not authorize a release.

## npm package inventory

| Workspace | Current fork identity | Publishable? | Evidence |
| --- | --- | --- | --- |
| `packages/cli` | `@kyan-du/agent-wechat-cli` | yes | no `private: true`; has `files`, `bin`, and public `publishConfig` |
| `packages/openclaw-extension` | `@kyan-du/agent-wechat-openclaw` | yes | no `private: true`; has `files` and public `publishConfig` |
| `packages/wechaty-puppet` | `@kyan-du/agent-wechat-wechaty-puppet` | yes | no `private: true`; has `files` and public `publishConfig` |
| root, docs, shared, Wechaty gateway, Rust server | fork-owned `@kyan-du/*` workspace names where scoped | no | root/docs/shared/gateway/server are explicitly private (or the root is private) |

The three public names follow npm's user-scope form and the GitHub fork owner,
`kyan-du`. Anonymous `npm view` returned `E404` for all three on 2026-08-15,
which proves that no public package is currently visible at those names but does
**not** prove availability or control. `npm whoami` returned `ENEEDAUTH`, so this
checkout has no non-destructive evidence that the maintainer controls the npm
`@kyan-du` scope.

**Decision gate:** do not publish until a maintainer authenticates to npm and
confirms `npm whoami` is `kyan-du` (and that the three package names are
available/controlled) during the separately reviewed P1-B first-publish process.
If that check fails, choose a verified fork-owned scope and migrate all names in
another reviewed change. Never fall back to upstream `@agent-wechat/*`.

## Container identity and immutable installs

The only fork image repository is `ghcr.io/kyan-du/agent-wechat`. Examples use a
version placeholder rather than `latest`:

```sh
docker pull ghcr.io/kyan-du/agent-wechat:<version>
docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/kyan-du/agent-wechat:<version>
docker run ghcr.io/kyan-du/agent-wechat@sha256:<digest>
```

Record both the version tag and resolved `sha256` digest in release/canary notes.
Deployments requiring reproducibility should use the digest form. P1-A does not
push an image, create a tag, or change release automation.
