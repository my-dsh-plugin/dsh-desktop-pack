# 决策记录（ADR）

> 每条记录：结论 + 依据。调研细节见 research.md。

## ADR-001：内化便携 Node

**结论**：内化。分发包自带便携 Node（官方发行包 + SHA256 校验）。

**依据**：用户零依赖；社区已验证（codeAnqiang-ma/dsh-installers：下载 Node → npm install dsh → dsh.cmd 包装器，冒烟测试通过）。用户确认"首先肯定是要内化自带 node"。

## ADR-002：随机回环端口，不固定 3080

**结论**：`--port 0` + `host: 127.0.0.1`（OS 分配随机端口，仅回环）。

**依据**（源码实证）：
- `dsh-host-webserver` Config：`host: '127.0.0.1' | '0.0.0.0'`、`port: z.natural()`，`port: 0` 请求 OS 分配（`listen(0)` → `address().port`）
- 默认 `port: !!js ctx.webStartup.port ?? 3080`（web-app bundle patch）
- `127.0.0.1` 只本机可连，不暴露局域网；随机端口无固定占用、无冲突
- 用户确认：不想在真机暴露固定端口占用

**代价**：启动器需运行时解析实际端口再加载 WebView（待研究干净通道）。

## ADR-003：模式预置 + 热更新（不重启）

**结论**：模式进 `seed-dsh-home/.agent-presets/`，更新器从 dsh-presets 仓库拉取，新会话即生效。

**依据**（源码实证）：
- roster 无记忆重读：`list()`/`resolve()` 每次重扫目录（agent-presets/src/index.ts）
- 用户预设根固定 `$DSH_HOME/.agent-presets/`（`USER_PRESET_DIR`）
- 本地实证：写完 flash-boost 文件 → 探针 standingKeyFor 立即挂载成功，全程未重启

## ADR-004：插件内化（link → 实体 + peer 对齐 + 来源动态配置）

**结论**：构建期把插件复制为实体目录进 seed 的 node_modules；peerDependencies 解析到捆绑 dsh。内置插件来源由 `builtin-sources.json` 动态配置，支持 **git 仓库源码**与**本地绝对路径**，不在打包脚本里写死仓库地址（详见 ADR-026）。

**依据**：当前开发态是 `"link:/Users/.../plugin"` 绝对路径符号链接，用户机器不可用。bundle patch 由 profile composer 按 `dsh.bundle.patch` 解析——包能被 node 解析即自动工作。peer 版本不一致会导致 dsh-* 双实例（Cordis 服务冲突）。

## ADR-005：Windows bash —— 检测宿主，不内化

**结论**：检测宿主 Git Bash（标准路径 + PATH），不内化；无则降级 pwsh。

**依据**：
- 模式层已不依赖 bash（pwsh 替换完成，dsh-presets 47c61bb）——bash 是增强非必需
- Git for Windows（MSYS2）是 GPL-3.0：内化要保留声明 + 提供源码对应，CI/发布持续负担
- Claude Code / Codex 均不内化（见 research.md §2）
- 目标用户（开发者）装 Git 是默认动作，检测命中率高

## ADR-006：WebView 壳 —— Tauri 2 薄壳 + 页面无 Tauri IPC

**结论**：壳选 **Tauri 2**（Rust 手写薄壳，不选 Pake / `--app=` / Electron）。**页面不授予任何 Tauri IPC**（不开 capabilities / 不注册 invoke handler，页面纯 http 加载本地回环服务）。

**进程模型**：Tauri shell 只做窗口/托盘/单实例，真正的 launcher 是随包提供的常驻 **Node manager**（`runtime/app/manager.mjs`）。shell spawn manager，二者通过**stdio JSON Lines** 通信（原生进程管道，不是网络、也不是 Tauri IPC）：manager 负责 DSH 生命周期、日志、seed/迁移、safe-mode/bisect、diag 与更新 staging。

**选型理由**（对比详见 research.md 社区调研）：
- 托盘是硬需求（ADR-013：5 项菜单）——`--app=` 无托盘直接淘汰；Pake 托盘极简、菜单定制受限、无单实例、AUMID 难配
- Pake 本质是 Tauri 薄封装但暴露面窄，系统集成（托盘菜单/单实例/通知 AUMID/窗口行为）直接用 Tauri 拿完整能力，壳代码仅数百行 Rust，一次性成本
- 社区先例：xiincs 用 Tauri 2 + 无 IPC 实证可行（54MB、托盘常驻、崩溃自恢复、自动更新）
- 更新走自有 GitHub Release 流程（ADR-014），不用 tauri updater

**壳配置清单（落地规格）**：
- **托盘**：tray-icon + 菜单 5 项——打开主界面 / 故障排查（--diag）/ 检查更新 / 重启 / 退出；图标随 bundle 打包
- **单实例**：tauri-plugin-single-instance，第二实例唤醒既有窗口后退出
- **通知**：tauri-plugin-notification 仅用于**配置 Windows AUMID**（toast 归属应用名/图标）；实际通知仍由页面 Web Notification 触发（ADR-015），壳层不主动发通知
- **无页面 IPC**：不注册任何 invoke handler，页面与 Tauri core 零信任面
- **shell ↔ manager**：stdio JSON Lines（内部可信通道）；manager 的 stdio 命令不是网络端口，页面不可达
- **窗口行为**：关闭按钮 = 隐藏到托盘（不退出）；再次启动/托盘点击恢复窗口；窗口大小/位置记忆（配置文件存 `data/`）
- **加载**：manager 启动 DSH `--port 0` 后解析 stdout 的 `dsh web: http://127.0.0.1:<port>` 就绪行，把 URL 回报 shell 后才加载 WebView；超时/无就绪行则按启动失败进恢复流程
- **安全**：仅允许导航到 `http://127.0.0.1:<port>`，禁止一切外部导航/新窗口（shell.open 不启用）

