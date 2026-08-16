/**
 * Opt-in skill visibility control.
 *
 * The shipped skill composition publishes every discovered model-invocable
 * skill into every session catalog; the only built-in opt-out is per-file
 * frontmatter. This plugin mounts one `skills-manager` provider whose
 * candidates are rank-0 tombstones: a tombstone wins the registry's
 * duplicate-name resolution, carries both invocation switches off, and so
 * removes that name from the session catalog, the `skill` tool, and the
 * `/name` user gesture — without touching any skill file. Enabling a skill
 * is simply not tombstoning it, so the original filesystem candidate wins
 * again. Toggles call `control.invalidate()`; `dsh-tool-skill` digests each
 * complete snapshot per step and republishes the replacement catalog on its
 * own.
 *
 * The visibility policy resolves from three layers, loosest to tightest:
 * the composition entry config (the plugin row's `config`), a settings
 * section (`skills-manager:` in `$DSH_HOME/settings.yaml`, hot-reloaded,
 * layered over the entry through `installSettingsSection`), and a runtime
 * policy persisted by `/skills mode` in the state file. Per-project
 * `/skills enable|disable` overrides outrank every policy layer. Note that
 * third-party settings namespaces are not exposed to the Web settings page
 * (the api-proxy allowlist is repository-owned), so the chat command and
 * the settings document are the control surfaces.
 *
 * @module dsh-skills-manager
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

export const name = 'skills-manager'
export const inject = ['skills']

/** Tombstones outrank every shipped provider (100–600) and runtime registrations (250). */
const TOMBSTONE_RANK = 0
/** Registry-wide identity of this plugin's provider and its tombstone candidates. */
const MANAGER_PROVIDER = 'skills-manager'
/** Settings namespace the plugin registers when a settings service is composed. */
const SETTINGS_NAMESPACE = settingsNamespace('skills-manager')
const TOMBSTONE_DESCRIPTION = 'Disabled by the skills-manager plugin.'
/** Sentinel universe key for lookups without a cwd. */
const NO_CWD = ''
/** Public kebab-case skill-name grammar, mirrored for early command validation. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Visibility policy selected by {@link Config.mode}. */
export type SkillManagerMode = 'all' | 'deny-list' | 'allow-list'

/** The two user-adjustable policy fields, shared by config, settings, and runtime policy. */
export interface SkillManagerPolicy {
  /** Visibility policy; `all` keeps every skill visible. */
  mode: SkillManagerMode
  /** Names the selected mode operates on; kebab-case skill identifiers. */
  names: string[]
}

/** Plugin configuration. */
export interface Config extends SkillManagerPolicy {
  /**
   * Persistent runtime-override file. Default `<dsh home>/skill-manager.json`;
   * the parent directory is created on first write. Beyond the two policy
   * fields it also stores the `/skills mode` runtime policy and per-project
   * overrides.
   */
  stateFile?: string
}

/** Validate and default the plugin configuration. */
export const Config: z<Config> = z.object({
  mode: z.union(['all', 'deny-list', 'allow-list']).default('all'),
  names: z.array(z.string()).default([]),
  stateFile: z.string().default(''),
})

/** The settings-section schema: the policy fields without the state-file location. */
const PolicyConfig: z<SkillManagerPolicy> = z.object({
  mode: z.union(['all', 'deny-list', 'allow-list']).default('all'),
  names: z.array(z.string()).default([]),
})

/** Per-project runtime overrides layered over every policy layer. */
export interface ProjectOverrides {
  /** Names force-disabled regardless of the policy. */
  disabled?: string[]
  /** Names force-enabled regardless of the policy. */
  enabled?: string[]
}

/** Persistent state file shape. */
export interface SkillManagerState {
  version: 1
  /** Runtime policy set by `/skills mode`; absent falls back to settings and entry config. */
  policy?: SkillManagerPolicy
  projects: Record<string, ProjectOverrides>
}

