# codex-relay

Codex CLI 中转站号池工具。配置一次，之后直接用 `codex-relay` 跑任务；当前 key 余额不足、不可用、限额或中转站异常时，会自动切到下一个 key，并自动恢复上一次中断的 Codex 对话。

## 1. 安装

```bash
npm install -g codex-relay
```

要求：

- Node.js `>=22 <23`
- 已安装官方 `codex` CLI

## 2. 最无脑配置方式

如果你有一个纯 key 文件，比如 `data.txt`：

```txt
sk-xxx
sk-yyy
sk-zzz
```

只需要执行：

```bash
codex-relay setup data.txt --base-url https://你的中转站地址/v1 --name relay
```

它会自动生成：

```txt
relay-1
relay-2
relay-3
```

这些账号使用同一个中转站 `baseUrl`，但 key 不同。前面的 key 用不了时，会自动继续切后面的 key。

## 3. 开始使用

```bash
codex-relay "帮我完成当前项目"
```

指定从某个账号开始：

```bash
codex-relay --account relay-3 "继续刚才的任务"
```

查看号池：

```bash
codex-relay list
```

测试号池连通性：

```bash
codex-relay test
```

## 4. 其它导入方式

一行一个中转站账号：

```txt
https://relay-a.example.com/v1,sk-xxx,relay-a
https://relay-b.example.com/v1,sk-yyy,relay-b
```

导入：

```bash
codex-relay import accounts.txt --overwrite
```

JSON：

```json
{
  "relays": [
    {
      "name": "relay-a",
      "baseUrl": "https://relay-a.example.com/v1",
      "apiKeys": ["sk-xxx", "sk-yyy", "sk-zzz"]
    }
  ]
}
```

导入：

```bash
codex-relay import data.json --overwrite
```

## 5. 常用命令

```bash
codex-relay setup <key-file> --base-url <url> [--name relay]
codex-relay import <file> [--overwrite]
codex-relay add <name> --key <key> --base-url <url>
codex-relay list
codex-relay test [name]
codex-relay use <name>
codex-relay remove <name>
codex-relay [...codex 参数或 prompt]
```

## 6. 它怎么自动切号

每次运行时，工具会：

1. 读取本机 `~/.codex-relay/accounts.json`
2. 用当前账号启动官方 `codex`
3. 注入当前账号的 `OPENAI_API_KEY`
4. 用 `-c openai_base_url="..."` 临时指定中转站地址
5. 发现余额不足、quota、401、402、invalid key、部分中转站错误时自动切号
6. 切号后执行 `codex resume <session-id> Continue`
7. 没拿到 session id 时才降级 `codex resume --last Continue`

不会改你的 `~/.codex/config.toml`，也不会改官方 Codex 的登录文件。

## 7. 本地数据位置

```txt
~/.codex-relay/
  accounts.json
  state.json
  logs/
```

`data.txt`、`data.json`、`.env*` 默认不会被提交到 git。

## 8. 开发和发布

开发：

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```

配置 GitHub 自动发布到 npm：

```txt
docs/npm-publish-setup.md
```
