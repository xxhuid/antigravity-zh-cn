# antigravity-zh-cn

面向 **Google Antigravity 2.0 桌面端（Electron）** 的社区开源**多语言 UI 界面汉化框架**与 **Agent 中文工作流插件**（非官方项目）。

项目内置**简体中文（`zh-CN`）**语言包，并采用可扩展的多语言架构：在客户端内直接注入 **“界面语言（Language）”设置项** 与快捷键切换面板，支持即时中英切换，也方便后续添加繁体中文、日语、韩语等更多语言包。

---

## 核心特性

- **客户端内“界面语言”设置项**
  - 自动在 Antigravity 的 **设置 -> 通用（General）** 中注入原生风格的 **显示语言（Language）** 下拉选项，切换后**立即生效、无需重启**。
  - 支持全局快捷键 `Ctrl+Alt+L`（macOS 为 `⌘+⌥+L`）与可选的右下角悬浮切换按钮，随时打开语言选择面板。
- **可扩展多语言包架构（`locales/`）**
  - 通过 `locales/manifest.json` 注册语言包，按模块拆分词库（侧边栏、设置页、对话区、原生菜单、通用按钮），新增语言包无需修改引擎代码。
- **严格 DOM 防误翻隔离引擎（`engine/`）**
  - 严格跳过 `<code>`、`<pre>`、Monaco 编辑器、xterm.js 终端、可编辑输入框、URL、文件路径与命令行参数，只翻译 UI 文案。
  - 使用 `WeakMap` 保留原始英文节点，支持 `简体中文 ↔ English ↔ 其他语言` 无损即时切换。
- **双加载路线（共用同一套引擎与词典）**
  - **路线一：非破坏性启动器（CDP 动态注入，推荐）** — 不修改客户端任何文件，更新省心、无签名校验风险。
  - **路线二：静态补丁（`app.asar` 注入）** — 支持覆盖原生顶部菜单栏，内置强制原版备份与一键还原。
- **可选：Agent 中文工作流插件（`agent-plugin/`）**
  - 基于 Antigravity 官方插件规范开发，让 AI 对话、实施计划、任务清单默认使用简体中文，并附带 `zh-commit` 与 `zh-code-review` 技能。

---

## 目录结构

```text
antigravity-zh-cn/
├── locales/                     # 多语言词典体系（易扩展）
│   ├── manifest.json            # 语言包注册表（en / zh-CN / 后续扩展语言）
│   ├── _template/               # 新语言包模板
│   └── zh-CN/                   # 简体中文分模块词库（sidebar / settings / chat / menu / common）
├── engine/                      # 核心运行时引擎（DOM 隔离翻译 + 设置页语言选择器）
│   ├── translator.js
│   ├── language-ui.js
│   └── runtime-entry.js
├── launcher/                    # 路线一：非破坏性 CDP 动态注入启动器
│   ├── launch.mjs
│   ├── start-windows.ps1        # Windows 一键启动 / 创建桌面快捷方式
│   └── start-unix.sh            # macOS / Linux 启动脚本
├── patcher/                     # 路线二：零依赖内置 ASAR 静态补丁（保留 unpacked + 备份/还原）
│   ├── asar-codec.mjs
│   └── patch.mjs
├── agent-plugin/                # 可选：Agent 中文工作流插件（plugin.json + rules + skills）
├── scripts/
│   ├── build-bundle.mjs         # 校验词库并构建 dist/i18n-runtime.js
│   └── install-agent-plugin.mjs # 一键安装/卸载 Agent 中文插件
├── tests/                       # 自动化测试（node --test）
├── package.json
├── LICENSE
└── README.md
```

---

## 快速开始

> **环境要求**：Node.js `>= 18`（使用 CDP 启动器推荐 Node.js `22+` 内置 `WebSocket`）。

先克隆本仓库并构建多语言运行时：

```bash
git clone https://github.com/xxhuid/antigravity-zh-cn.git
cd antigravity-zh-cn
npm run build
```

### 方式一：非破坏性启动器（不修改客户端文件）

