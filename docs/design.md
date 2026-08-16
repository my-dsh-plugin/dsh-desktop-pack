# 详细设计：DSH 分发包

> 状态：研究完成，未实施。本文记录设计结论与验证过的机制。

## 1. 目标

把 DSH + 三个自研模式（anchored-minimal / flash-boost / readonly-audit）+ 自研插件打包成可分发的客户端形态，用户下载即用。
实验性的 readonly-audit 插件版（readonly-security-audit 仓库）**不随发行版预装**（ADR-021）。
预置模式开箱即用、模式可热更新、Windows/macOS 双平台。

## 2. 目录布局（便携，程序与数据分离）

```
dsh-client-<version>-<platform>/        # 绿色版/便携布局（解压即用，安装目录必须可写）
├── runtime/                            # 内化运行时（构建期生成）
│   ├── node/                           # 便携 Node（win: node-v22-win-x64.zip；mac: darwin-arm64/x64.tar.gz）
│   ├── app/                            # 打包工程自产 launcher（不含 DSH core）
│   │   └── manager.mjs                 # ★ 常驻 Node manager：真正的 launcher
│   └── harness/                        # ★ 外部动态引入的 fork 自构建 DSH（ADR-016）
│       ├── current.json                # 发布态 { "version": "<yyyyMMdd.n>" }；开发态 { "path": "<外部构建产物>" }
│       └── versions/<version>/         # 每版本完整 harness（node_modules/@deepseek-ai/dsh/lib/bin.js）
├── data/                               # ★ 运行时数据（= DSH_HOME，ADR-008）
│   ├── dsh-home/                       # 程序自己的 DSH_HOME（非 ~/.dsh、非 %APPDATA%）
│   │   ├── .agent-presets/             # 三个预置模式（seed 或用户后装）
│   │   ├── profiles/web/               # profile（bundles + 插件）
│   │   ├── sessions/ storages/ settings.yaml .credentials.yaml .anonymous-user-id
│   │   └── .home-init-done             # 首启完成标记
│   └── logs/                           # 启动日志（崩溃排查）
├── seed-dsh-home/                      # 预置 DSH_HOME 内容（构建期生成，随包分发）
│   ├── .agent-presets/                 # 三个预置模式（纯文件 + bootstrap.mjs）
│   └── profiles/web/                   # 预置 profile
├── bin/
│   ├── dsh (sh) / dsh.cmd (ps1)        # 包装器：set PATH=bundled node; node bin.js $*
│   └── dsh-home-init.sh/.ps1           # 薄入口：写权限自检后派发到 manager.mjs
├── launcher/                           # Tauri 薄壳（页面无 IPC；与 manager 走 stdio）
└── README.md
```

**关键约束**：
- 安装目录必须可写（macOS `/Applications`、Windows `Program Files` 默认只读 → 绿色版解压到用户可写位置，或安装器处理）
- 首启先做**写权限自检**，失败明确报错 + 指引（换目录/授权），不静默
- 程序（runtime/）与数据（data/）分离：清理数据不破坏程序，重装不丢数据
- macOS dmg 安装形态为 `~/Applications/dsh-client/{dsh-client.app, runtime/, data/}`，详见 §6.3

## 3. runtime：便携 Node + 外部动态引入 fork 自构建 harness（ADR-016）

- **本仓库是打包工程**：不放置 DSH core 源码/构建产物；`harness-source.json` 支持 **npm / git / local** 三种来源（ADR-026）：
  - `git`：发布默认 deepseek-harness-fork 的 pinned ref/commit
  - `npm`：记录 package/version/integrity，解析后进入同一打包流程
  - `local`：本地源码/构建产物绝对路径，仅开发联调；发布 CI 拒绝
