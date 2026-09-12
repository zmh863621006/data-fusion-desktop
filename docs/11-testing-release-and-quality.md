# 测试、发布与质量基线

## 1. 测试分层

### Core 单元测试
重点覆盖：
- 唯一键生成
- 新增/更新/无变化判断
- 历史版本写入
- 查询 Schema 校验
- 分页边界
- 请求重试和取消
- License 签名校验
- 插件 Manifest 校验

### Plugin 合约测试
每个真实系统插件必须通过统一合约：
- 未登录时拒绝查询
- 登录状态可读取
- Session 失效可识别
- matterId 唯一
- uniqueKey 非空
- Query Schema 可序列化
- 列表查询返回标准 QueryPage

### 集成测试
使用 Mock 插件验证：
密钥状态 → 系统登录 → 条件查询 → 多页查询 → Sync Preview → Commit → 历史版本 → 导出。

### 手工验收
真实业务系统上线前必须对照原系统抽样验证总数、分页、字段、状态、详情和去重结果。

## 2. CI
当前仓库使用 GitHub Actions Windows Runner：
- npm install
- npm run typecheck
- npm run build

增加 lockfile 后改为 npm ci 并启用 npm cache。

## 3. 版本规范
主程序使用 SemVer：`MAJOR.MINOR.PATCH`。
插件独立版本，不与主程序强绑定。

建议：
- Patch：Bug 修复，不改变插件协议
- Minor：向后兼容的新能力
- Major：插件协议或本地数据库存在破坏性变化

## 4. 发布通道
后续预留：
- internal：开发/内部验证
- beta：少量业务人员试用
- stable：正式发布

## 5. 数据库迁移
任何数据库结构变化只能通过 migration 完成，禁止启动时临时修改表结构。
迁移规则：
- version 单调递增
- 已发布 migration 不修改
- 新增 migration 完成后再升级应用代码依赖
- 迁移失败必须阻止应用继续写业务数据

## 6. 插件发布
插件包需要包含：
- manifest
- 插件代码
- 版本
- engineVersion
- 文件哈希/签名（正式更新阶段实现）

更新流程：下载 → 验签 → 兼容性校验 → 备份当前版本 → 安装 → 健康检查 → 成功后切换；失败自动回滚。

## 7. 日志要求
日志不得记录：
- 密码
- 完整 Token
- 完整 Cookie
- 短信验证码
- 身份认证敏感参数

允许记录脱敏后的系统 ID、事项 ID、HTTP 状态、业务错误码、耗时、分页信息和任务 ID。

## 8. Definition of Done
一个功能被视为完成至少需要：
- 类型检查通过
- 构建通过
- 核心异常路径有处理
- 不向 Renderer 泄露认证材料
- 不把业务数据发送到产品服务器
- 文档与接口定义同步更新