**依据**：DSH 本身是本地 Web 服务，壳只负责展示 + 生命周期；xiincs 方案实证无 IPC 页面纯远程加载，攻击面最小化。用户确认真机 WebView 可接受。

## ADR-007：模式手动切换（不做自动路由）

**结论**：Pro/Flash 分模式手动选择（anchored-minimal vs flash-boost），不做 spec/react 自动分类路由。

**依据**：
- 自动路由（router-standard）在首条用户消息上分类，黑盒、可能分错
- 手动选择把路由决策交给最了解任务的人
- 用户确认："给 flash 单独做一个模式，手动切换模式"（已实施为 dsh-presets/flash-boost）

## ADR-008：DSH_HOME 定位 —— 程序安装目录内（便携布局）

**结论**：DSH_HOME = **程序安装目录内的数据子目录**（便携布局，如 `<install>/data/dsh-home/`）。
不用 `~/.dsh`、不用 `%APPDATA%`。首次启动**询问是否从现有 `~/.dsh` 迁移/拷贝**。
启动失败必须有**恢复/清理入口**。
macOS DMG 形态例外：`.app` 自包含 runtime/seed（`Contents/Resources/`），用户数据写 `~/Library/Application Support/dsh-desktop/dsh-home/`；zip 绿色版仍保持 `data/` 随程序目录（ADR-018）。

**依据**（用户拍板）：
- 程序目录内 = 完全自包含、卸载即清、多实例天然隔离
- 兼容性/互通需求通过**首启迁移**满足（拷贝 ~/.dsh 的会话/凭据/设置/模式/插件），而非直接共用
- 迁移是**拷贝不移动**：保留原 ~/.dsh 作为备份，可回退

**前提（必须验证）**：
- 程序安装目录必须**可写**。macOS `/Applications`、Windows `Program Files` 默认只读——
  分发包的形态必须是**绿色版/便携版布局**（解压到用户可写位置），或安装器负责把数据目录建到可写处并检测写入权限
- 启动器首启先做**写权限自检**：无法写入 → 明确报错并给出修复指引（换目录/授权），而不是静默失败

**首启迁移流程**（询问式，默认不迁移）：
1. 检测 `~/.dsh` 是否存在且非空
2. 询问：是否拷贝以下内容（可勾选，`.env` 默认不勾选）——
   - 会话（`sessions/`）
   - 状态/工作区（`storages/`）
   - 凭据（`.credentials.yaml`）——注意密钥安全，明确告知；复制后强制 0600（Windows 收紧 ACL）
   - 设置（`settings.yaml`）——用户文件优先于 seed 默认，seed 版本备份
   - 环境（`.env`）——含密钥/代理配置，需单独告知
   - 匿名身份（`.anonymous-user-id`）
   - 已装模式（`.agent-presets/`，no-clobber：内置 id 不覆盖）
   - 插件（`profiles/<name>/`，仅迁移 package.json 用户依赖 + cordis.patch.yml + 用户插件实体目录）
3. profiles 迁移规则：
   - `package.json` 依赖合并进 seed profile；同名依赖用户声明优先，`@deepseek-ai/dsh-*` 核心依赖不允许覆盖捆绑版本
   - `cordis.patch.yml` 数组合并：seed 基础在前，用户 patch 在后；同 id 后者覆盖
   - 插件实体目录：符号链接解析为目标实体后复制；`node_modules/`、pnpm lock、绝对路径 link 不整目录拷贝；完成后重跑 `dsh plugin --profile <name> install` 修复依赖
4. 顺序：seed(no-clobber) → 迁移(no-clobber/merge) → 写完成标记
5. 拷贝不移动；原 `~/.dsh` 原样保留，可回退
6. 首次跳过/部分迁移后，设置页保留“从 ~/.dsh 迁移”入口

**故障恢复/清理（必备设计）**：
- 启动器支持 `--reset-home`：把当前 DSH_HOME 改名 `.bak-<时间戳>`（不删除，可恢复）再重建
- 启动器支持 `--safe-mode`：由 Node manager 创建临时隔离 home（`data/safe-home`，启动前清空重建）并以 `DSH_HOME=<install>/data/safe-home` 启动 `dsh web --port 0`。空 home 只自动生成 base + web-app 模板，天然跳过用户 patch、插件 bundles 与 `.agent-presets/`，用于诊断"是配置炸了还是程序炸了"——不新增 DSH core 参数
- 首启/每次启动写**启动日志**到 DSH_HOME 外（如 `<install>/logs/`），崩溃时用户可查看
- 启动失败时 UI/CLI 提示：日志位置 + `--reset-home` / `--safe-mode` 指引
- 原则：**程序与数据分离**（runtime/ 与 data/ 分开），清理数据不破坏程序，重装不丢数据

## ADR-009：Shell 优先级（Windows / macOS）

**结论**：
- Windows：`pwsh` → `powershell`（5.1，系统自带）→ Git Bash（仅作为 bash 工具后端，不用于启动脚本）
- macOS：`/bin/zsh`（默认，无需检测）→ `/bin/bash`（3.2 兜底）

