# 国产模型 Provider 兼容性矩阵

[English](provider-compatibility.md) | **简体中文**

最后核对：2026-08-16

本文只回答一个问题：某个国产模型或平台，能否在**不替换 Codex 主线程、
不依赖 CC Switch 或本地协议转换器**的前提下，作为本项目的子代理 Provider Pack。

## 判定标准

“官方文档兼容”不等于“本项目已经支持”。进入内置 Pack 前，候选项必须依次满足：

1. 官方提供 OpenAI-compatible `POST /responses`；
2. 支持流式响应和 Responses 形式的自定义函数调用闭环；
3. 可使用 Bearer API key，并能通过 macOS Keychain 命令读取；
4. 有明确的 HTTPS Base URL、模型 ID 和模型能力边界；
5. 通过真实 API、Codex 子代理、工具调用、桥接释放和主线程复核测试。

状态定义：

- **内置 Pack**：已写入仓库并通过隔离测试；真实用户环境验证单独记录。
- **运行时已验证 Pack**：内置 Pack 已完成真实 Codex 子代理和人工复核。
- **A 级候选**：官方文档满足核心协议要求，等待 API key 和真实运行验证。
- **API 已验证候选**：官方协议证据与受控、脱敏的直接 API 探测均通过；仍不是内置 Pack、安装态或 Desktop 运行时验证。
- **B 级网关候选**：平台提供 Responses 兼容层，但底层可能是协议转换，能力有限制。
- **暂不兼容**：官方当前只公开 Chat Completions，或必须依赖外部转换器。

## 首批结论

| Provider / 模型 | 接入类型 | 当前结论 | 下一步 |
| --- | --- | --- | --- |
| DeepSeek / `deepseek-v4-flash` | 官方 Responses | **公开 Beta；macOS + 精确 Codex CLI `0.149.0` 的打包干净安装 External 维护者 E2E 已验证** | 保持 External 显式且默认关闭；扩大声明前取得独立用户验收 |
| DeepSeek / `deepseek-v4-pro` | 官方 Responses | **仅显式选择的 Profile；受控维护者 E2E 已达到 Level 3**：已记录可归因的 Host Provider/Model session、工具使用、桥接释放与主线程复核 | 保持关闭 Flash/Pro 自动路由；扩大声明前取得独立用户验收 |
| MiniMax / `MiniMax-M3` | 官方 Responses；官方给出 Codex Desktop 配置 | **运行时已验证 Pack：API、Codex CLI、Desktop 子代理和桥接释放均通过** | 保持回归测试；公开安装器 apply/verify 单独验收 |
| 阶跃星辰 / `step-3.7-flash` | 官方 `/v1/responses` | **A 级候选，优先级 2** | 验证流式工具循环和 Codex 子代理运行 |
| 阿里云百炼 / `qwen3.7-max` | 官方 Responses；官方给出最新版 Codex 配置 | **运行时已验证：API、SSE、自动 Function Calling、Codex CLI、Desktop 子代理和桥接释放均通过** | 保持纯文本边界；思考模式不接受 `tool_choice: required` |
| 火山方舟 / 豆包 Responses 模型 | 官方 `/api/v3/responses` | **A 级候选，优先级 4** | 需要账号实际可用的模型或 Endpoint ID |
| 百度千帆 Responses 网关 | 官方 `/v2/responses` | **B 级网关候选** | 先选官方列表中的具体模型，再验证工具循环 |
| 腾讯云 TokenHub | 官方 `/v1/responses` 兼容层 | **B 级网关候选** | 可测试 GLM、Kimi、DeepSeek；需接受兼容层限制 |
| Kimi K3 直连 | 官方只提供 Chat Completions；Codex 指南依赖 CC Switch 转换 | **暂不兼容** | 不接收直连 Kimi key；可改测 TokenHub 网关 |
| 智谱 GLM 直连 | 官方 OpenAI 兼容指南当前使用 Chat Completions | **暂不兼容** | 等待官方直连 Responses；可改测千帆或 TokenHub 网关 |
| 腾讯混元传统接口 | 官方兼容接口当前以 Chat Completions 为主 | **暂不兼容** | TokenHub 是另一条网关路线，不能等同于混元直连 |
| SiliconFlow 直连 | 官方文本接口当前公开 `/chat/completions` | **暂不兼容** | 等待官方 Responses 文档，不用 API key 盲测 |

这里的 “A 级” 仍然只是**值得提供 API key 测试**，不是已经完美支持。DeepSeek V4
Flash、MiniMax-M3 与 Qwen3.7-Max 已内置。V4 Pro 有独立的、仅显式选择的 Custom Agent
配置 Profile，绝不自动路由。Flash 已具备打包干净安装 External 公开 Beta，并在精确测试
边界取得严格本地安装证据。独立用户验收和广义路由声明仍待完成；Pro 保持既有受控维护者
证据边界。按上述严格口径，目前没有任何 Provider 可以直接标成“完美支持”。

