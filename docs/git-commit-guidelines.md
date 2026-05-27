# Git 提交与版本发布规范

本项目采用 [约定式提交 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/) 管理提交信息，并通过 Release Please 自动生成版本、CHANGELOG、GitHub Release 和 npm 发布流程。

## 提交格式

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

常用写法：

```text
feat: add relay account import command
fix(rotation): skip unavailable accounts
docs: simplify setup guide
ci: publish package after release
feat!: change account file schema
```

## type 取值

- `feat`: 新功能或新增用户可感知能力。
- `fix`: 修复 bug 或异常行为。
- `docs`: 只修改文档。
- `test`: 只新增或修改测试。
- `refactor`: 不改变外部行为的代码整理。
- `perf`: 性能优化。
- `ci`: GitHub Actions、发布流水线等 CI/CD 变更。
- `build`: 构建系统、打包配置、依赖范围变更。
- `chore`: 仓库维护、脚手架、非业务性调整。
- `style`: 只改格式，不改语义。
- `revert`: 回滚历史提交。

## 提交粒度

- 不同功能分开提交，例如导入逻辑、发布 workflow、README 修改不要混在一个提交里。
- 每个提交只表达一个清晰意图，描述使用英文小写开头，末尾不加句号。
- 不提交本地密钥、运行数据、打包产物和临时验证文件。
- 涉及行为变化时，提交前至少运行对应测试；发布相关变更还要运行完整验证。

## 破坏性变更

破坏性变更必须显式标记，二选一即可：

```text
feat!: change relay import schema
```

或：

```text
feat(import): change relay import schema

BREAKING CHANGE: import files now require a flat JSON array.
```

只要出现 `!` 或 `BREAKING CHANGE:`，Release Please 会按主版本发布处理。

## 版本号规范

本项目使用 SemVer：`MAJOR.MINOR.PATCH`。

- `fix` 对应 `PATCH`，例如 `0.2.0` -> `0.2.1`。
- `feat` 对应 `MINOR`，例如 `0.2.0` -> `0.3.0`。
- `!` 或 `BREAKING CHANGE:` 对应 `MAJOR`，例如 `0.2.0` -> `1.0.0`。
- `docs`、`test`、`refactor`、`ci`、`build`、`chore` 默认不触发版本号提升，除非带有破坏性变更标记。
- 当前仍处于 `0.x` 阶段时，也按上述规则写提交；是否升到 `1.0.0` 由 Release Please 的版本 PR 和维护者合并动作决定。

## 发布规则

- 不手动修改 `package.json` 版本号，除非自动化发布链路故障且已经明确需要人工修复。
- 合并 Release Please 创建的发布 PR 后，GitHub Actions 会创建精确 tag：`vX.Y.Z`。
- 每次发布会同步维护主版本 tag `vX` 和次版本 tag `vX.Y`，都指向对应发布提交。
- npm 发布由 GitHub Actions 使用仓库密钥 `NPM_TOKEN` 自动完成。
- 如果 GitHub Release 已经创建但 npm 发布失败，修复 `NPM_TOKEN` 后再次推送到 `main`，CI 会检测 npm 缺失的当前版本并补发。

## 推荐命令

提交前运行：

```bash
npm run lint
npm test -- --coverage
npm pack --dry-run
git diff --check
```

提交示例：

```bash
git add docs/git-commit-guidelines.md
git commit -m "docs: add git commit and versioning guide"
git push origin main
```
