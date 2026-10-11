# 本地同源 bundle 安装

此入口将三个已生产的本地 Inkos tgz 安装到一个明确的新目录，并读取该目录内真实 CLI/Core/Studio 的 owning manifests、导出与资源，执行该 CLI 的版本检查。它不发布 npm 包或 GitHub 资产，没有可用的公开下载链接。

## 宿主前提

- Bash 3.2+、Node.js >=22.19.0、npm 和标准 tar。bundle 保存三个包的实际 engines；若它们要求更高 Node 版本，按较高门槛检查。
- 第一阶段支持 Linux/macOS 的 Bash 入口；未提供 Windows PowerShell 安装。
- 宿主不需要 Python、jq、pnpm、Git 或编译器。脚本不安装 Node、不使用 sudo、不改全局 npm 配置或 Shell profile。

三个本地包的版本与内部依赖已固定。**第三方运行依赖仍由 npm 的正常网络/缓存解析；bundle 不是全部依赖离线自包含。** `--offline` 可用于已有 npm 缓存或自包含 fixture；缓存缺失时返回失败，不自动改为联网重试。

## 生成 bundle（作者工作区）

只在自己的隔离 checkout 构建和打包。沿用现有三包构建和 `npm pack` 流程：输入来自一个冻结源码树和它的构建产物，不使用其他运行 checkout 的 dist/node_modules。若先构建一次后用 `npm pack --ignore-scripts`，须明确执行现有 `prepare-package-for-publish.mjs`，在 `finally` 中调用 `restore-package-json.mjs`，记录命令退出码，确认 tracked manifests/lock 恢复原字节。

生产账本 JSON 的合同如下（填入已有的源提交标识；不计算 tarball SHA）：

```json
{
  "schemaVersion": 1,
  "kind": "production",
  "sourceCommit": "13107f89e2be7d9a3958e429d868e4cac4c1eaec",
  "build": {
    "command": "记录实际构建命令与环境；详细输出另存",
    "exit": 0,
    "sourceCommit": "13107f89e2be7d9a3958e429d868e4cac4c1eaec"
  },
  "pack": {
    "command": "记录实际 pack 命令及恢复检查；详细输出另存",
    "exit": 0,
    "sourceCommit": "13107f89e2be7d9a3958e429d868e4cac4c1eaec"
  },
  "packages": [
    {"name":"@actalk/inkos-core","version":"2.0.0","file":"actalk-inkos-core-2.0.0.tgz"},
    {"name":"@actalk/inkos-studio","version":"2.0.0","file":"actalk-inkos-studio-2.0.0.tgz"},
    {"name":"@actalk/inkos","version":"2.0.0","file":"actalk-inkos-2.0.0.tgz"}
  ]
}
```

```bash
node scripts/create-install-bundle.mjs \
  --pack-dir /path/to/existing-packs \
  --provenance /path/to/production-ledger.json \
  --output /path/to/new-bundle
```

输出目录必须不存在；生成器不运行构建、安装或 publish。它检查 tgz 内真正的 `package/package.json`，拒绝错名称、不同版本、无效 SemVer、runtime workspace 引用、非精确内部依赖、低于 22.19.0 的 engines、重复/逃逸路径及符号链接。版本1的 `bundle.json` 记录身份、版本、相对文件名、源提交和生产回执。提交标识是来源信息，**不是内容校验和或签名**；账本不能代替实际 build/pack 日志。

bundle 包含三个 tgz、Shell/Node 安装入口、原 release/Studio verifier，以及 release verifier 依赖的原 skills verifier 和独立的源码 skill 参考树。它不包含整棵源码或 node_modules。fixture 的账本必须标记 `kind=fixture`，不能称为真实产品交付。

## 安装到明确的新目录

```bash
bash /path/to/bundle/install.sh --prefix "/path/to/新安装目录"
# 仅使用既有 npm 缓存：
bash /path/to/bundle/install.sh --prefix "/path/to/另一个新目录" --offline
# 从 repo 入口显式指定本地 bundle：
bash scripts/install.sh --bundle /path/to/bundle --prefix /path/to/new-prefix
```

prefix 的父目录必须已存在且可写；prefix 必须不存在或是空目录，不能含符号链接祖先。未知/重复参数、缺值、非空目录、symlink prefix 和任何 bundle preflight 失败均在 npm 调用前拒绝，不修改已有目录。

安装只传三个已验证的本地 tgz 绝对路径给 `npm install --prefix ... --no-audit --no-fund`，可附加 `--offline`。不会用 registry 中的 Inkos 包名、dist-tag 或 PATH 中的旧 inkos 代替本地输入。

只有 npm 退出0、原 release verifier 的结构化报告通过且实际 `.bin/inkos` 指向已确认的 CLI，`.inkos-install-status.json` 才标记 `status=complete`，并显示精确版本、sourceCommit、prefix 和 `<prefix>/node_modules/.bin/inkos`。收据标记 `installMethod=local-bundle`。

安装失败返回非零，保留新 prefix 中的诊断和 `status=failed`；没有成功收据，不卸载、降级、回滚或删除旧用户文件。保留失败目录诊断，选择另一个新目录重试。普通安装不会启动 Studio、OAuth、模型或访问用户作品。

作者验收阶段另行执行原独立 Studio 离线 smoke，保存 JSON 和退出码：

```bash
node /path/to/bundle/verifiers/verify-installed-studio.mjs \
  --root /path/to/new-prefix --output /path/to/new-studio-evidence.json
```

## 后续版本

本阶段不实现原地或自动更新。用后续同源 bundle 安装到另一个明确的新 prefix，通过相同验证后使用新路径；不会自动激活或修改旧安装。

现有 `inkos update` 追踪 npm `@actalk/inkos` 的 latest，不能证明或更新这份本地 fork 组合。`13107f` bundle 不默认包含 updater `2d64`、length `4975` 或 validator `b0f` 候选；只有父任务明确指定的新同树基线才可纳入并重记来源。
