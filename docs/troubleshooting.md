# 故障排查

## `Provider API key is not provisioned`

不要把 key 发到聊天窗口，也不要使用命令行 `--api-key`。在系统终端执行：

```sh
# DeepSeek
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-deepseek-api-key -U -w

# MiniMax
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-minimax-api-key -U -w

# Qwen / 阿里云百炼
/usr/bin/security add-generic-password -a "$(id -un)" -s codex-qwen-api-key -U -w
```

然后重新运行安装。`-w` 位于末尾时由 macOS 安全提示输入。

## 官方模型目录下载失败

先核对网络和 provider 官方接入文档。也可保存官方脚本或模型目录后，使用：

```sh
node scripts/install.mjs ... --catalog-source /absolute/local/path
```

本项目不会执行下载的脚本。官方 heredoc、Markdown 目录或模型结构变化会失败关闭，而不是
猜测内容。

## Qwen 思考模式拒绝 `tool_choice = "required"`

Qwen3.7-Max 的思考模式可能对 `required` 或对象形式的 `tool_choice` 返回 400。
本项目的真实验证表明 `tool_choice = "auto"` 可正常返回 Responses
`function_call`；不要把 `required` 的失败误判为所有工具调用均不可用。

## 一直选择 Spark / Luna

预检在 Spark 额度无法读取时必须保留请求的 OpenAI worker，不能把未知状态当
成额度耗尽。如果已明确看到 Spark 限额错误但控制面查询仍失败，应先修复网络或
Codex 登录状态，不要发送试运行任务探测额度。

## 没有 Spark 的 Plus 用户

安装时选择 `--spark-available false`，并确认已有可调用的 `luna_worker`。建议
把 provider 阈值设为 `50`。如果 Luna 不存在，请先配置 Luna 或停用该回退链。

## bridge busy

同一时间只允许一个 provider 子任务。先通过 Codex 的子代理状态确认任务是否仍
在运行。正常任务会把 `active/` 原子归档；不要手动覆盖 `active/task.json`，
也不要删除历史归档。

若子代理失联，由主线程在确认目标任务后调用 bridge helper 将它归档为
`failed`，再重新预检。归档前会把 message 和 cwd 脱敏。

## fallback 收不到任务正文

检查任务委派流程：主线程先运行预检，由预检写入 owner-only bridge。
Fallback 子代理只读 `active/task.json`。不要让子代理猜测任务内容，
也不要扫描任务归档目录。

## 为什么图片、浏览器或 MCP 无效

本项目只支持文本、代码、研究整理和本地验证。图片、文件输入、computer use、
MCP 等超出当前 provider 及防线范围。

## `verify` 显示 `runtimeVerified: false`

这是正常且有意的。`verify` 只验证本地配置，不会为了验证而消耗额度或自动向
provider 发送任务。先检查 `hostCompatibility`：当前 `0.149.x` line 会 fail closed，
不能通过重启或 TOML 存在来升级为运行时可用。只有精确 Host 契约允许 cross-provider
child，并完成可归因 E2E 与主线程复核后，才可记录运行时证据。

## 卸载冲突

托管文件或 AGENTS 标记块被修改后，卸载会停止且不做部分删除。先查看冲突，保
留用户修改，再恢复为安装清单内容或手动合并。不要直接覆盖用户文件。

Keychain 凭据和 bridge 历史归档不会被卸载器删除。
