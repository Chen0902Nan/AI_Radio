# 在本机通过 Codex CLI 复用现有订阅

个人电台在本机通过官方 Codex CLI 子进程生成节目编排和播报稿，使用用户现有的 ChatGPT 登录复用 Codex 订阅。这符合用户明确提出的 Codex 选型与成本顺序：先复用已有订阅和免费额度，再根据预算决定新增服务费用；相应接受本机运行和订阅额度的约束，API 按量计费不作为默认大脑调用路径。

语音合成和歌曲播放由各自的接入层处理。Codex 的最终结构化结果与运行事件分别解析，实际延迟和输出结构须在接入时验证；依据见 [官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)及 [接入核验](../../.scratch/radio-agent/integration-research.md)。

---

> 本文引用的 `.scratch/` 证据文件属本机工作区，未随仓库分发；克隆中这些链接不可用。
