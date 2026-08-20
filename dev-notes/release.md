# Release process boundary

The fork's intended release artifacts are:

1. `@kyan-du/agent-wechat-cli`
2. `@kyan-du/agent-wechat-openclaw`
3. `@kyan-du/agent-wechat-wechaty-puppet`
4. `ghcr.io/kyan-du/agent-wechat`

See [publishable-artifacts.md](./publishable-artifacts.md) for the complete
workspace inventory, npm ownership decision gate, and digest-aware image usage.

No artifact may be published until the npm `@kyan-du` ownership gate is passed,
P1-B defines and reviews the prerelease workflow/provenance and approval steps,
and P1-C completes the redistribution review. Initial releases must not move
`latest`; record the exact commit, package tarball identities, image version and
immutable image digest. This P1-A migration intentionally does not modify the
inherited release workflow.
