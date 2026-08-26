# 当前状态

最后更新：2026-08-26

## Windows Support Phase 1 本地候选（2026-08-26）

- 基于 `e5926e9c4f01cddc2a1a7157348e3bd828a83b48` 建立 Windows 本地候选：安装器允许
  Windows 配置写入，使用 Windows Credential Manager 与当前用户 owner-only ACL，不使用
  `.env`、长期环境变量或明文文件保存 Provider credential。
- Credential Manager helper 通过一次性认证的随机 named pipe 传输 secret；Provider secret
  不进入 argv、环境变量、文件、stdout 或 stderr。合成凭据 write/read/match/delete/read-after-delete
  已在 Windows 11 原生后端通过并完成清理。
- Installer dry-run/apply/second apply、Doctor、Verifier、uninstall/second uninstall 已在隔离
  Windows fixture 通过；卸载会恢复安装前已有文件的原始 Windows security descriptor；
  真实用户 Codex config 哈希、长度和时间戳保持不变。
- Windows 配置可就绪，但 Provider runtime 明确保持 `BLOCKED_PENDING_PHASE_2`，
  `runtimeVerified=false`；External 保持 default-off，本任务 Provider requests 为 `0`。
- macOS 测试发现与行为保留完整；Windows 测试入口显式跳过依赖 macOS POSIX 权限、进程和
  External runtime contract 的 Phase 2 suites，不将它们伪装成 Windows runtime 证据。

## Windows Release-artifact independent clean-install evidence（2026-08-26）

- `WINDOWS RELEASE-ARTIFACT CLEAN INSTALL E2E = BLOCKED`：公开
  `v0.4.0-beta.3` 的 `.tgz` 在 Windows 上完成 SHA-256 完整性核对，作为 npm 依赖安装
  通过，Windows package-bin shim 可用，安装器 dry-run 通过。
- 两次 installer `--apply` 均在托管文件写入前安全阻断，返回
  `codex-third-party-subagents is macOS-only (darwin)`；隔离 fixture 在两次尝试后仍为空。
  这表示 Windows runtime/apply 尚不支持，不是 Release artifact 安装失败。
- 当前凭据实现是 macOS Keychain command-backed 路径（`/usr/bin/security`）；Windows
  Credential Manager、DPAPI 或其他受支持的安全凭据后端尚未实现。不要用明文 `.env` 或
  长期 `DEEPSEEK_API_KEY` 环境变量绕过这一边界。
- 独立 Windows 检查使用 Codex CLI `0.141.0`，它处于精确 Flash 生产验证边界
  `0.149.0` 之外；这不是将 `0.141.0` 外推为普遍不兼容，而是保持两条证据边界分开。
- Windows Provider-backed E2E 未运行，Flash、Pro、MiniMax、Qwen 请求均为 `0`；Verifier
  保持 `providerResolved=false`、`taskDelivered=false`、`runtimeExecuted=false`、
  `runtimeVerified=false`、`configurationReady=false`、`ready=false`。测试期间没有读取、
  打印、持久化或发送任何 API key，Windows 测试机源代码未改变。
- 该独立 Windows artifact/dry-run 证据不改变 macOS `0.4.0-beta.3` Public Beta 的维护者
  E2E 证据；当前公开 runtime/apply 支持仍限定为 macOS。

## DeepSeek V4 Flash `0.4.0-beta.3` 公开 Beta

- 已接受的 `d492dbcf81f8840fb169ca2ca3711fe6d9a1022b` RC 已通过 PR #15 合并到公开仓库
  `main`；发布提交为 `0906c624d83a41ff431aafa6962b0289cf27eba6`，轻量 tag
  `v0.4.0-beta.3` 与 GitHub prerelease 已发布。
- `main` 与 tag GitHub Actions 均通过。Release 资产
  `codex-third-party-subagents-0.4.0-beta.3.tgz` 为 66 文件，SHA-256
  `a8bdc59d56cd9bba626f688a23cf0e2e8f2f1679bfa72fc837c6023c329c81dd`；下载回读与
  fresh install 通过。npm registry 未发布。