## DeepSeek V4 Flash 干净安装 External Beta — 2026-08-24

打包 artifact 路径已在 macOS 与精确 Codex CLI `0.149.0` 上完成一次有边界的维护者 E2E。
严格 installation-scoped evidence 中 `providerResolved`、`taskDelivered`、`runtimeExecuted`、
`runtimeVerified` 均为 true；fresh-process Doctor/Verifier 复核未增加 Provider 请求。
External 仍需显式启用且默认关闭，Provider API 单独计费，尚未声称独立用户验收。

## DeepSeek V4 Flash 受控 E2E — 2026-08-16

一次已授权且有边界的维护者运行，把既有 Flash Pack 安装到真实 macOS Codex profile，显式
派发 `deepseek_worker` 完成非敏感 fixture 诊断，并由主线程独立确认桥接归档完成、active slot
释放和结果复核。该受控路径的分类是 **Level 3**。验证器仍输出 `runtimeVerified: false`，因为它
不会自行把一次运行升级为已验证状态；这不等于通用公开安装器成功、自动路由或用户验收。见
[脱敏运行时 E2E 记录](validation/deepseek-runtime-e2e-2026-08-16.md)。

## DeepSeek V4 Pro 探测 — 2026-08-16

官方当前文档已明确 `deepseek-v4-pro` 可原生使用位于
`https://api.deepseek.com` 的 Responses API，而不仅是 OpenAI-compatible
Chat Completions。受控直接探测也通过了普通 Responses、语义化 SSE、无副作用函数调用
闭环、`high` / `max` 推理请求和无效模型失败路径。脱敏记录见
[V4 Pro 探测](validation/deepseek-v4-pro-probe-2026-08-16.md)。

仓库现有独立命名、仅显式选择的 `deepseek_pro_worker` 配置 Profile，并有安装器/
rollback 隔离覆盖。一个全新 Host session 已用该身份处理只读代码 fixture，记录预期的
DeepSeek Provider/Model tuple、工具使用、桥接完成/释放与主线程复核，因此该受控维护者路径
达到 **Level 3**。早期被拒绝的非交互尝试仍只是历史项目 policy 结果，不是 Host 注册限制。

当前仍没有 Flash/Pro 自动路由、Provider dashboard 归因、广义公开安装器声明或独立用户
验收；验证器继续输出 `runtimeVerified: false`。见
[Custom Subagents 运行记录](validation/deepseek-custom-subagents-runtime-e2e-2026-08-16.md)与
[Custom Agents 迁移说明](migration/custom-agents.md)。

## 推荐测试顺序

1. **MiniMax-M3**：官方直接给出了 Codex Desktop、`wire_api = "responses"`、
   Base URL 和模型目录示例，文档证据最完整。
2. **step-3.7-flash**：固定 Base URL，Responses、流式输出和函数调用均有官方说明。
3. **火山方舟**：协议符合要求，但模型或 Endpoint ID 与账户开通情况相关。
4. **千帆 / TokenHub**：适合补齐多模型覆盖；它们属于网关验证，不代表模型厂商直连。

每次只验证一个 Provider。API key 不发送到聊天、不写进配置文件、不提交 GitHub；
应单独存入 macOS Keychain。测试依次覆盖非流式文本、流式文本、自定义函数调用闭环、
真实 Codex 子代理、失败回退和桥接目录释放。全部通过后，才新增 Provider Pack、离线测试
和安装文档，并把状态逐步改为“内置 Pack”和“运行时已验证 Pack”。

## 重要边界

- OpenAI-compatible 不自动等于 Responses-compatible。
- 能返回普通文本，不代表能完成 Codex 所需的工具调用循环。
- 平台网关能提供某模型，不代表该模型厂商的直连接口已经兼容。
- 外部协议转换器可能可用，但不属于本项目强调的官方配置与原生 Provider 路线。
- 模型列表和 API 能力会变化；新增 Pack 前必须再次核对官方文档和真实运行结果。

## 官方资料

- [OpenAI Codex 配置参考](https://developers.openai.com/codex/config-reference/)
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)
- [MiniMax：在 Codex 中使用 M3](https://platform.minimaxi.com/docs/token-plan/codex)
- [MiniMax Responses API](https://platform.minimaxi.com/docs/api-reference/responses-create)
- [阶跃星辰 Responses API](https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create)
- [阿里云百炼：Codex](https://help.aliyun.com/zh/model-studio/codex)
- [阿里云百炼 Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)
- [火山方舟 Responses API 工具调用](https://www.volcengine.com/docs/82379/1958524?lang=zh)
- [百度千帆 Responses API](https://cloud.baidu.com/doc/qianfan-docs/s/4mi400l1m)
- [腾讯云 TokenHub Responses API 兼容模式](https://cloud.tencent.com/document/product/1823/133813)
- [Kimi K3：在 Codex CLI 中使用](https://platform.kimi.com/docs/guide/codex-kimi)
- [智谱 OpenAI API 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [SiliconFlow OpenAI 对话接口](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)
