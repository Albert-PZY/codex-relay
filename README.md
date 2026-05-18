# codex-relay

Codex CLI 中转站号池工具。把中转站地址和 key 放进 `data.txt`，之后直接用 `codex-relay` 跑任务。第一次运行时会自动导入号池；当前 key 没余额、限额、失效或中转站异常时，会自动切到下一个 key，并自动恢复刚才中断的 Codex 对话。

## 1. 安装

```bash
npm install -g codex-relay
```

需要先装好：

- Node.js `>=22 <23`
- 官方 `codex` CLI

## 2. 准备 data.txt

最推荐直接写成这样：

```txt
base_url = "https://relay-a.example.com/v1"
sk-a1
sk-a2
sk-a3

----------------
base_url = "https://relay-b.example.com/v1"
sk-b1
sk-b2
```

也可以只有 key，然后命令里指定一个中转站地址：

```txt
sk-xxx
sk-yyy
sk-zzz
```

## 3. 直接开跑

如果 `data.txt` 里已经写了 `base_url`，可以直接执行：

```bash
codex-relay "帮我完成当前项目"
```

工具发现本机还没有号池时，会自动读取当前目录的 `data.txt` 并导入。
重复导入也没关系，已有账号名或同一个中转站 key 会自动跳过。

如果 `data.txt` 只有 key，先执行：

```bash
codex-relay setup --base-url https://你的中转站地址/v1 --name relay
```

想手动提前导入，也可以执行：

```bash
codex-relay setup
```

## 4. 常用操作

查看号池：

```bash
codex-relay list
```

指定从某个账号开始：

```bash
codex-relay --account relay-3 "继续刚才的任务"
```

测试所有账号是否能连上中转站：

```bash
codex-relay test
```

## 5. 常用命令

```bash
codex-relay setup                         # 默认读取当前目录 data.txt
codex-relay setup keys.txt --base-url <url>
codex-relay list
codex-relay test
codex-relay use <name>
codex-relay remove <name>
codex-relay add <name> --key <key> --base-url <url>
codex-relay "你的任务"
```

本机配置保存在 `~/.codex-relay/`。工具不会修改 `~/.codex/config.toml`，也不会改官方 Codex 的登录文件。

## 6. 自动发布到 npm

仓库已经配好 GitHub Actions，只需要配置一次：

1. 登录 npm，进入 `Access Tokens`，创建一个能发布 `codex-relay` 的 token。
2. 打开 GitHub 仓库 `Settings -> Secrets and variables -> Actions`。
3. 新建仓库 secret，名字填 `NPM_TOKEN`，内容粘贴刚才的 npm token。
4. 以后按 Conventional Commits 提交，例如：

```bash
git commit -m "feat: add setup command"
git commit -m "fix: handle quota rotation"
```

推送到 `main` 后，Release Please 会自动创建发版 PR；合并这个 PR 后会自动发布到 npm。

## 7. 开发

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
```
