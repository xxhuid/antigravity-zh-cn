---
name: zh-commit
description: >-
  Use this skill when the user asks to generate, draft, or format a Git commit
  message in Chinese, or asks to summarize staged/unstaged changes for a commit.
---

# 中文 Git 提交信息生成规范

当用户需要生成 Git Commit 提交信息时，按以下步骤执行：

## 步骤

1. **检查当前仓库变更**
   - 运行 `git status -s` 查看修改状态。
   - 优先运行 `git diff --staged` 查看已暂存内容；如果暂存区为空，则运行 `git diff` 查看工作区改动，并提醒用户尚未 `git add`。

2. **分析变更意图**
   - 区分本次改动的类型（`feat`、`fix`、`docs`、`refactor`、`style`、`test`、`chore`、`perf`、`build`）。
   - 总结改动影响了哪些模块，以及**为什么**这样改（而不只是复述文件名）。

3. **输出中文 Commit 信息**
   - 采用 Conventional Commits 格式：`<type>(<scope>): <简短中文摘要>`（scope 可选）。
   - 标题行尽量控制在 50 字以内，不加句号。
   - 如涉及多处逻辑或破坏性变更，空一行后补充简洁的中文正文要点（使用 `- ` 列表）。
   - 给出可直接复制执行的 `git commit -m "..."` 命令（若用户明确要求自动提交再执行提交，否则只提供建议）。
