# 常见问题

[English](faq.md) | **简体中文**

## 项目定位

### 这是 OpenAI 官方项目吗？

不是。

这是一个非官方的社区开源项目，不是 OpenAI 官方产品，也不是 Codex 的替代品。

### 这个项目会取代 Codex 吗？

不会。

Codex 仍然是主代理。第三方 Worker 只处理边界明确的文本/代码任务，然后由 Codex
复核和合成最终结果。

### 我为什么不直接用模型官方 API？

如果你希望保留 Codex 的统一主控、复核、路由策略和最终决策边界，同时把可外发的小任务
交给可能成本更低的 Provider，这个仓库可以做这件事，但不保证一定节省费用。

## 成本和额度

### 这能让我无上限用 Codex 吗？

不能。

Codex 订阅、配额和其自身计费边界仍然成立。

### 这能绕过 OpenAI 限制吗？

不能。

路由只在既有边界内运行，不会扩展或替代 OpenAI 的额度策略。

### 能否承诺固定降本比例？

不能。

成本由提供方、模型、任务类型、token 消耗和地区定价共同决定。

## 安全和隐私

### API key 存哪？

只存储在 macOS Keychain 中，仓库里不保存任何凭据。

### 安装器会打印 API key 吗？

不会。

安装器不接受 `--api-key`，不会在日志里输出 Keychain 值。

### 委派任务会把内容发给第三方吗？

会。任务被委派后，边界任务正文和 Worker 执行所需的请求上下文会发送给所选 Provider。
不要委派凭据、隐私内容或无权外发的资料。

你需要自行确认：

- 供应商隐私条款
- 数据保留策略
- 定价与地区合规

### 这个项目会改动 Codex 的主配置吗？

不会。

安装器不会改写主 `~/.codex/config.toml`、主模型、Provider 或认证。只有显式使用
`--apply` 时，才管理所选 Pack 文件、辅助文件、清单/备份和一段有边界的 AGENTS 规则。

## 兼容性

### Windows 现在支持吗？

`v0.4.0-beta.3` 当前不支持 Windows runtime 或 `--apply`。正式 Release `.tgz` 已在
Windows 上独立验证可作为 npm 依赖安装，package-bin shim 与安装器 dry-run 通过；但安装器
会在托管文件写入前安全阻断，Windows 安全凭据后端也尚未实现。该独立检查使用 Codex CLI
`0.141.0`，处于精确 Flash `0.149.0` 验证边界之外，因此不构成 Windows Provider 运行时
支持声明。不要用明文 `.env` 或 `DEEPSEEK_API_KEY` 环境变量绕过这一边界。

### 当前支持哪些 provider？

当前 Pack / Profile 与证据状态是：

- DeepSeek V4 Flash：打包干净安装 External 公开 Beta；已在 macOS + 精确 Codex CLI
  `0.149.0` 上完成一次有边界的维护者 E2E 并取得严格本地运行时证据，独立用户验收仍待完成。
- DeepSeek V4 Pro：仅显式选择的 Custom Agent 配置 Profile，已有直接 API 与受控维护者
  Level 3 E2E 证据；公开安装器与独立真实用户验收仍待完成。
- MiniMax-M3：已内置；已记录 API、CLI 与 Desktop Worker 运行时验证。
- Qwen3.7-Max：已内置；已记录 API、CLI 与 Desktop Worker 运行时验证。

候选项和网关条目不是已支持 Pack。完整分类见：

- [国产模型兼容性矩阵（中文）](provider-compatibility.zh-CN.md)
- [provider compatibility matrix (English)](provider-compatibility.md)

### 为什么某个模型显示“未兼容 / 候选”？

本仓库严格区分“官方文档兼容”和“运行时可复用”：

- OpenAI-compatible 的兼容接口不等于完整 Codex subagent 兼容；
- 有时支持普通文本不代表工具调用闭环可用；
- 网关路径不代表模型厂商直连兼容。

### 现在可以配置 DeepSeek V4 Pro 吗？

当 Doctor 确认 Host 与 identity 条件后，可以先检查带 `--model pro` 的
explicit-only dry-run；它绝不成为自动 fallback。若检测到匹配的旧用户定义，正式应用还需
显式加入 `--migrate-legacy --apply`。

受控维护者运行已记录预期的 Host Provider/Model tuple、工具使用、bridge 完成/释放和
主线程复核。这不等于自动路由、Provider dashboard 归因、其他用户环境的公开安装器成功、
广义可靠性或独立用户验收；验证器仍为 `runtimeVerified: false`。见
[Custom Agents 迁移说明](migration/custom-agents.md)和
[脱敏运行记录](validation/deepseek-custom-subagents-runtime-e2e-2026-08-16.md)。

### 什么时候可以申请新 provider？

按下面入口提交申请：
[Provider compatibility request](https://github.com/dhy365-creator/codex-third-party-subagents/issues/new?template=provider-compatibility.yml)

## 安装与验证

### 我第一次应该先跑什么？

先运行 `npm run doctor`。

它是只读检查：操作系统、Node 版本、Codex 环境、Provider/Model、Keychain 项是否
存在、fallback 提示、安装状态、权限和 verify 前置条件。

### Doctor 改了什么？

Doctor 不会改文件，也不会调用付费 API，属于只读诊断。

## Doctor 的 PASS/WARN/BLOCKED 怎么理解？

`PASS`、`WARN`、`BLOCKED` 是对当前环境和配置的分级判断。

### WARN/BLOCKED 是不是安全问题？

- `PASS`：可继续按既有流程执行。
- `WARN`：有待关注但未必阻塞。
- `BLOCKED`：需先处理再执行后续步骤。

## 运行时边界

### 什么是 `runtimeVerified`？

`runtimeVerified: false` 表示本项目尚未记录独立接受的运行时证据；它不会自动把一次受控维护者观察升级。

`configured: true` 只表示预检与文件/权限状态满足条件；它不自动等于运行时验证完成。