- 打包干净安装 External 路径已在 macOS 与精确 Codex CLI `0.149.0` 上完成一次有边界的
  维护者 E2E，严格本地安装证据中 `providerResolved`、`taskDelivered`、`runtimeExecuted`、
  `runtimeVerified` 均为 true；challenge、Doctor/Verifier 与 fresh-process persistence 通过。
- External 仍需显式启用并保持 default-off；Provider API 单独计费，Keychain 认证保持
  command-backed，Codex 仍是主代理。V4 Pro 继续 explicit-only，MiniMax/Qwen 边界不变。
- 这是公开 Beta 与维护者验证证据，不等于广义独立用户验收，也不代表 OpenAI 或 Provider
  官方背书。npm/package registry 发布没有既有历史，继续仅使用 GitHub Release 分发。

## Flash production catalog contract 与离线 release hardening（历史本地证据）

- 已修复 clean-install 将 minimal unit-test catalog 提升为 production `model_catalog_json`
  的缺陷。新增精确 Codex CLI `0.149.0` / DeepSeek V4 Flash production catalog contract，
  覆盖全部本地解析必需字段、nested shape/type/bounds、唯一目标模型、文本 modality 与
  instructions/template 约束；仅改名不能绕过语义验证。
- production runner 在 execution permit 创建、maintainer/fixture ledger 增量、slot、execution
  tree 和 child launch 前完成 catalog snapshot/validation；invalid catalog 回归证明 ledger `0`、
  无 active slot、无 execution tree、无 strict success evidence。真实 Codex `0.149.0` 使用
  unreachable loopback endpoint 与 fake credential 的离线探针已捕获 `thread.started`，未连接 Provider。
- `0.4.0-beta.2` tarball 已本地构建并在全新隔离 fixture 完成 dry-run/apply、重复 apply、
  fresh-process Doctor/Verifier、uninstall、第二次安全失败与 reinstall；artifact 包含 validator，
  不含 tests/ledger/evidence，installed `src/`/`scripts/` 与 worktree 一致，无 developer-tree dependency。
- 完整 `npm test`、artifact/source/fixture secret 与 personal-path scan、`git diff --check` 和
  Codex Security diff scan 均通过；Security scan 覆盖 13 个 changed production surfaces，
  `0` findings。历史 maintainer ledger 仍为 `3/3`，失败 clean fixture ledger 仍为 `1/3`，
  本任务 Provider request 为 `0`，Keychain 仅检查存在性且未修改/暴露。
- 本节记录 Provider-backed E2E 之前的历史离线状态；后续独立 Handoff 已完成唯一一次授权的
  installed-artifact Flash E2E，并由 ChatGPT 接受为 Beta RC。External 普通路由仍 default-off，
  独立用户验收仍未完成。

## Flash beta clean-install release readiness（历史 PARTIAL）

- 基于 Phase 3 接受基线 `d34b26d086d6e6e882786d8a9c91337a70c1a677` 在专用
  worktree 完成可发布 tarball、隔离 clean fixture、本地 tarball 安装、dry-run/apply/幂等、
  negative gates 与迁移回归；完整 `npm test` 为 `212/212` PASS，Codex Security 扫描
  为 `0` findings。
- Installer 仅对精确 `DeepSeek / deepseek-v4-flash / external` beta tuple 开放显式配置写入；
  全局 External registry/factory、feature gate 与 runtime route 仍 default-off。CLI 的
  `--home-dir` 允许隔离安装/Doctor/Verifier/uninstall，strict evidence 绑定 owner-only
  installation identity 与 canonical runtime root，跨 fixture 复制和 legacy unbound evidence
  均 fail closed。
- 本任务授权的唯一一次实际 Provider 请求已发出且失败，未重试。历史账本 `2/3 -> 3/3`，
  clean fixture 账本 `0/3 -> 1/3`，两者新增 outcome 均为 `failed`；child exit `1`，没有
  `thread.started`，因此 `providerResolved/taskDelivered/runtimeExecuted/runtimeVerified`
  均为 `false`，没有 strict success evidence。
