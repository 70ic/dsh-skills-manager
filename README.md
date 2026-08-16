# dsh-skills-manager

English | [中文](README.zh.md)

Opt-in skill visibility control for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), packaged as an installable plugin bundle.

The stock composition publishes **every** discovered model-invocable skill into every session catalog; the only built-in opt-out is editing each skill file's frontmatter. This plugin adds selection without touching any skill file:

- **`deny-list`** — hide named skills from the catalog, the `skill` tool, and the `/name` user gesture.
- **`allow-list`** — expose only the named skills.
- **`/skills` command** — list skills and toggle per-project overrides at runtime; overrides persist across restarts.

## How it works

The plugin registers one `skill-manager` provider on `ctx.skills` whose candidates are **rank-0 tombstones**. The skill registry resolves duplicate names by rank, so a tombstone outranks every shipped provider (ranks 100–600). A tombstone carries both invocation switches off — the registry's own visibility vocabulary — so `dsh-tool-skill` omits the name from the `<available_skills>` catalog, the `skill` tool rejects it, and a `/name` gesture stays plain prose. Enabling a skill is simply not tombstoning it; the original filesystem candidate wins again. Toggles invalidate the provider, and the existing catalog-digest machinery republishes the session catalog on the next model step. No dsh internals are replaced or forked — only public registry APIs.

## Requirements

- The `dsh` CLI (developer preview; tested against the `@deepseek-ai/*` `0.0.1-rc` npm line)

## Install

Install the bundle into a profile (here `web`):

```sh
dsh plugin --profile web add github:70ic/dsh-skills-manager
```

From a local checkout instead:

```sh
git clone https://github.com/70ic/dsh-skills-manager.git
dsh plugin --profile web add ./dsh-skills-manager
```

Verify the layer composes, then boot:

```sh
dsh --profile web --dump-config   # shows a "# == dsh-skills-manager" layer
dsh --profile web
```

Remove it again with `dsh plugin --profile web remove dsh-skills-manager`.

## Configure

Out of the box every skill stays visible, but the `/skills` command is
already live: `/skills disable <name>` hides a skill for the current project
immediately. Add a static policy in your profile's own patch layer — `$DSH_HOME/profiles/web/cordis.patch.yml` (`~/.dsh` by default), which is applied after every bundle layer:

```yaml
- id: skill-manager
  config:
    mode: deny-list        # 'deny-list' hides names; 'allow-list' exposes only names
    names: [pdf, pptx]
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `mode` | `'all' \| 'deny-list' \| 'allow-list'` | `'all'` | `all` keeps the manager inert. |
| `names` | `string[]` | `[]` | Kebab-case skill names the selected mode operates on. |
| `stateFile` | `string` | `<dsh home>/skill-manager.json` | Persistent runtime-override file. |

## The `/skills` command

| Input | Result |
|---|---|
| `/skills` | List every discoverable skill with its state, plus the active mode. |
| `/skills disable <name>` | Force-disable for this project, persist, republish on the next model step. |
| `/skills enable <name>` | Force-enable (overrides a `deny-list` entry). |
| `/skills reset <name>` | Drop the override; the active policy decides again. |
| `/skills mode` | Show the active mode, its names, and which layer supplied it. |
| `/skills mode all` | Everything visible again. |
| `/skills mode deny-list [n1,n2,...]` | Hide the named skills (names optional). |
| `/skills mode allow-list [n1,n2,...]` | Expose only the named skills. |
| `/skills mode reset` | Drop the runtime policy; settings/composition decide again. |

Overrides are keyed by the session's project directory in the state file:

```json
{
  "version": 1,
  "projects": {
    "F:\\work\\project": { "disabled": ["pdf"], "enabled": ["docx"] }
  }
}
```

## Limitations

- `allow-list` publishes its first catalog one model step later than usual (the workspace's skill universe must be observed once; until then the observation is deliberately incomplete so nothing flashes).
- A skill file added mid-session may appear in one snapshot before an `allow-list` tombstones it; `deny-list` has no such window once loaded.
- Names are exact kebab-case identifiers — no glob patterns.
- No model-facing toggle tool, on purpose: skill visibility is a user control plane.

## Development

```sh
npm install
npm run build    # tsc → lib/ (committed so git installs need no build step)
npm test         # 13 specs against the real SkillRegistry
npm run smoke    # boot the built lib against real package resolution
```

## License

MIT
