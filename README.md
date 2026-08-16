# dsh-desktop-pack

自研 DeepSeek Harness (DSH) 分发包：**打包工程**，harness 从 deepseek-ai/deepseek-harness 外部动态引入；预置自研模式与插件、内化 Node、随机回环端口、WebView 壳。

本仓库是**设计/研究仓库**：先把结论写下来，防止遗忘；实施在后续阶段进行。

> 关联仓库：[dsh-presets](https://github.com/my-dsh-plugin/dsh-presets)（三个预置模式的来源）、[org .github profile](https://github.com/my-dsh-plugin/.github)

## 一、为什么要自研（特异化需求）

社区已有 8+ 个 DSH 桌面封装（Tauri/Electron/安装器），但都是"通用壳"，不满足：

| 需求 | 社区客户端 | 我们要的 |
|---|---|---|
| 预置模式 | 无（用户自己装） | 三个自研模式预装（anchored-minimal / flash-boost / readonly-audit） |
| 预置插件 | 插件管理器（用户搜） | agent-mode-switcher 等自研插件预装 |
| 预置配置 | 空 DSH_HOME | sandbox workspace-write（ADR-017，可设置）；readonly-audit 需用户自行切 read-only |
| 模式更新 | 无 | 从 dsh-presets 仓库热更新（不用重启） |
| 模型适配 | 无 | Pro/Flash 双模式手动选择 |
| 平台 | 各有侧重 | macOS + Windows 都要 |

**手动切换模式（不做自动路由）**：自动任务路由（router-standard）是黑盒且可能分错；
手动选模式把路由决策交给最了解任务的人。Pro 会话选 anchored-minimal，Flash 会话选
flash-boost。

## 二、总体架构

```
dsh-client-<version>-<platform>/
├── runtime/
│   ├── node/                          # 便携 Node（官方下载 + SHA256 校验，参考 codeAnqiang-ma/dsh-installers）
│   ├── app/
│   │   └── manager.mjs                # 打包工程自产 launcher
│   └── harness/                       # ★ 外部动态引入的 upstream 自构建 DSH
│       ├── current.json               # 当前版本指针
│       └── versions/<version>/        # 每版本完整 harness
├── seed-dsh-home/                     # ★ 特异化核心：预置 DSH_HOME
│   ├── .agent-presets/
│   │   ├── anchored-minimal/          # V4 Pro 锚定（persona 逐字节 + bootstrap.mjs）
│   │   ├── flash-boost/               # V4 Flash 增强（w7 persona + RL 形状引导）
│   │   └── readonly-audit/            # 只读审计模式（只读沙箱由用户自行调整）
│   └── profiles/web/                  # 预置 profile（bundles + 插件实体目录）
├── bin/
│   ├── dsh / dsh.cmd                  # 包装器（PATH 指向 bundled node + dsh）
│   └── dsh-home-init.sh / .ps1        # ★ 首启 seed + 更新器
└── 启动器（WebView 壳）
```

## 三、关键技术决策（详见 docs/decisions.md）

| 决策 | 结论 | 一句话理由 |
|---|---|---|
| Node 运行时 | **内化**（便携 Node） | 用户零依赖；社区已验证（dsh-installers） |
| DSH core | **打包工程外部动态引入**：npm / git / local（ADR-016/026） | 仓库不 vendoring；换版本 = 加目录 + 翻 `current.json` |
| 端口 | **随机回环端口**（`--port 0` + `host: 127.0.0.1`） | DSH 原生支持 OS 分配端口；无固定占用、不暴露局域网 |
| 模式内化 | seed 目录 + no-clobber；来源走 `builtin-sources.json`（git/local） | roster 动态发现，新会话即用，**无需重启** |
| 插件内化 | 来源动态配置（git/local）→ 实体目录 + peer 版本对齐 | 不写死仓库；发布 pin commit + lock |
| Windows bash | **检测宿主 Git Bash，不内化** | Claude Code / Codex 均不内化；GPL 合规负担；pwsh 已是可用兜底 |
| WebView 壳 | **Tauri 2 薄壳 + 页面无 Tauri IPC**（ADR-006） | 壳越薄越安全；shell ↔ Node manager 走 stdio |
| 更新通道 | 应用走 GitHub Release，模式走 manifest | 程序更新重启；模式更新不重启 |

## 四、关键机制（已验证，有源码证据）

- `DSH_HOME` 解析：环境变量 → 默认 `~/.dsh`（`dsh-home-paths/src/index.ts:87`）
- 用户预设根：固定 `$DSH_HOME/.agent-presets/`（`USER_PRESET_DIR = '.agent-presets'`），roster 自动追加
- profile 根：`$DSH_HOME/profiles/<name>/`，bundles 启动时装配
- 用户补丁层：`$DSH_HOME/cordis.patch.yml`（升级不覆盖）
- webserver：`host: '127.0.0.1' | '0.0.0.0'`、`port: 0` = OS 分配（`dsh-host-webserver` Config）
- 模式热更新：roster 无记忆重读（`agent-presets/src/index.ts` 注释明确）

## 五、开发与打包

```bash
# 1. 按 manifest 拉取全部源码到 .cache/sources，并生成 sources.lock.json
npm run sources:fetch

# 2. 校验 manifest 与 lock 一致
npm run sources:verify

# 3. 构建 harness / 插件 / 组装 seed
npm run build:harness
npm run build:plugins
npm run assemble:seed

# 4. 完整打包入口（构建顺序：verify -> harness -> plugins -> seed）
npm run build
```

来源配置：

- `harness-source.json`：harness 来源（npm / git / local）
- `builtin-sources.json`：内置模式与插件来源（git / local）
- `sources.lock.json`：实际锁定 commit（随仓库提交，可复现）

## 六、文档导航

## 五、文档导航

- [docs/design.md](docs/design.md) — 详细设计（架构、seed、更新器、启动器）
- [docs/decisions.md](docs/decisions.md) — 决策记录（含调研依据）
- [docs/research.md](docs/research.md) — 调研资料（社区项目、Claude Code/Codex 做法、源码证据位置）

## 许可

[Apache License 2.0](LICENSE)
