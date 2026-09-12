# 01. 技术架构

## 1. 总体架构

```text
┌──────────────────────────────────────────┐
│              Renderer / React            │
│  页面、表单、结果表格、任务进度、数据中心    │
└───────────────────┬──────────────────────┘
                    │ contextBridge
┌───────────────────▼──────────────────────┐
│                  Preload                  │
│         白名单 API / 参数边界 / IPC        │
└───────────────────┬──────────────────────┘
                    │ ipcRenderer/ipcMain
┌───────────────────▼──────────────────────┐
│               Electron Main              │
│  Runtime / IPC / Window / Task / Update  │
└───────┬───────────┬───────────┬──────────┘
        │           │           │
        ▼           ▼           ▼
  Plugin Core   Storage Core  License Core
        │           │           │
        ▼           ▼           ▼
System Plugins   SQLite DB   License Service
        │
        ▼
原业务系统 HTTPS/API
```

## 2. 进程边界

### Renderer

只处理 UI 与用户交互，不直接保存或持有原始 Token/Cookie。页面只能看到业务系统会话状态，例如：未登录、登录中、已登录、即将过期、已失效。

### Preload

使用 `contextBridge` 暴露严格白名单 API。禁止 Renderer 任意调用 Node.js 能力。所有需要系统权限、文件系统、数据库、网络会话的操作统一经过 IPC。

### Main Process

承担高权限核心能力：

- 插件注册与生命周期
- 登录会话
- 业务请求
- SQLite
- 同步引擎
- 任务引擎
- 本地文件导出
- License
- 自动更新
- 日志

## 3. 推荐技术栈

- Electron
- TypeScript
- React
- Vite
- SQLite（推荐 `better-sqlite3` 或同等级稳定方案，落地时根据 Electron ABI 和打包方案确认）
- Zod（后续用于 IPC/插件配置运行时校验）
- Zustand 或轻量状态管理（UI 状态）
- Electron Builder 或 Electron Forge（二选一，在打包阶段统一）

## 4. Core 模块

```text
src/core/
├─ license/
├─ plugins/
├─ session/
├─ query/
├─ sync/
├─ storage/
├─ tasks/        # 待实现
├─ export/       # 待实现
├─ updater/      # 待实现
└─ logging/      # 待实现
```

Core 不写任何具体业务系统逻辑。

## 5. 插件架构

一个业务系统 = 一个一级插件。

```text
plugins/market-access/
├─ manifest.ts
├─ auth/
│  ├─ adapter.ts
│  └─ request-client.ts
├─ matters/
│  ├─ enterprise-establishment/
│  ├─ enterprise-change/
│  └─ enterprise-cancel/
├─ mapping/
├─ migrations/
└─ index.ts
```

主程序只定义规范，不理解业务细节。

## 6. 请求调用链

```text
Renderer 点击查询
  ↓
Preload desktopApi.matters.query(...)
  ↓
IPC matter:query
  ↓
检查插件是否存在
  ↓
检查 SessionState
  ↓
AuthAdapter.getSessionForRequest()
  ↓
RequestClient 注入 Token/Cookie/CSRF
  ↓
Matter.query()
  ↓
原业务系统
  ↓
标准 QueryPage
  ↓
Renderer 预览
```

## 7. 安全配置

BrowserWindow 默认要求：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox` 能开启时尽量开启
- 禁止随意开启 remote 模块
- 限制导航和新窗口
- 所有 IPC 使用固定频道
- IPC 参数后续增加 schema 校验

## 8. 错误模型

Core 统一错误类型建议：

- `LICENSE_REQUIRED`
- `LICENSE_EXPIRED`
- `PLUGIN_NOT_FOUND`
- `SESSION_REQUIRED`
- `SESSION_EXPIRED`
- `QUERY_VALIDATION_ERROR`
- `REMOTE_REQUEST_FAILED`
- `REMOTE_SCHEMA_CHANGED`
- `SYNC_FAILED`
- `STORAGE_FAILED`
- `EXPORT_FAILED`

UI 根据错误码展示友好信息，不直接把底层堆栈暴露给普通用户。

## 9. 可演进性

需要保证以下变化不会牵动主框架：

- 某系统登录方式变化
- 某事项查询参数变化
- 某系统接口 URL 变化
- 返回字段增加或减少
- 状态枚举变化
- 新增业务事项
- 新增整个业务系统

这些变化原则上只更新对应插件。