# omp-deck 独立 UI 界面构建计划

## 现状分析

```
当前架构:
  apps/web/ (React 18 + Vite 5 + Tailwind 3)
    → 构建为静态文件 (apps/web/dist/)
    → Hono 服务端静态托管 (http://127.0.0.1:8787)
    → 用户在浏览器中打开

  12 个路由视图 (Chat, Tasks, Routines, Topology, Memory, ...)
  Zustand store + WebSocket 实时通信
  145KB SettingsView 是最大的视图文件
```

**当前痛点：**
1. 需要"打开浏览器输入地址" — 不像应用
2. 开发者风格 UI — 不够美观/专业
3. 无法系统托盘/通知中心集成
4. 多窗口/标签页混乱

---

## 方案对比

| 方案 | 二进制大小 | 内存占用 | 开发成本 | 系统集成 | 推荐度 |
|---|---|---|---|---|---|
| **Tauri 2.0** | ~10MB | ~50MB | 中 | 高（托盘/通知/自更新） | ⭐⭐⭐⭐⭐ |
| Electron | ~150MB | ~200MB | 低 | 高 | ⭐⭐ |
| PWA | 0 | 浏览器 | 极低 | 低 | ⭐⭐⭐ |
| 系统 WebView | 0 | ~80MB | 低 | 中 | ⭐⭐⭐⭐ |

### 推荐：Tauri 2.0

**为什么选 Tauri：**
- 复用现有 React 前端 — 零重写
- 二进制仅 ~10MB（Electron 150MB）
- 原生窗口 + 系统托盘 + 全局快捷键
- macOS/Windows/Linux 三平台
- 自动更新内置
- Rust 后端可选（不需要也可以纯前端）

---

## 开发路线

### Phase 1: Tauri 骨架搭建（1-2天）

```
apps/desktop/              ← 新增 Tauri 应用
├── src-tauri/
│   ├── Cargo.toml         ← Rust 依赖
│   ├── tauri.conf.json    ← 窗口/图标/权限配置
│   ├── src/
│   │   └── main.rs        ← Rust 入口（启动内嵌 server 或连接外部）
│   └── icons/             ← 应用图标
├── package.json           ← npm 包装
└── src/
    └── main.ts            ← Tauri 前端入口
```

**核心决策：Tauri 如何与 omp-deck server 交互？**

```
方案 A (推荐): Tauri 内嵌 server
  Tauri sidecar 启动 `bun run start`
  前端连接 127.0.0.1:8787
  优点: 单进程, 用户不需要单独启动 server
  缺点: 需要打包 Bun 运行时

方案 B: Tauri 连接外部 server
  用户先启动 server, Tauri 连接
  优点: 更简单
  缺点: 需要两步启动
```

### Phase 2: 系统集成（2-3天）

```
功能清单:
  ├── 系统托盘图标 (右键菜单: 打开/停止/设置)
  ├── 全局快捷键 (Cmd+Shift+D 打开)
  ├── 原生通知 (任务完成/routine 失败)
  ├── 开机自启动
  ├── 单实例锁 (防止多开)
  └── 窗口状态记忆 (位置/大小)
```

### Phase 3: UI 重设计（3-5天）

```
改进方向:
  ├── 启动页/加载动画
  ├── 暗色/亮色主题切换
  ├── 紧凑/宽松布局模式
  ├── 侧边栏折叠/展开动画
  ├── 拓扑图可视化升级
  ├── 聊天界面优化 (消息分组/折叠)
  └── 状态栏 (连接状态/模型/CPU/内存)
```

### Phase 4: 打包发布（1-2天）

```
构建产物:
  macOS:   omp-deck.dmg (Universal Binary)
  Windows: omp-deck.msi + omp-deck.exe
  Linux:   omp-deck.AppImage + omp-deck.deb

自动更新:
  ├── GitHub Releases 作为更新源
  ├── Tauri updater 检查 + 增量下载
  └── 签名验证 (macOS notarization)
```

---

## 技术选型

| 层 | 技术 | 理由 |
|---|---|---|
| 前端 | 现有 React 18 + Vite | 复用，零迁移成本 |
| 壳 | Tauri 2.0 | 最小体积 + 最佳系统集成 |
| 通信 | 现有 WebSocket + REST | 不变 |
| 后端 | 现有 Hono + Bun | 不变，Tauri sidecar 启动 |
| 打包 | tauri-bundler | 原生格式 (dmg/msi/AppImage) |

---

## 文件结构规划

```
omp-deck/
├── apps/
│   ├── web/               ← 现有 React 前端 (不变)
│   ├── server/             ← 现有 Hono 后端 (不变)
│   └── desktop/            ← 新增: Tauri 桌面壳
│       ├── src-tauri/
│       │   ├── tauri.conf.json
│       │   ├── Cargo.toml
│       │   ├── src/main.rs
│       │   └── icons/
│       ├── src/
│       │   ├── main.ts     ← Tauri 前端入口
│       │   ├── tray.ts     ← 系统托盘逻辑
│       │   └── updater.ts  ← 自动更新
│       └── package.json
├── packages/
│   ├── protocol/           ← 不变
│   └── topology-memory/    ← 不变
```

---

## 立即可开始的第一步

1. `cargo install tauri-cli` 或 `bun add -D @tauri-apps/cli`
2. 初始化 `apps/desktop/` 骨架
3. 配置 `tauri.conf.json` 指向 `apps/web/dist`
4. 实现 sidecar 启动 omp-deck server
5. 测试 `tauri dev` 启动桌面窗口

---

## 验收标准

```
Phase 1 完成:
  ✓ tauri dev 启动桌面窗口
  ✓ 窗口内显示 omp-deck 完整界面
  ✓ WebSocket 连接正常
  ✓ 可以关闭浏览器，只通过桌面应用使用

Phase 2 完成:
  ✓ 系统托盘图标显示
  ✓ Cmd+Shift+D 全局快捷键
  ✓ 关闭窗口 → 最小化到托盘
  ✓ 开机自启动选项

Phase 3 完成:
  ✓ 启动加载动画
  ✓ 暗色/亮色主题
  ✓ 窗口位置/大小记忆

Phase 4 完成:
  ✓ macOS .dmg 打包
  ✓ Windows .msi 打包
  ✓ Linux .AppImage 打包
  ✓ 自动更新验证
```