> **使用方式说明**：由于本方式完全不修改 Antigravity 本体文件，**每次启动客户端都需要通过下方命令（或启动器快捷方式）打开**；直接双击官方原图标仍会以英文原版启动。  
> Windows 用户只需执行一次 `-CreateShortcut` 生成桌面快捷方式，以后直接双击桌面上的 **「Antigravity (中文版)」** 即可，无需每次手敲命令。如果你希望始终直接双击官方原图标即生效，请使用下方**方式二（静态补丁）**。

1. 先完全退出正在运行的 Antigravity 桌面端（包括系统托盘）。
2. 启动多语言客户端：

**Windows (PowerShell):**

```powershell
# 每次启动时运行（方式 A：命令行直接启动）
.\launcher\start-windows.ps1

# 或仅执行一次，在桌面创建「Antigravity (中文版)」快捷方式（方式 B：以后直接双击图标）
powershell -ExecutionPolicy Bypass -File .\launcher\start-windows.ps1 -CreateShortcut
```

**macOS / Linux:**

```bash
chmod +x ./launcher/start-unix.sh
# 每次启动时通过此脚本打开（可自行配置终端 alias 或桌面启动器）
./launcher/start-unix.sh
```

> 若未自动检测到安装路径，可通过 `--app "<Antigravity 可执行文件路径>"` 或环境变量 `ANTIGRAVITY_APP_PATH` 手动指定。

### 方式二：静态补丁（`app.asar` 注入，执行一次后直接点官方原图标生效）

```bash
# 1. 查看检测到的 app.asar 与备份状态
npm run patch:status

# 2. 预演补丁计划（不修改任何文件）
npm run patch:dry-run

# 3. 应用静态补丁（首次运行会自动备份为 app.asar.zh-cn.bak）
npm run patch:apply

# 4. 如需一键还原官方原版
npm run patch:restore
```

> **注意**：
> - 内置纯 Node.js ASAR 编解码器，**零外部依赖**（无需安装或联网下载 `@electron/asar`），且原样保留所有 `app.asar.unpacked` 原生模块条目。
> - Antigravity 官方自动更新后会覆盖 `app.asar`，只需再次运行 `npm run patch:apply` 即可（脚本会自动识别新版本号并刷新原版备份，**不会**拿旧版备份覆盖新版客户端）。
> - 若客户端启用了 ASAR 完整性校验或 macOS 签名校验导致无法启动，请运行 `npm run patch:restore` 还原并改用**方式一（CDP 启动器）**。

### 更新汉化词库

当仓库更新了新词条或新语言包时，无需 `npm install` 或手动编译：

```bash
# 静态补丁模式：拉取最新代码并重打补丁（需先退出 Antigravity，完成后重启）
git pull && npm run patch:apply

# CDP 启动器模式：只需 git pull，下次打开启动器会自动检测更新并重建
git pull
```

---

## 平台与版本兼容性

### 平台支持状态

| 平台 | 当前状态 | 推荐方式与说明 |
| :--- | :--- | :--- |
| **Windows** | 已实机验证 | **静态补丁**与 **CDP 启动器**均可用；若 Antigravity 安装在 `C:\Program Files`，执行静态补丁时请使用管理员 PowerShell |
| **macOS** | 方式一（CDP）已实机验证 | **强烈推荐使用方式一（`./launcher/start-unix.sh`）**；方式二（静态补丁）修改 `app.asar` 并做临时重签（`codesign --force --deep --sign -`）会破坏官方签名，在 Apple Silicon 上可能导致官方自动更新安装时签名校验失败（仅还原 `app.asar` 无法恢复整包签名，需重装官方 DMG） |
| **Linux** | 代码已适配，待社区实测 | 支持自动探测 `/opt/`、`/usr/lib/` 及 `~/Applications/Portable`、`~/Applications`、同级目录的便携解压包（`Antigravity-x64` / `Antigravity-arm64`）；只读挂载的 **AppImage** 请直接使用方式一（`./launcher/start-unix.sh --app <AppImage路径>`） |

### Antigravity 版本对应关系

本项目采用独立语义化版本号（SemVer），不与 Antigravity 官方版本号强绑定；每个发布版本均标注已实测适配的客户端版本（详见 [CHANGELOG.md](./CHANGELOG.md)）：

