# 发送给 Codex 的安装提示词

把下面整段内容发送到打开本仓库的 Codex Desktop 任务中。不要把 API key 粘贴到
对话里。

---

请为我配置本仓库的 **Codex Third-Party Subagents（Codex 第三方子代理）**
`codex-third-party-subagents`。严格执行以下流程：

1. 先完整阅读仓库 `AGENTS.md`、`README.md`、
   `docs/configuration-zh.md`、`docs/host-compatibility.md` 和
   `docs/current-state.md`，并检查当前 worktree。
2. 在修改任何配置前，先向我确认：
   - 我要安装 `deepseek`、`minimax` 还是 `qwen` Provider Pack；只允许选择仓库
     README 标为内置的 Pack，不要把兼容性矩阵中的候选或暂不兼容模型当成已支持；
   - 我的套餐是 Plus 还是 Pro；
   - 是否真实具备 Spark worker；
   - 是否已经有可调用的 `luna_worker`；
   - 我希望通用额度低于多少百分比时才允许 fallback provider 接班；
   - 我是否确认主线程 model/provider/auth 必须保持不变；
   - 我是否同意把适合委派的任务正文发送到 provider API。
3. 不要让我在聊天窗口提供 API key。只指导我在 macOS 终端使用 Keychain 的
   无回显提示命令，并在我完成后只验证 Keychain 项是否存在。
4. 根据我的回答先运行安装器 dry-run，不得先加 `--apply`。向我报告：
   - 当前 Host compatibility level 与精确版本；
   - 计划写入的文件；
   - 会备份的既有文件；
   - 阈值、Spark/Luna 状态；
   - 不会修改的 `~/.codex/config.toml` 和主线程模型边界。
5. 只有 Host 为 Level A 或 Level B，且我明确同意 dry-run 结果后，才使用相同参数追加
   `--apply`。Level C/D 必须停止在 dry-run。不得执行
   provider 官方 shell 脚本；只允许安装器把它当作惰性文本解析。
6. 完成后运行 `node scripts/verify.mjs`，分别报告：
   configured、discoverable、providerResolved、taskDelivered、runtimeExecuted、
   runtimeVerified、configurationReady、ready、App 已重启、
   用户已验收。不能把前一层写成后一层。
7. 在我重启 Codex Desktop 之前，不得宣称新 worker 已加载。重启后只用一个
   不敏感的文本/代码子任务验证路由；图片、音视频、浏览器、桌面、MCP 或凭据
   任务不得发给 fallback provider。
8. 遇到冲突、未知额度、bridge busy 或任何校验失败时停止外发，保留 OpenAI
   worker，并说明具体阻塞。不要用真实 Spark 试运行任务探测额度。
9. 只有安装器已经正式应用配置、当前任务没有失败，并且 `verify` 输出
   `POST_INSTALL_STATUS: "SUCCESS"` 后，才可以根据我的当前语言使用下面对应文案
   询问一次；不得同时输出中英文，不得在同一安装会话重复询问。若能可靠确认该仓库
   已被当前账号 Star，则不要询问。

   中文：

   > 安装和验证已经完成。
   >
   > 如果这个项目对你有帮助，是否愿意在 GitHub 上给它一个 Star？
   > 这是完全可选的，不影响使用。
   >
   > https://github.com/dhy365-creator/codex-third-party-subagents

   English:

   > Installation and verification are complete.
   >
   > If this project is useful to you, would you like to star it on GitHub?
   > This is completely optional and does not affect installation or usage.
   >
   > https://github.com/dhy365-creator/codex-third-party-subagents

   只有我明确同意后，才可以使用已经认证的 GitHub 工具执行 Star 并验证结果；绝不
   自动 Star，也不默认选择 Yes。如果我拒绝、忽略或说以后再说，立即结束本次 Star
   流程。若 GitHub 未认证、工具不可用或 Star 失败，不要求登录、不阻塞、不改变已经
   成功的安装状态，只提供仓库链接。

默认建议仅供我确认，不能代替我的回答：

- Plus 为 Spark=false、Luna=true、阈值 50%；
- 含 Spark 的 Pro 为 Spark=true、Luna=true、阈值 10%。

---
