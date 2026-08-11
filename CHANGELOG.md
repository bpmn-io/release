# Changelog

All notable changes to [@bpmn-io/release](https://github.com/bpmn-io/release) are documented here. We use [semantic versioning](http://semver.org/) for releases.

## Unreleased

___Note:__ Yet to be released changes appear here._

* `FEAT`: version + tag private packages by default (never publishing them); add `--no-private` to exclude them from the release entirely ([#9](https://github.com/bpmn-io/release/pull/9))
* `FEAT`: add `--force-release` to release every eligible package even without changes ([#9](https://github.com/bpmn-io/release/pull/9))
* `FEAT`: make the per-package `all` build step optional — skip (with a warning) when the script is absent, or skip entirely via `--no-build` ([#9](https://github.com/bpmn-io/release/pull/9))
* `FEAT`: add a `version` command / `setVersion` API to stamp versions ([#10](https://github.com/bpmn-io/release/pull/10))
* `FEAT`: accept explicit versions in `release --bump` (mirroring the `version` command) ([#10](https://github.com/bpmn-io/release/pull/10))

### Breaking Changes

* private packages are now included in the release by default (versioned + tagged, never published). Use `--no-private` flag to switch back to the old behavior

## 0.4.0

* `FEAT`: under the `fixed` strategy, only release packages that changed since the baseline tag (plus their dependents) ([#8](https://github.com/bpmn-io/release/pull/8))

## 0.3.0

* `FEAT`: support prereleases ([#1](https://github.com/bpmn-io/release/issues/1), [#4](https://github.com/bpmn-io/release/issues/4))
* `FIX`: correctly pass commit message to release runner ([#5](https://github.com/bpmn-io/release/pull/5))

## 0.2.0

* `FEAT`: support customizing the release commit message via `releaseConfig.commitMessage` ([#3](https://github.com/bpmn-io/release/pull/3))
* `FEAT`: include version in default fixed strategy release commit message ([#3](https://github.com/bpmn-io/release/pull/3))
* `CHORE`: execute commands with explicit argument passing ([#3](https://github.com/bpmn-io/release/pull/3))
* `FIX`: correctly handle directories with whitespace ([#3](https://github.com/bpmn-io/release/pull/3))
* `DEPS`: depend on `nano-spawn` ([#3](https://github.com/bpmn-io/release/pull/3))

## 0.1.0

* `FEAT`: initial version :tada:
