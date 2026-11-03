# Releasing

How versions of `@niur/nestjs-service-bus` are numbered and released.

## Versioning

Versions follow [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. The question that picks the number is: **after upgrading, may someone who uses the package have to change their code or their setup?**

| Change | Example | When |
|---|---|---|
| **MAJOR** | 1.4.2 → 2.0.0 | Code or a setup that worked can stop compiling or behave differently: an export removed or renamed, a type narrowed or changed, a behavior or a default changed, the minimum Node.js version raised, a peer dependency added or its range narrowed, support for a version of a dependency or of an API dropped. |
| **MINOR** | 1.4.2 → 1.5.0 | Something new that breaks nothing: a new option whose default keeps the current behavior, a new export, support for one more version of a dependency or an API. |
| **PATCH** | 1.4.2 → 1.4.3 | Only fixes that make the package do what it already said it did, with no change to the API; security fixes and internal dependency updates. |

- **When in doubt, pick the higher one.** A fix that changes a behavior someone may rely on is a major change.
- **0.x versions:** before 1.0.0 the API is not declared stable, and a minor version (0.1.0 → 0.2.0) may contain breaking changes; a patch version may not. Releasing 1.0.0 declares the API stable.
- **Deprecate before removing:** mark the old API `@deprecated` in a minor version, with what to use instead, and remove it in the next major version.
- **Pre-releases** (`2.0.0-beta.1`, `2.0.0-rc.1`) let users try a version before it is final. Publish them as a GitHub pre-release: they go to the `next` dist-tag, so `npm install` keeps resolving to the last stable version.
- **Every release has a changelog entry.** A major version lists its breaking changes and how to upgrade.

## Releasing

1. In a pull request: update `version` in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version`), and move the `Unreleased` changes of `CHANGELOG.md` to a section for the version, with its date.
2. Once it is merged and CI is green on the default branch, create a GitHub release on it:
   - tag: the version **without a `v`** (`2.0.0`), the same as `version` in `package.json`;
   - mark it as a pre-release only for a pre-release version.
3. The release runs the publish workflow: it builds and tests the package and **stages** it on npm with provenance, through npm trusted publishing (no npm token is stored).
4. Approve the staged version on npmjs.com (the package, **Staged Packages**) with 2FA. Only then is it published.
5. Check it: `npm view @niur/nestjs-service-bus dist-tags` and `npm audit signatures` in a project that installs it.

A version that should not be used is deprecated, never unpublished: `npm deprecate @niur/nestjs-service-bus@<version> "<why, and which version to use>"`.
