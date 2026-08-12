# Maintainer guide (kyan-du fork)

This fork is maintained as a conservative downstream of
[`thisnick/agent-wechat`](https://github.com/thisnick/agent-wechat). It does not
change or write to the upstream repository.

## Upstream synchronization

Remotes in maintainer clones should be:

- `origin`: `git@github.com:kyan-du/agent-wechat.git`
- `upstream`: `https://github.com/thisnick/agent-wechat.git`

Synchronize through a pull request, never by force-pushing `main`:

```sh
git fetch upstream --tags
git switch -c sync/upstream-YYYYMMDD origin/main
git merge --ff-only upstream/main
git push -u origin sync/upstream-YYYYMMDD
```

If the fast-forward fails, stop and review downstream commits. Rebase or merge
on the sync branch, run all CI checks, summarize upstream commits and conflicts,
then merge the PR. Preserve upstream tags unchanged; downstream releases use new
tags.

## Downstream versions and artifacts

Until npm organization ownership is confirmed, do **not** publish under the
upstream-owned `@agent-wechat` scope. Proposed downstream package names are:

- `@kyan-du/agent-wechat-cli`
- `@kyan-du/agent-wechat-openclaw`
- `@kyan-du/agent-wechat-wechaty-puppet`

Before any publication, confirm the npm scope, update package names and all
internal references in one reviewed PR, and configure npm trusted publishing for
this repository. Use versions of the form `0.11.15-kyan.1` while downstream is
based on upstream `0.11.15`; increment the suffix for downstream-only releases.
When adopting a newer upstream version, reset the base and suffix (for example,
`0.12.0-kyan.1`). Git tags should be `v0.11.15-kyan.1`.

Container images belong under `ghcr.io/kyan-du/agent-wechat` and must initially
be published with an immutable candidate tag such as `0.11.15-kyan.1-rc.1`.
Do not move `latest` until a candidate passes the documented smoke test and a
maintainer explicitly approves promotion.

## Release controls

The inherited release workflow is manual-only in this fork. A formal release PR
must:

1. synchronize and record the exact upstream commit;
2. pass TypeScript build/typecheck/tests and Rust check/tests;
3. verify package tarballs (`pnpm pack --dry-run` or equivalent);
4. build both container targets without pushing;
5. include release notes, rollback instructions, and an approval for npm/GHCR;
6. use a protected release environment and trusted publishers configured for
   this repository.

Never reuse upstream npm credentials, names, tags, or trusted-publisher setup.

## Dependency updates

Dependabot opens monthly grouped npm, Cargo, GitHub Actions, and Docker updates.
Merge dependency PRs only after lockfile review and the full CI matrix. Keep
security updates separate when they require urgent review. Avoid unattended
automerges for OpenClaw, WeChat automation, database, crypto, and container base
image changes.

## Local verification

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm -r --if-present test
cargo check --locked --manifest-path packages/agent-server-rust/Cargo.toml
cargo test --locked --manifest-path packages/agent-server-rust/Cargo.toml
```

There is currently no repository-level lint script. CI reports that fact rather
than silently substituting a formatter for a linter.
