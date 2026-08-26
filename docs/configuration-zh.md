# 配置指南

**Codex Third-Party Subagents（Codex 第三方子代理）** 是第三方模型有界交接的
version-scoped 兼容、安装与验证层，不替换主线程 OpenAI 模型。本版本为非官方、
macOS-only、公开 beta；GitHub/package slug 为 `codex-third-party-subagents`。

## 安装前确认

先运行 `npm run doctor` 并阅读 [Host compatibility contract](host-compatibility.md)。
精确 `0.147.0` 只有历史兼容证据；当前 `0.149.x` line 为 Host Blocked；其他未经验证
版本为 Unknown。Blocked/Unknown Host 只能 inspect、Doctor、dry-run 和 migration
analysis，不能 `--apply` 或创建 active provider bridge。

唯一例外是精确 `DeepSeek / deepseek-v4-flash / external-codex` 的 Beta 配置安装：
`--transport external --external-flash-beta` 可以在 `0.149.0` 写入受管配置，但不会开启
普通 External registry、factory、runtime route 或自动 fallback。实际 E2E 仍需独立的
显式付费授权和全部三个执行开关。见 [Flash Beta 干净安装指南](flash-beta-clean-install.md)。

`v0.4.0-beta.3` 的正式 Release artifact 已在 Windows 上验证可作为 npm 依赖安装，
package-bin shim 和 installer dry-run 也通过；这不表示 Windows runtime/apply 已支持。
当前版本会在 Windows 上于写入前 fail closed，且尚无 Windows 安全凭据后端。不要用明文
`.env` 或长期 `DEEPSEEK_API_KEY` 环境变量绕过凭据边界；Provider-backed Windows 执行需等待
受支持的安全后端和完整 Windows E2E。

安装器会要求确认：

1. 套餐是 Plus 还是 Pro。
2. 账号是否真实具备 Spark，以及是否已经有可调用的 `luna_worker`。
3. 通用额度多少百分比后允许 provider fallback 接班。
4. 主线程的 model/provider/auth 保持不变。
5. 同意把适合委派的任务正文发送到 provider。

建议默认值：

| 套餐 | Spark | Luna | provider 阈值 |
| --- | --- | --- | --- |
| Plus | 否 | 是 | 50% |
| Pro（含 Spark） | 是 | 是 | 10% |

套餐只用于生成默认值。每次路由仍读取实际额度；不能仅凭“Pro”推断 Spark 仍有剩余。

## 1. 将 API key 写入 macOS Keychain

在系统终端执行：

```sh
# DeepSeek
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-deepseek-api-key -U -w

# MiniMax
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-minimax-api-key -U -w

# Qwen / 阿里云百炼
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-qwen-api-key -U -w
```

`-w` 放在命令末尾时，由 macOS 安全提示输入内容，不会把 key 放进普通命令参数或 shell 历史。安装器没有 `--api-key` 参数，只检查当前 Pack 对应的 Keychain 项是否存在。

## 2. 先做 dry-run

以下命令只读取和计算，不修改 `~/.codex`：

```sh
node scripts/install.mjs \
  --provider deepseek \
  --plan plus \
  --spark-available false \
  --luna-available true \
  --threshold 50 \
  --confirm-main-preserved \
  --consent-data
```

MiniMax 或 Qwen 把 `--provider deepseek` 改成 `--provider minimax` 或
`--provider qwen`。安装器一次管理一个当前
路由的 Provider Pack。Pro 用户把 `plan` 改为 `pro`、Spark 设为 `true`、阈值改为 `10`。不传完整
参数并在交互式终端运行时，安装器会逐项询问。

dry-run 会从官方地址下载目录来源文本，但绝不执行它；DeepSeek 提取
`CODEX_MODELS_JSON`，MiniMax 提取官方 Codex 指南中的 JSON 目录，Qwen 从阿里云
官方模型页核对模型、纯文本、Function Calling 与上下文元数据，再按
provider-pack 策略校验后落盘。离线时可追加：

