# 任务清单

## 已完成（local / verified）

- [x] 2026-08-23 基于官方 Codex `0.149` bounded role override 建立 version-scoped Host
  compatibility contract，明确 role-level Provider/catalog/endpoint/auth 值会被忽略并继承父线程。
- [x] 关闭 `multi_agent=true` 的 current Host false-positive：Doctor、Installer、Verifier 与
  preflight 对 `0.149.x` line 报 Level C Host Blocked，对未经验证版本报 Level D Unknown。
- [x] Installer 在 blocked/unknown Host 上保留 inspect、Doctor、dry-run、migration analysis，
  但在 active installation 写入、provider readiness 与 bridge creation 前 fail closed。
- [x] Verifier 分开输出 configured/discoverable/provider resolved/task delivered/runtime
  executed/runtime verified，不再从 TOML 与 multi-agent 推导第三方 runtime success。
- [x] 新增 Host contract、Doctor false-positive、Verifier false-positive、Installer/preflight
  fail-before-bridge 回归测试；完整本地基线从 `79/79` 增至 `91/91`。
- [x] `0.4.0-beta.2` 候选新增只读 Doctor，并覆盖环境、Provider/Model、Keychain 存在性、
  fallback、安装态、权限、verify 前置条件、无 mutation 与无私有路径输出测试。
- [x] 新增 Bug、Provider 兼容性、Feature 三组 GitHub Issue Forms 与安全问题私下入口。
- [x] 收紧中英文 README 首屏定位和 Quick Start，并加入 Doctor 入口与当前 Provider 证据。
- [x] 2026-08-14 本地 `npm test` 通过 `50/50`，Issue Form YAML 解析通过。
- [x] README、SECURITY、CHANGELOG、AGENTS、`.github` 流程与文档更新。
- [x] macOS Keychain-only 凭据边界，拒绝 CLI 明文 API key。
- [x] 官方 setup 脚本文本解析、size/host/结构校验和 provider-pack 约束。
- [x] Spark -> Luna -> provider fallback 的实时额度路由（含未知额度回退）。
- [x] spawn/follow-up、桥接忙回退、owner/mode/symlink 校验和脱敏归档。
- [x] dry-run 默认、显式 `--apply`、owner-only backup、幂等 AGENTS 标记块与 manifest。
- [x] verify 与冲突时全停的安全 uninstall。
- [x] fake home 离线测试、敏感信息扫描、官方 catalog 抓取兼容。
- [x] 提供可直接发送给 Codex 的中文安装提示词。
- [x] 安装与完整本地验证成功后提供一次性、可选、需明确同意的 GitHub Star 提示；
  installer 不执行 GitHub 写操作，拒绝、未认证或 Star 失败均不影响使用。
- [x] 新增社区与文档可发现性：
  - `docs/demos/`（Qwen、MiniMax、DeepSeek 示例）及索引；
  - `docs/faq.md` 与 `docs/faq.zh-CN.md`；
  - `ROADMAP.md`（Current/Next/Later 与边界分层）；
  - README 与 CONTRIBUTING 文档导航入口。
- [x] 在 `CHANGELOG.md` Unreleased、`docs/current-state.md`、`docs/tasks.md` 记录本轮文档交付状态。
- [x] 2026-08-16 完成 DeepSeek V4 Pro 官方资料核对及受控直接 Responses API 探测：模型目录、
  普通请求、SSE、函数调用闭环、推理参数和失败处理均有脱敏记录；结论仅为 API 已验证候选。
- [x] 2026-08-16 完成 DeepSeek V4 Flash 受控维护者 E2E：dry-run、已授权 `--apply`、显式
  `deepseek_worker` 非敏感 fixture 诊断、默认 bridge root 完成/释放及主线程复核均有脱敏证据；
  结论仅为该路径的 Level 3，验证器仍保持 `runtimeVerified: false`。
- [x] 修复 bridge CLI 未传 platform 时的 macOS 默认 bridge-root 解析，并补充回归测试。
- [x] 2026-08-16 记录旧的直接程序化 V4 Pro 审计：当时项目 preflight policy 对未配置的
  probe role 返回 `unknown requestedAgent`。该结果仅说明旧 policy 输入，不再被解释为
  官方 Host identity 注册限制。
- [x] 2026-08-16 完成 Custom Agents architecture migration：官方 TOML `name` 作为
  Host identity；安装器/Doctor/verify 检查 capability、identity、duplicate、legacy migration
  与 per-agent evidence；`complete`/`fail` 等非官方顶层字段不再生成。