/** Parse the state file defensively; the caller owns error handling. */
export function parseState(text: string): SkillManagerState {
  if (text.trim() === '') return { version: 1, projects: {} }
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('skills-manager state must be { version: 1, projects: {...} }')
  }
  const record = parsed as { version?: unknown; policy?: unknown; projects?: unknown }
  if (record.version !== 1 || typeof record.projects !== 'object' || record.projects === null) {
    throw new Error('skills-manager state must be { version: 1, projects: {...} }')
  }
  const state: SkillManagerState = { version: 1, projects: record.projects as Record<string, ProjectOverrides> }
  if (record.policy !== undefined) {
    if (typeof record.policy !== 'object' || record.policy === null) {
      throw new Error('skills-manager state policy must be { mode, names }')
    }
    const { mode, names } = record.policy as { mode?: unknown; names?: unknown }
    if (mode !== 'all' && mode !== 'deny-list' && mode !== 'allow-list') {
      throw new Error('skills-manager state policy has an invalid mode')
    }
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new Error('skills-manager state policy names must be a string array')
    }
    state.policy = { mode, names }
  }
  return state
}

/** Normalize a cwd into the state file and universe key space. */
export function projectKeyOf(cwd: string | undefined): string {
  return cwd === undefined || cwd === '' ? NO_CWD : resolve(cwd)
}

/**
 * Resolve the effective policy. The runtime policy (from `/skills mode`)
 * replaces the settings-resolved value entirely when present; the settings
 * value itself already layers the user document over the composition entry.
 */
export function resolvePolicy(
  runtime: SkillManagerPolicy | undefined,
  settingsValue: SkillManagerPolicy | undefined,
  entry: SkillManagerPolicy,
): SkillManagerPolicy {
  if (runtime !== undefined) return runtime
  if (settingsValue !== undefined) return settingsValue
  return entry
}

/**
 * Resolve one skill name's visibility. Runtime overrides always outrank the
 * static policy, in every mode — so the manager is useful out of the box:
 * `mode: 'all'` means "everything visible, `/skills` toggles available".
 * Pure so tests and the provider share one definition.
 */
export function resolveEnabled(
  mode: SkillManagerMode,
  names: readonly string[],
  overrides: ProjectOverrides | undefined,
  skillName: string,
): boolean {
  if (overrides?.enabled?.includes(skillName)) return true
  if (overrides?.disabled?.includes(skillName)) return false
  if (mode === 'all') return true
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
    content: `Skill "${candidate.name}" is currently disabled by the skills-manager plugin. Ask the user to re-enable it with /skills enable ${candidate.name}.`,
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

function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value)
}

