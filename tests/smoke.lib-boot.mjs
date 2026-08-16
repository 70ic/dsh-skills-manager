/**
 * Lib-path smoke boot: loads the BUILT plugin through real package resolution
 * (the same path a profile composition uses), applies it to a real
 * SkillRegistry, and asserts tombstone masking end to end.
 * Run: npm run smoke
 */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { apply, Config, inject, name } from '../lib/index.js'

const ctx = new Context()
await ctx.plugin(SkillRegistry)
ctx.skills.registerProvider(() => ({
  name: 'memory',
  async list() {
    return [
      { name: 'alpha', description: 'Alpha', invocation: { modelInvocable: true, userInvocable: true }, provider: 'memory', source: 'memory', rank: 100, locator: 'alpha' },
      { name: 'beta', description: 'Beta', invocation: { modelInvocable: true, userInvocable: true }, provider: 'memory', source: 'memory', rank: 100, locator: 'beta' },
    ]
  },
  async get(candidate) {
    return { ...candidate, content: `${candidate.name} body.` }
  },
}))
await ctx.plugin({ name, inject, apply, Config }, { mode: 'deny-list', names: ['beta'], stateFile: './.smoke-state.json' })

for (let attempt = 0; attempt < 50; attempt++) {
  const snapshot = await ctx.skills.snapshot({})
  if (snapshot.complete) {
    const providers = new Map(snapshot.skills.map(skill => [skill.name, skill.provider]))
    if (providers.get('alpha') === 'memory' && providers.get('beta') === 'skill-manager') {
      const beta = await ctx.skills.get('beta')
      console.log(`smoke OK: alpha->memory, beta->${providers.get('beta')}, beta modelInvocable=${beta.invocation.modelInvocable}`)
      process.exit(0)
    }
    console.error('smoke FAIL: unexpected providers', [...providers])
    process.exit(1)
  }
  await new Promise(resolve => setTimeout(resolve, 20))
}
console.error('smoke FAIL: snapshot never completed')
process.exit(1)