- 照抄 dsh-installers 方案：官方 Node 发行包 + SHA256 校验（Node 部分不变）
- **DSH 核心 = 构建期按来源解析后 `pnpm build` 自构建**（web-app bundle + base/headless），**默认不装 upstream npm 包**；打包脚本生成 `runtime/harness/versions/<version>/`，补丁随 fork 发版（见 §9 补丁清单）
- **动态引入/切换**：manager 每次启动 DSH 前读取 `runtime/harness/current.json` 的 `version` 字段，解析到 `versions/<version>/node_modules/@deepseek-ai/dsh/lib/bin.js`；不依赖 symlink/junction
- **开发态**：`current.json` 可指向外部 fork 构建产物路径；**发布态**：只允许指向 `versions/` 内已校验版本
- 版本策略：捆绑核心版本号 `yyyyMMdd.n`（ADR-025，跟随 fork 发版），旧版本目录保留可回滚
- 可回滚：新增版本目录 → 校验 → 原子翻转 `current.json`；失败/新核心有问题 → 翻回旧版本号（ADR-014）

## 4. seed-dsh-home：预置内容

### 4.1 模式（`.agent-presets/`）

模式来源由 `builtin-sources.json` 的 `modes` 项动态配置：发布默认从 dsh-presets 仓库 pinned ref 抽取，开发态可用本地绝对路径；CI 按 include 清单把三个模式目录原样复制进 seed（含 bootstrap.mjs）：

```
.agent-presets/
├── anchored-minimal/   # persona 逐字节 = minimal；bootstrap: bash+editor → 全量
├── flash-boost/        # w7 persona；bootstrap: bash+editor（win32→pwsh+editor）→ 全量
└── readonly-audit/     # 纯预设版；只读沙箱由用户自行调整（见 4.3）
```

**seed 语义：no-clobber**（不覆盖用户已有安装）。`cp -Rn`（POSIX）/ 等价 PowerShell 逻辑。

**bundling 范围（ADR-021）**：三个模式全带（anchored-minimal / flash-boost / readonly-audit 纯预设版）；模式自带 bootstrap 插件随模式目录打包；**不打包**实验性质的 readonly-audit 插件版（readonly-security-audit 仓库）与任何第三方插件。

### 4.2 插件（`profiles/web/`）

现状问题：开发态是 `link:` 绝对路径符号链接（不可分发）。

**来源动态配置（ADR-026）**：内置插件清单放在 `builtin-sources.json` 的 `plugins[]`，每项声明 `id / kind / 来源坐标 / build / install-to`：
- `kind: "git"`：开源仓库源码，pin 到 tag/commit，CI checkout → build
- `kind: "local"`：本地绝对路径，仅供开发联调；发布 CI 拒绝 local 项
- 配套 `builtin-sources.lock.json` 记录实际 commit、版本、产物 sha256，保证可复现

内化方案（A 推荐）：
- 构建期按清单把插件目录（lib/ + cordis.patch.yml + package.json）复制进 seed 的 node_modules 实体目录
- profile package.json 的 dependencies 改为实体引用
- 确保插件的 peerDependencies（`@deepseek-ai/dsh-*`）解析到捆绑 dsh 的那份——**同一 node_modules 树**，避免双实例服务冲突

### 4.3 sandbox 默认配置（ADR-017）

- 默认 **workspace-write**：会话工作区可读写，工作区外写按 DSH 沙箱策略逐次批准
- 随 seed 写入 settings（`settings.yaml`），用户可改
- **readonly-audit 模式内置，但发行版不自动切换沙箱**：该模式依赖 read-only 沙箱，用户使用前需自行把目标会话沙箱调为 read-only（设计决策，README/模式说明中明示）
- **anchored-minimal / flash-boost 的本地文件工具使用 preset 内 `fs-local`（无沙箱本地 fs）**：这是锚定效果的必要条件，不受 ADR-017 默认 sandbox 约束；这两档模式的语义是“锚定优先 + 本机全量文件访问”

## 5. dsh-home-init：首启与更新

**进程模型**：Tauri shell 只做窗口/托盘/单实例；真正的 launcher 是 `runtime/app/manager.mjs`（用捆绑 Node 运行）。shell spawn manager，两者走 **stdio JSON Lines**——不是网络端口，也不是页面可触达的 Tauri IPC。manager 负责下面所有首启/启动/恢复/更新逻辑。seed 路径由 shell 通过 stdio 传给 manager：zip 形态为 `<install>/seed-dsh-home/`，macOS `.app` 形态为 `<app>/Contents/Resources/seed-dsh-home/`。