- 失败后 active slot 与相关进程均不存在，配置仍持久化，Doctor/Verifier 未增加请求。
  按验收停止条件，uninstall/reinstall 未执行；当前 `BETA_READINESS =
  NOT_READY_FOR_FLASH_BETA_RC`。改动保持 uncommitted，未 push/merge/tag/release/deploy/publish。

## External Transport Phase 3 Flash production E2E（本地已验证）

- 在专用 worktree 完成受控 DeepSeek V4 Flash production path：全局 registry/factory
  继续 default-off，仅显式 feature gate、billable authorization、精确 Provider/Model、
  `read-only`、single-slot 与单调请求账本共同允许执行。
- 修复 production child 将 `HOME` 与隔离 `CODEX_HOME` 混同导致 Keychain lookup exit `44`
  的问题：`CODEX_HOME` 保持隔离，`HOME` 来自当前 macOS 用户数据库并经过 absolute/owner/
  realpath/symlink 校验；child env 仍为最小 allowlist，不含 credential 变量。
- 新增 exact child-context credential preflight；它在 live ledger 增量和 child launch 前执行
  同一条 command-backed Keychain lookup，只保留 exit/present/non-empty/normalization 安全
  元数据，不打印、持久化、哈希或注入 credential value。非零和空输出均 fail closed。
- 首次入口检查在 Provider 请求前发现历史 execution tree 的已审核 Codex `arg0` symlink
  验证范围过窄；账本保持 `1/3`。修复后只允许 bounded execution path 下指向已验证 Codex
  executable/package runtime 的三个已审核链接。
- 最终非网络门禁通过：`npm test` 为 `208/208` PASS、`git diff --check` PASS、Codex
  Security diff scan 覆盖 17 个 production source surface 且 `0` findings；secret/personal-path、
  active import、BUSY/ledger/evidence spoofing 与 Native/provider policy 回归通过。
- 本任务仅发出 `1` 次实际 Provider 请求；持久账本 `1/3 -> 2/3`，第二条为 `completed`。
  strict local evidence 为 `providerResolved=true`、`taskDelivered=true`、
  `runtimeExecuted=true`、`runtimeVerified=true`、challenge verified。Doctor/Verifier 前后账本
  均为 `2`，没有额外 Provider 请求，active slot 已释放。
- 该证据仅适用于本机、当前 source、exact Codex CLI `0.149.0` 和 DeepSeek V4 Flash
  controlled runner；public External install/auto routing 仍禁用，Native `0.149.x` 仍 blocked，
  Pro/MiniMax/Qwen 未收到请求，独立用户验收、push/merge/tag/release/deploy/publish 均未完成。

## External Transport Phase 2 control plane（本地 checkpoint）

- 基于 Phase 1 commit `4f0a10a7719426bd9b73d664250ac1489a5ae2c5` 在独立
  worktree/branch 接入 control plane；原 main worktree 的 catalog safety、HTML 与状态文档
  修改未混入。
- 新增 `transport-control-plane`、`transport-readiness` 与 `transport-verification`：
  Doctor 分开报告 Native/External，Verifier 分开配置/发现/Provider/runtime evidence，
  Preflight 只返回 `ALLOW|BLOCK|REQUIRE_EXPLICIT|BUSY`，Installer dry-run 描述
  `auto|native|external`。
- 当前 Codex `0.149.x` Native 继续 `BLOCKED`。External adapter registry 仍为
  `enabled: false` / `factory: null`，Phase 2 feature gate 与 runtime-route gate 也为
  `false`；External `--apply` 在 catalog、Keychain 与写入前 fail closed，active bridge
  只接受 Native `ALLOW`。
- Flash 的 controlled maintainer evidence 与本机安装 evidence 严格分开；result 自报不能
  证明 Provider。Pro 继续 explicit-only 且 External evidence 为 `UNKNOWN`；MiniMax/Qwen
  External evidence 也未扩大。无可接受本机证据时 `runtimeVerified` 保持 `false`。
- 完整本地 `npm test` 为 `189/189` PASS；本阶段第三方 live request 为 `0`。package
  version 仍为 `0.4.0-beta.2`，README availability claim、发布状态与现有 Provider/fallback/
  migration/uninstall policy 未提升或改变。

