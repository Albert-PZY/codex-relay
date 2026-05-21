# codex-relay

`codex-relay` 是官方 Codex CLI 的中转站号池管理器。它负责维护多个 `baseUrl + apiKey` 账号，在额度耗尽、鉴权失败、限流或中转站异常时自动切换账号，并尽量恢复中断的 Codex 会话继续执行。

## 安装

```bash
npm install -g codex-relay-cli
```

运行环境：

- Node.js `>=22 <23`
- 本机已经安装官方 `codex` 命令
- 交互式 Codex TUI 依赖 `node-pty`；缺少原生 PTY 时，使用 `codex-relay exec "任务"` 运行非交互任务

查看版本和帮助：

```bash
codex-relay --version
codex-relay --help
```

## 账号文件

在要工作的项目根目录准备 `data.json`。文件必须是顶层数组，每一项都是扁平账号对象：

```json
[
  {
    "baseUrl": "https://relay-a.example.com/v1",
    "apiKey": "sk-a1",
    "name": "relay-a-1"
  },
  {
    "baseUrl": "https://relay-a.example.com/v1",
    "apiKey": "sk-a2"
  },
  {
    "baseUrl": "https://relay-b.example.com/v1",
    "apiKey": "sk-b1",
    "model": "gpt-5.1-codex"
  }
]
```

字段规则：

- `baseUrl`：必填，中转站 OpenAI 兼容入口，例如 `https://relay.example.com/v1`
- `apiKey`：必填，这个中转站对应的 key
- `name`：可选，不写会按 `baseUrl` 自动生成，例如 `relay-example-com-1`
- `model`：可选，这个账号默认使用的模型

导入只支持这种 JSON 数组格式；不支持 txt、分段 `base_url`、纯 key 列表或 `{ "accounts": [...] }` 这种外层包裹格式。重复账号名或重复的 `baseUrl + apiKey + model` 会自动跳过。

## 快速开始

```bash
codex-relay setup
codex-relay "帮我完成当前项目"
```

如果本机号池还是空的，直接运行 `codex-relay "任务"` 时也会自动读取当前目录的 `data.json`。重复执行 `setup` 或自动导入不会写入重复账号。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `codex-relay setup [file]` | 从 JSON 文件初始化号池，默认读取 `data.json` |
| `codex-relay import <file>` | 从指定 JSON 文件导入账号 |
| `codex-relay add <name> --key <key> --base-url <url> [--model <model>]` | 手动添加账号 |
| `codex-relay list` | 查看账号、健康状态和占用状态 |
| `codex-relay health` | 查看冷却和已退役账号记录 |
| `codex-relay test [name]` | 对一个或全部账号做轻量预检 |
| `codex-relay use <name>` | 设置默认优先账号 |
| `codex-relay remove <name>` | 删除账号 |
| `codex-relay --account <name> "任务"` | 本次运行指定账号 |
| `codex-relay "任务"` | 启动官方 Codex，并启用自动切号和恢复 |
| `codex-relay exec "任务"` | 透传官方 Codex 的非交互 `exec` 模式 |

`codex-relay test` 只请求 `baseUrl + /models`。`OK` 表示轻量预检通过，`UNKNOWN` 表示中转站不支持这个接口或暂时无法用它判断，`FAILED` 表示明确的连接、鉴权或额度失败。真实切号不依赖 `/models`，只根据实际 Codex 对话输出判断。

## 本地文件

号池状态保存在 `~/.codex-relay/`：

- `accounts.json`：账号池
- `state.json`：默认账号、最近成功账号和多终端租约
- `health.json`：冷却、失败原因和退役记录
- `store.lock`：本机并发写入锁

Codex 配置复用官方 Codex Home。默认路径是 `~/.codex/`，如果当前环境设置了 `CODEX_HOME`，则沿用 `CODEX_HOME` 指向的目录。

每次启动或恢复 Codex 前，工具会写入当前号池账号：

- `auth.json` 里的 `OPENAI_API_KEY`
- `config.toml` 中当前 `model_provider` 对应 `[model_providers.<provider>]` 的 `base_url`

账号切换时，CLI 窗口会显示当前账号、脱敏 key、base URL 和模型，例如：

```text
[codex-relay] using relay-a (key sk-...abcd, baseUrl https://relay.example.com/v1).
```

如果本机存在多个 Codex CLI 版本，默认会使用 `PATH` 中的 `codex`。需要固定某个 Codex 可执行文件时，设置 `CODEX_RELAY_CODEX_PATH`。

## 多项目同时使用

多个项目、多个终端同时运行 `codex-relay` 时，共用同一个 `~/.codex-relay/` 号池。工具会用 `store.lock` 和 `state.json` 里的短时租约协调账号分配：

- 新终端优先选择没有被其他终端占用的账号
- `codex-relay list` 会在占用中的账号后显示 `in-use`
- 账号数量不足时才会共享同一个账号，并在 CLI 窗口提示
- 终端正常退出会释放租约；异常退出时租约会自动过期
- 需要隔离号池时，为该终端设置 `CODEX_RELAY_HOME`

所有运行实例默认复用同一个 Codex Home，因此官方 Codex 的登录状态、配置和会话历史保持一致。

## 自动切号

运行过程中，`codex-relay` 透传官方 Codex 输出，同时识别余额不足、额度耗尽、401/402/403、限流、上游异常和中转站不可用等信号。高置信失败会立即切号，中等置信失败会等 Codex 异常退出后切号。

失败账号会进入 `health.json` 冷却期，冷却中的账号会被跳过。后续真实对话成功一次，账号会恢复为可用；连续 10 天没有恢复的账号会从 `accounts.json` 移除，并保留在 `health.json` 的 `retired` 记录里。

能识别 Codex 会话 id 时，恢复命令使用 `codex resume <session-id> Continue`；识别不到时使用 `codex resume --last Continue`。

## 开发

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
pnpm pack --dry-run
```
