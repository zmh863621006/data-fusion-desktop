# 数据融合助手（data-fusion-desktop）

基于 Electron 的本地数据融合桌面工具。

本项目面向业务人员：用户先通过授权密钥激活软件，再在应用内部登录自己有权限访问的业务系统，通过系统插件完成查询、同步、本地留存、状态更新、历史追踪和导出。

## 核心原则

- 应用本身不做用户账号体系，仅使用授权密钥激活。
- 用户进入具体业务系统模块后，在应用内登录对应业务系统。
- 业务系统登录成功后，由系统插件维护 Token / Cookie / Session 等会话信息。
- 未登录或会话失效时，不允许发起该系统的数据查询。
- 业务认证信息不上传授权/更新服务器。
- 所有业务数据默认只保存在本地。
- 每个业务系统独立插件化，每个业务事项独立声明查询条件、字段映射、唯一键和同步策略。
- 本地数据同步支持新增、更新、无变化与历史版本追踪。
- 公网服务器只负责 License 和软件/插件更新，不承担业务数据中转。

## 完整方案文档

项目方案已整理到 [`docs/`](./docs/README.md)：

- [项目总览与产品基线](./docs/00-project-overview.md)
- [技术架构](./docs/01-architecture.md)
- [产品流程与 UI 规范](./docs/02-product-flow-and-ui.md)
- [插件规范与接口分析流程](./docs/03-plugin-and-interface-analysis.md)
- [本地数据库、同步、去重与历史版本](./docs/04-local-data-and-sync.md)
- [授权、更新与安全方案](./docs/05-license-update-security.md)
- [任务引擎与运行时设计](./docs/06-task-engine-and-runtime.md)
- [开发路线图](./docs/07-development-roadmap.md)

## 当前代码结构

```text
src/
├─ main/                 Electron 主进程、Runtime、IPC
├─ preload/              安全桥接层
├─ renderer/             桌面 UI
├─ core/
│  ├─ license/           授权密钥
│  ├─ plugins/           插件协议与注册器
│  ├─ session/           Token/Cookie/Session 会话
│  ├─ query/             查询协议与 Schema
│  ├─ sync/              本地同步与去重
│  └─ storage/           本地数据存储抽象
└─ plugins/
   └─ mock-market/       Mock 市场准入系统
```

## 核心流程

```text
密钥激活
  ↓
选择业务系统
  ↓
检查系统登录状态
  ├─ 未登录 → 在应用内完成原系统登录 → 获取有效会话
  └─ 已登录 → 继续
  ↓
选择业务事项
  ↓
根据 Schema 生成查询条件
  ↓
调用原业务系统接口
  ↓
查询结果预览
  ↓
计算新增 / 更新 / 无变化
  ↓
确认写入本地 SQLite
  ↓
历史版本 / 本地查询 / 导出
```

## 当前开发顺序

```text
构建链路
→ SQLite
→ Sync Engine
→ Task Engine
→ License 骨架
→ 插件 Manifest
→ 正式 UI
→ 第一个真实系统
```

> 当前仓库只包含框架与 Mock 系统，不提交任何真实业务系统密码、Token、Cookie、验证码或敏感业务数据。