## External Transport Phase 1 production adapter（本地 checkpoint）

- 基于正式架构 commit `502cd981b2c39ed37ae6252a2d7730c67f255b1a`
  在独立分支实现 production `External Codex` adapter；未修改 Spike checkpoint，也未混入
  原 main worktree 的 catalog safety / HTML material。
- 新增 `src/transports/` 正式模块，覆盖 adapter contract、最小隔离配置、argv-safe launcher、
  lifecycle supervisor、single-slot、严格 result/evidence parser、workspace/parent snapshot、
  centralized redaction 与 owner-only atomic archive；production `src/**` 不依赖 Spike。
- 每次执行使用独立 `CODEX_HOME`、最小 env allowlist、`0700` 目录和 `0600` 文件；只允许
  `read-only` / `workspace-write`，明确拒绝 `danger-full-access`。凭据保持
  command-backed Keychain contract，adapter 不读取 secret value。
- `external-codex` registry 明确为 `enabled: false` / `factory: null`，production execution
  fail closed；仅本地 dependency-injected fake child 测试可直连 adapter。Installer、Doctor、
  Verifier、Preflight、active routing/bridge、Native path 与 fallback/provider policy 均未接入或改变。
- 新增 37 项 production adapter/fake-child 测试；完整本地 `npm test` 为 `158/158` PASS。
  本阶段第三方 live request 为 `0`，fixture evidence 不提升 `runtimeVerified`，package version、
  README support claim 与发布状态不变。

## External Transport 正式架构（本地 checkpoint）

- 基于 External Child runtime checkpoint
  `956b193a570c9c42d46cbaca0cca2490b1eb69d8` 创建独立架构分支；原 main
  worktree 的 catalog safety 与 HTML material 未混入。
- 正式确立 `Role != Provider != Model != Transport`：保留 Native adapter，并新增
  External Codex adapter 的正式契约；`0.149.x` Native 继续由 Host compatibility
  contract fail closed。
- 新增纯 `transport-contract`、`transport-evidence`、`transport-selection` 模块，覆盖
  request/result、权限、生命周期状态机、anti-spoof evidence、provider-policy-first
  selection、explicit-only、single-slot busy 与无 silent fallback。模块尚未接入 Installer、
  Doctor、Verifier、Preflight、routing 或 active bridge。
- 新增 19 项纯 contract 测试；完整本地 `npm test` 为 `121/121` PASS，Markdown
  internal links、diff check、secret/personal-path scan 均通过。
- 已形成正式 Transport、External、Security、ADR 与六阶段实施计划文档。Threat Model
  覆盖 credential、argv/env/config、prompt/cwd/symlink、archive/result/provider spoof、
  orphan/timeout/race、并发、恶意输出、日志与 parent contamination。
- DeepSeek V4 Flash / External 仅记录 exact Codex CLI `0.149.0` 的 controlled
  maintainer fixture evidence；public installer/local installation/independent user 仍未验证。
  Pro External、MiniMax External 与 Qwen External 均保持 `UNKNOWN`；Pro 在任何
  Transport 下继续 explicit-only。
- 本任务不发起第三方 API 请求，不改变 package version、发布状态或 production runtime。

## Host compatibility contract（本地候选分支）

- 当前基线为 `origin/main` `6c317a7751216e9cdb6c346245d34e5e28633ade`；当前 CLI 为
  `0.149.0`，Desktop bundled Codex 为 `0.149.0-alpha.4.1`。
- 官方 `0.149` bounded role override 支持 `model`、`model_reasoning_effort`、
  `developer_instructions` 以及 skills/features reductions；role 内的 `model_provider`、
  `model_providers`、`model_catalog_json`、Provider endpoint/auth 值不生效，实际值继承父线程。
- 新增 version-scoped Host compatibility contract：精确 `0.147.0` 的既有 Flash/Pro
  记录为 **HISTORICAL RUNTIME VERIFIED**；`0.149.x` line 为 Level C Host Blocked；
  `0.148.x` 和其他未经验证版本为 Level D Unknown。没有建议用户降级或静默 pin 旧版本。
