# codex-relay

`codex-relay` 是官方 Codex CLI 的中转站号池外壳。你只需要准备一个本地 `data.json`，里面放中转站 `baseUrl` 和对应 `apiKey`；工具会自动导入、自动去重、额度异常时自动切号，并尽量恢复上一次中断的 Codex 对话继续执行。

## 安装

```bash
npm install -g codex-relay-cli
```

需要先准备好：

- Node.js `>=22 <23`
- 官方 `codex` CLI
- 交互式 Codex TUI 需要 `node-pty` 可用；如果你的环境装不上它，请用 `codex-relay exec "任务"` 跑非交互任务

## 第一次使用

在你要工作的项目根目录新建 `data.json`。文件必须是顶层数组，每一项都是一个账号对象：

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

字段规则很少：

- `baseUrl`：必填，中转站地址，例如 `https://relay.example.com/v1`
- `apiKey`：必填，这个中转站对应的 key
- `name`：可选，不写会自动生成，例如 `relay-example-com-1`
- `model`：可选，指定这个账号默认使用的模型

只支持这种 JSON 文件导入；不支持 txt、分段 `base_url`、纯 key 列表或 `{ "accounts": [...] }` 这种包一层的格式。

然后直接运行：

```bash
codex-relay "帮我完成当前项目"
```

如果本机号池还是空的，工具会自动读取当前目录的 `data.json` 并导入。重复运行也没关系，重复账号名或重复的 `baseUrl + apiKey + model` 会自动跳过，不需要你手工排重。

## 常用命令

```bash
codex-relay setup                         # 导入当前目录 data.json
codex-relay setup ./my-relays.json        # 导入指定 JSON 文件
codex-relay import ./my-relays.json       # 同样导入 JSON 文件
codex-relay add relay-a --key <key> --base-url <url>
codex-relay list
codex-relay health
codex-relay test
codex-relay use <name>
codex-relay remove <name>
codex-relay --account relay-a "继续任务"
codex-relay "你的任务"
```

`codex-relay test` 只是轻量预检：`OK` 表示 `/models` 预检通过，`UNKNOWN` 表示中转站不支持这个接口或暂时无法用它判断，不代表不能正常对话，`FAILED` 才是明确不可连、鉴权失败或额度失败。

本机号池和健康状态保存在 `~/.codex-relay/`。运行 Codex 时会复用官方 Codex 的 `~/.codex/`，并按当前号池账号更新 `auth.json` 里的 `OPENAI_API_KEY` 和 `config.toml` 里当前模型 provider 的 `base_url`。

## 多项目同时使用

多个项目、多个终端同时运行 `codex-relay` 时，共用同一个 `~/.codex-relay/` 号池。工具会自动协调，不需要你手动分配 key：

- `accounts.json`、`state.json`、`health.json` 的读写会经过本地 `store.lock`，避免多个终端同时写坏配置或互相覆盖状态。
- 每个正在运行的终端会在 `state.json` 里登记一个短时租约。新终端启动时会优先选择没有被其他终端使用的账号。
- `codex-relay list` 会在正在占用的账号后显示 `in-use`。
- 如果号池账号数量不够，所有可用账号都已经被占用，才会共享同一个账号，并在 CLI 里提示这个账号正在被其他终端使用。
- 所有运行实例复用官方 Codex 的 `~/.codex/` 配置和历史。账号分配仍由 `~/.codex-relay/state.json` 的租约协调。
- 终端正常退出会释放租约；异常退出时租约会自动过期，不会长期占住账号。
- 如果你想让某个项目使用独立号池，可以给该终端设置 `CODEX_RELAY_HOME` 指到另一个目录。

## 自动切号

每次启动 Codex 前，工具会把当前账号写入官方 Codex 配置：`auth.json.OPENAI_API_KEY` 和当前模型 provider 的 `base_url`。如果输出里出现余额不足、额度耗尽、401/402、限流或中转站暂不可用等信号，会自动换下一个可用账号并重新写入配置。

交互式模式会用 PTY 承载官方 Codex TUI，并自动处理 raw mode、窗口尺寸变化和退出后的终端恢复。缺少 PTY 时，工具不会用普通 stdin/stdout 管道硬跑交互界面，因为那种方式容易出现输入无响应、界面错乱。

能识别到 Codex 会话 id 时，会用 `codex resume <session-id> Continue` 恢复；识别不到时会退回 `codex resume --last Continue`。

真实切号不依赖 `/models`。工具只根据 Codex 实际对话输出判断 key 是否失败：鉴权失败、额度耗尽、限流、上游异常会写入 `~/.codex-relay/health.json`，冷却中的 key 会被跳过。key 后续真实对话成功一次就自动恢复为可用；如果连续 10 天没有恢复，会自动从号池移除，并保留在 `health.json` 的 retired 记录里。用 `codex-relay health` 可以查看当前状态。

## 开发

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```