```bash
# 定位 DSH_HOME：程序安装目录 data/dsh-home/（ADR-008，默认）
#   例外：用户显式设置 $DSH_HOME 环境变量时尊重之（高级用户）
# 写权限自检：失败 → 明确报错 + 换目录/授权指引，不静默
# 首启流程（无 .home-init-done 标记时）：
#   1. seed（幂等，no-clobber）
mkdir -p "$DSH_HOME/.agent-presets"
cp -Rn seed-dsh-home/.agent-presets/* "$DSH_HOME/.agent-presets/"
#   2. 询问迁移 ~/.dsh（见 5.1）
#   3. 写入 .home-init-done 标记
# 启动：manager 按 current.json 解析当前 harness bin
HARNESS_VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$RUNTIME/harness/current.json")"
HARNESS_BIN="$RUNTIME/harness/versions/$HARNESS_VERSION/node_modules/@deepseek-ai/dsh/lib/bin.js"
"$RUNTIME/node" "$HARNESS_BIN" web --port 0
```

### 5.1 首启迁移（询问式，默认不迁移）

检测 `~/.dsh` 存在且非空时询问，逐项勾选：

| 内容 | 来源 | 迁移规则 |
|---|---|---|
| 会话 | `~/.dsh/sessions/` | 拷贝不移动；目标已有同名会话跳过（no-clobber） |
| 状态/工作区 | `~/.dsh/storages/` | workspace 注册、投影缓存等本地状态 |
| 凭据 | `~/.dsh/.credentials.yaml` | 含 API Key，**明确告知密钥将被复制**；复制后强制 0600（Windows 收紧 ACL） |
| 设置 | `~/.dsh/settings.yaml` | 用户文件优先于 seed 默认；seed 版本备份为 `settings.yaml.seed-bak` |
| 环境 | `~/.dsh/.env` | 默认不勾选；含密钥/代理配置，需单独告知 |
| 匿名身份 | `~/.dsh/.anonymous-user-id` | 保留遥测/反馈匿名身份，避免迁移后身份重置 |
| 模式 | `~/.dsh/.agent-presets/` | no-clobber：seed 已内置的 id 不覆盖，仅拷贝用户自装模式 |
| 插件 | `~/.dsh/profiles/<name>/` | 只迁三样：`package.json` 的用户依赖、`cordis.patch.yml`、用户插件实体目录 |

**profiles 迁移 = 合并，不是整目录覆盖**：
1. `package.json`：把用户依赖合并进 seed profile 依赖；同名依赖以用户声明为准，但 `@deepseek-ai/dsh-*` 核心依赖不允许覆盖捆绑版本。
2. `cordis.patch.yml`：数组合并，seed 基础在前、用户 patch 在后；同 id 后者覆盖（用户优先）。
3. 插件实体目录：仅拷贝用户依赖引用的包，符号链接解析为目标实体后复制；`node_modules/`、`pnpm-lock.yaml`、绝对路径 link 一律不整目录拷贝，完成后重跑 `dsh plugin --profile <name> install` 修复依赖。

- **拷贝不移动**：原 `~/.dsh` 原样保留（可回退、不影响其他 CLI 用法）
- **顺序**：seed(no-clobber) → 逐项迁移(no-clobber/merge) → 写 `.home-init-done`
- **不是一次性机会**：首次跳过/部分迁移后，设置页保留“从 ~/.dsh 迁移”入口

### 5.2 故障排查模式与恢复向导（核心 UI，ADR-011/012）

**原则：能查清单就不重置。** `--reset-home` 是最后手段，不是第一手段。DSH 启动失败时**日志天然点名**（`assertEntriesActivated` 逐条列出失败插件名 + stack；`installFailLoud` 打印 `fatal load failure` 后 exit(1)），所以恢复的第一步是展示清单而不是猜测。

**四级排查体系**：

| 级别 | 手段 | 说明 |
|---|---|---|
| 0 点名 | 解析启动 stderr | 失败条目名字 + 原因，零成本 |
| 1 单条隔离 | patch 层 `{ id, disabled: true }` | 只动这一条；运行中可 HMR 热生效；可恢复 |
| 2 二分定位 | `--dump-config` 取 id 清单 → 生成临时 `--patch` overlay → 反复探测启动 | 不知道哪个炸时定位最小嫌疑集 |
| 3 重置 | `--reset-home`（改名备份） | 已知元凶后的最后手段 |

