import { expect } from 'chai';

import { createScriptedPrompter } from '../lib/prompt.js';


async function rejects(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('Expected promise to reject but it resolved');
}


describe('createScriptedPrompter', function() {

  describe('bump()', function() {

    it('should return { type, preid } for a pre* bump', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'preminor', preid: 'alpha' });

      // when
      const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });

      // then
      expect(result).to.deep.equal({ type: 'preminor', preid: 'alpha' });
    });

    it('should default preid to "alpha"', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'preminor' });

      // when
      const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });

      // then
      expect(result.preid).to.equal('alpha');
    });

    it('should return { type } for a stable bump', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'minor' });

      // when
      const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });

      // then
      expect(result.type).to.equal('minor');
    });

    it('should apply a per-package bump over the default', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'minor', bumps: { 'foo': 'patch' } });

      // when
      const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });

      // then
      expect(result.type).to.equal('patch');
    });

    it('should fall back to the default bump for unlisted packages', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'minor', bumps: { 'foo': 'patch' } });

      // when
      const result = await prompter.bump({ name: 'bar', currentVersion: '1.0.0' });

      // then
      expect(result.type).to.equal('minor');
    });

    it('should handle skip', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'skip' });

      // when
      const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });

      // then
      expect(result.type).to.equal('skip');
    });

    it('should throw for an unknown bump type', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'invalid' });

      // then
      const err = await rejects(prompter.bump({ name: 'foo', currentVersion: '1.0.0' }));
      expect(err.message).to.match(/invalid/i);
    });

    it('should support all pre* bump types', async function() {

      // given
      const preTypes = [ 'prerelease', 'prepatch', 'preminor', 'premajor' ];

      for (const type of preTypes) {
        const prompter = createScriptedPrompter({ bump: type });
        const result = await prompter.bump({ name: 'foo', currentVersion: '1.0.0' });
        expect(result.type).to.equal(type);
      }
    });

  });

  describe('confirm()', function() {

    it('should return true when yes: true', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'minor', yes: true });

      // then
      expect(await prompter.confirm()).to.be.true;
    });

    it('should return false when yes: false', async function() {

      // given
      const prompter = createScriptedPrompter({ bump: 'minor', yes: false });

      // then
      expect(await prompter.confirm()).to.be.false;
    });

  });

});
