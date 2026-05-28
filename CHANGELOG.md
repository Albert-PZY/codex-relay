# Changelog

## [0.8.3](https://github.com/Albert-PZY/codex-relay/compare/v0.8.2...v0.8.3) (2026-05-28)


### Bug Fixes

* recover context overflow sessions ([4f72f59](https://github.com/Albert-PZY/codex-relay/commit/4f72f596f25d736479a55857fd3cfe2c1058cb33))

## [0.8.2](https://github.com/Albert-PZY/codex-relay/compare/v0.8.1...v0.8.2) (2026-05-28)


### Bug Fixes

* refresh sessions before relay rotation ([#63](https://github.com/Albert-PZY/codex-relay/issues/63)) ([1d50f27](https://github.com/Albert-PZY/codex-relay/commit/1d50f275d78f664f1cab390b993741f57ea2ce36))

## [0.8.1](https://github.com/Albert-PZY/codex-relay/compare/v0.8.0...v0.8.1) (2026-05-27)


### Bug Fixes

* avoid rotation during mcp startup ([acf59b5](https://github.com/Albert-PZY/codex-relay/commit/acf59b5fb265db1eb9c35324a57224e0b8f33b8d))

## [0.8.0](https://github.com/Albert-PZY/codex-relay/compare/v0.7.0...v0.8.0) (2026-05-27)


### Features

* harden relay credential cooldowns ([1783ebf](https://github.com/Albert-PZY/codex-relay/commit/1783ebf7ffb3dfedefcf9fb6f655ca75fe6c67fb))

## [0.7.0](https://github.com/Albert-PZY/codex-relay/compare/v0.6.10...v0.7.0) (2026-05-25)


### Features

* add diagnostics and workspace resume controls ([46aa1f3](https://github.com/Albert-PZY/codex-relay/commit/46aa1f3a0d6d273d6e5801faabf2e4f96d525c14))

## [0.6.10](https://github.com/Albert-PZY/codex-relay/compare/v0.6.9...v0.6.10) (2026-05-25)


### Bug Fixes

* write structured rotation logs ([f965a7b](https://github.com/Albert-PZY/codex-relay/commit/f965a7b92cd8229d36769aed1ce6f0503fb25372))

## [0.6.9](https://github.com/Albert-PZY/codex-relay/compare/v0.6.8...v0.6.9) (2026-05-25)


### Bug Fixes

* show relay account during resumed sessions ([e78af27](https://github.com/Albert-PZY/codex-relay/commit/e78af275180b539e0f7c9536957b0e548cd55c6f))

## [0.6.8](https://github.com/Albert-PZY/codex-relay/compare/v0.6.7...v0.6.8) (2026-05-25)


### Bug Fixes

* bind rotation recovery to explicit sessions ([c6d915a](https://github.com/Albert-PZY/codex-relay/commit/c6d915a0efcf51b4f0d82c572010b5095e68184d))

## [0.6.7](https://github.com/Albert-PZY/codex-relay/compare/v0.6.6...v0.6.7) (2026-05-23)


### Bug Fixes

* keep rotation fallback alive ([7354f43](https://github.com/Albert-PZY/codex-relay/commit/7354f4382525189f48f3a92b60004005f1186377))

## [0.6.6](https://github.com/Albert-PZY/codex-relay/compare/v0.6.5...v0.6.6) (2026-05-23)


### Bug Fixes

* resume interrupted sessions after rotation ([d5b3a94](https://github.com/Albert-PZY/codex-relay/commit/d5b3a94c16046473541a4570bc29cbd6bbe4b166))

## [0.6.5](https://github.com/Albert-PZY/codex-relay/compare/v0.6.4...v0.6.5) (2026-05-23)


### Bug Fixes

* rotate on disabled relay keys ([d1ab5b1](https://github.com/Albert-PZY/codex-relay/commit/d1ab5b18c3bc2e4b21497fe2fa89c21398cc18bc))

## [0.6.4](https://github.com/Albert-PZY/codex-relay/compare/v0.6.3...v0.6.4) (2026-05-22)


### Bug Fixes

* auto-repair duplicate local state files ([6328ecf](https://github.com/Albert-PZY/codex-relay/commit/6328ecf8bb56951bcd3a8baa2cb953e554d014e9))

## [0.6.3](https://github.com/Albert-PZY/codex-relay/compare/v0.6.2...v0.6.3) (2026-05-21)


### Bug Fixes

* add rotation log and preserve resume order ([d5b9e51](https://github.com/Albert-PZY/codex-relay/commit/d5b9e5113a57e38ecf5a6a0cfac6cdc4c4950978))

## [0.6.2](https://github.com/Albert-PZY/codex-relay/compare/v0.6.1...v0.6.2) (2026-05-21)


### Bug Fixes

* reuse codex home for relay runs ([aca8c83](https://github.com/Albert-PZY/codex-relay/commit/aca8c83fed18280ee1ca42377fb09ee5558954a2))

## [0.6.1](https://github.com/Albert-PZY/codex-relay/compare/v0.6.0...v0.6.1) (2026-05-20)


### Performance Improvements

* slim runtime state and dependencies ([5707569](https://github.com/Albert-PZY/codex-relay/commit/570756913cb210ee0da4cfecc5fc87c308e5129b))

## [0.6.0](https://github.com/Albert-PZY/codex-relay/compare/v0.5.0...v0.6.0) (2026-05-20)


### Features

* coordinate concurrent relay sessions ([93e9eba](https://github.com/Albert-PZY/codex-relay/commit/93e9ebafa42bd0c03f3e16cf8b882abed40d55cf))

## [0.5.0](https://github.com/Albert-PZY/codex-relay/compare/v0.4.1...v0.5.0) (2026-05-20)


### Features

* add bilingual cli help ([#30](https://github.com/Albert-PZY/codex-relay/issues/30)) ([146a1f2](https://github.com/Albert-PZY/codex-relay/commit/146a1f23ff775b118fcdc9f35d93747066465891))

## [0.4.1](https://github.com/Albert-PZY/codex-relay/compare/v0.4.0...v0.4.1) (2026-05-20)


### Bug Fixes

* create relay codex home before launch ([#28](https://github.com/Albert-PZY/codex-relay/issues/28)) ([b10aa53](https://github.com/Albert-PZY/codex-relay/commit/b10aa533492114262ab9d26840abfc9bd4998384))

## [0.4.0](https://github.com/Albert-PZY/codex-relay/compare/v0.3.5...v0.4.0) (2026-05-20)


### Features

* show active relay account ([#26](https://github.com/Albert-PZY/codex-relay/issues/26)) ([882f3fa](https://github.com/Albert-PZY/codex-relay/commit/882f3fa386b4995fd3121fd2e7767b2d8a4d0b9e))

## [0.3.5](https://github.com/Albert-PZY/codex-relay/compare/v0.3.4...v0.3.5) (2026-05-20)


### Bug Fixes

* rotate on payload limit failures ([#24](https://github.com/Albert-PZY/codex-relay/issues/24)) ([89fa26c](https://github.com/Albert-PZY/codex-relay/commit/89fa26c9b0039d28a8c940b7fba05e9199aaa6a5))

## [0.3.4](https://github.com/Albert-PZY/codex-relay/compare/v0.3.3...v0.3.4) (2026-05-20)


### Bug Fixes

* resolve codex npm shim on windows ([#20](https://github.com/Albert-PZY/codex-relay/issues/20)) ([8d2999b](https://github.com/Albert-PZY/codex-relay/commit/8d2999b899a76c39ec18c199758589225a632689))

## [0.3.3](https://github.com/Albert-PZY/codex-relay/compare/v0.3.2...v0.3.3) (2026-05-19)


### Bug Fixes

* report codex-relay version ([87746ac](https://github.com/Albert-PZY/codex-relay/commit/87746ac03d5e89df2254de8cc17640566ab908a0))

## [0.3.2](https://github.com/Albert-PZY/codex-relay/compare/v0.3.1...v0.3.2) (2026-05-19)


### Bug Fixes

* stabilize interactive codex terminal handling ([188037c](https://github.com/Albert-PZY/codex-relay/commit/188037c719b450dc4e6f53a21ae1cc962cdfc45b))

## [0.3.1](https://github.com/Albert-PZY/codex-relay/compare/v0.3.0...v0.3.1) (2026-05-19)


### Bug Fixes

* extend health retirement window ([8f80aa7](https://github.com/Albert-PZY/codex-relay/commit/8f80aa7dd9e259d5756dadd24f30b216e4db406f))
* extend health retirement window ([25d4bd8](https://github.com/Albert-PZY/codex-relay/commit/25d4bd880159e91e5872eea8fcd5cf6f67b94d3b))

## [0.3.0](https://github.com/Albert-PZY/codex-relay/compare/v0.2.4...v0.3.0) (2026-05-19)


### Features

* track runtime relay health ([fb235f2](https://github.com/Albert-PZY/codex-relay/commit/fb235f2c78ab9a30027b6a2c3cc3d6aea6cd710b))
* track runtime relay health ([a2828fc](https://github.com/Albert-PZY/codex-relay/commit/a2828fc05e993824eec23348c88162343188c9d3))

## [0.2.4](https://github.com/Albert-PZY/codex-relay/compare/v0.2.3...v0.2.4) (2026-05-19)


### Bug Fixes

* treat unsupported relay test endpoint as unknown ([61b9081](https://github.com/Albert-PZY/codex-relay/commit/61b90810066cefc4039fdc2ccef33de73fd57b42))
* treat unsupported relay test endpoint as unknown ([ac299b2](https://github.com/Albert-PZY/codex-relay/commit/ac299b2a3425cb4e187d3440171b41513c54e9e6))

## [0.2.3](https://github.com/Albert-PZY/codex-relay/compare/v0.2.2...v0.2.3) (2026-05-19)


### Bug Fixes

* forward terminal input to codex process ([7630f30](https://github.com/Albert-PZY/codex-relay/commit/7630f30bda6b374800f3005f787111a89417e99a))
* forward terminal input to codex process ([0fbad23](https://github.com/Albert-PZY/codex-relay/commit/0fbad23e16a8a8ead8ff761edfc80dcfda576223))

## [0.2.2](https://github.com/Albert-PZY/codex-relay/compare/v0.2.1...v0.2.2) (2026-05-19)


### Bug Fixes

* keep exec mode when resuming after rotation ([4c23a90](https://github.com/Albert-PZY/codex-relay/commit/4c23a90bf059592d7582b2deb25ec40ed23ce57a))
* keep exec mode when resuming after rotation ([0573116](https://github.com/Albert-PZY/codex-relay/commit/057311617a5c069fa648a1bcc2066099bec18751))

## [0.2.1](https://github.com/Albert-PZY/codex-relay/compare/v0.2.0...v0.2.1) (2026-05-19)


### Bug Fixes

* publish package under available npm name ([a2a8c00](https://github.com/Albert-PZY/codex-relay/commit/a2a8c00a607bdaa75a24bd15ed370065a0ee3fbe))
* publish package under available npm name ([65609b6](https://github.com/Albert-PZY/codex-relay/commit/65609b6d9503f5497ff40efaa373d3af4124c404))

## [0.2.0](https://github.com/Albert-PZY/codex-relay/compare/v0.1.0...v0.2.0) (2026-05-19)


### Features

* add one-command key pool setup ([4aef890](https://github.com/Albert-PZY/codex-relay/commit/4aef89066c0312ca7448ac4035028c1bb7696afd))
* auto-import data.txt on first run ([1f9cc9d](https://github.com/Albert-PZY/codex-relay/commit/1f9cc9d88d4d1ec11e6fa2139eee76adeb2bbc2f))
* dedupe imported relay accounts ([92ad23b](https://github.com/Albert-PZY/codex-relay/commit/92ad23b37a04e0fb12d100da01b2866c9cf6bb97))
* detect quota signals and rotate accounts ([2f928c7](https://github.com/Albert-PZY/codex-relay/commit/2f928c72f032d304cb518bfd10b648ccc75cc0f9))
* expose codex-relay cli commands ([d3f83e6](https://github.com/Albert-PZY/codex-relay/commit/d3f83e644086769eab716eb8d64dec68e452792c))
* manage relay accounts and state ([497aebd](https://github.com/Albert-PZY/codex-relay/commit/497aebd0f3535af0b7cbdd7c6ded689bf8a4fe1f))
* run codex with automatic account rotation ([950efdf](https://github.com/Albert-PZY/codex-relay/commit/950efdfc3913560484a635baaf285751f925a744))
* simplify json relay import flow ([78c2031](https://github.com/Albert-PZY/codex-relay/commit/78c20310f2f515c88bf52e78e2e94c794eee8098))


### Bug Fixes

* handle cli help exit cleanly ([82a6166](https://github.com/Albert-PZY/codex-relay/commit/82a61668ee078fe11018d546ddab55bee78ad678))
* publish under scoped npm package ([ce1afae](https://github.com/Albert-PZY/codex-relay/commit/ce1afaeb5aeaac92bd41df36b74f35e48487a8de))