/** Parse `/skills mode` name arguments: tokens may carry comma-separated lists. */
export function parsePolicyNames(tokens: readonly string[]): string[] {
  const names: string[] = []
  for (const token of tokens) {
    for (const part of token.split(',')) {
      const name = part.trim()
      if (name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * Owns the per-cwd universe cache, the tombstone computation, the state
 * file, and change-driven invalidation. All registry interaction goes
 * through public APIs: one rank-0 provider plus `control.invalidate()`.
 */
class SkillManager {
  private readonly universes = new Map<string, Set<string>>()
  private readonly refreshing = new Set<string>()
  /** Serialized state layers behind the last invalidated tombstone computation. */
  private stateStamp = ''
  private settingsSource: () => SkillManagerPolicy
  private stateCache: { stamp: string; state: SkillManagerState } | undefined
  private control: { invalidate(): void } | undefined
  private disposed = false

  constructor(
    private readonly ctx: Context,
    private readonly entry: SkillManagerPolicy,
    private readonly stateFile: string,
  ) {
    this.settingsSource = () => entry
  }

  /** The policy in force right now: runtime file, else settings, else entry. */
  policy(): SkillManagerPolicy {
    return resolvePolicy(this.loadState().policy, this.settingsSource(), this.entry)
  }

  /** Swap the settings-resolved source in and out; `installSettingsSection` drives this. */
  setSettingsSource(source: () => SkillManagerPolicy): void {
    this.settingsSource = source
  }

  /** The rank-0 tombstone provider registered on `ctx.skills`. */
  readonly provider: SkillProvider = {
    name: MANAGER_PROVIDER,
    list: (options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> => {
      const key = projectKeyOf(options.cwd)
      this.scheduleRefresh(options.cwd)
      this.invalidateSoonIfStateChanged()
      const { mode, names } = this.policy()
      const overrides = this.loadState().projects[key]
      if (mode === 'all' && overrides === undefined) return Promise.resolve([])
      const universe = this.universes.get(key)
      // Until the universe for this cwd has been observed once, report an
      // incomplete observation: `dsh-tool-skill` then publishes no catalog
      // for that step rather than flashing skills the policy would hide.
      if (universe === undefined) return Promise.resolve({ candidates: [], complete: false })
      const disabled = [...universe].filter(skillName => !resolveEnabled(mode, names, overrides, skillName))
      return Promise.resolve(disabled.map(tombstoneOf))
    },
    get: candidate => Promise.resolve(tombstoneDefinition(candidate)),
  }

  /** Names this manager currently tombstones for one cwd, sorted; empty before the first refresh. */
  disabledNames(cwd: string | undefined): string[] {
    const key = projectKeyOf(cwd)
    const universe = this.universes.get(key)
    if (universe === undefined) return []
    const { mode, names } = this.policy()
    const overrides = this.loadState().projects[key]
    return [...universe].filter(skillName => !resolveEnabled(mode, names, overrides, skillName)).sort()
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
      .catch((error: unknown) => { this.ctx.logger.warn(`skills-manager: universe refresh failed: ${String(error)}`) })
      .finally(() => { this.refreshing.delete(key) })
  }

  invalidate(): void {
    this.stateStamp = this.currentStateStamp()
    this.control?.invalidate()
  }

  private currentStateStamp(): string {
    const state = this.loadState()
    return JSON.stringify({ policy: state.policy ?? null, projects: state.projects })
  }

  /**
   * Republish after an external state-file edit. The check sits on the
   * provider read path so manual edits apply without a restart; the
   * deferred invalidation never mutates registry state during the collect
   * that observed it.
   */
  private invalidateSoonIfStateChanged(): void {
    const stamp = this.currentStateStamp()
    if (stamp === this.stateStamp) return
    this.stateStamp = stamp
    setTimeout(() => {
      if (!this.isDisposed()) this.control?.invalidate()
    }, 0)
  }

  /** Indirection so post-await checks are not narrowed to the initial `false`. */
  private isDisposed(): boolean {
    return this.disposed
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
    this.stateStamp = this.currentStateStamp()
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
      this.ctx.logger.warn(`skills-manager: state file unreadable, using empty state: ${String(error)}`)
      this.stateCache = undefined
      return { version: 1, projects: {} }
    }
  }

  private async persistState(next: SkillManagerState): Promise<void> {
    await writeFileAtomic(this.stateFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    this.stateCache = undefined
    this.invalidate()
  }

  /** Set the runtime policy (from `/skills mode`); persisted and republished. */
  async setPolicy(mode: SkillManagerMode, names: readonly string[]): Promise<void> {
    for (const skillName of names) {
      if (!isSkillName(skillName)) throw new Error(`"${skillName}" is not a kebab-case skill name`)
    }
    const state = this.loadState()
    await this.persistState({ version: 1, policy: { mode, names: [...names].sort() }, projects: state.projects })
  }

  /** Drop the runtime policy; settings and entry config decide again. */
  async clearPolicy(): Promise<void> {
    const state = this.loadState()
    if (state.policy === undefined) return
    const next: SkillManagerState = { version: 1, projects: state.projects }
    await this.persistState(next)
  }

  /** Mutate one project's overrides, persist atomically, and republish. */
  async setOverride(cwd: string | undefined, mutation: 'enable' | 'disable' | 'reset', skillName: string): Promise<void> {
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
    await this.persistState({ version: 1, ...state.policy !== undefined ? { policy: state.policy } : {}, projects })
  }
}

export function apply(ctx: Context, config: Partial<Config> = {}): void {
  const entry: SkillManagerPolicy = {
    mode: config.mode ?? 'all',
    names: config.names ?? [],
  }
  const stateFile = config.stateFile || dshHomePath('skill-manager.json')
  const manager = new SkillManager(ctx, entry, stateFile)
  ctx.effect(() => manager.install(), 'skills-manager provider')
  ctx.logger.info(`skills-manager: mode=${entry.mode} names=${entry.names.length} stateFile=${stateFile}`)

  // The canonical optional-settings wiring: while a settings service is
  // composed, the `skills-manager:` document section (hot-reloaded, layered
  // over this entry config) drives the policy; without one, the entry stands.
  installSettingsSection(ctx, SETTINGS_NAMESPACE, PolicyConfig, entry, {
    setSource: source => manager.setSettingsSource(source),
    onChange: () => manager.invalidate(),
  })

  // The /skills command child activates only when a command registry is
  // composed; UI-less compositions simply skip it.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'skills',
      description: 'List skills and control skill visibility',
      input: { hint: '[enable|disable|reset <skill-name>] | [mode all|deny-list|allow-list [names...]] | [mode reset]' },
      handler: async ({ agent, rawInput }) => {
        const cwd = agent.session.header.cwd
        const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
        if (tokens.length === 0) return await listSkills(commandCtx, manager, cwd)
        const [action, arg] = tokens
        if (action === 'mode') return await handleModeCommand(manager, tokens.slice(1))
        if ((action === 'enable' || action === 'disable' || action === 'reset') && arg !== undefined && tokens.length === 2) {
          if (!isSkillName(arg)) return { kind: 'error', text: `"${arg}" is not a kebab-case skill name` }
          try {
            await manager.setOverride(cwd, action, arg)
          } catch (error) {
            return { kind: 'error', text: `skills-manager: ${String(error)}` }
          }
          const verb = action === 'reset' ? 'reset to the active policy' : `${action}d`
          return { kind: 'success', text: `Skill "${arg}" ${verb}. The session skill catalog updates on the next model step.` }
        }
        return { kind: 'error', text: 'Usage: /skills [enable|disable|reset <skill-name>] or /skills mode [all|deny-list|allow-list [names...]|reset]' }
      },
    })
  })
}

async function handleModeCommand(
  manager: SkillManager,
  tokens: readonly string[],
): Promise<{ kind: 'success'; text: string } | { kind: 'error'; text: string }> {
  const [subcommand] = tokens
  if (subcommand === undefined) {
    const policy = manager.policy()
    const source = manager.loadState().policy !== undefined
      ? 'runtime policy (/skills mode)'
      : 'settings / composition default'
    const names = policy.names.length > 0 ? policy.names.join(', ') : '(none)'
    return { kind: 'success', text: `Mode: ${policy.mode} (${source})\nNames: ${names}\nChange it: /skills mode <all|deny-list|allow-list> [names...] or /skills mode reset` }
  }
  try {
    if (subcommand === 'reset') {
      if (tokens.length !== 1) return { kind: 'error', text: 'Usage: /skills mode reset' }
      await manager.clearPolicy()
      return { kind: 'success', text: 'Runtime policy cleared. The settings / composition default decides again.' }
    }
    if (subcommand === 'all' || subcommand === 'deny-list' || subcommand === 'allow-list') {
      const names = parsePolicyNames(tokens.slice(1))
      await manager.setPolicy(subcommand, names)
      const detail = subcommand === 'all' ? '' : ` (names: ${names.length > 0 ? names.join(', ') : 'none'})`
      return { kind: 'success', text: `Mode set to ${subcommand}${detail}. The session skill catalog updates on the next model step.` }
    }
  } catch (error) {
    return { kind: 'error', text: `skills-manager: ${String(error)}` }
  }
  return { kind: 'error', text: 'Usage: /skills mode [all|deny-list|allow-list [names...]|reset]' }
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
  const policy = manager.policy()
  return { kind: 'success', text: [`Skills in this workspace (mode: ${policy.mode}):`, ...lines].join('\n') }
}
