---
name: zh-code-review
description: >-
  Use this skill when the user asks for a code review, PR review, or diff check
  with structured feedback and actionable recommendations in Simplified Chinese.
---

# 中文代码审查（Code Review）工作流

当用户要求审查代码、本地改动或 PR Diff 时，按以下流程用简体中文给出结构化反馈：

## 步骤

1. **获取审查范围**
   - 若用户指定了文件或分支，先读取对应代码或运行 `git diff <base>...HEAD`。
   - 若未指定，运行 `git status` 和 `git diff` 确认当前待审查的变更。

2. **按优先级检查问题**
   - **正确性与边界条件**：空值处理、并发/异步竞态、错误吞没、状态不一致。
   - **安全与权限**：注入风险、硬编码密钥、未校验输入、越权访问。
   - **可维护性与性能**：重复逻辑、过深嵌套、多余 I/O 或 N+1 查询。

3. **输出中文审查报告**
   - 按严重程度分组：**严重问题（必须修复）** > **建议改进** > **优点/亮点**。
   - 每条问题必须指明具体**文件路径与行号**、**风险原因**以及**可直接落地的修改建议**。
   - 若未发现明显 Bug，明确说明已检查的范围与潜在的测试盲区。
