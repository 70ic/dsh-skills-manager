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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export declare const name = "skill-manager";
export declare const inject: string[];
/** Visibility policy selected by {@link Config.mode}. */
export type SkillManagerMode = 'all' | 'deny-list' | 'allow-list';
/** Plugin configuration. */
export interface Config {
    /**
     * Visibility policy: `all` mounts the manager inert, `deny-list` hides the
     * configured names, `allow-list` hides everything except the configured
     * names. Runtime overrides apply in both listing modes and are ignored in
     * `all`.
     */
    mode?: SkillManagerMode;
    /** Names the selected mode operates on; kebab-case skill identifiers. */
    names?: string[];
    /**
     * Persistent runtime-override file. Default `<dsh home>/skill-manager.json`;
     * the parent directory is created on first write.
     */
    stateFile?: string;
}
/** Validate and default the plugin configuration. */
export declare const Config: z<Config>;
/** Per-project runtime overrides layered over the static {@link Config} policy. */
export interface ProjectOverrides {
    /** Names force-disabled regardless of the static policy. */
    disabled?: string[];
    /** Names force-enabled regardless of the static policy. */
    enabled?: string[];
}
/** Persistent state file shape. */
export interface SkillManagerState {
    version: 1;
    projects: Record<string, ProjectOverrides>;
}
/** Parse the state file defensively; the caller owns error handling. */
export declare function parseState(text: string): SkillManagerState;
/** Normalize a cwd into the state file and universe key space. */
export declare function projectKeyOf(cwd: string | undefined): string;
/**
 * Resolve one skill name's visibility. Overrides outrank the static policy;
 * `all` is inert. Pure so tests and the provider share one definition.
 */
export declare function resolveEnabled(mode: SkillManagerMode, names: readonly string[], overrides: ProjectOverrides | undefined, skillName: string): boolean;
export declare function apply(ctx: Context, config?: Config): void;