**依据**：
- 与厂商实践一致：Claude Code / Codex 均不内化 bash，靠检测宿主
- pwsh 7 现代且 UTF-8 原生；5.1 系统自带零依赖兜底；Git Bash 不内化（GPL + 体积）
- macOS Catalina 起 zsh 是系统默认 shell，`/bin/zsh` 必然存在

**三条纪律**：
1. macOS 的 `/bin/bash` 是 **3.2（2007 年）**：无 `${var,,}`、无关联数组、无 `**`——兜底脚本必须按 bash 3.2 语法写
2. **脚本按最低公分母写，不是同一份换解释器跑**：zsh 数组索引从 1 开始、关联数组语法不同；PowerShell 5.1 没有 `??`/`??=` 等 pwsh 7 语法——一份脚本按最老解释器的语法子集写
3. **Git Bash 的角色分两层**：启动脚本层它是最后兜底（基本用不到）；bash 工具层（DSH 模式的 bash 工具后端）它才是唯一提供者（custom-bash 检测）

## ADR-010：Windows 编码策略（第一大坑）

**结论**：Windows 系统默认编码不是 UTF-8（中文系统 ANSI 代码页 936/GBK，英文系统 437/1252）——**所有文件读写、管道、控制台输出都不得依赖系统代码页**。分发包内部统一 UTF-8。

**坑清单**（全部实测/已知）：
- **PowerShell 5.1**：无 BOM 的 UTF-8 文件按 ANSI 解析 → 中文乱码（所以 ps1 必须带 UTF-8 BOM）；`Get-Content`/`Set-Content` 默认 ANSI
- **控制台代码页**：`chcp` 默认 936/437；Node/Python 子进程 stdout 按控制台代码页编码 → 管道到 PowerShell 乱码
- **`irm | iex`**：网络拉取内容经 5.1 管道时按 ANSI 解码，UTF-8 内容会被破坏
- **Node 侧相对安全**：Node 内部统一 UTF-8，读文件默认 UTF-8；但子进程 stdout 仍是控制台代码页

**应对**：
1. **ps1 一律 UTF-8 with BOM**（5.1 正确解析中文的前提；pwsh 7 无 BOM 也能读，但统一带 BOM 两边都稳）——已在 dsh-presets 安装脚本落地
2. **写文件用 `[System.IO.File]::WriteAllText(path, content, New-Object Text.UTF8Encoding($false))`**：无 BOM 的 UTF-8（YAML/Node 读取方最稳）
3. **脚本开头设 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`**（5.1 中可设）
4. **禁止依赖**：系统代码页、`chcp` 结果、ANSI 编码的任何隐式假设
5. 预设文件（agent.cordis.yml / bootstrap.mjs 含中文注释）**必须是 UTF-8 字节原样落盘**，seed/更新器不得经过任何编码转换
6. 校验手段：seed 后对预设文件做 UTF-8 完整性检查（读回 + 比对），防静默损坏

## ADR-011：故障排查分级 —— 点名日志 → 单条隔离 → 二分 → 才重置

**问题**：装了几十上百个插件，只有一个炸了，`--reset-home` 重装全部不能接受。恢复必须能**逐个排查**。

**DSH 现状（已核实源码，deepseek-ai/deepseek-harness）**：

1. **启动失败点名报错**：`boot()` 尾部 `assertEntriesActivated` 审计所有 enabled 条目——任何 apply 失败 / inject 挂起 / 模块加载失败的条目，都会 throw 一条错误，**逐条列出插件名 + 原始 stack**（`<name>: <stack>`）；模块解析失败则 `plugin(s) failed to load: X, Y`。后续未捕获 rejection 由 `installFailLoud` 打印 `fatal load failure: <stack>` 后 exit(1)。→ **日志天然点名，不需要猜**。
2. **disabled 是合法状态**：`assertEntriesLoaded` 明确"disabled 条目是唯一合法的无 fiber 状态"，禁用条目启动时直接跳过。`EntryOptions.disabled` 支持布尔或 `!!js` 表达式（条件禁用），祖先 group 禁用会级联。
3. **patch 层按 id 覆盖**（`@deepseek-ai/cordis-plugin-include`）：`PatchOptions { id, name?, disabled?, config?, ... }`，`{ id: 'xxx', disabled: true }` 精准禁用单条，不动基础配置；匹配不到目标 id 只是 warning 跳过（跨版本残留无害）；支持 `!!js`；group 内嵌套行同样可按 id 命中。
4. **用户 patch 层热生效**：profile 的 `cordis.patch.yml` 被 `watchUserPatches` 监听（Cordis HMR），保存即事务性重应用到根 Include（`entry.update`）——运行中禁用某条通常**免重启**。
5. **离线工具共享同一语义**：`dsh --dump-config` 用同一套 `applyEntryPatches` 合成补丁——发行版可以**不启动 app** 先离线算合成结果 / 预写隔离 patch。
6. **运行时状态可观测**：`plugin-inventory` Gateway（Typert Remote）暴露每条目 `entryId / moduleName / enabled / fiberPhase`；GUI 设置页已有只读"插件清单"tab（状态点 + 标签 + entryId）。官方无 UI 开关、无 CLI disable 命令——需要发行版自建。

**结论**：发行版故障恢复做成**四级排查体系**，`--reset-home` 降级为最后手段：

- **第 0 级 · 点名**（零成本）：启动器捕获 stderr，解析 `did not activate` / `fatal load failure` 列表 → UI 直接展示"以下 N 个插件未启动 + 原因"
- **第 1 级 · 单条隔离**（主路径）：对每个失败项提供"禁用此插件"→ 写 `cordis.patch.yml` 一条 `{ id, disabled: true }` → 重启（或运行中 HMR 热生效）。只动这一条，其余全不动
- **第 2 级 · 二分定位**（不知道哪个炸时）：manager 侧 `--bisect` 流程（不是 DSH CLI 新参数）——先跑 `dsh web --dump-config` 取当前有效 entry id 清单 → 生成临时 overlay（按 id 写 `{ disabled: true }`）→ 用 `dsh web --patch <overlay> --port 0` 反复启动探测（launcher 自身 flag 在前；成功 = 超时窗口内等到 `dsh web: http://127.0.0.1:<port>` 就绪行，随后 SIGTERM 收掉）→ 二分收敛到最小嫌疑集 → 把最终禁用写入正式 `cordis.patch.yml`
- **第 3 级 · 重置**（最后手段）：保留 `--reset-home`（改名备份不删除），此时用户已知元凶，可勾选保留项

