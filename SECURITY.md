# Security policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions
or pull requests.**

Report them privately through GitHub's private vulnerability reporting: open
the repository's **Security** tab and choose **Report a vulnerability**, or go
directly to
<https://github.com/jrimmer/hrmny/security/advisories/new>.

The report is visible only to you and the maintainers. We will discuss it,
develop a fix and, where appropriate, publish a security advisory and request
a CVE there.

### What to include

The more of this you can give, the faster we can act:

- the affected component (server, web app, desktop, mobile, terminal client,
  SSH host, the Discord-compatible API, the Docker images or compose kit) and
  the version or commit;
- the kind of issue (for example authentication bypass, permission escalation
  across workspaces or channels, cross-site scripting, server-side request
  forgery, injection, information disclosure, denial of service);
- step-by-step reproduction, with any proof-of-concept code, requests or
  configuration needed;
- the impact as you understand it: what an attacker can do, and which
  preconditions they need (an account, a workspace role, a bot credential, a
  network position);
- any suggested fix or mitigation.

Test only against a deployment you run yourself. Do not access, modify or
delete other people's data, and do not degrade a service other people rely on.

## What to expect

These are targets, not guarantees; Hrmny is maintained by volunteers.

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 working days |
| Initial assessment (confirmed or not, and severity) | within 10 working days |
| Fix for a confirmed critical or high-severity issue | as fast as possible, normally within 30 days |
| Fix for a medium or low-severity issue | normally within 90 days |

We will keep you informed while we work on it, and credit you in the
advisory unless you prefer to stay anonymous.

## Supported versions

Security fixes are made on `main` and ship in the next release and in the
`latest` container images (`ghcr.io/jrimmer/hrmny`,
`ghcr.io/jrimmer/hrmny-ssh-host`). Only the latest release and the current
`main` are supported; older versions do not receive backported fixes, so
self-hosters should stay current (see
[docs/self-hosting.md](docs/self-hosting.md) for upgrading).

| Version | Supported |
|---|---|
| Latest `main` / latest release | Yes |
| Anything older | No |

## Disclosure policy

We follow coordinated disclosure:

1. You report privately, as above.
2. We confirm the issue, prepare a fix, and agree a disclosure date with you.
3. We release the fix, then publish the advisory with details and credit.

Please give us a reasonable time to ship a fix before disclosing publicly.
We aim to publish within 90 days of the report, or sooner once a fix is
released; if a fix needs longer, we will tell you why and agree a new date.
If a vulnerability is already being exploited or publicly known, we will move
faster and may publish an advisory with mitigations before a full fix.

## Scope

In scope: the code in this repository and the container images built from it.
Security issues in third-party dependencies are welcome too; if the problem
is in the dependency itself, please also report it upstream.

Out of scope: vulnerabilities in a particular deployment's own configuration
(its host, proxy, mail or DNS setup), social engineering, and reports from
automated scanners without a demonstrated impact.