- `multi_agent=true` 不再等于 cross-provider child supported。Doctor 会分开显示原生
  multi-agent 与 Host cross-provider 状态；Installer 在 Level C/D 仍允许 inspect、Doctor、
  dry-run 和 migration analysis，但 `--apply` 在任何写入前停止。
- 运行时 preflight 会在 provider readiness 和 bridge creation 前重新检查当前 Host；只有
  Level A 可自动路由或创建 bridge。Level B 只允许配置，Level C/D 回到 OpenAI 或 deny。
- Verifier 分开输出 `configured`、`discoverable`、`providerResolved`、`taskDelivered`、
  `runtimeExecuted`、`runtimeVerified`、`configurationReady` 与 `ready`。在 `0.149.0` 上，
  本地配置可以完整，但第三方 Provider resolution 与 runtime success 不会被报告为通过。
- `v0.5.0-beta.1` 当前为 **NOT READY**；本任务不创建 Release 或 tag。

## Custom Agents architecture migration（本地候选分支）

- 公开项目名称调整为 **Codex Third-Party Subagents / Codex 第三方子代理**，GitHub 与
  package slug 为 `codex-third-party-subagents`。为兼容既有安装、备份和卸载，磁盘内
  `codex-third-party-workers` 运行 namespace 暂时保留。
- 已按当前 Codex Custom Agents 机制将 Host identity 与项目路由策略分离：用户级
  `~/.codex/agents/*.toml` 的 `name` 是 Host identity；`requestedAgent`
  只用于项目预检的选择输入，不再被写成“注册”机制。
- 历史 CLI Host E2E 基于精确 `0.147.0`，当时 `multi_agent` 已启用、
  `multi_agent_v2` 未启用。该证据不外推到当前 `0.149.0` Host。
- 安全 diff scan 发现项目级同名 Custom Agent 可覆盖预检验证过的用户级 identity；运行时
  预检现会检查真实任务 `cwd` 的完整祖先 agent layers，仅排除用户级 `~/.codex/agents`。
  发现任意项目 TOML 或无法安全读取时，在创建 bridge 前回退 OpenAI；该边界也覆盖自定义
  project root markers 与嵌套 Git 仓库。
- 新增四个 TOML identity profile：`deepseek_worker -> deepseek-v4-flash`、
  `deepseek_pro_worker -> deepseek-v4-pro`、`minimax_worker -> MiniMax-M3`、
  `qwen_worker -> qwen3.7-max`。Pro 只可显式选择，绝不自动替换 Flash。
- 已在全新 Host session 分别完成 Flash 与显式 Pro Custom Subagent 的受控维护者代码
  fixture E2E：均记录预期 Agent/Provider/Model tuple、工具使用、桥接完成/释放和主线程
  复核。该记录是这些命名路径的 Level 3 证据，不是自动路由、Provider dashboard 归因、
  广义公开安装器或独立用户验收；`runtimeVerified` 仍为 `false`。

## 已写入本地仓库

- 当前源码版本线为 `0.4.0-beta.3`，MIT，Node.js `>=20`，macOS-only；PR、CI、tag 与
  Release 的实时状态以 GitHub 公开控制面为准。
- 公开仓库：`https://github.com/dhy365-creator/codex-third-party-subagents`。
- 仓库入口提供英文 `README.md` 与简体中文 `README.zh-CN.md`，顶部可相互切换。
- 中英文 README 首屏已按产品化顺序补充定位、Quick Start、真实运行记录、兼容性摘要、
  Mermaid 架构、验证与安全边界。
- 中英文 README 首屏进一步明确 Codex 主代理、有界委派、三组内置 Pack 的当前证据、
  只读 Doctor 与默认 dry-run 入口；DeepSeek Flash 与显式 Pro 的受控 E2E 分别记录，
  没有扩大为自动路由、通用用户运行时或广义支持声明。
- 新增只读 `npm run doctor`：检查 macOS、Node.js、Codex 环境、Provider/Model、Keychain
  是否存在、fallback 提示、安装状态、权限与 verify 前置条件；不写配置、不读取或输出
  credential value、不输出私有路径、不联网且不调用付费 API。
