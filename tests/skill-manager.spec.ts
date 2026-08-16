import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, {
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { apply, Config, name, parseState, projectKeyOf, resolveEnabled } from '../src/index.ts'

class MemoryProvider implements SkillProvider {
  readonly name = 'memory'

  constructor(private candidates: SkillCandidate[]) {}

  async list(_options: SkillLookupOptions): Promise<SkillCandidate[]> {
    return this.candidates
  }

  async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
    return { ...candidate, content: `${candidate.name} body.` }
  }
}

function memorySkill(skillName: string, description: string): SkillCandidate {
  return {
    name: skillName,
    description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: 'memory',
    source: 'memory',
    rank: 100,
    locator: skillName,
  }
}

interface Harness {
  ctx: Context
  memory: MemoryProvider
  stateFile: string
}

const liveDirs: string[] = []

afterEach(async () => {
  await Promise.all(liveDirs.splice(0).map(async dir => rm(dir, { recursive: true, force: true }).catch(() => {})))
})

async function createHarness(config: Record<string, unknown>, candidates: SkillCandidate[] = [
  memorySkill('alpha', 'Alpha skill'),
  memorySkill('beta', 'Beta skill'),
  memorySkill('gamma', 'Gamma skill'),
]): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const memory = new MemoryProvider(candidates)
  ctx.skills.registerProvider(() => memory)
  const stateFile = join(await mkdtemp(join(tmpdir(), 'skill-manager-')), 'state.json')
  liveDirs.push(join(stateFile, '..'))
  await ctx.plugin({ name, inject: ['skills'], apply, Config }, { stateFile, ...config })
  return { ctx, memory, stateFile }
}

/** The winning provider per skill name once the registry view settles complete. */
async function settledProviders(harness: Harness, cwd?: string): Promise<Map<string, string>> {
  await vi.waitFor(async () => {
    const snapshot = await harness.ctx.skills.snapshot({ cwd })
    expect(snapshot.complete).toBe(true)
  })
  const snapshot = await harness.ctx.skills.snapshot({ cwd })
  return new Map(snapshot.skills.map(skill => [skill.name, skill.provider]))
}

/** Provide a stub commands service and capture the /skills registration. */
async function captureSkillsCommand(harness: Harness): Promise<CommandDefinition> {
  const captured = new Promise<CommandDefinition>((resolvePromise) => {
    harness.ctx.reflect.provide('commands', {
      register(definition: CommandDefinition) {
        resolvePromise(definition)
        return () => {}
      },
    })
  })
  return await captured
}

function commandInvocation(rawInput: string, cwd: string | undefined) {
  return {
    commandId: 'test-command' as never,
    agent: { session: { header: { cwd } } } as never,
    rawInput,
    signal: new AbortController().signal,
  }
}

describe('resolveEnabled policy', () => {
  it('keeps every skill visible in all mode while overrides still apply', () => {
    expect(resolveEnabled('all', ['alpha'], undefined, 'alpha')).toBe(true)
    expect(resolveEnabled('all', ['alpha'], undefined, 'beta')).toBe(true)
    expect(resolveEnabled('all', ['alpha'], { disabled: ['alpha'] }, 'alpha')).toBe(false)
    expect(resolveEnabled('all', ['alpha'], { enabled: ['alpha'] }, 'alpha')).toBe(true)
  })

  it('hides deny-listed names unless an override re-enables them', () => {
    expect(resolveEnabled('deny-list', ['alpha'], undefined, 'alpha')).toBe(false)
    expect(resolveEnabled('deny-list', ['alpha'], undefined, 'beta')).toBe(true)
    expect(resolveEnabled('deny-list', ['alpha'], { enabled: ['alpha'] }, 'alpha')).toBe(true)
    expect(resolveEnabled('deny-list', ['alpha'], { disabled: ['beta'] }, 'beta')).toBe(false)
  })

  it('shows only allow-listed names unless an override disables them', () => {
    expect(resolveEnabled('allow-list', ['alpha'], undefined, 'alpha')).toBe(true)
    expect(resolveEnabled('allow-list', ['alpha'], undefined, 'beta')).toBe(false)
    expect(resolveEnabled('allow-list', ['alpha'], { disabled: ['alpha'] }, 'alpha')).toBe(false)
    expect(resolveEnabled('allow-list', ['alpha'], { enabled: ['beta'] }, 'beta')).toBe(true)
  })
})

describe('parseState and projectKeyOf', () => {
  it('parses a valid state file and rejects other shapes', () => {
    const state = parseState('{"version":1,"projects":{"/p":{"disabled":["x"]}}}')
    expect(state.projects['/p']?.disabled).toEqual(['x'])
    expect(() => parseState('{"version":2,"projects":{}}')).toThrow()
    expect(() => parseState('not json')).toThrow()
    expect(parseState('')).toEqual({ version: 1, projects: {} })
  })

  it('normalizes cwd keys', () => {
    expect(projectKeyOf(undefined)).toBe('')
    expect(projectKeyOf('')).toBe('')
    expect(projectKeyOf('/a/b')).toBe(projectKeyOf('/a/b'))
  })
})

