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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "skills-manager";
export declare const inject: string[];
/** Visibility policy selected by {@link Config.mode}. */
export type SkillManagerMode = 'all' | 'deny-list' | 'allow-list';
/** The two user-adjustable policy fields, shared by config, settings, and runtime policy. */
export interface SkillManagerPolicy {
    /** Visibility policy; `all` keeps every skill visible. */
    mode: SkillManagerMode;
    /** Names the selected mode operates on; kebab-case skill identifiers. */
    names: string[];
}
/** Plugin configuration. */
export interface Config extends SkillManagerPolicy {
    /**
     * Persistent runtime-override file. Default `<dsh home>/skill-manager.json`;
     * the parent directory is created on first write. Beyond the two policy
     * fields it also stores the `/skills mode` runtime policy and per-project
     * overrides.
     */
    stateFile?: string;
}
/** Validate and default the plugin configuration. */
export declare const Config: z<Config>;
/** Per-project runtime overrides layered over every policy layer. */
export interface ProjectOverrides {
    /** Names force-disabled regardless of the policy. */
    disabled?: string[];
    /** Names force-enabled regardless of the policy. */
    enabled?: string[];
}
/** Persistent state file shape. */
export interface SkillManagerState {
    version: 1;
    /** Runtime policy set by `/skills mode`; absent falls back to settings and entry config. */
    policy?: SkillManagerPolicy;
    projects: Record<string, ProjectOverrides>;
}
/** Parse the state file defensively; the caller owns error handling. */
export declare function parseState(text: string): SkillManagerState;
/** Normalize a cwd into the state file and universe key space. */
export declare function projectKeyOf(cwd: string | undefined): string;
/**
 * Resolve the effective policy. The runtime policy (from `/skills mode`)
 * replaces the settings-resolved value entirely when present; the settings
 * value itself already layers the user document over the composition entry.
 */
export declare function resolvePolicy(runtime: SkillManagerPolicy | undefined, settingsValue: SkillManagerPolicy | undefined, entry: SkillManagerPolicy): SkillManagerPolicy;
/**
 * Resolve one skill name's visibility. Runtime overrides always outrank the
 * static policy, in every mode — so the manager is useful out of the box:
 * `mode: 'all'` means "everything visible, `/skills` toggles available".
 * Pure so tests and the provider share one definition.
 */
export declare function resolveEnabled(mode: SkillManagerMode, names: readonly string[], overrides: ProjectOverrides | undefined, skillName: string): boolean;
/** Parse `/skills mode` name arguments: tokens may carry comma-separated lists. */
export declare function parsePolicyNames(tokens: readonly string[]): string[];
export declare function apply(ctx: Context, config?: Partial<Config>): void;
