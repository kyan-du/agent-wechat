# Security policy

## Supported versions

Only the latest release of the `kyan-du/agent-wechat` fork is eligible for
security fixes. Upstream versions and artifacts are supported by their upstream
maintainers. This project automates a desktop WeChat client and is not an
official Tencent product.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for this repository:

<https://github.com/kyan-du/agent-wechat/security/advisories/new>

Include affected commit/version, platform and architecture, a minimal
reproduction, impact, and any suggested mitigation. Remove tokens, account
identifiers, message contents, QR codes, databases, and other personal data from
reports and logs.

Maintainers aim to acknowledge a report within 7 days and provide a status
update within 14 days. These are response targets, not guarantees. Coordinated
disclosure timing will be agreed with the reporter after impact is understood.

## Operational precautions

- Treat WeChat session data, the SQLite database, VNC credentials, API tokens,
  and OpenClaw configuration as secrets.
- Bind local control endpoints narrowly and do not expose VNC/API ports directly
  to the public Internet.
- Pin release versions or image digests; do not use `latest` in production.
- Test upgrades with a non-critical account and retain a rollback artifact.
- Never attach production databases or unredacted logs to public issues.
