# 数据融合助手：方案文档索引

本目录是项目当前产品与技术方案的开发基线。后续讨论形成的新结论，优先更新到对应文档，再进入代码实现。

## 文档目录

1. [00-project-overview.md](./00-project-overview.md) — 项目定位、产品边界、核心流程
2. [01-architecture.md](./01-architecture.md) — Electron 技术架构、进程边界、Core 设计
3. [02-product-flow-and-ui.md](./02-product-flow-and-ui.md) — 页面、交互与完整业务流程
4. [03-plugin-and-interface-analysis.md](./03-plugin-and-interface-analysis.md) — 插件规范、真实系统接口分析方法
5. [04-local-data-and-sync.md](./04-local-data-and-sync.md) — SQLite、去重、更新、历史版本、时效策略
6. [05-license-update-security.md](./05-license-update-security.md) — 密钥授权、自动更新、插件更新、安全边界
7. [06-task-engine-and-runtime.md](./06-task-engine-and-runtime.md) — 分页查询、任务引擎、恢复、重试、运行时
8. [07-development-roadmap.md](./07-development-roadmap.md) — 分阶段开发计划和当前优先级
9. [08-real-system-onboarding-checklist.md](./08-real-system-onboarding-checklist.md) — 真实业务系统接入检查表
10. [09-decisions-and-open-questions.md](./09-decisions-and-open-questions.md) — 已确定架构决策与待确认事项
11. [10-ui-screen-specification.md](./10-ui-screen-specification.md) — 全部桌面页面与交互规格
12. [11-testing-release-and-quality.md](./11-testing-release-and-quality.md) — 测试、CI、发布、迁移与质量基线
13. [12-security-threat-model.md](./12-security-threat-model.md) — 本地数据、业务会话、插件和更新安全模型

## 核心不可破坏原则

- 应用本身无用户账号登录，只有 License 激活。
- 业务系统必须由用户本人在应用内完成原系统认证后才能查询。
- 业务系统 Token / Cookie / Session 不上传授权服务器。
- 业务数据默认只留在用户本机。
- Renderer 不直接持有原始业务认证凭据。
- 每个业务系统独立插件化，每个事项独立 Schema 和同步策略。
- 查询与本地写入分离，写入前必须进行新增/更新/无变化识别。
- 系统变化优先通过插件升级解决，避免频繁升级整个桌面主程序。

## 文档维护规则

当产品逻辑发生变化时：

1. 先确认是否改变核心边界。
2. 更新对应 docs 文档。
3. 如涉及公共接口，再修改 Core 类型。
4. 如只涉及某个系统，则只更新对应插件及该系统专属分析文档。
5. 数据库结构变化必须提供 migration 说明。

后续真实系统接入时，建议为每个系统增加：

```text
docs/systems/<system-id>/
├─ README.md
├─ auth-flow.md
├─ matters.md
├─ fields.md
├─ status-map.md
└─ change-log.md
```

真实 Token、密码、Cookie、验证码和敏感业务样本不得提交到 GitHub。
