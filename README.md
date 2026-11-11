# 数据融合助手（data-fusion-desktop）

基于 Electron 的本地数据融合桌面工具。

本项目面向业务人员：用户先通过授权密钥激活软件，再在应用内部登录自己有权限访问的业务系统，通过内置业务模块完成查询、同步、本地留存、状态更新、历史追踪和导出。

## 核心原则

- 应用本身不做用户账号体系，仅使用授权密钥激活。
- 用户进入具体业务系统模块后，在应用内登录对应业务系统。
- 业务系统登录成功后，由对应的内置模块维护 Token / Cookie / Session 等会话信息。
- 未登录或会话失效时，不允许发起该系统的数据查询。
- 业务认证信息不上传授权/更新服务器。
- 所有业务数据默认只保存在本地。
- 每个业务系统在源码内保持独立模块，每个业务事项独立声明查询条件、字段映射、唯一键和同步策略。
- 本地数据同步支持新增、更新、无变化与历史版本追踪。
- 公网服务器只负责 License 和主程序整包更新，不承担业务数据中转。

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
│  ├─ plugins/           内置业务模块协议与注册
│  ├─ session/           Token/Cookie/Session 会话
│  ├─ query/             查询协议与 Schema
│  ├─ sync/              本地同步与去重
│  ├─ storage/           SQLite、本地数据与平台状态
│  ├─ tasks/             持久化任务运行时
│  ├─ export/            Excel/CSV/JSON 导出
│  └─ updater/           签名更新清单检查
└─ plugins/
   ├─ market-access/     广东省市场准入系统真实插件
   ├─ government-info/   政务综合信息平台双公示回流插件
   └─ mock-market/       开发测试用 Mock 插件（运行时不注册）
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

## 已实现的平台能力

```text
在线 / 离线 License 激活与授权闸门
→ License 控制可用业务系统和功能
→ 业务系统登录与会话隔离
→ 查询、同步预览、SQLite 事务写入
→ 任务历史、审计、本地检索、版本轨迹和导出
→ 签名更新清单检查、校验与安装程序启动
```

> 仓库不提交任何真实业务系统密码、Token、Cookie、验证码或敏感业务数据。市场准入系统登录由独立的应用内登录窗口完成，会话只保存在 Electron 隔离分区中。

## 本地运行

需要 Node.js 22.12 或更高版本。依赖版本已锁定，安装时会自动校验并下载 Electron 运行时。

```bash
npm ci
npm run dev
```

提交前可运行完整校验：

```bash
npm test
npm run typecheck
npm run build
```

开发环境可在激活页使用 `DF-DEV-LOCAL`。正式构建不接受开发授权，必须使用受信私钥签发的 `DFL1.` 离线密钥，或配置 `DATA_FUSION_ACTIVATION_URL` 接入在线激活服务。

生产部署需要注入以下配置：

- `DATA_FUSION_LICENSE_PUBLIC_KEY`：仅开发测试可覆盖 License 验签公钥；正式包固定产品公钥。
- `DATA_FUSION_UPDATE_PUBLIC_KEY`：仅开发测试可覆盖更新清单验签公钥；正式包固定产品公钥。
- `DATA_FUSION_ACTIVATION_URL`：可选的在线激活接口。
- `DATA_FUSION_LICENSE_STATUS_URL`：在线授权状态刷新接口。
- `DATA_FUSION_UPDATE_URL`：可选的签名更新清单地址。

密钥签发和后台部署方法见 [License 与发行操作](./docs/13-license-and-plugin-operations.md)。

本地启动授权管理后台：

```powershell
$env:ADMIN_INITIAL_PASSWORD = '请替换为强密码'
$env:ADMIN_LICENSE_PRIVATE_KEY = 'D:\secure\license-private.pem'
npm run admin:start
```

后台默认仅监听 `http://127.0.0.1:8787`，可管理客户、按系统授权、激活设备、授权停用和主程序整包更新。

当前内置广东省市场准入、政务综合信息、道路运输从业人员、大件运输及网约车车证五个业务组件，另有卫健局双公示工具。新增系统随主程序新版统一交付，在线设备自动更新，离线设备人工安装新版；License 决定每台设备实际可用的系统和工具。

### 行政许可导出（2026-10-20）

行政许可 Excel 统一使用用户提供的 `行政许可模板 (1).xls` 布局，输出真实 `.xlsx`：保留 32 列、两行合并表头、必填红星及填写提示/下拉规则，数据从第 3 行开始。原模板只读提取为内嵌描述，其他电脑不需要 E 盘文件。缺字段仍先提示确认，继续导出后整行标红并保留批注。普通市场原始查询不是行政许可数据，仍按其原始字段单独导出，不允许混合类型导出。

- 固定目录：正式程序 EXE 同级的 `导出文件`；开发环境为项目根目录下 `导出文件`。不再弹出“另存为”，也不沿用微信等其他目录。
- 命名：`行政许可-业务名-开始日期至结束日期.xlsx`，例如 `行政许可-大件运输许可-2026-10-01至2026-10-19.xlsx`。
- 批次使用原任务查询日期；合并台账和卫健工具使用所选记录的许可决定日期范围。没有日期或部分缺失时在名称明确标注，不使用导出当天冒充业务日期。
- 同名文件自动加序号，不覆盖已有文件。目录无写权限则明确提示，不静默换位置。
- 导出成功后点击完整路径打开所在文件夹。主进程只接受本次成功导出的固定目录内文件，拒绝任意路径和链接目标。
- 企业补全先于回流保存；原系统/本地已有法人和有效信用代码不查后台，缺项才按后台企业库→阿里云顺序补充。仍查不到则保留状态和缺项提醒。