describe('skill-manager plugin', () => {
  it('mounts visible-everything in all mode: every skill stays with its original provider', async () => {
    const harness = await createHarness({})
    const providers = await settledProviders(harness)
    expect(providers.get('alpha')).toBe('memory')
    expect(providers.get('beta')).toBe('memory')
    expect(providers.get('gamma')).toBe('memory')
  })

  it('deny-list mode masks configured skills behind rank-0 tombstones', async () => {
    const harness = await createHarness({ mode: 'deny-list', names: ['beta'] })
    const providers = await settledProviders(harness)
    expect(providers.get('alpha')).toBe('memory')
    expect(providers.get('gamma')).toBe('memory')
    expect(providers.get('beta')).toBe('skill-manager')

    const beta = (await harness.ctx.skills.snapshot({})).skills.find(skill => skill.name === 'beta')
    expect(beta?.invocation).toEqual({ modelInvocable: false, userInvocable: false })

    const body = await harness.ctx.skills.get('beta')
    expect(body?.invocation.modelInvocable).toBe(false)
    expect(body?.invocation.userInvocable).toBe(false)
    expect(body?.content).toContain('skill-manager')

    const alpha = await harness.ctx.skills.get('alpha')
    expect(alpha?.content).toBe('alpha body.')
  })

  it('reports an incomplete first observation so no catalog flashes hidden skills', async () => {
    const harness = await createHarness({ mode: 'deny-list', names: ['alpha', 'beta', 'gamma'] })
    const first = await harness.ctx.skills.snapshot({})
    expect(first.complete).toBe(false)
    await settledProviders(harness)
    const settled = await harness.ctx.skills.snapshot({})
    expect(settled.complete).toBe(true)
    expect(settled.skills.map(skill => skill.provider)).toEqual(['skill-manager', 'skill-manager', 'skill-manager'])
  })

  it('allow-list mode shows only the listed skills', async () => {
    const harness = await createHarness({ mode: 'allow-list', names: ['gamma'] })
    const providers = await settledProviders(harness)
    expect(providers.get('gamma')).toBe('memory')
    expect(providers.get('alpha')).toBe('skill-manager')
    expect(providers.get('beta')).toBe('skill-manager')
  })

  it('completes an empty workspace instead of staying incomplete forever', async () => {
    const harness = await createHarness({ mode: 'deny-list', names: ['beta'] }, [])
    const providers = await settledProviders(harness)
    expect(providers.size).toBe(0)
    const snapshot = await harness.ctx.skills.snapshot({})
    expect(snapshot.complete).toBe(true)
  })
})

describe('/skills command', () => {
  it('disables, enables, and resets per-project overrides that persist', async () => {
    const harness = await createHarness({ mode: 'deny-list', names: ['beta'] })
    const cwd = 'F:\\proj'
    await settledProviders(harness, cwd)
    const command = await captureSkillsCommand(harness)

    const listing = await command.handler(commandInvocation('', cwd))
    expect(listing).toMatchObject({ kind: 'success' })
    expect(listing.kind === 'success' && listing.text).toContain('beta')

    const disabled = await command.handler(commandInvocation('disable gamma', cwd))
    expect(disabled).toMatchObject({ kind: 'success' })
    expect((await settledProviders(harness, cwd)).get('gamma')).toBe('skill-manager')

    const enabled = await command.handler(commandInvocation('enable beta', cwd))
    expect(enabled).toMatchObject({ kind: 'success' })
    expect((await settledProviders(harness, cwd)).get('beta')).toBe('memory')

    const state = parseState(await readFile(harness.stateFile, 'utf8'))
    expect(state.projects[projectKeyOf(cwd)]?.disabled).toEqual(['gamma'])
    expect(state.projects[projectKeyOf(cwd)]?.enabled).toEqual(['beta'])

    const reset = await command.handler(commandInvocation('reset gamma', cwd))
    expect(reset).toMatchObject({ kind: 'success' })
    expect((await settledProviders(harness, cwd)).get('gamma')).toBe('memory')
  })

  it('applies runtime overrides in all mode and rejects unknown grammar', async () => {
    const inert = await createHarness({})
    await settledProviders(inert, 'F:\\proj')
    const inertCommand = await captureSkillsCommand(inert)
    const mutation = await inertCommand.handler(commandInvocation('disable gamma', 'F:\\proj'))
    expect(mutation).toMatchObject({ kind: 'success' })
    expect((await settledProviders(inert, 'F:\\proj')).get('gamma')).toBe('skill-manager')

    const harness = await createHarness({ mode: 'deny-list', names: [] })
    await settledProviders(harness)
    const command = await captureSkillsCommand(harness)
    const usage = await command.handler(commandInvocation('frobnicate', undefined))
    expect(usage).toMatchObject({ kind: 'error' })
  })

  it('overrides survive a reload from the same state file', async () => {
    const harness = await createHarness({ mode: 'deny-list', names: ['beta'] })
    const cwd = 'F:\\proj'
    await settledProviders(harness, cwd)
    const command = await captureSkillsCommand(harness)
    await command.handler(commandInvocation('disable gamma', cwd))

    const next = new Context()
    await next.plugin(SkillRegistry)
    const memory = new MemoryProvider([
      memorySkill('alpha', 'Alpha skill'),
      memorySkill('beta', 'Beta skill'),
      memorySkill('gamma', 'Gamma skill'),
    ])
    next.skills.registerProvider(() => memory)
    await next.plugin({ name, inject: ['skills'], apply, Config }, { stateFile: harness.stateFile, mode: 'deny-list', names: ['beta'] })
    const providers = await settledProviders({ ctx: next, memory, stateFile: harness.stateFile }, cwd)
    expect(providers.get('gamma')).toBe('skill-manager')
    expect(providers.get('beta')).toBe('skill-manager')
    expect(providers.get('alpha')).toBe('memory')
  })
})
