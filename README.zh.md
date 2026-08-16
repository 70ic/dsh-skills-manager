# dsh-skills-manager

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的可选 skill 可见性控制插件，打包为可安装的插件 bundle。

出厂组合会把**每一个**发现的 model-invocable skill 发布进每个会话目录，唯一的内置开关是逐个改 skill 文件的 frontmatter。本插件在不改动任何 skill 文件的前提下提供选择能力：

- **`deny-list`** —— 把指定 skill 从目录、`skill` 工具和 `/name` 用户手势中隐藏。
- **`allow-list`** —— 只暴露指定的 skill。
- **`/skills` 命令** —— 列出 skill 并在运行期按项目切换覆盖项，重启后仍生效。

## 原理

插件在 `ctx.skills` 上注册一个 `skill-manager` provider，其候选是 **rank-0 墓碑**。skill 注册表按 rank 决同名胜负，墓碑压过一切出厂 provider（rank 100–600）。墓碑的两个调用开关均为关闭——这正是注册表自身的可见性词汇——于是 `dsh-tool-skill` 不会把该名字写进 `<available_skills>` 目录，`skill` 工具拒绝加载，`/name` 手势保持普通文本。启用只是不再立墓碑，原始文件系统候选重新胜出。切换会使 provider 缓存失效，既有的目录摘要机制在下一步模型调用时自动重发布会话目录。不替换、不 fork 任何 dsh 内部实现，只使用注册表公开 API。

## 环境要求

- `dsh` CLI（developer preview；针对 npm 上的 `@deepseek-ai/*` `0.0.1-rc` 版本线测试）

## 安装

把 bundle 安装进 profile（以 `web` 为例）：

```sh
dsh plugin --profile web add github:70ic/dsh-skills-manager
```

或从本地检出安装：

```sh
git clone https://github.com/70ic/dsh-skills-manager.git
dsh plugin --profile web add ./dsh-skills-manager
```

验证组合层后启动：

```sh
dsh --profile web --dump-config   # 应出现 "# == dsh-skills-manager" 层
dsh --profile web
```

移除：`dsh plugin --profile web remove dsh-skills-manager`。

## 配置

开箱即全部 skill 可见，但 `/skills` 命令立刻可用：`/skills disable <name>`
马上对当前项目隐藏一个 skill。如需静态策略，在你自己的 profile 补丁层——`$DSH_HOME/profiles/web/cordis.patch.yml`（默认 `~/.dsh`）——里配置，它应用在所有 bundle 层之后：

```yaml
- id: skill-manager
  config:
    mode: deny-list        # 'deny-list' 隐藏 names；'allow-list' 只暴露 names
    names: [pdf, pptx]
```

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `'all' \| 'deny-list' \| 'allow-list'` | `'all'` | `all` 保持惰性。 |
| `names` | `string[]` | `[]` | kebab-case skill 名列表。 |
| `stateFile` | `string` | `<dsh home>/skill-manager.json` | 运行期覆盖持久化文件。 |

## `/skills` 命令

| 输入 | 结果 |
|---|---|
| `/skills` | 列出全部可发现 skill 及其状态和当前模式。 |
| `/skills disable <name>` | 对本项目强制禁用，持久化，下一步重发布。 |
| `/skills enable <name>` | 强制启用（可越过 `deny-list` 条目）。 |
| `/skills reset <name>` | 删除覆盖项，回到当前策略。 |
| `/skills mode` | 显示当前模式、名单及其来源层。 |
| `/skills mode all` | 恢复全部可见。 |
| `/skills mode deny-list [n1,n2,...]` | 隐藏名单内的 skill（名单可省略）。 |
| `/skills mode allow-list [n1,n2,...]` | 只暴露名单内的 skill。 |
| `/skills mode reset` | 删除运行期策略，回到设置/组合默认。 |

覆盖项按会话项目目录写入状态文件：

```json
{
  "version": 1,
  "projects": {
    "F:\\work\\project": { "disabled": ["pdf"], "enabled": ["docx"] }
  }
}
```

## 限制

- `allow-list` 的首份目录比平常晚一个模型步骤发布（需先观测一次工作区 skill 全集；期间观测刻意标记为不完整，避免闪现）。
- 会话中途新增的 skill 文件可能在一个快照中先出现、随后才被 `allow-list` 墓碑；`deny-list` 在全集加载后没有该窗口。
- 名字是精确 kebab-case 标识符，不支持通配符。
- 故意不提供面向模型的开关工具：skill 可见性是用户控制面。

## 开发

```sh
npm install
npm run build    # tsc → lib/（已提交，git 安装无需构建）
npm test         # 13 个用例，跑在真实 SkillRegistry 上
npm run smoke    # 用真实包解析路径引导构建产物
```

## 许可

MIT