**故障排查模式（`--diag`）**：manager 检测到启动失败（exit≠0 且 stderr 匹配 `did not activate` / `fatal load failure`）**自动进入**；也可手动 `--diag`。此模式**不启动 DSH**（boot 失败时 DSH GUI 起不来），由 manager 自带最小 Web UI：绑定 `127.0.0.1:<random>`，路径为 `/diag/<128-bit-token>/`，默认只在 Tauri WebView 打开（不提供普通浏览器打开），token 随页面关闭/超时吊销：

- 数据源（全部离线，不依赖 DSH 运行）：
  - 上次启动日志 `data/logs/`：失败点名列表 + stack 摘要
  - 离线合成配置：bundled `@deepseek-ai/cordis-plugin-include` 的 `applyEntryPatches`（与 `dsh --dump-config` 同一语义）→ 全部条目（id/name/enabled/来源层：seed / 用户 patch / overlay）
- **action API 安全边界**：修改类操作只接受 POST + `Content-Type: application/json`；不放行 CORS；`Cache-Control: no-store`；页面不接触 Tauri core（ADR-006 无页面 IPC 不变）
- UI 清单（表格）：
  - 每行：名称、状态（active/failed/pending/disabled）、失败原因、所属来源层、entryId
  - 失败项置顶标红，含"查看详情"（完整 stack）
- **快捷操作按钮**（每行）：
  - **禁用**：写 patch 层 `{ id, disabled: true }`（可逆，推荐）
  - **卸载**：从基础 cordis.yml **删除该行**（patch 层无 delete 操作，卸载必须改基础文件）+ 原文件备份到 `data/backups/`（可恢复）；bundle 安装的插件同时移除其包引用
  - 内置核心行（agentPresets/loader 等 host 必需行）标记"内置"不可卸载；模式行（`.agent-presets/`）入口转模式管理
- 顶部操作：**重启应用**（应用当前禁用/卸载后重启）、**恢复全部**（清空隔离 patch）
- 自动进入时提供"仍要启动"选项（用户可强行试启动，用于确认问题是否真的致命）

**禁用 vs 卸载的语义边界**：
- 禁用 = patch 层覆盖，零风险可逆，跨版本残留无害（id 匹配不到只是 warning）
- 卸载 = 改基础配置，需要备份；两者 UI 并列但默认推荐禁用
- 前提约定：**seed/安装的 cordis.yml 每行带稳定显式 id**（如 `id: tool-fs`），否则 entryId 随机无法稳定引用

**`--safe-mode`（manager 实现，不改 DSH core）**：每次启动前清空重建 `data/safe-home`，以 `DSH_HOME=<install>/data/safe-home` 启动 `dsh web --port 0`。空 home 只自动生成 base + web-app 模板，天然跳过用户 patch、插件 bundles 与 `.agent-presets/`，用于区分"配置炸了 vs 程序炸了"：
- safe-home 能出 URL → 问题在用户配置/插件/模式，进 diag 修原 home
- safe-home 也起不来 → 问题在 runtime/core/Node，转更新/回滚路径

**启动日志**：写 `data/logs/`（DSH_HOME 外，崩溃时数据目录可能已坏）。

**原则**：**程序与数据分离**——清理数据不破坏程序，重装不丢数据。

### 更新器（双轨渠道，ADR-014）

**应用本体 → GitHub Release（主渠道，ADR-014/016，策略 ADR-023）**：
- 每版本在 GitHub Release 发布 runtime 更新包 + shell 整包，附版本号 + SHA256（+ 可选签名）
- **捆绑核心 = deepseek-harness-fork 源码自构建**（版本 `yyyyMMdd.n`，ADR-025，非 upstream npm），版本节奏跟随 fork 发版
- **自动检测、手动更新、双平面替换**（ADR-023）：
  1. 启动静默检查 + 常驻每 24h 后台检查（可关）→ 有新版本托盘角标/通知提示，不自动下载
  2. 用户确认后下载到 `data/update-staging/` 并做 SHA256 校验
  3. 用户点"重启并更新"→ 终止 DSH 进程树 → shell 资源内 updater sidecar 执行替换：
     - harness-only：解包到 `runtime/harness/versions/<new>/` → 冒烟 → 原子翻转 `current.json`，不整包替换 runtime
     - node/manager：替换 `runtime/node/`、`runtime/app/`，保留 harness 版本目录与指针
     - shell：替换 `.app`（macOS）或走 NSIS（Windows）
  4. runtime 更新后先做 `dsh --dump-default-config` 冒烟，失败翻回旧 `current.json`/旧目录；旧版本保留最近 N 份
  5. 成功后拉起新版本；shell 替换后执行 xattr 清理（ADR-020）
