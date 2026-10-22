# Changelog

## [0.6.0](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.5.0...desktop-v0.6.0) (2026-10-22)


### Features

* **api:** run each request on a D1 session, ready for read replication ([8b17368](https://github.com/Fibteq-Inc/myrel/commit/8b17368c88e161d27efc570f478fc8d31f01efa5))
* **api:** run each request on a D1 session, ready for read replication ([a175ea3](https://github.com/Fibteq-Inc/myrel/commit/a175ea333dc69d5415b0f23fbaa914c5f3638874))
* harden plan limits, sign-up and a few endpoints before going public ([ff79e7c](https://github.com/Fibteq-Inc/myrel/commit/ff79e7ceb1ca7f78e226f049b66a4284cee9c089))
* open files agents mention in messages, by link or inline code ([44f8837](https://github.com/Fibteq-Inc/myrel/commit/44f8837b753aa1438a1d62bf91207facde5a54ef))

## [0.5.0](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.4.1...desktop-v0.5.0) (2026-10-22)


### Features

* **api:** wake the thread when its pull request starts to conflict ([c7c4d49](https://github.com/Fibteq-Inc/myrel/commit/c7c4d499cc279463ad7d42b9bc146a6bb240f5a8))
* continue a turn the runner's restart cut off, a bounded number of times ([2f9de59](https://github.com/Fibteq-Inc/myrel/commit/2f9de59c31925303d56448a9f71618165074d42b))
* **coordinator:** refuse duplicate threads and close mistaken ones ([d602a4b](https://github.com/Fibteq-Inc/myrel/commit/d602a4b256e6ef515b36a820e04ceab1b6679eeb))
* **coordinator:** refuse duplicate threads and close mistaken ones ([e07d6c5](https://github.com/Fibteq-Inc/myrel/commit/e07d6c5b2b4a9efc00cd733074f6fe10b4ef1486))

## [0.4.1](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.4.0...desktop-v0.4.1) (2026-10-22)


### Bug Fixes

* **desktop:** open external links in the default browser ([b07927c](https://github.com/Fibteq-Inc/myrel/commit/b07927ce0f82e2d722d8253aa677f26cd4bcbae9))
* **runner:** let Codex run approved MCP and app tools in agent runs ([3247cc8](https://github.com/Fibteq-Inc/myrel/commit/3247cc8cded45d784dc82a07cd4ac7b8b2960b09))

## [0.4.0](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.3.0...desktop-v0.4.0) (2026-10-22)


### Features

* **chat:** note plan changes at the end of the conversation ([d5454dd](https://github.com/Fibteq-Inc/myrel/commit/d5454dde8692149b0a7deb6ab06081f28d439aed))
* let people open what the coordinator sent a thread ([9e865bd](https://github.com/Fibteq-Inc/myrel/commit/9e865bd06275bec401305f4d4d8eb6a2a75be037))

## [0.3.0](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.2.1...desktop-v0.3.0) (2026-10-22)


### Features

* **chat:** open the whole plan from the pinned progress line ([ae133c4](https://github.com/Fibteq-Inc/myrel/commit/ae133c4f30640f26492b46d3281face05668da6d))
* **chat:** open the whole plan from the pinned progress line ([b36fd8e](https://github.com/Fibteq-Inc/myrel/commit/b36fd8eaa48fd72006bee47fc2f210b084ef27fa))

## [0.2.1](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.2.0...desktop-v0.2.1) (2026-10-22)


### Bug Fixes

* **desktop:** sign macOS releases again and write full release notes ([c7943a8](https://github.com/Fibteq-Inc/myrel/commit/c7943a897843c1a1fde6d5de5dae658193767947))
* **desktop:** sign macOS releases again and write full release notes ([8238957](https://github.com/Fibteq-Inc/myrel/commit/823895701f8ad1c30cf12c2dcfe394e9e69ec55f))

## [0.2.0](https://github.com/Fibteq-Inc/myrel/compare/desktop-v0.1.0...desktop-v0.2.0) (2026-10-22)


### Features

- feat(connectors): thread agent offers a connector as a card in the thread ([#133](https://github.com/Fibteq-Inc/myrel/pull/133))
- feat(billing): sell Pro in the mobile app (App Store, Google Play via RevenueCat) ([#110](https://github.com/Fibteq-Inc/myrel/pull/110))

### Changes

- Sandbox agent: use its folders, clone over HTTPS, show what it waits on ([#113](https://github.com/Fibteq-Inc/myrel/pull/113))
- Sandbox: prebuilt image, repo work kept on GitHub, merges settled without a turn ([#115](https://github.com/Fibteq-Inc/myrel/pull/115))
- Plan before work, faster clones, readable git progress, sandbox start breakdown ([#116](https://github.com/Fibteq-Inc/myrel/pull/116))
- Remind OpenCode of its active plan step between tool calls ([#120](https://github.com/Fibteq-Inc/myrel/pull/120))
- Show a project's model cost on its card ([#123](https://github.com/Fibteq-Inc/myrel/pull/123))
- Verify emails, keep local runs to the computer's owner, bind connector sign-ins ([#125](https://github.com/Fibteq-Inc/myrel/pull/125))
- Fix ServerInfo tests after email verification ([#127](https://github.com/Fibteq-Inc/myrel/pull/127))
- Open projects without a connection flash and keep long conversations fast ([#128](https://github.com/Fibteq-Inc/myrel/pull/128))
- Send email from the onboarded mail.fibteq.app domain ([#129](https://github.com/Fibteq-Inc/myrel/pull/129))
- Connector catalog from the official MCP Registry ([#130](https://github.com/Fibteq-Inc/myrel/pull/130))
- Connector catalog: categories, recommended Fibteq connectors, wider page ([#131](https://github.com/Fibteq-Inc/myrel/pull/131))
- Security fixes from the Codex review (13 findings + 3 follow-ups) ([#132](https://github.com/Fibteq-Inc/myrel/pull/132))
- Harden workflows and self-host docs before going public ([#136](https://github.com/Fibteq-Inc/myrel/pull/136))
- Show CLI versions and subscription limits on the Devices page ([#138](https://github.com/Fibteq-Inc/myrel/pull/138))
- Credit thread pull requests and open them through the GitHub App ([#137](https://github.com/Fibteq-Inc/myrel/pull/137))
- Compact answered cards and keep thread PRs on the GitHub App ([#140](https://github.com/Fibteq-Inc/myrel/pull/140))
- Project tabs: only the selected tab shows its name ([#142](https://github.com/Fibteq-Inc/myrel/pull/142))
- runner: start Claude Code without the 30s wait on the person's own MCP servers ([#141](https://github.com/Fibteq-Inc/myrel/pull/141))
- Add an auto access level that runs Claude Code in auto mode ([#143](https://github.com/Fibteq-Inc/myrel/pull/143))
- Local runs survive deploys; clearer Codex terminal ([#144](https://github.com/Fibteq-Inc/myrel/pull/144))
- Fix open_pull_request's token scope; only connect repos the person can reach ([#145](https://github.com/Fibteq-Inc/myrel/pull/145))