**发行版必须配套的约定**：
- **seed/安装的 cordis.yml 每行带稳定显式 id**（如 `id: tool-fs`），否则 entryId 是随机 hex，patch 无法稳定引用——这是第 1 级成立的前提
- 恢复向导在 **Node manager（launcher）层**实现（spawn dsh → 解析 stdout/stderr → 写 patch → 重启），因为 boot 失败发生在 Web 服务起来之前，GUI 靠不住
- `--safe-mode` 走隔离 home（ADR-008）：safe-home 能出 URL → 问题在用户配置/插件/模式；safe-home 也起不来 → 问题在 runtime/core/Node，直接转更新/回滚路径
- 启动失败 UI 入口 = 恢复向导（非 DSH GUI）：点名列表 + 禁用/详情/二分/手动编辑 patch
- 本方案不需要给 deepseek-ai/deepseek-harness 增加 `--safe-mode` / `--bisect` 补丁
- 待验证：preset（模式）的 cordis.yml 是否支持用户 patch 层（preset 经 agentPresets 服务挂载，非 include 树）；不支持则模式内某行炸了走"第 2 级禁用该模式 + 其余模式不受影响"（preset 是 per-session 独立子树，一个模式失败不影响其他会话，需实测确认）

## ADR-012：恢复向导 —— launcher 自带 UI，禁用走 patch、卸载走基础文件

**问题**：故障排查需要"UI 展示插件清单 + 快捷禁用/卸载按钮"。但 boot 失败发生在 Web 服务起来之前，**DSH GUI 靠不住**；且 patch 层（ADR-011 的第 1 级手段）没有删除操作，卸载语义需要单独定。

**结论**：

1. **恢复向导 = Node manager 按需启动的最小 Web UI**（`--diag` 故障排查模式）：
   - manager 仅在本模式启动本地随机回环 HTTP：`http://127.0.0.1:<random>/diag/<128-bit-token>/`，页面由 manager 自身 serve，不依赖 DSH 任何服务
   - 页面通过同源 HTTP 调 manager 的 action API；所有修改类操作要求 POST + `Content-Type: application/json`，不返回任何 CORS 放行头
   - 默认只在 Tauri WebView 内打开，**不提供普通浏览器打开**；确需浏览器兜底时发放一次性短时 token 并校验 Origin
   - 关闭 diag 页面或超时即吊销 token、关闭 server；`Cache-Control: no-store`
   - 页面与 Tauri core 仍无任何 IPC（ADR-006 安全边界不变）
   - 数据源全部离线：`data/logs/` 启动日志（失败点名 + stack）+ `applyEntryPatches` 离线合成配置（bundled `@deepseek-ai/cordis-plugin-include` 可直接 require，与 `dsh --dump-config` 同一语义）
   - 启动失败自动进入（检测 exit≠0 + stderr 模式），也可手动 `--diag`
   - 操作按钮调 manager action API（写 patch / 改配置 / 重启），页面本身无状态、无权限

2. **禁用 vs 卸载分开**：
   - **禁用**：patch 层 `{ id, disabled: true }`——零风险可逆，运行中可 HMR 热生效，跨版本残留无害（id 匹配不到只是 warning）
   - **卸载**：`applyEntryPatches` 只支持 insert + id-targeted 覆盖，**没有 delete** → 卸载 = 编辑基础 cordis.yml 删除该行 + 原文件备份到 `data/backups/`（可恢复）；bundle 安装的插件同时移除包引用
   - UI 两者并列，默认推荐禁用；内置核心行（host 必需）标记不可卸载

3. **前提**：seed/安装的 cordis.yml 每行带稳定显式 id（patch 引用与卸载定位的前提）。

**待验证**：preset（模式）的 cordis.yml 是否支持用户 patch 层（preset 经 agentPresets 挂载，非 include 树）；不支持则模式内行失败走"禁用该模式"，模式本身是 per-session 独立子树、一个失败不影响其他会话（需实测）。

## ADR-013：系统托盘常驻（关窗不退出）

**结论**：
- 点窗口关闭按钮 = 最小化到托盘，DSH 进程保持运行（launcher 保活，会话不丢）
- 托盘菜单：**打开主界面 / 故障排查（--diag）/ 检查更新 / 重启 / 退出**
- 更新可用时托盘提示；平台惯例（Windows 通知区域、macOS 菜单栏）由壳层原生支持
- **单实例互斥**：Tauri shell 持有（tauri-plugin-single-instance），第二个实例只唤醒既有窗口/托盘后退出；manager 是 shell 的单实例子进程，不额外监听网络端口——避免双托盘/双进程/双端口冲突
- 托盘属壳层能力（Tauri 原生），不涉及 DSH 内部；退出 = shell 通知 manager 结束 DSH 进程树 + 清托盘

