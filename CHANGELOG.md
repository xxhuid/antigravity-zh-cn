# 更新日志 (Changelog)

本项目版本号采用独立语义化版本（SemVer），不与 Antigravity 官方版本号强绑定；每个版本均标注已实测适配的 Antigravity 客户端版本。

## [0.2.2] - 2026-11-24

> **已实测适配客户端**：`Google Antigravity 2.35.1`（Windows 11 静态补丁 & macOS CDP 启动器双平台验证，兼容 `2.35.x+`）

### 新增与优化

- **词库扩展至 546 条 UI 词条 + 42 条动态正则**：
  - 完整汉化**「账号（Account）」设置页**：覆盖页面副标题、遥测数据收集（`Enable telemetry`）、营销邮件（`Marketing emails`）、电子邮箱（`Email`）、Pro 专属的**远程 Agent 数据删除区（`Remote Agents Data`）**，以及底部服务条款/隐私政策提示；
  - 完整适配 **Google AI Plus / Starter 套餐**说明与多套餐动态升级提示正则（同步放宽长句正则匹配上限至 260 字符）。
- **平台验证更新**：更新 [README.md](./README.md) 平台支持矩阵，确认 **macOS** 平台通过方式一（CDP 启动器 `./launcher/start-unix.sh`）已实机验证通过。

## [0.2.1] - 2026-11-24

> **已实测适配客户端**：`Google Antigravity 2.35.1`（Windows 11，兼容 `2.35.x+`）

### 新增与优化

- **词库扩展至 531 条 UI 词条 + 41 条动态正则**：
  - 补全**本地/远程权限下拉菜单**（`Local Permissions`、四档执行策略说明、默认设置悬浮提示、运行期不可更改权限提示）；
  - 补全**模型选择器与思考强度**（`Model`、`Orchestrator`、`Leaving Soon`、`Notice`、`View Usage`、`Thinking effort` 与详细说明）；
  - 补全**查看用量（Usage）悬浮面板**（`Weekly limit`、`5h limit`、`剩余 X%` 以及 `Resets in Xd Yh / Xh Ym` 动态倒计时）；
  - 补全**输入框工具栏与悬浮提示**（`+` 添加上下文菜单 `Add Context / Files / Folder / Mentions / Actions / Drive / Set up`，以及 `Send Message`、`Record Audio`、`Start Voice mode` 提示）。
- **语境与大小写引擎增强**：
  - 修复模型行内 `New ⓘ` 徽标误译为「新建」的问题：独立 `+ New` 按钮继续译为 **新建**，模型/功能徽标译为 **新**；
  - 新增多词短语忽略大小写安全兜底（仅作用于多词 UI 短语，不影响单字与代码区），自动兼容 Title Case / Sentence case 变体。

## [0.2.0] - 2026-11-24

> **已实测适配客户端**：`Google Antigravity 2.35.1`（Windows 11，兼容 `2.35.x+`）

### 核心亮点

- **全量简体中文 UI 词库**：内置 **492 条** 简体中文 UI 词条与 **33 条** 动态正则（覆盖主界面、顶部菜单栏、侧边栏、排队消息栏、权限审批卡片、自动化任务页，以及「通用 / 应用程序 / 外观 / 快捷键 / 通知 / 模型与用量 / 浏览器」全部 7 个设置分页）。
- **客户端内原生风格「界面语言」设置**：
  - 在 **设置 -> 通用** 顶部注入 1:1 贴合 Antigravity 风格的自定义胶囊下拉菜单与圆角滑动开关；
  - 支持 **`Ctrl + Alt + L`**（macOS `⌘ + ⌥ + L`）快捷键弹窗及可选右下角悬浮切换按钮；
  - 支持 **简体中文 ↔ English ↔ 后续扩展语言包** 无损即时切换，无需重启。
- **严格 DOM 防误翻隔离引擎**：跳过代码块、Monaco 编辑器、xterm.js 终端、输入框、URL 与文件路径，并修复 React 拆分文本节点及异步 `MutationObserver` 还原问题。
- **双加载路线（零第三方依赖）**：
  - **方式一（非破坏性 CDP 启动器）**：不修改官方任何文件，支持 Windows 一键创建桌面快捷方式，自动检测词库变更并重建；
  - **方式二（内置零依赖 ASAR 静态补丁）**：原样保留 `app.asar.unpacked`，自动识别客户端版本号并在官方升级后自动刷新原版备份，支持一键还原。
- **可选 Agent 中文工作流插件（`agent-plugin/`）**：附带全局简体中文协作规范及 `zh-commit`、`zh-code-review` 技能。

### 附件说明

- `i18n-runtime.js`：预构建的多语言运行时脚本（含 `en` 与 `zh-CN`）。
- `menu-locales.json`：预构建的 Electron 原生菜单多语言词典。
- 完整安装与使用步骤请查看 [README.md](https://github.com/xxhuid/antigravity-zh-cn#readme)。
