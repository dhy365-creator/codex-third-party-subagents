# Chinese Provider Compatibility Matrix

**English** | [简体中文](provider-compatibility.zh-CN.md)

Last reviewed: 2026-08-16

This document evaluates whether a Chinese model or platform can become a
provider-pack subagent without replacing the primary Codex model and without
CC Switch or another local protocol translator.

## Acceptance gate

Documentation compatibility is not the same as repository support. A built-in
pack must pass all of the following:

1. An official OpenAI-compatible `POST /responses` endpoint.
2. Streaming and a complete Responses-style custom function-call loop.
3. Bearer credentials that can be retrieved by a macOS Keychain command.
4. A defined HTTPS base URL, model ID, and capability boundary.
5. Live API, Codex subagent, tool-call, bridge-release, and main-thread review.

Statuses:

- **Built-in pack**: implemented and isolated-tested; live user-environment status is tracked separately.
- **Runtime-verified pack**: a built-in pack that passed a real Codex subagent run and human review.
- **Tier A candidate**: official documentation meets the core protocol gate; live testing is pending.
- **API-verified candidate**: official protocol evidence and a limited, sanitized direct API probe passed; it is not installed, a built-in pack, or Desktop-runtime verified.
- **Tier B gateway candidate**: a Responses compatibility gateway exists, but it may translate another protocol and impose limitations.
- **Not currently compatible**: official direct access is Chat Completions-only or requires an external translator.

## Initial results

| Provider / model | Access type | Current result | Next step |
| --- | --- | --- | --- |
| DeepSeek / `deepseek-v4-flash` | Official Responses | **Public Beta; packaged clean-install External maintainer E2E verified on macOS with exact Codex CLI `0.149.0`** | Keep External explicit/default-off; obtain independent-user acceptance before broadening claims |
| DeepSeek / `deepseek-v4-pro` | Official Responses | **Explicit-only profile; controlled maintainer E2E passed at Level 3**: attributable Host provider/model session, tool use, bridge release, and main review recorded | Keep automatic Flash/Pro routing disabled; obtain independent user acceptance before broadening claims |
| MiniMax / `MiniMax-M3` | Official Responses and an official Codex Desktop guide | **Runtime verified: API, Codex CLI, Desktop subagent, and bridge release passed** | Keep regression coverage; verify public-installer apply separately |
| StepFun / `step-3.7-flash` | Official `/v1/responses` | **Tier A, priority 2** | Verify streaming tool loops and Codex subagent execution |
| Alibaba Model Studio / `qwen3.7-max` | Official Responses and current Codex configuration | **Runtime verified: API, SSE, automatic function call, Codex CLI, Desktop subagent, and bridge release passed** | Keep text-only boundary; thinking mode does not accept `tool_choice: required` |
| Volcano Ark / Doubao Responses models | Official `/api/v3/responses` | **Tier A, priority 4** | Use an account-enabled model or Endpoint ID |
| Baidu Qianfan Responses gateway | Official `/v2/responses` gateway | **Tier B gateway** | Select one listed model and verify the tool loop |
| Tencent Cloud TokenHub | Official `/v1/responses` compatibility gateway | **Tier B gateway** | GLM, Kimi, or DeepSeek can be tested subject to gateway limits |
| Direct Kimi K3 | Official Codex guide requires CC Switch to translate Chat Completions | **Not currently compatible** | Do not test a direct Kimi key; TokenHub is a separate gateway option |
| Direct Zhipu GLM | Current official OpenAI guide uses Chat Completions | **Not currently compatible** | Wait for direct Responses or test through Qianfan/TokenHub |
| Legacy Tencent Hunyuan endpoint | Current compatibility documentation is centered on Chat Completions | **Not currently compatible** | TokenHub is a separate gateway, not direct Hunyuan support |
| Direct SiliconFlow | Current official text endpoint is `/chat/completions` | **Not currently compatible** | Wait for official Responses documentation |

Tier A means “worth testing with an API key,” not “perfectly supported.” DeepSeek
V4 Flash, MiniMax-M3, and Qwen3.7-Max are built-in packs. V4 Pro has a separate
explicit-only Custom Agent profile, never an automatic route. Flash has a
packaged clean-install External Public Beta with strict local-installation
evidence on the exact tested boundary. Independent-user acceptance and broad
routing claims remain pending; Pro keeps its prior controlled maintainer
boundary. Under the strict gate above, no provider is labeled “perfectly
supported.”

## DeepSeek V4 Flash clean-install External Beta — 2026-08-24

