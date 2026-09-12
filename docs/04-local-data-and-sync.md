# 04. 本地数据库、同步、去重与历史版本

## 1. 目标

本地数据库解决三个问题：

1. 把用户有权限查看的数据留存在本机。
2. 同一业务记录状态变化时正确更新，而不是重复插入。
3. 保留关键变化历史，支持业务追溯。

## 2. 推荐存储

使用 SQLite。所有业务数据库文件默认存放在 Electron `userData` 目录下的专用数据目录，不放在应用安装目录。

建议拆分：

```text
userData/
├─ db/
│  └─ data-fusion.sqlite
├─ exports/
├─ logs/
├─ plugins/
└─ cache/
```

## 3. 核心表设计

### systems

记录已安装系统插件元数据。

关键字段：`system_id`, `name`, `plugin_version`, `enabled`, `updated_at`。

### matters

记录业务事项元数据。

关键字段：`system_id`, `matter_id`, `name`, `schema_version`。

### records

保存当前最新版本。

建议字段：

```text
id
system_id
matter_id
record_key
business_status
source_updated_at
payload_json
payload_hash
first_seen_at
last_seen_at
last_changed_at
sync_batch_id
```

唯一索引：`(system_id, matter_id, record_key)`。

### record_versions

保存发生变化时的历史快照。

```text
id
system_id
matter_id
record_key
version_no
payload_json
payload_hash
captured_at
sync_batch_id
```

### sync_batches

记录一次查询/同步批次。

```text
id
system_id
matter_id
started_at
finished_at
query_json
remote_total
inserted
updated
unchanged
failed
status
```

### tasks

用于后台任务持久化。

### saved_queries

保存用户常用查询模板。

## 4. record_key 计算

插件声明 `uniqueKey: string[]`。

例如：

```text
uniqueKey = ["businessNo"]
```

或者必要时：

```text
uniqueKey = ["regionCode", "applicationNo"]
```

Core 统一把唯一键字段规范化后计算稳定 `record_key`。

唯一键一旦发布应尽量保持稳定。变更唯一键需要 migration 方案。

## 5. 数据比较

除了唯一键，再计算标准化 payload hash。

同步时：

```text
本地无 record_key
→ INSERT

本地存在 + hash 相同
→ UNCHANGED，只更新 last_seen_at

本地存在 + hash 不同
→ UPDATE，并写 record_versions
```

对于系统中每次请求都会变化、但无业务意义的字段（请求时间、随机流水等），插件应在 hash 前排除，避免制造假更新。

## 6. 历史版本策略

默认只在业务内容发生变化时记录版本，不为完全相同的数据重复写历史。

详情页面可根据版本计算字段差异：

```text
status: accepted → reviewing
approveUser: null → 张*
finishTime: null → 2026-09-12 13:20
```

## 7. 时效与滚动回查

不能只按“新增时间”增量，因为未办结业务会持续变化。

事项插件需要声明同步策略，例如：

```text
最近 30 天数据 + 所有本地未办结记录
```

建议策略：
- 未办结：高频回查
- 最近已办结：中频回查
- 历史已办结：低频或不再回查

第一版先支持手动策略配置，后续再自动调度。

## 8. 大数据量

必须分页处理，不一次性把全部数据放进 Renderer 内存。

建议：

```text
查询一页
→ 标准化
→ 计算同步预览
→ 累计统计
→ 下一页
```

用户选择“只预览”时可限制最大预览条数，但同步任务可以继续全量跑完。

## 9. 事务

单批次写入需合理使用 SQLite Transaction。

原则：
- 一页或一小批作为事务边界
- 不建议几十万行一个超大事务
- 失败页可重试
- 已成功页面不应因后续失败全部回滚

## 10. 数据删除

原系统某条记录这次查询没出现，不代表业务记录已删除。因此不能简单根据“本次不存在”删除本地数据。

只有插件能够明确判断远程删除/撤销语义时，才更新本地删除状态。

## 11. 数据导出

导出基于本地数据库，而不是直接把远程响应写 Excel。

优点：
- 可重复导出
- 可选列
- 可按当前视图导出
- 可组合多个同步批次
- 查询失败不影响已同步数据使用

## 12. 备份

后续提供：
- 手动备份 SQLite
- 恢复前校验版本
- 自动备份周期
- 数据目录迁移

由于业务数据敏感，默认不做云备份。