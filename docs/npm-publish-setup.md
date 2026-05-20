# npm 自动发布无脑配置教程

这份教程只需要配置一次。配置完成后，合并 Release Please 创建的发版 PR 时，会自动创建 GitHub Release、同步版本 tag，并发布到 npm。

## 你需要准备什么

- 一个 npm 账号
- 这个 GitHub 仓库的管理权限
- npm 包名 `codex-relay-cli` 的发布权限

## 第 1 步：登录 npm

1. 打开 `https://www.npmjs.com/`
2. 点击右上角 `Sign In`
3. 登录你的 npm 账号

## 第 2 步：创建 npm Token

1. 登录 npm 后，点击右上角头像
2. 点击 `Access Tokens`
3. 点击 `Generate New Token`
4. 选择 `Granular Access Token`
5. 填写：
   - `Token name`: `codex-relay-github-actions`
   - `Expiration`: 建议选 90 天、180 天，或按你自己的安全习惯选择
6. 在权限里选择可以发布 package 的权限：
   - 如果 npm 页面让你选择包，选择 `codex-relay-cli`
   - 如果包还没发布，选择允许创建/发布包的权限
7. 点击生成 token
8. 复制生成出来的 token

注意：token 只显示一次，复制后不要发给别人，不要写进代码。

## 第 3 步：把 token 填到 GitHub

1. 打开 GitHub 仓库：`https://github.com/Albert-PZY/codex-relay`
2. 点击仓库顶部的 `Settings`
3. 左侧找到 `Secrets and variables`
4. 点击 `Actions`
5. 点击 `New repository secret`
6. 填写：
   - `Name`: `NPM_TOKEN`
   - `Secret`: 粘贴刚才 npm 生成的 token
7. 点击 `Add secret`

完成后，GitHub 页面里应该能看到一个名为 `NPM_TOKEN` 的 secret。

## 第 4 步：确认仓库 Actions 已开启

1. 打开仓库顶部的 `Actions`
2. 如果页面提示需要启用 workflows，点击启用
3. 确认能看到这些 workflow：
   - `CI`
   - `Release Please`

## 第 5 步：以后怎么发布新版本

正常开发时只需要按 Conventional Commits 提交，例如：

```bash
git commit -m "feat: add new command"
git commit -m "fix: repair account rotation"
git commit -m "docs: update readme"
```

推送到 `main` 后，`Release Please` 会自动创建一个发布 PR。

你需要做的只有：

1. 打开 GitHub 的 `Pull requests`
2. 找到 release-please 创建的发布 PR
3. 确认版本号和 changelog 没问题
4. 合并这个 PR

合并后，`Release Please` workflow 会自动：

1. 创建 GitHub Release
2. 创建精确版本 tag，例如 `v0.2.0`
3. 同步大版本 tag，例如 `v0`
4. 同步小版本 tag，例如 `v0.2`
5. 执行校验并发布到 npm

## 第 6 步：怎么确认发布成功

1. 打开 GitHub 仓库的 `Actions`
2. 点击最新的 `Release Please` 运行记录
3. 看到绿色对勾表示发布成功
4. 打开 npm 包页面确认版本：

```text
https://www.npmjs.com/package/codex-relay-cli
```

用户之后就可以安装：

```bash
npm install -g codex-relay-cli
```

## 常见问题

### 发布失败，提示 401 或 authentication failed

通常是 `NPM_TOKEN` 配错了。

处理方式：

1. 回到 npm 重新生成 token
2. 回到 GitHub `Settings -> Secrets and variables -> Actions`
3. 删除旧的 `NPM_TOKEN`
4. 新建同名 `NPM_TOKEN`
5. 重新运行失败的 `Release Please` workflow

### 发布失败，提示 package name already exists

说明 npm 上已经有人占用了当前包名。

处理方式：

1. 修改 `package.json` 里的 `name`
2. 例如改成还没被占用的包名
3. 如果使用 scoped package，需要先确认对应 npm scope 存在并且 token 有权限

### 没看到 release PR

确认最近提交是否使用了 Conventional Commits 格式。

能触发版本的常见提交：

```text
feat: add account import
fix: handle quota error
```

只改文档的 `docs:` 可能不会触发新版本发布，这是正常的。
