# 06. 任务引擎与运行时设计

## 1. 为什么需要任务引擎

真实业务系统查询可能存在大量分页、网络抖动、会话过期、接口限速和长时间运行。如果把这些逻辑直接放在 UI 点击事件里，会导致界面卡顿、无法恢复、无法追踪进度。

因此所有超过一次简单请求的查询和同步都应统一进入 Task Engine。

## 2. 任务类型

第一版建议：

- `remote-query`：远程分页查询
- `sync-preview`：计算新增/更新/无变化
- `sync-commit`：写入本地数据库
- `export`：导出文件
- `plugin-update`：插件更新
- `app-update`：主程序更新

后续可增加：
- 自动同步
- 本地重建索引
- 数据备份

## 3. 任务状态

```text
waiting
running
paused       # 后续
completed
partial_failed
failed
cancelled
```

## 4. Task 数据结构建议

```ts
interface TaskRecord {
  id: string;
  type: string;
  systemId?: string;
  matterId?: string;
  status: TaskStatus;
  progress: number;
  currentPage?: number;
  totalPages?: number;
  processedRows?: number;
  totalRows?: number;
  retryCount: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  errorCode?: string;
  errorMessage?: string;
}
```

## 5. 查询任务流程

```text
创建任务
→ 校验 License
→ 校验插件
→ 校验 Session
→ 校验查询条件
→ 发起第一页
→ 获取 total / page info
→ 循环分页
→ 标准化数据
→ 更新任务进度
→ 完成
```

## 6. Session 过期处理

如果分页过程中 Session 过期：

- 暂停当前任务
- 标记 `SESSION_EXPIRED`
- UI 提示重新登录
- 用户重新登录成功后，允许从失败页继续

不应从第一页强制全部重新查询，除非目标系统无法安全恢复分页。

## 7. 重试策略

建议只对明确的临时错误自动重试，例如：
- 网络超时
- 502/503/504
- 短暂连接失败

不自动重试：
- 401/403
- 参数错误
- 返回 Schema 变化
- 业务错误

建议指数退避并限制最大次数。

## 8. 限速

每个插件可以声明请求并发和最小间隔，避免对原系统形成不必要压力。

例如：

```ts
requestPolicy: {
  concurrency: 1,
  minIntervalMs: 300
}
```

默认应保守，不追求极端抓取速度。

## 9. 取消

用户取消任务后：
- 停止创建新请求
- 已发出的请求尽可能 Abort
- 已成功写入的数据按既定事务保持完整
- 任务状态记录为 cancelled

## 10. 崩溃恢复

任务元数据存入 SQLite。应用异常关闭后，下次启动可以识别未完成任务，并让用户选择：
- 继续
- 重新开始
- 丢弃任务

是否能继续取决于插件和 Session 是否仍有效。

## 11. Runtime

应用启动时 Runtime 负责：

```text
初始化日志
→ 初始化数据库
→ 迁移数据库
→ 加载 License
→ 加载插件
→ 校验插件兼容性
→ 注册 IPC
→ 恢复任务状态
→ 创建主窗口
→ 异步检查更新
```

任何插件初始化失败都不能让整个应用崩溃。应把该插件标记为不可用，并显示错误原因。

## 12. 任务进度事件

Main Process 通过受控 IPC 事件把任务状态推送给 Renderer。

Renderer 不轮询业务系统，只订阅本地任务状态。

## 13. 日志关联

每个任务分配 `taskId`，所有日志带 taskId，便于排障：

```text
[task:abc123][mock-market][enterprise-establishment] page=4 request completed rows=100
```

敏感认证字段仍然不进入日志。