| 本项目版本 | 已实测 Antigravity 版本 | 兼容范围与说明 |
| :--- | :--- | :--- |
| **`v0.3.0`** | `2.35.1`（Windows / macOS） | 593 条 UI 词条 + 51 条动态正则；重构核心引擎（用户内容/混合容器隔离、纯 WeakMap 防泄漏、rAF 分帧防掉帧、作用域词典与快捷键保留）、修复聊天区误插设置卡片、强化 Linux 便携探测与 CDP 目标过滤 |
| **`v0.2.2`** | `2.35.1`（Windows / macOS） | 546 条 UI 词条 + 42 条动态正则，补全「账号」页、Plus/Starter 套餐说明与长句正则，确认 macOS CDP 实机可用 |
| **`v0.2.1`** | `2.35.1`（Windows） | 531 条 UI 词条 + 41 条动态正则，补全权限/模型/用量/上下文菜单，修复 `New` 徽标语境与多词大小写匹配 |
| **`v0.2.0`** | `2.35.1`（Windows） | 492 条 UI 词条 + 33 条动态正则，通常兼容 `2.35.x+` 小版本更新 |

- **跨版本兼容性**：本框架基于 DOM 运行时词典匹配与无侵入注入，不依赖客户端压缩代码的变量名或行号，通常天然兼容同大版本下的后续小版本更新（仅新版本新增的英文文案需补充词库）。
- **官方客户端更新后**：静态补丁会自动比对 `app.asar` 内置版本号与补丁标记，发现官方更新后会自动刷新原版备份，安全无损重新注入。

### 可选：同时安装 Agent 中文工作流插件

让 AI 助手的回复、实施计划（Implementation Plan）、任务清单、Code Review 和 Git Commit 也默认使用简体中文：

```bash
# 全局安装到 ~/.gemini/config/plugins/antigravity-zh-cn
npm run install:agent-plugin

# 如需卸载
node scripts/install-agent-plugin.mjs --uninstall
```

安装后在 Antigravity 左侧栏进入 **Skills & Customizations**（技能与自定义）即可随时开启或关闭。

---

## 切换界面语言

安装并启动后，可通过以下任意方式切换语言（立即生效，无需重启）：

1. 进入 Antigravity 的 **设置（Settings）-> 通用（General）**，在顶部 **界面语言** 卡片中切换显示语言（也可在此随时开关右下角悬浮按钮）。
2. 按快捷键 **`Ctrl + Alt + L`**（macOS 为 **`⌘ + ⌥ + L`**）呼出语言选择弹窗（即使隐藏了右下角悬浮按钮，依然可随时用快捷键唤出并重新开启）。
3. 点击窗口右下角悬浮语言徽标（可在弹窗或设置页中随时关闭/恢复显示）。

> **词条贡献者调试提示**：如需扫描当前页面尚未翻译的英文词条，可在开发者工具（DevTools）控制台运行 `window.__ANTIGRAVITY_I18N__.setDebugMode(true)`，随后在语言弹窗中会出现「复制当前页未翻译词条 (JSON)」按钮；或直接运行 `copy(window.__ANTIGRAVITY_I18N__.collectUntranslated())`。

---

## 添加新的语言包

欢迎通过 PR 贡献繁体中文（`zh-TW`）、日语（`ja`）、韩语（`ko`）等更多语言包！只需 3 步：

1. 复制 `locales/_template/` 为新目录，例如 `locales/zh-TW/`，并在其中编写 `index.json` 与对应模块词库（参考 `locales/zh-CN/`）。
2. 在 [locales/manifest.json](./locales/manifest.json) 的 `locales` 数组中注册新语言：
   ```json
   {
     "code": "zh-TW",
     "name": "Traditional Chinese",
     "nativeName": "繁體中文",
     "direction": "ltr",
     "entry": "zh-TW/index.json"
   }
   ```
3. 运行校验、构建与测试：
   ```bash
   npm run validate:locales
   npm run build
   npm test
   ```

构建完成后，客户端内的“界面语言”下拉菜单与快捷键切换弹窗会自动列出你新增的语言。

---

## 免责声明与 License

- 本项目为社区驱动的开源本地化项目，与 Google 无任何官方隶属关系。
- 本项目采用 [MIT License](./LICENSE) 开源。
