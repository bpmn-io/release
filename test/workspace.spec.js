import { expect } from 'chai';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bumpVersion,
  compareVersions,
  maxVersion,
  topoSort,
  discoverPackages
} from '../lib/workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));


describe('bumpVersion', function() {

  describe('stable bumps', function() {

    it('should bump patch', function() {
      expect(bumpVersion('1.2.3', 'patch')).to.equal('1.2.4');
    });

    it('should bump minor and reset patch', function() {
      expect(bumpVersion('1.2.3', 'minor')).to.equal('1.3.0');
    });

    it('should bump major and reset minor + patch', function() {
      expect(bumpVersion('1.2.3', 'major')).to.equal('2.0.0');
    });

  });

  describe('prerelease start', function() {

    it('should start premajor with default preid', function() {
      expect(bumpVersion('1.0.0', 'premajor')).to.equal('2.0.0-alpha.0');
    });

    it('should start preminor with default preid', function() {
      expect(bumpVersion('1.0.0', 'preminor')).to.equal('1.1.0-alpha.0');
    });

    it('should start prepatch with default preid', function() {
      expect(bumpVersion('1.0.0', 'prepatch')).to.equal('1.0.1-alpha.0');
    });

    it('should use a custom preid', function() {
      expect(bumpVersion('1.0.0', 'preminor', 'rc')).to.equal('1.1.0-rc.0');
    });

    it('should treat prerelease from stable as prepatch', function() {
      expect(bumpVersion('1.0.0', 'prerelease')).to.equal('1.0.1-alpha.0');
    });

  });

  describe('prerelease increment', function() {

    it('should increment counter on same channel', function() {
      expect(bumpVersion('1.1.0-alpha.0', 'prerelease', 'alpha')).to.equal('1.1.0-alpha.1');
    });

    it('should increment a high counter', function() {
      expect(bumpVersion('1.1.0-alpha.9', 'prerelease', 'alpha')).to.equal('1.1.0-alpha.10');
    });

    it('should switch channel (keeps same base)', function() {
      expect(bumpVersion('1.1.0-alpha.2', 'prerelease', 'rc')).to.equal('1.1.0-rc.0');
    });

  });

  describe('errors', function() {

    it('should throw on an unknown bump type', function() {
      expect(() => bumpVersion('1.0.0', 'invalid')).to.throw(/unknown bump type/);
    });

    it('should throw on an unparseable version', function() {
      expect(() => bumpVersion('not-a-version', 'patch')).to.throw(/Cannot parse version/);
    });

  });

});


describe('compareVersions', function() {

  it('should return negative when a < b (major)', function() {
    expect(compareVersions('1.0.0', '2.0.0')).to.be.below(0);
  });

  it('should return positive when a > b (minor)', function() {
    expect(compareVersions('1.1.0', '1.0.0')).to.be.above(0);
  });

  it('should return 0 for equal stable versions', function() {
    expect(compareVersions('1.2.3', '1.2.3')).to.equal(0);
  });

  it('should sort prerelease below stable at the same base', function() {
    expect(compareVersions('1.0.0-alpha.0', '1.0.0')).to.be.below(0);
  });

  it('should sort stable above prerelease at the same base', function() {
    expect(compareVersions('1.0.0', '1.0.0-alpha.0')).to.be.above(0);
  });

  it('should compare prerelease counters on the same channel', function() {
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.0')).to.be.above(0);
  });

  it('should sort prerelease of a higher base above stable of a lower base', function() {
    expect(compareVersions('1.1.0-alpha.0', '1.0.0')).to.be.above(0);
  });

  it('should compare channels alphabetically', function() {
    expect(compareVersions('1.0.0-alpha.0', '1.0.0-beta.0')).to.be.below(0);
  });

});


describe('maxVersion', function() {

  it('should return the highest stable version', function() {
    expect(maxVersion([ '1.0.0', '2.0.0', '1.5.0' ])).to.equal('2.0.0');
  });

  it('should handle a single version', function() {
    expect(maxVersion([ '1.2.3' ])).to.equal('1.2.3');
  });

  it('should pick a prerelease when it is higher than all stable versions', function() {
    expect(maxVersion([ '1.0.0', '1.1.0-alpha.2', '0.9.0' ])).to.equal('1.1.0-alpha.2');
  });

  it('should pick stable over prerelease at the same base', function() {
    expect(maxVersion([ '1.0.0-alpha.5', '1.0.0' ])).to.equal('1.0.0');
  });

});


describe('topoSort', function() {

  it('should place dependencies before their dependents', function() {

    // given
    const packages = [
      { name: 'b', pkg: { dependencies: { 'a': '^1.0.0' } } },
      { name: 'a', pkg: {} }
    ];

    // when
    const sorted = topoSort(packages);

    // then
    const names = sorted.map(p => p.name);
    expect(names.indexOf('a')).to.be.below(names.indexOf('b'));
  });

  it('should handle transitive dependencies', function() {

    // given
    const packages = [
      { name: 'c', pkg: { dependencies: { 'b': '^1.0.0' } } },
      { name: 'b', pkg: { dependencies: { 'a': '^1.0.0' } } },
      { name: 'a', pkg: {} }
    ];

    // when
    const sorted = topoSort(packages);

    // then
    const names = sorted.map(p => p.name);
    expect(names.indexOf('a')).to.be.below(names.indexOf('b'));
    expect(names.indexOf('b')).to.be.below(names.indexOf('c'));
  });

  it('should handle packages with no inter-dependencies', function() {

    // given
    const packages = [
      { name: 'a', pkg: {} },
      { name: 'b', pkg: {} }
    ];

    // when
    const sorted = topoSort(packages);

    // then
    expect(sorted.map(p => p.name)).to.have.members([ 'a', 'b' ]);
  });

  it('should throw on a dependency cycle', function() {

    // given
    const packages = [
      { name: 'a', pkg: { dependencies: { 'b': '^1.0.0' } } },
      { name: 'b', pkg: { dependencies: { 'a': '^1.0.0' } } }
    ];

    // then
    expect(() => topoSort(packages)).to.throw(/cycle/i);
  });

});


describe('discoverPackages', function() {

  const fixtureRoot = join(__dirname, 'fixtures', 'monorepo');

  it('should discover non-private workspace packages', function() {

    // given
    const rootPkg = { workspaces: [ 'packages/*' ] };

    // when
    const packages = discoverPackages(fixtureRoot, rootPkg);

    // then
    expect(packages.map(p => p.name)).to.include.members([ '@test/a', '@test/b' ]);
  });

  it('should skip private packages', function() {

    // given
    const rootPkg = { workspaces: [ 'packages/*' ] };

    // when
    const packages = discoverPackages(fixtureRoot, rootPkg);

    // then
    expect(packages.map(p => p.name)).not.to.include('@test/private');
  });

  it('should expose dir, name, and pkg for each package', function() {

    // given
    const rootPkg = { workspaces: [ 'packages/*' ] };

    // when
    const packages = discoverPackages(fixtureRoot, rootPkg);
    const pkgA = packages.find(p => p.name === '@test/a');

    // then
    expect(pkgA).to.exist;
    expect(pkgA.dir).to.equal('packages/a');
    expect(pkgA.pkg.version).to.equal('1.0.0');
  });

});