The packaged artifact path completed one bounded maintainer E2E on macOS with
exact Codex CLI `0.149.0`. Strict installation-scoped evidence set
`providerResolved`, `taskDelivered`, `runtimeExecuted`, and `runtimeVerified`
to true, and fresh-process Doctor/Verifier readback added no Provider request.
External remains explicit and default-off, Provider API use is billed
separately, and independent-user acceptance has not been claimed.

## DeepSeek V4 Flash controlled E2E — 2026-08-16

An authorized, bounded maintainer run installed the existing Flash pack into an
actual macOS Codex profile, explicitly spawned `deepseek_worker` for a
non-sensitive fixture diagnostic, and independently confirmed a completed,
released bridge plus main-thread review. The classification is **Level 3** for
that controlled path. `runtimeVerified` remains `false` because the verifier
does not self-promote a single run, and this does not assert generic public
installer success, automatic routing, or user acceptance. See the
[sanitized runtime E2E record](validation/deepseek-runtime-e2e-2026-08-16.md).

## DeepSeek V4 Pro probe — 2026-08-16

Official current documentation identifies `deepseek-v4-pro` as a native
Responses model at `https://api.deepseek.com`, rather than merely an
OpenAI-compatible Chat Completions model. A limited direct probe also passed
ordinary Responses, semantic SSE, a no-side-effect function-call round trip,
`high` and `max` reasoning requests, and an invalid-model failure path. The
sanitized record is in [the V4 Pro probe](validation/deepseek-v4-pro-probe-2026-08-16.md).

The repository now has a separately named, explicit-only
`deepseek_pro_worker` configuration profile and isolated installer/rollback
coverage. A fresh Host session ran that identity on a read-only coding fixture,
recorded the expected DeepSeek provider/model tuple, used tools, completed and
released the bridge, and passed main-thread review. That is controlled
maintainer **Level 3** evidence. The earlier rejected noninteractive attempts
remain historical project-policy results, not Host registration limits.

There is still no automatic Flash/Pro routing, provider-dashboard attribution,
broad public-installer claim, or independent user acceptance. The verifier
remains `runtimeVerified: false`. See the
[Custom Subagents runtime record](validation/deepseek-custom-subagents-runtime-e2e-2026-08-16.md)
and [Custom Agents migration guide](migration/custom-agents.md).

## Recommended test order

1. **MiniMax-M3**: the vendor documents Codex Desktop, `wire_api = "responses"`,
   the base URL, and a Codex model catalog.
2. **step-3.7-flash**: fixed base URL with documented Responses, streaming, and functions.
3. **Volcano Ark**: the protocol fits, while model or Endpoint IDs depend on the account.
4. **Qianfan / TokenHub**: useful for wider model coverage, but these validate a gateway rather than direct vendor access.

Test one provider at a time. Never send an API key in chat, write it to the
configuration, or commit it to GitHub; store it under a provider-specific macOS
Keychain service. Tests must cover non-streaming text, streaming text, a custom
function-call round trip, a real Codex subagent, failure fallback, and bridge
release. Only after all checks pass should the repository add a provider pack,
offline tests, and installation documentation.

## Boundaries

- OpenAI-compatible does not automatically mean Responses-compatible.
- Returning text does not prove that the Codex tool-call loop works.
- A gateway offering a model does not prove that the model vendor's direct API works.
- External translators may work, but they are outside this project's native-provider scope.
- Model lists and API behavior change; every pack requires a fresh official-doc and live-runtime review.

## Official sources

- [OpenAI Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [MiniMax: M3 in Codex](https://platform.minimaxi.com/docs/token-plan/codex)
- [MiniMax Responses API](https://platform.minimaxi.com/docs/api-reference/responses-create)
- [StepFun Responses API](https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create)
- [Alibaba Model Studio: Codex](https://help.aliyun.com/zh/model-studio/codex)
- [Alibaba Model Studio Responses API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)
- [Volcano Ark Responses API tool calls](https://www.volcengine.com/docs/82379/1958524?lang=zh)
- [Baidu Qianfan Responses API](https://cloud.baidu.com/doc/qianfan-docs/s/4mi400l1m)
- [Tencent Cloud TokenHub Responses compatibility](https://cloud.tencent.com/document/product/1823/133813)
- [Kimi K3 in Codex CLI](https://platform.kimi.com/docs/guide/codex-kimi)
- [Zhipu OpenAI API compatibility](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)
- [SiliconFlow OpenAI chat endpoint](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)
