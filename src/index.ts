/**
 * Opt-in skill visibility control.
 *
 * The shipped skill composition publishes every discovered model-invocable
 * skill into every session catalog; the only built-in opt-out is per-file
 * frontmatter. This plugin mounts one `skill-manager` provider whose
 * candidates are rank-0 tombstones: a tombstone wins the registry's
 * duplicate-name resolution, carries both invocation switches off, and so
 * removes that name from the session catalog, the `skill` tool, and the
 * `/name` user gesture — without touching any skill file. Enabling a skill
 * is simply not tombstoning it, so the original filesystem candidate wins
 * again. Toggles call `control.invalidate()`; `dsh-tool-skill` digests each
 * complete snapshot per step and republishes the replacement catalog on its
 * own.
 *
 * @module dsh-skills-manager
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
} from '@deepseek-ai/dsh-skill'

export const name = 'skill-manager'
export const inject = ['skills']

/** Tombstones outrank every shipped provider (100–600) and runtime registrations (250). */
const TOMBSTONE_RANK = 0
/** Registry-wide identity of this plugin's provider and its tombstone candidates. */
const MANAGER_PROVIDER = 'skill-manager'
const TOMBSTONE_DESCRIPTION = 'Disabled by the skill-manager plugin.'
/** Sentinel universe key for lookups without a cwd. */
const NO_CWD = ''

/** Visibility policy selected by {@link Config.mode}. */
export type SkillManagerMode = 'all' | 'deny-list' | 'allow-list'

/** Plugin configuration. */
export interface Config {
  /**
   * Visibility policy: `all` mounts the manager inert, `deny-list` hides the
   * configured names, `allow-list` hides everything except the configured
   * names. Runtime overrides apply in both listing modes and are ignored in
   * `all`.
   */
  mode?: SkillManagerMode
  /** Names the selected mode operates on; kebab-case skill identifiers. */
  names?: string[]
  /**
   * Persistent runtime-override file. Default `<dsh home>/skill-manager.json`;
   * the parent directory is created on first write.
   */
  stateFile?: string
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['all', 'deny-list', 'allow-list']).default('all'),
  names: z.array(z.string()).default([]),
  stateFile: z.string().default(''),
})

/** Per-project runtime overrides layered over the static {@link Config} policy. */
export interface ProjectOverrides {
  /** Names force-disabled regardless of the static policy. */
  disabled?: string[]
  /** Names force-enabled regardless of the static policy. */
  enabled?: string[]
}

/** Persistent state file shape. */
export interface SkillManagerState {
  version: 1
  projects: Record<string, ProjectOverrides>
}

/** Parse the state file defensively; the caller owns error handling. */
export function parseState(text: string): SkillManagerState {
  if (text.trim() === '') return { version: 1, projects: {} }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('skill-manager state must be { version: 1, projects: {...} }')
  }
  const record = parsed as { version?: unknown; projects?: unknown }
  if (record.version !== 1 || typeof record.projects !== 'object' || record.projects === null) {
    throw new Error('skill-manager state must be { version: 1, projects: {...} }')
  }
  return { version: 1, projects: record.projects as Record<string, ProjectOverrides> }
}

/** Normalize a cwd into the state file and universe key space. */
export function projectKeyOf(cwd: string | undefined): string {
  return cwd === undefined || cwd === '' ? NO_CWD : resolve(cwd)
}

/**
 * Resolve one skill name's visibility. Overrides outrank the static policy;
 * `all` is inert. Pure so tests and the provider share one definition.
 */
export function resolveEnabled(
  mode: SkillManagerMode,
  names: readonly string[],
  overrides: ProjectOverrides | undefined,
  skillName: string,
): boolean {
  if (mode === 'all') return true
  if (overrides?.enabled?.includes(skillName)) return true
  if (overrides?.disabled?.includes(skillName)) return false
  return mode === 'allow-list' ? names.includes(skillName) : !names.includes(skillName)
}

function tombstoneOf(skillName: string): SkillCandidate {
  return {
    name: skillName,
    description: TOMBSTONE_DESCRIPTION,
    invocation: { modelInvocable: false, userInvocable: false },
    source: MANAGER_PROVIDER,
    provider: MANAGER_PROVIDER,
    rank: TOMBSTONE_RANK,
    locator: skillName,
  }
}

function tombstoneDefinition(candidate: SkillCandidate): SkillDefinition {
  return {
    name: candidate.name,
    description: TOMBSTONE_DESCRIPTION,
    content: `Skill "${candidate.name}" is currently disabled by the skill-manager plugin. Ask the user to re-enable it with /skills enable ${candidate.name}.`,
    invocation: { modelInvocable: false, userInvocable: false },
    source: MANAGER_PROVIDER,
    provider: MANAGER_PROVIDER,
  }
}