- [x] 2026-08-16 以当时 `0.147.0` Host 发现的 `deepseek_worker` 做有界 Flash dispatch 检查；任务完成、
  system bridge active slot 释放。未取得可独立归因的 provider 返回模型元数据，因此
  `runtimeVerified` 仍为 `false`。
- [x] 2026-08-16 在全新 Host session 完成 Flash 与显式 Pro 的只读代码 fixture E2E：
  预期 Agent/Provider/Model tuple、工具使用、桥接完成/释放、准确诊断与主线程复核均通过；
  Pro 仍不自动路由，验证器仍为 `runtimeVerified: false`。
- [x] 公开名称迁移为 **Codex Third-Party Subagents / Codex 第三方子代理**，目标 GitHub 与
  package slug 为 `codex-third-party-subagents`；保留旧磁盘 runtime namespace 以兼容升级与卸载。
- [x] 修复安全 diff scan 发现的项目级 Custom Agent identity shadowing：运行时预检在 bridge
  创建前检查真实任务 `cwd` 的完整祖先 agent layers，仅排除用户级 agent 目录；存在项目 TOML
  或检查不确定时 fail closed 到 OpenAI，并覆盖自定义 project root markers 与嵌套 Git 仓库。

## 公开仓库

- [x] 通用 provider-pack 核心与首个 DeepSeek V4 Flash pack。
- [x] GitHub Actions 只读测试流程与 MIT 开源文件。
- [x] 远程 catalog 逐跳 host 校验及无网络回归测试。
- [x] GitHub 仓库入口提供中英文双语说明与完整下载、配置、验证步骤。
- [x] 基于官方资料发布中英文国产模型 Provider 兼容性矩阵，区分直连、网关、候选与
  运行时验证状态。
- [x] 新增 MiniMax-M3 Pack，并完成真实 API、流式、Function Calling、Codex CLI 与
  Keychain 验证。
- [x] 新增 Qwen3.7-Max Pack，并完成真实 API、流式、自动 Function Calling、Codex
  CLI、Desktop 子代理、桥接释放和 Keychain 删除验证。
- [x] 产品化中英文 README 第一屏，并准备 Hero、真实终端记录、兼容性摘要和测试/CI
  四组可复现 SVG/PNG 推广素材。
- [x] 准备并发布 OpenAI Codex Show and tell Discussion #38119；Awesome Agent Harness
  候选条目和 beta release notes 仍为本地准备材料。
- [ ] 在 GitHub Settings 手工上传 `assets/hero-social-preview.png` 并目视确认。
- [ ] 用户单独确认后，再决定是否提交 Awesome List PR。

## `0.4.0-beta.2` 发布控制

- [x] 明确 PR、CI、merge、tag 与 Release 状态以 GitHub 公开控制面为准，不以本地 PASS
  替代 GitHub Actions 结果。
- [x] 明确只有在 PR CI、公开页面、最终 diff 与安全检查通过后才能 merge。
- [x] 明确 merge 后先复核 `main` 并运行关键回归，再创建 prerelease。

## Provider 扩展待办

- [x] 重启 Codex Desktop，运行真实 `minimax_worker` 子任务并验证桥接完成与释放。
- [ ] 取得 DeepSeek V4 Flash 独立真实用户验收；不要把维护者 E2E 扩写为自动路由或通用成功。
- [ ] 取得 Flash 与显式 Pro 公开安装器的独立真实用户验收，并补充 Pro provider dashboard
  归因/跨任务可靠性证据；不要把受控维护者 E2E 扩写为自动 Flash/Pro 路由或通用成功。
- [ ] 按 StepFun -> 火山方舟顺序逐一进行真实 API 与 Codex 子代理验证。
- [ ] 对通过验证的 Provider 单独新增 Pack、Keychain service、目录策略、离线测试和文档。
- [ ] 对千帆与 TokenHub 保持“网关候选”标识，不把网关通过写成模型厂商直连通过。
- [ ] 官方新增 Responses 支持后，重新核对 Kimi、智谱、混元传统接口和 SiliconFlow。

## 用户环境待办

- [ ] 在真实用户环境执行 dry-run 后，由用户确认再 `--apply`。
- [ ] 重启 Codex Desktop，执行一个不敏感文本/代码子任务。
- [ ] 完成用户人工验收与运行时状态更新。

## `v0.5.0-beta.1` release gate

- [ ] **NOT READY**：先由维护者选择下一阶段 Host 架构方向；当前任务不创建 Release/tag。
- [ ] 方向 A：等待 Codex 官方提供 cross-provider child support。
- [ ] 方向 B：只维护精确版本范围内的 legacy compatibility，不静默 pin 或引导降级。
- [ ] 方向 C：另行设计有界、provider-neutral handoff；本轮不实现新 transport/sidecar。