- 新增 Bug、Provider 兼容性和 Feature 三组 GitHub Issue Forms，并关闭 blank issue；安全
  漏洞继续引导至 `SECURITY.md` 的私下报告流程。
- `assets/` 已提供四组可复现 SVG 与 PNG：Hero/Social Preview、脱敏真实终端记录、
  Provider 兼容性摘要、测试与 CI 信任证据。
- `docs/github-promotion.md` 已记录 OpenAI Codex Show and tell Discussion #38119 的真实
  发布状态；Awesome List 候选仍未提交。
- GitHub 推广资产通过 PR #5 合并到 `main`，CI 通过；仓库 Description 与 Topics 已按
  当前真实定位更新。Homepage 保持为空，因为尚无独立官方站点。
- 已发布中英文国产模型 Provider 兼容性矩阵；矩阵中的候选状态仅代表官方文档筛选，
  不等于本仓库已经支持。
- 已完成 DeepSeek V4 Pro 的官方资料核对与受控直接 Responses API 探测：模型目录、普通
  请求、SSE、函数调用闭环、`high` / `max` 推理请求与受控失败处理均有脱敏证据。当前
  源码提供 explicit-only Custom Agent 安装 profile；受控维护者 Host E2E 已通过，但不存在
  自动路由、Provider dashboard 归因、广义公开安装器或独立用户验收声明。
- 已完成 DeepSeek V4 Flash 的受控维护者 E2E：在已授权的真实 macOS Codex profile 对既有
  Pack 先 dry-run 再 `--apply`，显式派发 `deepseek_worker` 处理一个非敏感、故意失败的代码
  fixture，得到预期诊断；桥接归档完成、active slot 已释放，并由主线程复核。该路径为
  **Level 3** 证据，`verify` 仍输出 `configured: true` / `runtimeVerified: false`，不自动升级为
  通用公开安装器成功、自动路由或用户验收。
- 已完成 DeepSeek V4 Pro 的受控维护者 E2E：全新 Host session 发现并显式运行
  `deepseek_pro_worker`，对同一只读失败 fixture 得到准确诊断，记录预期 Provider/Model、
  工具使用、桥接完成/释放和主线程复核。该路径为 **Level 3**；Pro 仍不自动路由，验证器
  仍为 `runtimeVerified: false`。
- E2E 首次运行发现 bridge CLI 在未显式传入 platform 时会错用临时目录；已将
  `getBridgeRoot` 默认 platform 固定为 `process.platform`，并增加回归测试。最终 E2E 在默认
  bridge root 下完成。
- 新增中英文 FAQ（`docs/faq.md`、`docs/faq.zh-CN.md`）用于首次用户问题边界说明。
- 新增 `docs/demos/` 证据索引与三页展示：Qwen、MiniMax，以及明确标记 Level 3 维护者 E2E
  与通用用户验收待完成的 DeepSeek 页面。
- 新增 `ROADMAP.md`，并记录 v0.4.x 当前边界、v0.5 规划评估项、Later 探索项。
- README 与 CONTRIBUTING 增加 Documentation/community 的入口导航与链接。
- 架构为通用 provider-pack 形态；DeepSeek V4 Flash、MiniMax-M3 与 Qwen3.7-Max 为
  默认/单模型 Pack，V4 Pro 为 DeepSeek 下独立的 explicit-only profile。
- 安装器、预检、桥接、验证器和卸载器全部支持 provider pack 的路径、文件名和
  配置。
- 默认通道：Spark -> Luna -> provider fallback；provider 仅在额度低于阈值且任务
  适配时被选中。
- Keychain 使用独立服务名读取，不接收明文 `--api-key`。
- 主线程 `config.toml`、model、provider、auth 不在写入范围内。
- 安装/验证时使用 owner-only 目录与文件（`0700` / `0600`），并保持配置哈希。
- `verify` 仅在配置、托管文件、兼容 Host 与 Keychain 检查全部通过时输出
  `POST_INSTALL_STATUS: "SUCCESS"`；可复制的 Codex 安装提示词随后只允许询问一次
  可选 Star，绝不由 installer 自动执行，也不影响安装或使用状态。

## 已在隔离环境验证

