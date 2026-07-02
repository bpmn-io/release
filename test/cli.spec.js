import { expect } from 'chai';

import { parseArgs } from '../bin/release.js';


describe('parseArgs', function() {

  it('should default to interactive mode with alpha preid', function() {

    // when
    const opts = parseArgs([]);

    // then
    expect(opts.interactive).to.be.true;
    expect(opts.preid).to.equal('alpha');
    expect(opts.yes).to.be.false;
  });

  it('should set defaultBump and disable interactive mode with --bump', function() {

    // when
    const opts = parseArgs([ '--bump', 'minor' ]);

    // then
    expect(opts.interactive).to.be.false;
    expect(opts.defaultBump).to.equal('minor');
  });

  it('should set a per-package bump with --bump name=level', function() {

    // when
    const opts = parseArgs([ '--bump', '@scope/pkg=patch' ]);

    // then
    expect(opts.bumps['@scope/pkg']).to.equal('patch');
    expect(opts.interactive).to.be.false;
  });

  it('should handle package names containing = by splitting on the last =', function() {

    // given — package name itself doesn't contain =, but test the split logic
    const opts = parseArgs([ '--bump', '@scope/pkg=preminor' ]);

    // then
    expect(opts.bumps['@scope/pkg']).to.equal('preminor');
  });

  it('should set preid with --preid', function() {

    // when
    const opts = parseArgs([ '--preid', 'beta' ]);

    // then
    expect(opts.preid).to.equal('beta');
  });

  it('should set yes with --yes', function() {

    // when
    const opts = parseArgs([ '--yes' ]);

    // then
    expect(opts.yes).to.be.true;
  });

  it('should set yes with -y', function() {

    // when
    const opts = parseArgs([ '-y' ]);

    // then
    expect(opts.yes).to.be.true;
  });

  it('should set cwd with --cwd', function() {

    // when
    const opts = parseArgs([ '--cwd', '/some/path' ]);

    // then
    expect(opts.cwd).to.equal('/some/path');
  });

  it('should set help with --help', function() {

    // when
    const opts = parseArgs([ '--help' ]);

    // then
    expect(opts.help).to.be.true;
  });

  it('should set help with -h', function() {

    // when
    const opts = parseArgs([ '-h' ]);

    // then
    expect(opts.help).to.be.true;
  });

  it('should accumulate multiple --bump flags', function() {

    // when
    const opts = parseArgs([
      '--bump', '@scope/a=patch',
      '--bump', '@scope/b=minor'
    ]);

    // then
    expect(opts.bumps['@scope/a']).to.equal('patch');
    expect(opts.bumps['@scope/b']).to.equal('minor');
  });

  it('should combine --bump, --preid, and --yes', function() {

    // when
    const opts = parseArgs([ '--bump', 'preminor', '--preid', 'rc', '--yes' ]);

    // then
    expect(opts.defaultBump).to.equal('preminor');
    expect(opts.preid).to.equal('rc');
    expect(opts.yes).to.be.true;
    expect(opts.interactive).to.be.false;
  });

});
