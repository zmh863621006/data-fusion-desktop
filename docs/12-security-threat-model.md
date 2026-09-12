# 安全威胁模型

## 目标资产
- 业务系统登录会话：Token / Cookie / Session / CSRF 信息
- 用户在原业务系统可见的数据
- 本地 SQLite 数据库
- License 授权信息
- 插件包与自动更新包

## 信任边界
1. Renderer：最低权限，只负责 UI 和用户交互。
2. Preload：严格白名单桥接。
3. Main Process：文件、数据库、任务调度和插件运行。
4. Plugin：仅处理对应业务系统，不允许随意访问其他插件状态。
5. Product Server：只负责 License、版本和插件更新，不承载业务数据。
6. Target Business System：远程真实业务系统。

## 主要风险与控制

### Renderer XSS 导致会话泄露
控制：
- contextIsolation=true
- nodeIntegration=false
- Renderer 不接收原始 Token/Cookie
- IPC 只暴露 DTO

### 敏感会话明文落盘
控制：
- 默认仅内存保存
- 如需跨重启保存，必须使用操作系统凭据/安全存储
- 不写普通 SQLite 表、不写日志

### 插件供应链篡改
控制：
- 插件 manifest
- 包哈希
- 发布签名
- engineVersion 兼容检查
- 更新前备份，失败回滚

### 更新包被替换
控制：
- HTTPS 只是基础，正式版本还需要包签名验签
- 主程序更新与插件更新均需完整性验证

### 本地数据库被复制
可选控制取决于部门要求：
- 操作系统磁盘加密
- 应用级数据库加密
- 导出权限受 License 控制
- 数据目录权限限制

### 日志泄露业务数据
控制：
- 默认不记录响应正文
- 不记录认证材料
- 对查询条件中的敏感字段做脱敏策略

### 请求过快影响原系统
控制：
- RequestGate
- 插件级最小请求间隔
- 分页上限
- 并发上限
- 限流响应后退避

### 越权查询
本产品不设计绕过权限。插件只能使用当前用户正常登录得到的有效会话，并调用该会话原本允许访问的功能。账号不可见的数据不应通过本工具额外获取。

## 默认安全原则
- deny by default
- least privilege
- sensitive data stays local
- raw session stays outside Renderer
- no business data telemetry
- no hidden remote data upload
