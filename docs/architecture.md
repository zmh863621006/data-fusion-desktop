# 底层架构说明

## 1. 信任边界

数据融合助手分成三个安全边界：

1. **Renderer（UI）**
   - 只负责界面、查询条件、结果展示。
   - 不直接访问 Node.js、文件系统或业务系统 Token。
   - 通过 Preload 暴露的白名单 API 调用主进程。

2. **Main Process（可信核心）**
   - 插件注册、系统登录、Session 管理、查询调度、本地数据库、导出、License、更新均在此层处理。
   - Token / Cookie / CSRF 等敏感认证材料原则上只存在于此边界或操作系统安全凭据存储。

3. **Business System Plugin（系统插件）**
   - 每个业务系统独立插件。
   - 插件负责该系统的登录方式、认证材料、请求头、接口调用、查询条件、分页、字段映射、事项定义。
   - 插件之间禁止共享业务系统 Session。

## 2. 核心调用链

```text
Renderer
   ↓ safe IPC
Preload
   ↓ allow-list IPC
Main IPC Router
   ↓
Plugin Registry
   ↓
Business System Plugin
   ├─ AuthAdapter
   ├─ Session
   └─ BusinessMatter
           ↓
      Query Adapter
           ↓
      原业务系统
```

本地写入阶段：

```text
查询结果
  ↓
Sync Engine
  ├─ 唯一键计算
  ├─ 新增判断
  ├─ 字段变化判断
  └─ 历史版本生成
  ↓
Local Repository (SQLite)
```

## 3. 强制规则

- 应用没有业务用户登录体系；只有 License 激活。
- 查询任何系统前必须存在该系统有效 Session。
- Renderer 不允许接触原始 Token。
- 一个系统一个 Session 容器，不能跨系统复用。
- 一个系统可包含多个 BusinessMatter。
- 每个事项必须声明 uniqueKey。
- 查询 Schema 由插件声明，UI 动态生成。
- 所有业务数据默认只落本地。
- 授权/更新服务器不得接收业务查询结果。

## 4. 后续基础模块

下一阶段底层继续补齐：

- SQLite Repository + migration
- Sync Engine 实现（insert/update/unchanged/history）
- License 签名验证与本地激活状态
- 系统安全凭据存储
- Query Task 队列、取消、进度、重试
- 日志与错误码体系
- 插件 manifest / version / compatibility
- 主程序更新和插件更新
- Excel 导出服务

## 5. 真实系统接入规范

后续每接一个真实系统，先分析并记录：

- 登录入口与认证方式
- Token/Cookie/Session/CSRF 来源
- Session 过期规则与刷新方式
- 查询请求 URL / Method / Headers
- 查询参数及其含义
- 时间字段格式
- 分页规则
- 返回字段
- 唯一业务键
- 状态字段与状态枚举
- 详情接口
- 请求频率与错误码
- 是否存在多级查询依赖

完成分析后，只实现该系统插件，不修改主框架的业务逻辑。