```sh
--catalog-source /absolute/path/to/local-catalog-or-setup-script
```

仓库不附带官方完整目录或系统提示词。

### Custom Agents 迁移与 DeepSeek V4 Pro

当前 Codex Host 的 Agent 身份以 `~/.codex/agents/*.toml` 中的 `name` 为准；
预检请求里的 `requestedAgent` 只是本项目的路由选择输入，不会注册 Host Agent。

DeepSeek 默认配置为 `deepseek_worker -> deepseek-v4-flash`。V4 Pro 使用独立的
`deepseek_pro_worker -> deepseek-v4-pro` 显式配置，只能由明确选择触发，绝不作为
Flash 的自动替换或回退。

如果 Doctor 提示“matching legacy Custom Agent”，先确认 dry-run，再在正式命令中加：

```sh
--migrate-legacy --apply
```

该选项只接管名称、模型、Provider 和文件名均匹配的用户级旧定义；先创建 owner-only
备份，卸载时可恢复。存在重复、错配或项目级同名定义时会拒绝应用。详情见
[Custom Agents 迁移说明](migration/custom-agents.md)。

## 3. 正式写入

只有 Doctor 报告 Host 为 Level A 或 Level B，且检查 dry-run 输出无误后，才能在相同
命令末尾添加：

```sh
--apply
```

以上条件不改变当前平台边界：本版本的正式写入/runtime 路径仅支持 macOS。Windows 上即使
package 安装和 dry-run 成功，也不要追加 `--apply`。

写入范围仅包括：

- 当前所选 provider 的自定义子代理文件。
- provider-pack 的 runtime catalog。
- 实时额度预检与单槽任务桥模块。
- `~/.codex/AGENTS.md` 内的一段带起止标记的规则。
- owner-only 的安装清单和必要备份。

不会修改 `~/.codex/config.toml`、主模型、主 provider、主 auth 或数据库。
不会写入项目级 `.codex/agents`、改变 Host feature flags 或修改 Agent 优先级。

## 4. 重启并核验

重启 Codex Desktop 后执行：

```sh
node scripts/verify.mjs
```

`configured: true` 只表示本地文件、权限、hash、catalog 与已请求的凭据检查正确。
`discoverable`、`providerResolved`、`taskDelivered`、`runtimeExecuted` 与
`runtimeVerified` 分开报告；`configurationReady` 还要求 Host 兼容，`ready` 再要求
Keychain 检查通过。
`runtimeVerified` 仍会是 `false`：当前验证器不摄取或独立接受外部运行记录。真实文本/
代码子任务及主线程复核必须作为单独、按 Agent/Model 归因的证据记录。

`verify` 还会按 Agent / Provider / Model 输出带时间戳的本地配置证据；它没有
Host 返回的运行时元数据，不能把 Flash 的任何记录扩大为 Pro，也不能自动把已记录的
受控维护者 E2E 写成 `runtimeVerified: true`。

## 路由规则

1. Spark 真实有额度时优先 `spark-worker`。
2. Spark 不可用后，通用额度高于或等于阈值时用 OpenAI 回退（`luna_worker` 先于
   `spark-worker`）。
3. 只有精确 Host 为 Level A、低于阈值、任务适合、Keychain/配置正常且桥为空闲时才会走 provider
   fallback。
4. 额度查询失败时保留 OpenAI worker，不自动外发给 provider。
5. 图片、音视频、浏览器、桌面和非文本多模态任务不得交给 provider。

Codex Desktop 目前不保证原生拦截所有协作调用，因此预检属于需要主代理主动执行
的策略护栏，不是系统级安全边界。

## 卸载

```sh
node scripts/uninstall.mjs
node scripts/uninstall.mjs --apply
```

默认仍是 dry-run。正式卸载只删除 hash 未变化的托管文件，并只移除精确匹配
的 AGENTS 标记块；发现用户修改后会停止，不做部分卸载。Keychain 凭据和历史
桥接归档不会自动删除。
