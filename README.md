# codex-relay

`codex-relay` 是官方 Codex CLI 的中转站号池外壳。你只需要准备一个本地 `data.json`，里面放中转站 `baseUrl` 和对应 `apiKey`；工具会自动导入、自动去重、额度异常时自动切号，并尽量恢复上一次中断的 Codex 对话继续执行。

## 安装

```bash
npm install -g codex-relay
```

需要先准备好：

- Node.js `>=22 <23`
- 官方 `codex` CLI

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
codex-relay test
codex-relay use <name>
codex-relay remove <name>
codex-relay --account relay-a "继续任务"
codex-relay "你的任务"
```

本机数据保存在 `~/.codex-relay/`。工具不会修改 `~/.codex/config.toml`，也不会改官方 Codex 的登录文件。

## 自动切号

每次启动 Codex 时，工具会给官方 `codex` 子进程注入当前账号的 `OPENAI_API_KEY`，并传入对应的 `openai_base_url`。如果输出里出现余额不足、额度耗尽、401/402、限流或中转站暂不可用等信号，会自动换下一个可用账号。

能识别到 Codex 会话 id 时，会用 `codex resume <session-id> Continue` 恢复；识别不到时会退回 `codex resume --last Continue`。

## 开发

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```