- **运行中禁止替换 runtime/**：存活期间只 staging，最终替换在退出后执行
- 更新入口：托盘菜单"检查更新" + 通知提示
- **可达性注意**：Release 资产经 `github.com/.../releases/download/` 302 → `objects.githubusercontent.com`，与 raw.githubusercontent 不同域——实测可达性待验证；保留可配置镜像/代理兜底

**模式内容 → dsh-presets 仓库 manifest.json（ADR-003/024）**：
- manifest 结构见 ADR-024：`schemaVersion` + `modes[]`（id/name/version/requires.dsh/files[] 文件级 sha256）
- 获取：GitHub API contents（base64，raw 被墙）；生成器 `scripts/gen-manifest.cjs` + CI 一致性校验
- **检查自动、安装手动（与 ADR-023 一致）**：列出每模式版本 diff + 变更文件 → 用户逐项确认后才下载/安装
- **本地修改判定靠安装基线快照**：`.installed.json` 保存上次成功安装的逐文件 sha256；本地 hash == 基线 → 可安全更新；== 新 manifest → 已最新；否则判为本地修改/损坏，默认保留 + 提示覆盖
- 更新：未变化文件跳过 → 变化文件下载到 staging → 按新 manifest 全部校验（含 `requires.dsh`）→ 整目录 rename 替换（旧目录 `.bak-<ts>`）→ 成功后写新基线；任一步失败保留旧目录和旧基线
- 新会话即生效（**无需重启**）；更新前已在运行的会话继续用旧 standing mount
- 入口：设置页模式管理"检查更新"，并入 24h 后台检测

两者职责分明：**程序更新要重启，模式更新不重启**。

## 6. 启动器、托盘与端口

- 端口：`--port 0`（OS 分配随机回环端口）+ `host: 127.0.0.1`（默认已是）
- manager 启动 DSH 后**解析 stdout 就绪行**：`dsh web: http://127.0.0.1:<port>`（Loader settlement 后打印；超时/无行按启动失败转恢复流程），拿到 URL 再回报 Tauri shell 加载 WebView
- **进程模型**：Tauri shell（窗口/托盘/单实例）→ stdio JSON Lines → `runtime/app/manager.mjs`（DSH 生命周期、日志、seed/迁移、safe-mode/bisect、diag、更新 staging）→ spawn DSH 子进程
- **WebView 壳：Tauri 2 薄壳**（ADR-006）：页面不授予 Tauri IPC（不开 capabilities / 无 invoke handler），纯 http 加载本地回环服务；仅允许导航到 `127.0.0.1:<port>`，禁外部导航/新窗口

### 6.1 系统托盘（ADR-013）

- **关窗不退出**：点关闭按钮 = 最小化到托盘，DSH 进程保持运行（launcher 保活，会话不丢）
- 托盘图标常驻 + 菜单：**打开主界面** / **故障排查（--diag）** / **检查更新** / **重启** / **退出**
- 更新可用时托盘弹提示（气泡/菜单角标）
- 平台惯例：Windows 通知区域、macOS 菜单栏（两者壳层均原生支持）
- 托盘属于**壳层**（Tauri 原生能力），不涉及 DSH 内部
- **单实例互斥**：Tauri shell 持有（tauri-plugin-single-instance），第二个实例只唤醒既有窗口/托盘并退出；manager 为 shell 单实例子进程，避免双托盘/双进程/双端口
- 退出 = shell 通知 manager 结束 DSH 进程树 + 清托盘；首启引导里说明"关闭 = 最小化到托盘"

### 6.2 会话完成通知（窗口失焦时，ADR-015）

- **触发信号**：`agent/status`（AgentStatus `running → idle`）= 一次会话/任务完成。host 侧可直接监听（Scoped emit 事件），**浏览器拿不到**——host 事件转发是白名单制（`API_REMOTE_FORWARDED_EVENTS`，当前无 agent 事件，且 payload 是 live Agent 对象不可直传）
- **通道（首发零 fork）**：预置 bundle 插件对（`dsh.client` 行，host 半 + client 半）——host 半监听 `agent/status` 聚合"完成标记"，client 半定时轮询 `host.call('notify:take')` 取回并上报焦点状态；本地回环 1s 间隔开销可忽略；实时性不够再升级 fork 白名单（需扁平事件，工程量大，后置）
- **失焦检测（client 半）**：`!document.hasFocus() || document.visibilityState !== 'visible'`（切走/最小化都覆盖）
- **通知（页面 Web Notification）**：失焦且完成 → `new Notification(会话标题, { body })`，点击聚焦回窗口；聚焦时静默不弹
- **壳层配套**：WebView2 toast 需配置 **AppUserModelID**（Tauri 应用归属）；WKWebView 走通知中心；首次授权由 WebView 自动请求——权限与 AUMID 配置列入壳层实测项
- 设置项：开关（默认开）+ 可关通知权限状态展示

### 6.3 安装器（双轨，ADR-018）

- **zip 绿色版**（主推）：解压即用，用户放任意可写目录
- **平台安装包**：Windows per-user NSIS（默认 `%LOCALAPPDATA%\Programs\dsh-client`，可自选）；macOS dmg（拷到用户可写位置如 `~/Applications/dsh-client`，可自选；安装引导执行 xattr 去隔离，ADR-020）
- **macOS 安装形态**：
  ```
  ~/Applications/dsh-client/
  ├── dsh-client.app/    # Tauri shell；seed-dsh-home 在 Contents/Resources/seed-dsh-home
  ├── runtime/           # node + app/manager.mjs + harness（versions/ + current.json）
  └── data/              # DSH_HOME（dsh-home/ + logs/）
  ```
  `.app` 通过 `../runtime/`、`../data/` 相对定位；可写数据不进 bundle；shell 更新替换 `.app`，runtime 更新替换 `runtime/`，均不碰 `data/`
- **统一 runtime/ + data/ 拆分语义**（ADR-008）：`/Applications` 和 `Program Files` 只读，安装包版**一律装用户可写位置**，不装系统只读目录——三平台不引入第二套 DSH_HOME 策略
- 安装包 = 绿色版的"装到固定位置 + 快捷方式/卸载入口"包装

### 6.4 build/CI（ADR-019）

- GitHub Actions 三平台矩阵：`windows-latest`（x64）、`macos-14`（Intel）、`macos-14-arm64`（Apple Silicon）
- 流水线：读 `harness-source.json`（npm/git/local）与 `builtin-sources.json`（模式/插件 git/local）→ 解析来源并校验 lock → checkout/build → harness 生成 `runtime/harness/versions/<version>/`，模式/插件实体化进 seed → 组装 runtime/node、app/manager.mjs、seed-dsh-home/ 与 `current.json` → Tauri 壳（Rust toolchain）→ zip + NSIS/dmg → SHA256 → 传 GitHub Release（ADR-014）
- 签名：无证书默认不签（ADR-020）；有证书时插入签名/公证步骤（留位）
- 发布：手动 workflow_dispatch + tag，不自动发版

## 7. Windows 专项

- 模式层：已修复（persistent-shell win32 门控 + bootstrap 对 pwsh 替换，dsh-presets commit 47c61bb）
- bash 策略：**检测宿主 Git Bash**（标准路径 + PATH），不内化；检测不到 → 降级 pwsh（现状可用）
- 签名：Windows 无代码签名证书 → SmartScreen"更多信息 → 仍要运行"（社区惯例）
- 参考 Claude Code / Codex：两者均不内化 bash（详见 research.md）

### 7.1 macOS 签名（ADR-020）

- 首发**不签名、不公证**（社区惯例）：无 $99/年 开发者账号成本；未签名 app 首次启动会被 Gatekeeper 拦截
- **保留 xattr 去隔离步骤**：安装/首次启动引导中执行 `xattr -dr com.apple.quarantine <app>`（用户已确认安装），README 说明安全含义；拒绝时保留"右键 → 打开"兜底
- **更新/替换 `.app` 后同样执行 xattr 清理**，避免二次拦截
- 升级位：将来有账号 → CI 插入 Developer ID 签名 + `notarytool` 公证，产物布局不变，并移除 xattr 引导

## 8. 待办 / 待验证

- [ ] 启动器如何可靠拿到随机分配的实际端口（日志/API 通道）
- [ ] Windows 真机验证：pwsh 引导对 + custom-bash 检测
- [ ] seed no-clobber 在双平台的边界（符号链接、权限位）
- [x] 更新源 manifest.json 设计 → ADR-024（生成器 + 文件级 sha256 + 原子替换）
- [ ] dsh-presets 落地：preset.yml 加 version 字段 + gen-manifest.cjs + CI 一致性校验（ADR-024）
- [x] DSH_HOME 便携 vs 用户目录的选择 → ADR-008：便携（`<install>/data/dsh-home/`）
- [x] 首启迁移 + 故障恢复方案 → 设计 5.1 / 5.2
- [x] 托盘常驻 + 更新渠道 GitHub Release → 设计 6.1，ADR-013/014
- [ ] 恢复向导 UI 原型：`--diag` 清单页 + 禁用/卸载按钮（设计 5.2，ADR-011/012）
- [ ] 实测：坏插件启动失败 → 解析 stderr 点名 → patch 禁用 → 重启恢复（ADR-011 第 1 级端到端）
- [ ] 实测：preset 模式 cordis.yml 是否支持用户 patch 层；一个坏模式是否影响其他会话
- [ ] 实测：GitHub Release 资产下载可达性（objects.githubusercontent.com）
- [ ] 实测：WebView 通知（WebView2 AUMID / WKWebView 授权）+ 会话完成通知端到端（ADR-015）
- [x] WebView 壳选型 → ADR-006：Tauri 2 薄壳 + 页面无 Tauri IPC（配置清单已落）
- [ ] 壳 + manager 原型：Tauri 2 托盘 5 项 + single-instance + stdio JSON Lines 控制 manager + 关窗隐藏 + 就绪行 URL 加载（ADR-006 规格）
- [x] sandbox 默认 → ADR-017：workspace-write（设计 4.3）
- [x] 安装器双轨 + CI + mac 签名 → ADR-018/019/020（设计 6.3/6.4/7.1）
- [ ] CI 首次打通：三平台矩阵出 zip/NSIS/dmg + SHA256（ADR-019）
- [x] 插件 bundling 范围 → ADR-021（设计 4.1）
- [x] API Key onboarding 延后 → ADR-022（正常首页先行）
- [x] 更新策略 → ADR-023：自动检测、手动更新（设计更新器小节）
- [ ] 更新面板原型：版本对比 + changelog + 确认 → 下载 → 校验 → 替换（ADR-023）

## 9. Fork 补丁清单（deepseek-harness-fork）

捆绑 fork 自构建（ADR-016），本清单记录发行版对核心的本地修改，fork 同步 upstream 时按此重放/核对：

- [ ] （空——当前无发行版专属补丁；ADR-015 备选"扁平化完成事件 + 白名单"若启用则在此登记）

## 10. 版本号速查（统一 `yyyyMMdd.n`，ADR-025）

- 发行版（dsh-desktop-pack）：`yyyyMMdd.n`（UTC 日期，n 从 1 起，如 `20260211.1`），GitHub Release 发布
- 捆绑核心（deepseek-harness-fork）：同格式；upstream 基座（基于哪个 upstream commit/版本）记录在 release notes，不进版本号
- 模式（dsh-presets）：preset.yml `version` 同格式
- 所有比较：解析为 `(yyyyMMdd, n)` 两个整数做数值比较，**禁止字典序字符串比较**（避免 `20260211.10 < 20260211.9`）
- `requires.dsh`：日期版本下限（如 `"dsh": ">=20260211.1"`），用同一比较器
