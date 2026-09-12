# 07. 开发路线图

## Phase 0：架构基线

目标：确定边界，避免后续推翻。

已完成/进行中：
- Electron + React + TypeScript 基础方向
- Plugin Registry
- AuthAdapter
- SessionState
- BusinessMatter
- QuerySchema
- License 接口模型
- LocalRepository 抽象
- SyncEngine 抽象
- Mock 市场准入插件
- 基础 IPC / Preload 边界

## Phase 1：可运行桌面底座

目标：本机可安装、可启动、可完整跑 Mock 流程。

任务：
- 完善 Vite/Electron 开发启动流程
- Main/Preload/Renderer 构建配置
- 主窗口
- 路由/页面壳
- IPC schema 校验
- Runtime 初始化
- 错误边界
- 基础日志
- Mock 登录
- Mock 动态查询

验收：

```text
启动
→ 激活 Mock License
→ 进入系统
→ 未登录无法查询
→ 登录 Mock 系统
→ 动态生成事项条件
→ 查询 Mock 数据
```

## Phase 2：SQLite 与同步引擎

目标：真正实现本地回流。

任务：
- SQLite 接入
- migration
- systems/matters/records/record_versions/sync_batches/tasks 表
- record_key
- payload normalization
- payload hash
- preview sync
- commit sync
- history diff

验收：同一条 Mock 业务从“受理中”变成“已办结”后，本地只保留一条当前记录，同时存在正确历史版本。

## Phase 3：任务引擎

目标：支持大分页查询。

任务：
- Task Manager
- 分页任务
- 进度事件
- Abort
- retry
- Session 失效恢复
- 崩溃恢复
- 日志关联

## Phase 4：正式 UI

目标：实现完整工具体验。

页面：
- 密钥激活
- 工作台
- 系统主页
- 系统登录
- 事项查询
- 查询结果预览
- 同步确认
- 任务中心
- 本地数据中心
- 数据详情 + 时间轴
- 导出
- 授权信息
- 设置

## Phase 5：License 服务

目标：商业授权能力。

任务：
- 非对称签名
- 本地验签
- 在线激活 API
- 设备绑定
- 有效期
- 系统/事项授权
- 吊销
- 离线宽限策略

## Phase 6：自动更新与插件分发

目标：解决业务系统频繁变化。

任务：
- 主程序 manifest
- 插件 manifest
- 版本比较
- 下载
- 包摘要/签名校验
- 插件热替换或重启替换
- 回滚
- migration

## Phase 7：第一个真实业务系统

选择一个最典型、权限和使用范围明确的真实系统。

接入步骤：
1. 登录流程分析
2. 会话分析
3. 第一个事项列表接口
4. QuerySchema
5. 字段映射
6. 唯一键
7. 状态映射
8. 详情接口
9. 分页同步
10. 本地历史验证

不要一开始同时接多个真实系统。

## Phase 8：真实系统扩展

第一个系统跑稳定以后，复制插件规范扩展：
- 同系统更多事项
- 第二个系统
- 扫码登录系统
- 手机验证码系统
- 统一认证系统

## 开发优先级

P0：
- 安全边界
- Session
- 插件规范
- SQLite
- 去重/更新
- 任务引擎

P1：
- UI
- 导出
- License
- 更新

P2：
- 自动同步
- 保存视图
- 备份恢复
- 高级全局搜索

## 开发原则

- Core 与业务插件严格分离
- 真实系统任何特殊逻辑不得散落到主程序
- 所有真实接口先分析后编码
- 数据结构变化必须 migration
- 不用“先能跑再说”破坏安全边界
- 复杂功能优先 Mock 验证，再接生产系统

## 当前下一步

从现在开始底层开发顺序建议固定为：

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