**理由**：DSH 是长驻服务（会话、后台任务、模式热更新），关窗即退出会丢上下文；桌面应用惯例也是托盘常驻。首启引导需说明"关闭 = 最小化到托盘，退出在托盘菜单"。

## ADR-014：更新渠道 —— 应用本体走 GitHub Release（双轨）

**结论**：
- **应用本体 → GitHub Release**（主渠道）：每版本发布 runtime 更新包 + shell 整包 + SHA256（可选签名）；`GET /repos/my-dsh-plugin/dsh-desktop-pack/releases/latest`（GitHub API 可达，raw.githubusercontent 实测被墙）
- **runtime 平面更新**：manager 下载 staging 到 `data/update-staging/` → 校验哈希 → 用户点"重启并更新" → 终止 DSH 进程树并让 manager/shell 退出 → 由 shell 资源内的 updater sidecar（在 runtime 外）执行：
  - **harness-only 更新**：解包到 `runtime/harness/versions/<new>/` → 用新版本做 `dsh --dump-default-config` 冒烟 → 原子翻转 `current.json` → 拉起；回滚 = 翻回旧版本号，旧版本保留最近 N 份
  - **node/manager 更新**：整体替换 `runtime/node/` 与 `runtime/app/`，保持 `runtime/harness/` 与 `current.json` 不动
  - 只有 harness 变化时**不整包替换 runtime/**，这也是外部动态引入的价值
- **shell 平面更新**：下载整包/安装器 → 用户确认 → shell 退出 → 同一 updater/安装器替换 `.app`（macOS）或走 NSIS（Windows）→ 保留 `data/` 与 `runtime/`；替换后执行 xattr 清理（ADR-020）
- **模式内容 → dsh-presets 仓库 manifest.json**（ADR-003 维持）：程序更新要重启，模式更新不重启（新会话热生效）
- 更新入口：托盘"检查更新" + 启动静默检查（可关）
- **待实测**：Release 资产 302 → objects.githubusercontent.com 的可达性（与 raw.githubusercontent 不同域）；不可达则保留可配置镜像/代理兜底

**理由**：用户拍板"渠道直接用 GitHub Release"——发布管理最省事（页面/资产/哈希一站式），且与 dsh-presets、readonly-security-audit 现有 org 仓库体系一致。模式内容体量小、更新频繁、需热生效，单独走 manifest 更合理。

## ADR-015：会话完成平台通知（窗口失焦时）

**需求**：窗口失焦时，会话/任务完成弹平台通知（Windows toast / macOS 通知中心），点击回窗口。

**关键事实（已核实源码）**：
- 完成信号 = `agent/status`（`AgentStatus: 'running' | 'idle'`，running→idle 即一次完成）；host 侧可直接监听（agent-scoped emit 事件）
- **浏览器收不到 host 事件**：转发是白名单制（`API_REMOTE_FORWARDED_EVENTS`，`packages/api/remotes/src/remote-events.ts`），当前无 agent 事件；且 `agent/status` payload 含 live `Agent` 对象，不可 verbatim 序列化
- bundle 预置插件支持 `dsh.client` 行（host 半 + client 半成对，node 半是 layer-2 host）

**结论**：
- **通道（首发）**：预置 bundle 插件对——host 半监听 `agent/status` 聚合完成标记；client 半轮询 `host.call('notify:take')`（Package-private RPC，本地回环 ~1s，顺带上报焦点状态）。**零补丁**
- **升级备选**：实时性不可接受时，给 upstream 加扁平化完成事件 + 白名单（需改 core，payload 纯数据化），后置
- **失焦检测（client 半）**：`!document.hasFocus() || document.visibilityState !== 'visible'`（切走 + 最小化都覆盖）
- **通知走页面 Web Notification**：跨平台一致、点击聚焦天然、不依赖宿主脚本；壳层配套 = WebView2 配置 AppUserModelID（Windows toast 归属）、WKWebView 通知中心、首次授权 WebView 自动请求——权限/AUMID 配置列入壳层实测项
- 设置项：开关默认开；失焦才弹，聚焦静默

## ADR-016：DSH 版本策略 —— 打包工程外部动态引入 upstream 自构建 harness

**结论**：`dsh-desktop-pack` 定位为**打包工程**，仓库内不放置 DSH core 源码与构建产物。发行版默认从 **deepseek-ai/deepseek-harness upstream 源码自构建**（pin 到 ref/commit），也可按 ADR-026 切换 npm / local 来源；发布期按 `current.json` 动态指向 `runtime/harness/versions/<version>/`。

**理由**：upstream 是 DSH 的权威来源；打包工程不 vendoring core，外部引入让"换 harness 版本 = 加目录 + 翻指针"，打包与回滚都简单。如后续需要核心补丁，可把 harness 来源切到 fork 或 local 源码，不改变打包框架。

**配套机制**：
1. **外部来源锁定**：打包仓库维护 `harness-source.json`：支持 `npm` / `git` / `local` 三种 `kind`（ADR-026）；发布默认 `git` = deepseek-ai/deepseek-harness 的 pinned ref/commit，不把源码或 node_modules 提交进本仓库
2. **构建来源**：按来源 kind 解析到本地后，upstream 源码 `pnpm install/build` 产出（web-app bundle + base/headless bundles），打包脚本生成平台 harness 目录 `harness-<version>-<platform>/`，替代 dsh-installers 的 `npm install @deepseek-ai/dsh` 配方；`npm` kind 记录 package/version/integrity，`local` 仅限开发
3. **运行时布局**：
   ```
   runtime/harness/
   ├── current.json                    # 发布态 { "version": "20260211.1" }；开发态 { "path": "<外部构建产物>" }
   └── versions/
       └── <version>/
           └── node_modules/@deepseek-ai/dsh/lib/bin.js
   ```
   manager 启动 DSH 前读取 `current.json` 解析 `versions/<version>/...`；跨平台不依赖 symlink/junction
4. **开发态外部直连**：`current.json` 支持指向外部 upstream 构建产物的路径（本地开发）；发布包只允许指向 `versions/` 内已校验版本
5. **替换与回滚**：新增版本 = 解包到 `versions/<new>/` 并全量校验；切换 = 临时文件 + rename 原子写 `current.json`；回滚 = 翻回旧版本号；旧目录保留 N 份后清理
6. **版本号方案**：统一 `yyyyMMdd.n`（UTC 日期，n 从 1 起；ADR-025）——比较解析为 `(yyyyMMdd, n)` 两个整数做数值比较，禁止字典序字符串比较；upstream 基座（基于哪个 upstream commit/版本）记录在 release notes，不进版本号
7. **upstream 版本策略**：升级 = 更新 `harness-source.json` 的 pinned commit/tag → 重新 build/打包/发版；如需本地补丁，把来源切到 fork 或 local 并维护 design §9 补丁清单
8. **升级路径**：build → 打包 harness 版本目录 → 随 GitHub Release 发 runtime/harness 更新包（ADR-014）→ 用户更新后翻转 `current.json`；**核心仍统一走发行版发版，不开放绕过发行的独立通道**
9. **风险边界**：upstream 更新后用户拿不到新特性——可接受（我们的目标用户以我们的发版为准）；需要上游某修复时升级 pinned commit 即时跟进

## ADR-017：sandbox 默认配置 —— workspace-write

**结论**：发行版默认 sandbox = **workspace-write**（会话工作区可读写，工作区外写操作按 DSH 沙箱策略逐次批准），用户在设置中可改。

**与预置模式的关系（设计决策）**：
- `anchored-minimal` / `flash-boost` 在 preset 内挂载 `@deepseek-ai/dsh-fs-local`（无沙箱本地 fs）。这是锚定效果的必要条件：这两档模式的文件工具不受默认 sandbox 约束，语义为本机全量文件访问。
- `readonly-audit` 模式依赖 read-only 沙箱，但发行版**不自动切换**；用户使用该模式前需自行把目标会话沙箱调为 read-only。模式内置，插件版（readonly-security-audit）不内置。

**理由**：目标用户是开发者，日常在项目目录里改文件，read-only 默认会频繁打断；工作区外的危险写仍有批准/拒绝闸门，安全底线保住。顺手优先，策略可改。

## ADR-018：安装器形态 —— zip 绿色版 + 平台安装包双轨

**结论**：两种产物都发布，**统一 runtime/ + data/ 拆分策略**（ADR-008，data/ 随程序目录）：
- **zip 绿色版**：解压即用，主推（用户可放任意可写目录）；根目录含 `runtime/`、`seed-dsh-home/`、`data/`、`bin/`
- **平台安装包**：Windows per-user NSIS（默认 `%LOCALAPPDATA%\Programs\dsh-client`，可自选目录）；macOS dmg（拷贝安装到用户可写位置如 `~/Applications/dsh-client`，可自选）

**macOS DMG 安装形态（用户期望的标准 App 拖动）**：
```
dsh-desktop.app/
└── Contents/
    ├── MacOS/dsh-desktop
    └── Resources/
        ├── runtime/               # node + manager + harness
        └── seed-dsh-home/         # 首次启动 seed 来源
```
- DMG 只展示 `dsh-desktop.app` + `/Applications` 快捷方式，用户直接拖 App 安装
- 用户数据写入 `~/Library/Application Support/dsh-desktop/dsh-home/`（macOS 平台例外）
- zip 绿色版仍为目录形态：`runtime/`、`seed-dsh-home/`、`data/`、`bin/`

**关键约束**：macOS `/Applications`、Windows `Program Files` 只读，而 ADR-008 要求绿色版 DSH_HOME 在程序目录内——**Windows 安装包一律装用户可写位置**，不装系统只读目录；macOS DMG 用 App Support 存数据。安装包只是绿色版的"装到固定位置 + 快捷方式/卸载入口"包装。

## ADR-019：build/CI —— GitHub Actions 三平台构建 + Release 发布

**结论**：CI 必做，GitHub Actions：
- **构建矩阵**：`windows-latest`（x64）、`macos-latest`——双平台产物
- **流水线**：读 `harness-source.json`（npm/git/local，ADR-026）与 `builtin-sources.json`（模式/插件 git/local）→ 解析来源并校验 lock → checkout/build → harness 生成 `runtime/harness/versions/<version>/`，模式/插件实体化进 seed → 组装 runtime/node、app/manager.mjs、seed-dsh-home/ 与 `current.json` → Tauri 壳构建（Rust toolchain）→ 打包 zip + NSIS/dmg → 生成 SHA256 → 上传 GitHub Release 资产（ADR-014，含 latest 版本号）
- **签名**：无证书默认不签（见 ADR-020）；有证书时插入签名/公证步骤（留好步骤位）
- 发布触发：手动 workflow_dispatch 打 tag 发布，不在每次 push 自动发版

## ADR-020：mac 签名策略 —— 无证书社区路线 + xattr 去隔离，留公证升级位

**结论**：首发**不签名、不公证**（社区惯例：xiincs 等均如此）：
- 无 Apple Developer 账号（$99/年）成本；未签名 app 首次启动会被 Gatekeeper 拦截
- **发行版保留 xattr 去隔离步骤**：macOS 安装/首次启动引导中执行 `xattr -dr com.apple.quarantine <app>` 清除下载隔离属性（用户已确认安装的前提下），README 同时说明该操作的安全含义；用户拒绝时保留"右键 → 打开"兜底
- **升级/替换 `.app` 后同样执行 xattr 清理**，避免更新后的 app 再次被 Gatekeeper 拦截
- `xattr` 只清除 quarantine 标记，不是签名/公证的替代；**升级位**：将来有开发者账号时，CI 插入 Developer ID 签名 + `notarytool` 公证步骤（ADR-019 留位），产物不变，并移除 xattr 引导
- Windows 对称处理：无代码签名证书 → SmartScreen"更多信息 → 仍要运行"

## ADR-021：插件 bundling 范围 —— 自研全打，实验插件不打

**结论**：seed/profiles 内化范围：
- **模式**（`.agent-presets/`）：anchored-minimal、flash-boost、readonly-audit（纯预设版）——三个全带
- **模式自带插件**：anchored-minimal-tool-bootstrap、flash-boost-tool-bootstrap——是模式目录的一部分（bootstrap.mjs 随模式走，agent.cordis.yml 本地引用），随模式打包，不进独立 bundle
- **发行版专属插件**：会话完成通知插件对（host 半 + client 半，ADR-015）——dsh-desktop-pack 自研，进 `profiles/web/`
- **不打包**：readonly-audit 插件版（即 readonly-security-audit 仓库，实验性质，README 已标注实验）；社区第三方插件一律不预装

**理由**：用户指定"自研的都带，除实验安全审计"——readonly-audit **模式**内置，readonly-audit **插件版**不内置；实验插件版与纯预设版功能重叠且未稳定，不进入发行版。

## ADR-022：API Key onboarding —— 延后，正常首页先行

**结论**：首屏 API Key 引导**暂缓**，发行版默认进入 DSH 正常首页；API Key 配置仍走 DSH 自带凭据设置页（能力已有，不重复造）。首屏引导作为后续可选增强（待用户再启用）。

## ADR-023：更新策略 —— 自动检测，手动更新

**结论**：**检测自动、安装手动**（用户建议，采纳）：
- **自动检测**：启动时静默检查 + 常驻托盘期间每 24h 一次后台检查（均可关）
- **手动更新**：检测到新版本 → 托盘角标/通知提示（不自动下载、不自动安装）→ 用户进更新面板 → 版本对比（当前 vs 最新 + changelog）→ 用户确认 → 下载到 `data/update-staging/` → SHA256 校验 → 用户点"重启并更新" → 终止 DSH 进程树 → shell 资源内 updater sidecar 事务替换（harness-only 只翻 `current.json`）→ 冒烟 → 回滚或拉起
- **运行中禁止替换 runtime/**：进程存活期间只允许 staging；最终替换发生在退出后（ADR-014 双平面）
- 不做自动下载/静默替换：避免后台流量与半自动替换的状态问题；替换前校验哈希，失败自动回退

## ADR-024：模式更新 manifest.json 设计（dsh-presets 仓库）

**位置**：dsh-presets 仓库根 `manifest.json`，由仓库生成器（`scripts/gen-manifest.cjs`，扫描模式目录计算文件 sha256 + 读 preset.yml 的 version）生成并提交；仓库 CI 校验 manifest 与目录一致（防忘跑生成器）。

**获取通道**：GitHub API `GET /repos/my-dsh-plugin/dsh-presets/contents/manifest.json`（base64，raw 实测被墙；可配置镜像源，同 ADR-014）。

**结构**：
```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-02-11T00:00:00Z",
  "modes": [{
    "id": "anchored-minimal",
    "name": "锚定极简",
    "version": "20260211.1",
    "requires": { "dsh": ">=20260210.2" },
    "files": [
      { "path": "agent.cordis.yml", "sha256": "...", "size": 1234 }
    ]
  }]
}
```

**关键决策**：
1. **schemaVersion**：不兼容变更时升号；更新器拒绝未知版本
2. **文件级 sha256 + 安装基线快照**：
   - manifest 只描述**新版本**文件哈希，不能直接用于"本地是否被修改"判断
   - `.installed.json` 保存**上次安装成功的逐文件基线**（path/sha256/size），判断规则：
     - 本地 hash == 安装基线 → 未被修改，可安全更新
     - 本地 hash == 新 manifest → 已经是最新
     - 其他 → 本地修改或损坏：默认保留本地 + UI 提示可覆盖（与 seed no-clobber 理念一致）
   - 未变化文件可跳过下载（增量）；变化文件下载到 staging 后按新 manifest 校验
3. **安装流程（检测自动、安装手动，与 ADR-023 对齐）**：后台/手动检查 → 列出每模式版本 diff + 变更文件 → **用户逐项确认后**才下载/安装 → staging 全部校验 → 整目录 rename 替换（旧目录 `.bak-<ts>` 保留）→ 成功后才写新 `.installed.json` 基线；任何一步失败保留旧目录和旧基线
4. **requires.dsh**：模式对捆绑核心的最低版本要求（peer 对齐，ADR-004 思路；版本比较算法见 ADR-025）——不满足则提示"需先更新客户端"，不下载
5. **只列运行时文件**：agent.cordis.yml / bootstrap.mjs / preset.yml / README 双语——**排除 install 脚本**（独立安装通道用，发行版更新不需要）
6. **不删用户模式**：manifest 没有的模式（用户自装/实验）不动
7. **preset.yml 需加 version 字段**（当前缺失，格式 `yyyyMMdd.n`）——生成器数据源
8. **本地状态**：`$DSH_HOME/.agent-presets/.installed.json` 结构：
   ```json
   {
     "schemaVersion": 1,
     "modes": {
       "anchored-minimal": {
         "version": "20260211.1",
         "installedAt": "2026-02-11T00:00:00Z",
         "files": [
           { "path": "agent.cordis.yml", "sha256": "...", "size": 1234 }
         ]
       }
     }
   }
   ```
   - 该文件是安装成功的最后一步；回滚时同时恢复旧基线
9. **入口**：设置页模式管理"检查更新"；与 24h 后台检测合并（应用 + 模式一起查，提示分开）

## ADR-025：统一版本号 `yyyyMMdd.n`

**结论**：发行版、捆绑核心、模式版本**统一 `yyyyMMdd.n`**（日期取 UTC；n 从 1 起，如 `20260211.1`）。**比较必须解析为 `(yyyyMMdd, n)` 两个整数做数值比较，禁止字典序字符串比较**；`requires.dsh` 下限用同一比较器（如 `>=20260210.2`）。不依赖 semver 库，但发行版提供一个 5 行以内的版本比较函数供应用更新、模式更新、requires.dsh 共用。

**比较规则**：
- 合法格式：`^\d{8}\.\d+$`；不合法直接判为不可比较并报配置错误，不猜
- `compare(a, b)` = 先比 8 位日期整数，再比 `n` 整数
- 这样 `20260211.10 > 20260211.9`（字典序会判反，这是禁用字符串比较的原因）
- `n` 不强制补零；是否固定两位由生成器决定，比较器不接受补零差异以外的变体

**理由**：用户指定"暂定 yyyyMMdd.no"；日期版本对"模式昨天有没有更新"一目了然、生成简单（生成器读 **UTC 日期**即可）、无 semver 语义负担（我们不需要 semver 的 major/minor 兼容语义）。**代价**：不表达兼容性语义——由 release notes（breaking 标注）+ schemaVersion（格式兼容）+ requires.dsh（核心下限）兜底。

**注意**：upstream 基座信息（基于哪个 commit/版本）从版本号移入 release notes（ADR-016 同步更新）。

## ADR-026：内置内容来源动态配置 —— harness 支持 npm/git/本地，内置插件支持 git/本地绝对路径

**结论**：`dsh-desktop-pack` 作为打包工程，所有内置内容的来源都通过 manifest 动态配置，不写死在打包脚本/代码里：
- **harness 来源**（`harness-source.json`）支持 `npm` / `git` / `local` 三种 `kind`
- **内置插件/模式来源**（`builtin-sources.json`）支持 `git` 仓库源码与 `local` 本地绝对路径

**harness-source.json**：
```json
{
  "schemaVersion": 1,
  "source": {
    "kind": "git",
    "repo": "my-dsh-plugin/deepseek-ai/deepseek-harness",
    "ref": "refs/tags/dsh-20260211.1",
    "commit": "<pinned-sha>"
  }
}
```
- `kind: "npm"`：记录 `package`、`version`、`integrity`，解析到本地后再走打包流程
- `kind: "git"`：发布默认使用 deepseek-ai/deepseek-harness 的 ref/commit（ADR-016），禁止只写可变分支
- `kind: "local"`：记录本地源码/构建产物**绝对路径**，仅供开发联调；发布 CI 拒绝 local 来源
- 无论哪种来源，打包后都落到 `runtime/harness/versions/<version>/`，运行时仍由 `current.json` 选择

**builtin-sources.json**：
```json
{
  "schemaVersion": 1,
  "modes": {
    "kind": "git",
    "repo": "my-dsh-plugin/dsh-presets",
    "ref": "<pinned-tag-or-sha>",
    "include": ["anchored-minimal", "flash-boost", "readonly-audit"]
  },
  "plugins": [
    {
      "id": "agent-mode-switcher",
      "kind": "git",
      "repo": "<repo>",
      "ref": "<pinned-tag-or-sha>",
      "path": "<package-subdir>",
      "build": "pnpm build"
    },
    {
      "id": "session-notify-host",
      "kind": "local",
      "path": "/absolute/path/to/plugin"
    }
  ]
}
```
- 每个内置插件声明 `id / kind / 来源坐标 / build / install-to`；打包脚本按清单 checkout 或读取本地绝对路径 → build → 实体化到 seed profile 的 node_modules
- 本地绝对路径仅用于开发态；发布流水线拒绝任何 `local` 项，防止把开发机路径带进产物
- 插件 manifest 与 lock（`builtin-sources.lock.json`）一起提交：记录实际 commit、版本与产物 sha256，保证可复现
- 模式目录来源同样支持 git 仓库与本地绝对路径，seed 打包时按 include 清单抽取

**约束**：
- 发布版所有来源必须 pin 到不可变 commit/tag + 完整性哈希；开发态才允许 local
- 用户运行时不受影响：manifest 只在打包期生效，发行产物里内置插件仍是实体目录（ADR-004），不暴露本地绝对路径
