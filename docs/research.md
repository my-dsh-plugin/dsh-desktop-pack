# 调研资料

> 记录外部资料与源码证据位置，防止遗忘。所有结论的出处都在这。

## 1. 社区 DSH 桌面封装项目

| 项目 | 技术栈 | 关键点 |
|---|---|---|
| [xiincs/deepseek-harness-desktop](https://github.com/xiincs/deepseek-harness-desktop) | Tauri 2 | 54MB（Electron 1/3）；WebView2/WKWebView/WebKitGTK；托盘常驻、崩溃自恢复、自动更新；**无 Tauri IPC**（纯远程页面）；Windows 签名，mac/Linux 未公证 |
| [csyyywy/dsh-desktop](https://github.com/csyyywy/dsh-desktop) | Electron | 壳核分离（原样跑官方 dsh）；内置便携 Node v22 免联网；**插件管理器**（GitHub `dsh-plugin` topic、一键装/卸、备份回退）；绿色版/NSIS/单文件便携三种产物 |
| [codeAnqiang-ma/dsh-installers](https://github.com/codeAnqiang-ma/dsh-installers) | 原生安装器 | **免 Node**：捆绑官方 Node + 官方未改动 dsh npm 包；dmg/pkg/exe/zip/tar.gz 全平台；SHA256SUMS；构建脚本可参考（build-windows.ps1：下载 Node → 校验 → npm install → dsh.cmd 包装器 → 冒烟测试 → 打包） |
| [RZX00/deepseek-harness-desktop](https://github.com/RZX00/deepseek-harness-desktop) | Electron fork | 自带运行时免预装；**教训：无 terminal 工具**（PTY 后端是编译模块，包没带）——分发包必须验证 terminal 可用性 |
| [myYangyunfan/dsh_desktop](https://github.com/myYangyunfan/dsh_desktop)、[zasSYJ/deepseek-harness-desktop](https://github.com/zasSYJ/deepseek-harness-desktop)、[Skyearn/deepseek-harness-app](https://github.com/Skyearn/deepseek-harness-app)、[ipfred/deepseek-harness-app](https://github.com/ipfred/deepseek-harness-app) | 各色 | 社区个人项目，供参考不供依赖 |

## 2. Claude Code / Codex 的 Windows bash 做法（结论：都不内化）

- **Claude Code**：原生 Windows 需要 Git Bash 提供 Unix 工具（grep/find/awk/sed）。官方无内置 bash，靠检测宿主 Git for Windows。社区痛点实证：[Bash tool non-functional on Windows](https://github.com/anthropics/claude-code/issues/45830)（PATH 找不到可执行文件，工具失效）、[VS Code panel requires git-bash](https://github.com/anthropics/claude-code/issues/25599)。第三方 [win-claude-code](https://github.com/somersby10ml/win-claude-code) 的做法是**绕过 bash 检测 + 可选检测宿主 Git Bash 提供 Unix 命令**——与我们 ADR-005 同思路。
- **Codex**：Windows App 有 WSL 支持但 agent 仍按 Windows_NT 跑，导致 `/bin/bash` CreateProcess 失败（[issue 26096](https://github.com/openai/codex/issues/26096)、[issue 2172](https://github.com/openai/codex/issues/2172)）。同样是"依赖宿主环境，不内化"。

**共同结论**：两大厂商都不内化 bash（体积 + GPL + 维护成本），全部走"检测宿主/依赖宿主"路线。我们 ADR-005 与之对齐。

## 3. 锚定/模式相关社区项目（dsh-presets 的设计来源）

| 项目 | 贡献 |
|---|---|
| [xiaobright/modeltest](https://github.com/xiaobright/modeltest) | Project2 评测（Minimal 99/96 vs Standard 91/92）；Flash 跟随 persona、Pro 跟随工具目录；触发机制实验文档（docs/v4.1/） |
| [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | 首请求工具 schema 锚定（MIT）；我们 bootstrap.mjs 的来源 |
| [dbydd/pi-anchored-tool-for-dspro](https://github.com/dbydd/pi-anchored-tool-for-dspro) | 同一锚定移植到 pi 编码器（跨平台验证） |
| [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) | 三行为带（spec/mixed/react）+ weak 内路由；按模型选 persona（Pro=spec 句，Flash=neutral+classify，P11/P23）；RL 形状接口（shell+editor → 100% 行动 vs read/write/edit → 25%） |
| [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) | 注入器 + 路由预设 + 模式提升三件套（1641 stars） |

## 4. 学术研究（通用 agent，佐证方向）

- [BiasBusters](https://arxiv.org/abs/2510.00307)：工具选择偏差——描述扰动敏感、位置偏差、预训练暴露放大
- [ToolTweak](https://scite.ai/reports/tooltweak-an-attack-on-tool-3nYkOMRA)：工具描述可被操纵
- [Progressive tool loading (Wire Blog)](https://usewire.io/blog/progressive-tool-loading-mcp-context-pattern/)：Anthropic 案例 150K→2K tokens；"保持大目录、工作集变小"
- [Is Progressive Disclosure All You Need (arXiv 2607.17598)](https://www.alphaxiv.org/overview/2607.17598)：首个受控研究——渐进披露有效但取决于设计
- [cocoloop 论坛](http://www.cocoloop.cn/t/topic/4956/7)：DSv4 系统指令位置敏感（放最后一条消息末尾才管用）

## 5. 源码证据位置（deepseek-harness-fork）

| 机制 | 位置 |
|---|---|
| DSH_HOME 解析 | `packages/util/home-paths/src/index.ts:87`（`resolveDshHome`） |
| 用户预设根 | `packages/preset/agent-presets/src/discovery.ts:41`（`USER_PRESET_DIR = '.agent-presets'`） |
| roster 无记忆重读 | `packages/preset/agent-presets/src/index.ts`（注释：list/resolve 每次重读 roots） |
| 本地插件文件 import | `packages/preset/agent-presets/src/mount.ts`（`.` 开头 specifier → `super.import` 相对路径） |
| webserver 端口 | `packages/host/webserver/src/index.ts`（Config: host/port；`listen(port, host)` → `listenedPort`） |
| 默认端口 | `packages/bundle/web-app/cordis.patch.yml:120`（`port: !!js ctx.webStartup.port ?? 3080`） |
| profile bundle patch | `packages/bundle/*/src/index.ts`（`dsh.bundle.patch` 由 profile composer 解析） |
| 终端 bash 平台 | `packages/terminal/terminal-bash/src/config.ts:46`（`shellPath` 默认 `/bin/bash`，linux/darwin-only） |

## 6. 关键实测结论（本人验证）

- flash-boost 写完即 `standingKeyFor` 挂载成功，**全程未重启** → 模式热更新成立
- Windows 门控修复（persistent-shell win32 disabled + bootstrap 对 pwsh 替换）双模式挂载 OK（dsh-presets 47c61bb）
- `raw.githubusercontent.com` 在本网络不可达（API 可达）→ 更新源必须可配置
