# codex-relay 架构说明

`codex-relay` 是一个极轻量的 Codex CLI 中转站号池管理器。它不接管用户的 Codex 配置文件，只是在外层管理一组 `baseUrl + apiKey` 账号，并在需要时自动切号、自动恢复上下文、自动继续执行未完成任务。

## 技术栈

- Node.js 22 LTS：单一主版本，减少兼容分支。
- TypeScript + ESM：类型清晰，最终产物仍然是标准 Node CLI。
- commander：命令解析轻，够用且直接。
- zod：本地 JSON 文件和导入数据校验。
- Vitest：覆盖核心逻辑和 CLI 行为。
- pnpm：开发、测试、打包和 CI 统一使用。
- GitHub Actions + Release Please：自动校验、自动发版、自动发布 npm。

## 主要功能

- 账号管理：`add`、`list`、`use`、`remove`
- JSON 导入：`import`、`setup` 和首次自动运行都只读取顶层数组 JSON
- 自动去重：重复账号名、重复 `baseUrl + apiKey + model` 自动跳过
- 自动切号：遇到额度、鉴权、限流或中转站异常时自动切换到下一个账号
- 上下文恢复：尽量恢复中断前的 Codex 会话
- 原子写入：账号池和状态文件使用临时文件 + rename

## 目录结构

```text
src/
  cli.ts              # 命令入口和自动导入入口
  core/
    accounts.ts       # 账号池读取、导入、去重、保存
    runner.ts         # Codex 子进程启动、输出检测、切号
    detector.ts       # 额度和异常信号识别
    rotator.ts        # 切号顺序和可用性判断
    state.ts          # 本地运行状态
  utils/
    atomic.ts         # JSON 原子读写
    paths.ts          # 本机数据目录
```

## 架构图

```mermaid
flowchart LR
  User[用户命令<br>codex-relay] --> CLI[src/cli.ts<br>命令入口<br>setup/import/auto-import]
  CLI --> ACC[src/core/accounts.ts<br>JSON 导入<br>去重<br>原子保存]
  CLI --> RUN[src/core/runner.ts<br>启动 Codex<br>识别异常<br>自动切号]
  RUN --> DET[src/core/detector.ts<br>额度和错误识别]
  RUN --> ROT[src/core/rotator.ts<br>账号选择和可用性判断]
  RUN --> STA[src/core/state.ts<br>成功账号和重试窗口]
  ACC --> AJSON[(~/.codex-relay/accounts.json)]
  STA --> SJSON[(~/.codex-relay/state.json)]
  RUN --> CODEX[官方 Codex CLI]
```

## 执行流程

```mermaid
sequenceDiagram
  participant User as 用户
  participant CLI as codex-relay
  participant Pool as 本机账号池
  participant Codex as 官方 Codex CLI
  User->>CLI: codex-relay "任务"
  CLI->>Pool: 如果账号池为空<br>自动读取 data.json
  CLI->>Pool: 导入时自动跳过重复账号名<br>跳过重复凭据
  CLI->>Codex: 注入 OPENAI_API_KEY<br>传入 openai_base_url
  Codex-->>CLI: 输出正常内容或错误内容
  CLI->>CLI: 检测余额不足<br>限流<br>401/402<br>中转站异常
  CLI->>Codex: 切到下一个账号<br>resume Continue
  CLI->>Pool: 成功后记录当前账号和状态
```

## 数据约定

本机账号池保存在 `~/.codex-relay/accounts.json`，状态保存在 `~/.codex-relay/state.json`。

- `accounts.json`：`version`、`preferred`、`customQuotaPatterns`、`accounts`
- 单条账号：`name`、`apiKey`、`baseUrl`、可选 `model`、`addedAt`
- `data.json`：导入文件只接受顶层数组，每项是扁平对象

项目根目录里的 `data.txt`、`data.json`、`切号工具.md` 都被 `.gitignore` 忽略。

## 导入规则

1. 读取 JSON 文件。
2. 只接受顶层数组。
3. 每项必须包含 `baseUrl` 和 `apiKey`，`name` 和 `model` 可选。
4. 如果 `name` 重复，跳过。
5. 如果 `baseUrl + apiKey + model` 重复，跳过。
6. 如果 `name` 缺失，按 `baseUrl` 自动生成一个可读名字。
7. 只追加新增账号，不重写已有数据。

## 发布流程

```mermaid
flowchart LR
  Commit[Conventional Commits] --> CI[CI<br>pnpm lint<br>pnpm test<br>pnpm build<br>pnpm pack --dry-run]
  CI --> RP[Release Please]
  RP --> Merge[合并发版 PR]
  Merge --> Release[GitHub Release<br>精确版本 tag]
  Release --> Tags[同步 v主版本<br>同步 v主版本.次版本]
  Tags --> Publish[npm publish]
  Publish --> Users[全球安装使用]
```

发布前只需要在 GitHub 仓库里配置一次 `NPM_TOKEN`，具体步骤见 [docs/npm-publish-setup.md](docs/npm-publish-setup.md)。
