# Security policy

## Reporting a vulnerability

Please do not report security issues in public issues, discussions or pull
requests.

Report them privately through GitHub:
[Report a vulnerability](https://github.com/Fibteq-Inc/myrel/security/advisories/new).
If you cannot use GitHub, email **security@fibteq.com**.

Include what you found, how to reproduce it, and what an attacker could do
with it. A proof of concept helps.

We will:

- confirm we received your report within 3 working days;
- tell you whether we can reproduce it and how we plan to fix it within 10 working days;
- keep you informed until it is fixed, and credit you in the advisory if you want.

Please give us a reasonable time to release a fix before you disclose the
issue publicly. We aim to fix critical issues within 30 days.

## Supported versions

Myrel is pre-1.0. Only the latest commit on `main` and the latest release get
security fixes.

## Scope

In scope: this repository, including the API Worker, the Durable Objects, the
web app, the shared packages and the default deployment configuration.

Of particular interest:

- authentication, sessions and access to projects you are not a member of;
- prompt injection that makes an agent act on text from outside the user
  (relayed messages, uploaded files, web pages, GitHub content);
- leaking secrets or model keys to clients or to model providers;
- isolation between projects and between threads.

Out of scope: issues in Cloudflare, model providers or other third-party
services themselves (report those to the vendor), denial of service through
volume alone, and findings that need a compromised Cloudflare account or a
malicious server operator.

## For self-hosters

- Keep `BETTER_AUTH_SECRET` and model keys as Worker secrets, never in
  `wrangler.jsonc` or Git.
- Leave `SIGNUP_ENABLED` off on public servers unless you mean to allow open
  registration. If you open it, set up
  [Turnstile](docs/self-hosting.md#sign-up-protection-turnstile) on sign-up.
- Only list origins you control in `TRUSTED_ORIGINS`.
