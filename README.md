# InkOS

**持续创作，独立分发。** InkOS 将小说、短篇、剧本、分镜、互动内容、翻译和文章放在同一个 durable 执行基座上。CLI、TUI 与 Studio 连接同一项目 runtime；不需要发布平台也能完成稿件。

[English](README.en.md) · [日本語](README.ja.md) · [操作与配置](docs/runtime.md) · [CLI 命令](packages/cli/README.md)

## 安装与快速开始

需要 **Node ≥22.19.0**。仓库开发使用 **pnpm 11.3.0**。以下是 InkOS 2 的命令；本分支尚未发布 npm 新版本。

```sh
npm install -g @actalk/inkos
mkdir manuscript && cd manuscript
inkos init --lang ja
inkos up
```

`up` 启动或连接唯一项目 runtime，并启动 Studio（默认 `http://127.0.0.1:4567`）。只启动后台 runtime 可用 `inkos up --no-studio`。`inkos tui` 打开终端界面；退出界面或关闭网页不会取消后台工作，明确停止用 `inkos down`。

无需模型的稿件导入示例：

```sh
inkos work create --id letters --title '夜の手紙' --locale ja \
  --review '{"enabled":false}'
inkos write letters --file ./draft.txt --request-id import-first --wait
inkos work show letters
inkos tasks tree
# 从 work show 的 artifactIds 选择产物 ID
inkos export <artifact-id> --format epub
inkos down
```

模型创作前，查看官方目录、登录并选择模型：

```sh
inkos models list
inkos models login <provider-id> --type api_key  # 支持的提供商也可用 oauth
inkos models set <provider-id> <model-id>
inkos work create --id story --title 'My story' --locale fr-FR \
  --brief 'Author intent, setting, voice and desired scope'
inkos write story --wait
```

普通交互通过 `inkos agent 'message'` 或 TUI 发起 SDK 原生 Submission。需要重试同一请求时复用明确的会话和请求 ID；刷新或 SSE 重连只读取状态，不重发请求。模型调用和图片生成可能产生费用，使用前自行配置并授权。

## 创作 SOP

1. 保存作者意图、locale、profile 和计划；研究与规划按需使用，不强制商业模板或固定章数。
2. durable 内容任务读取素材、专业领域数据和前文，生成／编辑一个内容单元。
3. 按策略审稿：普通建议不阻断；真实矛盾或作者要求才触发必要修订。相同版本与策略复用审稿结果；模型执行失败保留草稿，不自动无意义重写。
4. 保存稳定版本 ID 的文件产物和领域状态。导出、后续创作与各目标分发分别进行。

内置 profile：`fiction`、`short-fiction`、`script`、`storyboard`、`interactive-film`、`play`、`translation`、`article`。专业 JSON 结构通过 profile 解析，不把剧本、剧情树或互动世界压平为小说章节。外部官方 Extension 可增加 profile、工具、任务或发布描述，不需要修改核心枚举。

有限目标配置 `units`，连载配置 `serial`；存稿配额与日历配置在 `production`。计划可在开始后修改，影响后续相关步骤而非覆盖已保存稿件。暂停是持久化步骤边界意图，取消使用 SDK 原生 abort；明确重试会建立新任务，不复活终止任务。

## 创作与发布分离

一个作品可绑定多个独立目标。存稿直接派生目标的 durable 分发任务，消费 `ArtifactRevision`，无需手动导出发布包。改稿保留同一逻辑产物，不自动重复发布；已提交／已发布内容要使用明确 `operation:update`。

默认发布能力为通用 `browser` 和 `meganovel`。二者通过官方 `pi-mcp` 与 Playwright MCP 工作，分别声明建书、发布和更新能力；未实现站点不列为默认能力。目标绑定账号，浏览器可用持久化用户目录或配置的 CDP 连接，不依赖易失 tab ID。

稿件完成、已提交、审核中、已发布是不同状态。外部操作前保存意图，中断或不确定结果先观察，不宣称远端副作用恰好一次。登录、验证码、实名、付款或新合约成为对应目标的用户待办，不停止作者写作或其他目标。配置方法见[操作文档](docs/runtime.md#publishing)。

## 数据与迁移

- `.inkos/durable.sqlite`：唯一执行库，SDK 管理会话、Submission、任务树、恢复、压缩和用量。
- 领域 Documents：作品、计划、故事／专业状态、版本引用、暂停意图与分发记录。
- `.inkos/artifacts/<work>/<artifact>/<revision>/`：正文、图片和附件。
- `.inkos/materials/`：可检索的来源材料；`.inkos/credentials.json`：官方提供商凭据，勿提交。

```sh
inkos work migrate --source /path/to/legacy --json       # 默认只读预览
inkos work migrate --source /path/to/legacy --apply --json
```

迁移保留原 ID、历史正文版本、素材引用、可用历史、暂停／取消／完成意图与远端映射；不改写旧数据库和原稿。重复应用不重复创建作品或任务。旧模型历史是可读历史与业务步骤，不能假装无缝续接为 SDK 模型会话；不确定发布状态进入观察。请先备份并检查预览，勿把新旧执行器同时运行在同一项目上。

## 三包开发与验收

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm test:flows
pnpm --filter @actalk/inkos-studio test:e2e
pnpm test:install
```

`core` 提供官方 SDK runtime、领域服务与扩展；`cli` 是命令／TUI 客户端；`studio` 是分域 Hono 路由与浏览器界面。开发和 CI 使用同一版本的 pnpm，三个包通过原生 `pnpm pack` 转换工作区依赖。安装冒烟在干净目录安装三个 tarball，并实际启停 CLI、runtime 与 Studio。

架构与删除决策见 [.opensdlc/architecture.md](.opensdlc/architecture.md)；迁移、实际验收和剩余缺口见 [.opensdlc/delivery.md](.opensdlc/delivery.md)。

**验收边界：** 本次本地交付不调用真实模型、不登录账号、不创建或提交真实平台作品。真实模型创作和 MegaNovel 建书／首章提交／状态观察／重启去重闭环未配置、未执行。SDK、SQLite、子进程和浏览器协议测试不是平台成功或文学质量的证明。

## License

[AGPL-3.0-only](LICENSE)。历史版本变更保留在 [CHANGELOG.md](CHANGELOG.md)，其中旧命令不适用于 InkOS 2。