- `npm test`：2026-08-14 本地通过 `50/50` 项测试；当前候选分支通过 `91/91` 项测试，
  覆盖 Host compatibility levels/current false-positive、Custom Agent TOML schema、
  重复/错配 identity、legacy migration、
  rollback、per-agent verify evidence、Doctor 只读性和私有路径保护。
- fake home 的 dry-run、apply、重复安装、verify、dry-run uninstall、正式 uninstall 与
  冲突停止通过。
- 官方 catalog 文本提取、本地约束（V4 限制、文本模型）及逐跳 host 校验通过。
- single-slot bridge 权限与归档、follow-up 识别通过。
- MiniMax-M3 已通过真实 Responses API 普通文本、SSE 流式、Function Calling 两轮闭环，
  并通过 Codex CLI + command-backed Keychain 运行；未记录或输出 API key。
- MiniMax-M3 已在 Codex Desktop 以 `minimax_worker` 完成真实子代理冒烟任务，返回预期
  结果，任务桥状态为 `completed`，`active/` 已释放。
- Qwen3.7-Max 已通过按量计费 Responses 普通文本、SSE 流式、自动 Function Calling、
  Codex CLI 与 Codex Desktop `qwen_worker` 冒烟任务；桥状态为 `completed`，`active/`
  已释放。思考模式不支持 `tool_choice = "required"`，但 `auto` 已验证可用。测试后本机
  Qwen Keychain 凭据已按用户要求删除；本次 Desktop 验证是显式调用，不代表旧版全局
  DeepSeek 专用预检已经自动路由到 Qwen。
- DeepSeek V4 Pro 的直接 API 探测使用 Keychain 凭据且未记录或输出 credential value；早期两次
  非交互尝试没有生成 V4 Pro 模型请求或消费 bridge task，只作为历史失败证据保留。后续全新
  Host session 的显式 Pro E2E 已单独通过，不反向改变旧记录。
- 早期直接程序化 V4 Pro 审计中的 `unknown requestedAgent` 是当时项目预检 policy
  对未配置角色的拒绝，不是官方 Host identity 注册能力的结论。当前机制改用官方 TOML
  `name` 发现；CLI 仍无显式 `--agent` 参数，但新 Host session 已通过官方 Custom Agent
  发现执行 Pro。见[迁移说明](migration/custom-agents.md)。

## 尚未完成或未声称

- 当前 CLI `0.149.0` 与 bundled Desktop `0.149.0-alpha.4.1` 不支持本项目所需的
  Native OpenAI Main -> third-party Provider child topology。External Phase 3 Flash controlled
  production E2E 已在本机通过，但 public runtime route、Installer activation 与 auto routing
  仍禁用。
- `0.148.x` 没有可归因的项目 Host evidence，保持 Level D Unknown；不得自动宣告兼容。
- 已完成 Flash controlled External local E2E 与既有 Flash/显式 Pro 维护者 E2E，但尚未取得
  独立真实用户验收；Verifier 仅从本机严格 External evidence 读取
  `transports.external.runtimeVerified=true`，不会提升 Native 或公开支持状态。
- Pro 的 provider dashboard 归因、跨任务可靠性和公开安装器用户验收仍未完成；继续保持
  explicit-only，不做 Flash/Pro 自动路由。
- Doctor 对当前用户级 `~/.codex` 父目录权限给出“非 owner-only” **WARN**；安装器不应擅自
  chmod 既有全局父目录，托管子目录/文件仍按 owner-only 规则创建与验证。
- GitHub Social Preview 图片已准备，但仍需在 GitHub Settings 手工上传并目视确认。
- 尚未提交 Awesome List 外部 PR 或任何新增第三方评论。
- 未由用户进行人工验收。
- 已有一次独立 Windows 用户环境的 GitHub Release artifact npm install/package-bin/dry-run
  验证；Windows runtime/apply 仍在写入前安全阻断，Provider-backed E2E 未运行，npm registry
  仍未发布，本项目不把该结果写成 Windows runtime 支持。
- StepFun、火山方舟、百度千帆和腾讯云 TokenHub 尚未加入内置 Pack。