function statOrNull(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    return statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Owns the per-cwd universe cache, the tombstone computation, the state
 * file, and change-driven invalidation. All registry interaction goes
 * through public APIs: one rank-0 provider plus `control.invalidate()`.
 */
class SkillManager {
  private readonly universes = new Map<string, Set<string>>()
  private readonly refreshing = new Set<string>()
  /** Serialized projects map behind the last invalidated tombstone computation. */
  private overridesStamp = ''
  private stateCache: { stamp: string; state: SkillManagerState } | undefined
  private control: { invalidate(): void } | undefined
  private disposed = false

  /** Indirection so post-await checks are not narrowed to the initial `false`. */
  private isDisposed(): boolean {
    return this.disposed
  }

  constructor(
    private readonly ctx: Context,
    private readonly mode: SkillManagerMode,
    private readonly names: readonly string[],
    private readonly stateFile: string,
  ) {}

  /** The rank-0 tombstone provider registered on `ctx.skills`. */
  readonly provider: SkillProvider = {
    name: MANAGER_PROVIDER,
    list: (options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> => {
      if (this.mode === 'all') return Promise.resolve([])
      const key = projectKeyOf(options.cwd)
      this.scheduleRefresh(options.cwd)
      this.invalidateSoonIfStateChanged()
      const universe = this.universes.get(key)
      // Until the universe for this cwd has been observed once, report an
      // incomplete observation: `dsh-tool-skill` then publishes no catalog
      // for that step rather than flashing skills the policy would hide.
      if (universe === undefined) return Promise.resolve({ candidates: [], complete: false })
      const overrides = this.loadState().projects[key]
      const disabled = [...universe].filter(skillName => !resolveEnabled(this.mode, this.names, overrides, skillName))
      return Promise.resolve(disabled.map(tombstoneOf))
    },
    get: candidate => Promise.resolve(tombstoneDefinition(candidate)),
  }

  /** Names this manager currently tombstones for one cwd, sorted; empty before the first refresh. */
  disabledNames(cwd: string | undefined): string[] {
    if (this.mode === 'all') return []
    const key = projectKeyOf(cwd)
    const universe = this.universes.get(key)
    if (universe === undefined) return []
    const overrides = this.loadState().projects[key]
    return [...universe].filter(skillName => !resolveEnabled(this.mode, this.names, overrides, skillName)).sort()
  }

  /**
   * Observe the winning catalog for one cwd and grow that cwd's universe by
   * every foreign name. The union is monotonic on purpose: a tombstoned
   * name's original summary disappears behind the tombstone, so a
   * non-monotonic cache would oscillate the provider between masking and
   * unmasking it.
   */
  async refresh(cwd: string | undefined): Promise<void> {
    if (this.isDisposed()) return
    const key = projectKeyOf(cwd)
    const snapshot = await this.ctx.skills.snapshot({ cwd })
    if (this.isDisposed()) return
    const universe = this.universes.get(key) ?? new Set<string>()
    let grew = false
    for (const summary of snapshot.skills) {
      if (summary.provider === MANAGER_PROVIDER) continue
      if (!universe.has(summary.name)) {
        universe.add(summary.name)
        grew = true
      }
    }
    this.universes.set(key, universe)
    if (grew) this.invalidate()
  }

  /** Refresh once per cwd at a time, never from inside `list()` itself. */
  scheduleRefresh(cwd: string | undefined): void {
    const key = projectKeyOf(cwd)
    if (this.refreshing.has(key)) return
    this.refreshing.add(key)
    void this.refresh(cwd)
      .catch((error: unknown) => { this.ctx.logger.warn(`skill-manager: universe refresh failed: ${String(error)}`) })
      .finally(() => { this.refreshing.delete(key) })
  }

  private invalidate(): void {
    this.overridesStamp = JSON.stringify(this.loadState().projects)
    this.control?.invalidate()
  }

  /**
   * Republish after an external state-file edit. The check sits on the
   * provider read path so manual edits apply without a restart; the
   * deferred invalidation never mutates registry state during the collect
   * that observed it.
   */
  private invalidateSoonIfStateChanged(): void {
    const stamp = JSON.stringify(this.loadState().projects)
    if (stamp === this.overridesStamp) return
    this.overridesStamp = stamp
    setTimeout(() => {
      if (!this.isDisposed()) this.control?.invalidate()
    }, 0)
  }

  /** Wire the registry registration and the change listener; returns the combined disposer. */
  install(): () => void {
    const disposeProvider = this.ctx.skills.registerProvider((control) => {
      this.control = control
      return this.provider
    })
    const disposeListener = this.ctx.on('skills/change', () => {
      // Foreign providers changed; re-observe every seen cwd so newly added
      // skills enter the universe and, when the policy hides them, receive
      // tombstones. Converges: refresh invalidates only when a universe grew.
      for (const key of this.universes.keys()) {
        this.scheduleRefresh(key === NO_CWD ? undefined : key)
      }
    })
    this.overridesStamp = JSON.stringify(this.loadState().projects)
    return () => {
      this.disposed = true
      disposeListener()
      disposeProvider()
    }
  }

  /** Read the state file with an mtime+size cache; failures degrade to empty. */
  loadState(): SkillManagerState {
    try {
      const stats = statOrNull(this.stateFile)
      if (stats === undefined) {
        this.stateCache = undefined
        return { version: 1, projects: {} }
      }
      const stamp = `${stats.mtimeMs}:${stats.size}`
      if (this.stateCache?.stamp === stamp) return this.stateCache.state
      const state = parseState(readFileSync(this.stateFile, 'utf8'))
      this.stateCache = { stamp, state }
      return state
    } catch (error) {
      this.ctx.logger.warn(`skill-manager: state file unreadable, using empty state: ${String(error)}`)
      this.stateCache = undefined
      return { version: 1, projects: {} }
    }
  }

  /** Mutate one project's overrides, persist atomically, and republish. */
  async setOverride(cwd: string | undefined, mutation: 'enable' | 'disable' | 'reset', skillName: string): Promise<void> {
    if (this.mode === 'all') throw new Error('skill-manager mode is "all"; there is nothing to enable or disable')
    const key = projectKeyOf(cwd)
    const state = this.loadState()
    const project = state.projects[key] ?? {}
    const disabled = new Set(project.disabled ?? [])
    const enabled = new Set(project.enabled ?? [])
    if (mutation === 'enable') {
      disabled.delete(skillName)
      enabled.add(skillName)
    } else if (mutation === 'disable') {
      enabled.delete(skillName)
      disabled.add(skillName)
    } else {
      disabled.delete(skillName)
      enabled.delete(skillName)
    }
    const next: ProjectOverrides = {
      ...disabled.size > 0 ? { disabled: [...disabled].sort() } : {},
      ...enabled.size > 0 ? { enabled: [...enabled].sort() } : {},
    }
    const projects: Record<string, ProjectOverrides> = {}
    for (const [project, entry] of Object.entries(state.projects)) {
      if (project === key && Object.keys(next).length === 0) continue
      projects[project] = entry
    }
    if (Object.keys(next).length > 0) projects[key] = next
    await writeFileAtomic(this.stateFile, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`, { mode: 0o600 })
    this.stateCache = undefined
    this.invalidate()
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const mode = config.mode ?? 'all'
  const names = config.names ?? []
  const stateFile = config.stateFile || dshHomePath('skill-manager.json')
  const manager = new SkillManager(ctx, mode, names, stateFile)
  ctx.effect(() => manager.install(), 'skill-manager provider')
  ctx.logger.info(`skill-manager: mode=${mode} names=${names.length} stateFile=${stateFile}`)

  // The /skills command child activates only when a command registry is
  // composed; UI-less compositions simply skip it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'skills',
      description: 'List skills and control per-project skill visibility',
      input: { hint: '[enable|disable|reset <skill-name>]' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agent.session.header.cwd
        const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
        if (tokens.length === 0) return await listSkills(commandCtx, manager, cwd)
        const [action, skillName] = tokens
        if ((action === 'enable' || action === 'disable' || action === 'reset') && tokens.length === 2 && skillName !== undefined) {
          try {
            await manager.setOverride(cwd, action, skillName)
          } catch (error) {
            return { kind: 'error', text: `skill-manager: ${String(error)}` }
          }
          const verb = action === 'reset' ? 'reset to the configured policy' : `${action}d`
          return { kind: 'success', text: `Skill "${skillName}" ${verb}. The session skill catalog updates on the next model step.` }
        }
        return { kind: 'error', text: 'Usage: /skills [enable|disable|reset <skill-name>]' }
      },
    })
  })
}

async function listSkills(
  ctx: Context,
  manager: SkillManager,
  cwd: string | undefined,
): Promise<{ kind: 'success'; text: string }> {
  const snapshot = await ctx.skills.snapshot({ cwd })
  const disabled = new Set(manager.disabledNames(cwd))
  const overrides = manager.loadState().projects[projectKeyOf(cwd)]
  if (snapshot.skills.length === 0) {
    return { kind: 'success', text: 'No skills are currently discoverable in this workspace.' }
  }
  const lines = snapshot.skills.map((skill) => {
    const state = disabled.has(skill.name)
      ? 'disabled'
      : overrides?.enabled?.includes(skill.name)
        ? 'enabled (override)'
        : 'enabled'
    return `- ${skill.name} — ${state} — ${skill.description}`
  })
  return { kind: 'success', text: ['Skills in this workspace:', ...lines].join('\n') }
}
