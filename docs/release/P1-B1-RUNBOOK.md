# npm production release runbook

This runbook describes the maintained stable npm flow. It does not publish prereleases and
does not recover partial publication automatically.

## Immutable contract

- Public packages: `@kyan-du/agent-wechat-cli` and `@kyan-du/agent-wechat-openclaw`.
- Workflow: `.github/workflows/npm-release.yml`.
- Environment gate: `npm-production`.
- Input: exact stable `X.Y.Z` only.
- npm: public packages with provenance.
- GitHub: exact `vX.Y.Z` tag and final Release.

## Local validation

From a clean branch:

```bash
pnpm install --frozen-lockfile
pnpm test:prerelease-contract
pnpm test:npm-production-release
pnpm typecheck
pnpm -r --if-present test
pnpm turbo run build --filter='!@kyan-du/agent-wechat-docs'
pnpm test:npm-packages
git diff --check
```

## Platform setup before dispatch

1. `npm-production` Environment requires a human reviewer.
2. npm Trusted Publishing is configured for both public packages, bound to repository
   `kyan-du/agent-wechat`, workflow `.github/workflows/npm-release.yml`, and environment
   `npm-production`.
3. Repository settings allow GitHub Actions to create `vX.Y.Z` and the GitHub Release while
   preventing mutable release tags by ordinary users.
4. The exact version is already committed to both public package manifests on `main`.
5. CI has passed on the exact `main` commit to be dispatched.

## Dispatch

Manually run `npm production release` from `main` with the exact version. The workflow will:

1. confirm the dispatch SHA is the current `main`;
2. confirm successful CI evidence for that commit;
3. install, test, build, and pack;
4. wait at the `npm-production` approval gate;
5. publish `@kyan-du/agent-wechat-cli` then `@kyan-du/agent-wechat-openclaw` with provenance;
6. verify exact public registry versions by clean install/import;
7. create or verify `vX.Y.Z` and the GitHub Release.

## Interruption handling

Do not rerun blindly after a partial npm publication. npm versions are immutable; inspect the
public registry state manually and either choose a new version or perform a targeted operator
repair. The workflow intentionally does not contain an automatic reconciliation state machine.
