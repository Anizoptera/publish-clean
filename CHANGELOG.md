# Changelog

## [0.3.0](https://github.com/Anizoptera/publish-clean/compare/v0.2.0...v0.3.0) (2026-08-11)


### Features

* **cli:** refuse to publish a manifest that lost a field consumers read ([b5ff004](https://github.com/Anizoptera/publish-clean/commit/b5ff0048a442d2632cb1cb3e772db865a293f99d))
* **cli:** report manifest fields nobody recognises instead of shipping them silently ([7f41118](https://github.com/Anizoptera/publish-clean/commit/7f41118484fdd728d8b379b2f129e76eec5a5f1d))


### Bug Fixes

* **build:** stop requiring an optional peer that nothing installs ([9a50594](https://github.com/Anizoptera/publish-clean/commit/9a50594fd8899929a8e34e61be8a13581a757efd))
* catch private keys the leak guard was letting through ([9b3008b](https://github.com/Anizoptera/publish-clean/commit/9b3008b9a964ddb44cc26d005527e41f98ac0bb5))
* **cli:** say what a required tool actually did instead of guessing ([95397f6](https://github.com/Anizoptera/publish-clean/commit/95397f610b0005c42d6fd3680f8a6eb682364b34))
* correct the Yarn claim, which was inferred and is false ([594339a](https://github.com/Anizoptera/publish-clean/commit/594339ad41021c40cbc7895b1729bf6203d06ab7))
* correct what the docs and the advisory claim about Bun and Yarn ([9b42660](https://github.com/Anizoptera/publish-clean/commit/9b4266040808ae711dc51df2891dcb98db65188d))
* **release:** stop dropping user-visible changes from the changelog ([b31954f](https://github.com/Anizoptera/publish-clean/commit/b31954fccdb946c2f81842f0b5a88e6c7ef8e08f))
* **release:** unblock publishing from generated files and package-manager drift ([2626743](https://github.com/Anizoptera/publish-clean/commit/2626743c68bea33fbbba904b658749c06a1e2cdf))


### Internal changes

* **cli:** drop the pnpm.overrides check, which guarded nothing ([689f7b2](https://github.com/Anizoptera/publish-clean/commit/689f7b259e6415e93f6acb7d35a21ced7067a740))
* **cli:** stream publish output, and fold the two path collectors into one ([9446fb7](https://github.com/Anizoptera/publish-clean/commit/9446fb7d599d55de5f119c9d27c5fbe3906afdc1))
* keep the packer evidence in one place ([e379fd4](https://github.com/Anizoptera/publish-clean/commit/e379fd497d0a82f66def80722619404aff6e158b))
* **release:** make the publish job minimal and repeatable ([12f9bad](https://github.com/Anizoptera/publish-clean/commit/12f9bad339d3ea5ff024a2b466dcc803da904346))

## [0.2.0](https://github.com/Anizoptera/publish-clean/compare/v0.1.0...v0.2.0) (2026-08-10)


### Features

* create public publish-clean package ([5cc9879](https://github.com/Anizoptera/publish-clean/commit/5cc9879cfe794299b41733910f93b1d53bf97dc2))
* retain the published tarball and attest it in the release pipeline ([4f79788](https://github.com/Anizoptera/publish-clean/commit/4f79788c1807fd6b67c1efb611b536c63c96a3ef))


### Bug Fixes

* harden publish-clean CLI guards ([9401836](https://github.com/Anizoptera/publish-clean/commit/940183612c43d4a5a184a38df7ad860a177a28db))
* locate packed tarballs on disk instead of parsing packer stdout ([3c9f778](https://github.com/Anizoptera/publish-clean/commit/3c9f778e95a59190968efbbc38fbdc3142226fd1))
* make cli build reproducible ([6fe8fff](https://github.com/Anizoptera/publish-clean/commit/6fe8fff46c8a1b067b0f2d422136153b3b006f5e))
* publish cleaned npm tarballs ([1bf9a2e](https://github.com/Anizoptera/publish-clean/commit/1bf9a2eb73c3061c6608d9b9b7f24f7535d5cd3c))
* stop tracking built cli artifact ([ba822da](https://github.com/Anizoptera/publish-clean/commit/ba822dabd49ecba68356c957bca3411c47d0b34a))

## Changelog

All notable changes are managed by release-please from Conventional Commits.
