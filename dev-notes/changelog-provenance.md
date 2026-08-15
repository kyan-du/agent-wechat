# Changelog identity boundary

Existing `CHANGELOG.md` entries retain upstream `@agent-wechat/*` headings, dependency
names, and `thisnick/agent-wechat` links as historical provenance. Do not rewrite them.

Future entries are generated from the renamed package manifests and
`.changeset/config.json`, whose GitHub changelog repository is
`kyan-du/agent-wechat`. The CLI release-boundary test guards both the fork repo and
fork package names so later Changesets output uses fork headings/dependencies/links.
