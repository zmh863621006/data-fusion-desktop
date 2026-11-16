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
14. [13-license-and-plugin-operations.md](./13-license-and-plugin-operations.md) — 在线/离线授权、后台部署与发行操作
15. [14-government-query-export-comparison.md](./14-government-query-export-comparison.md) — 政务查询、导出及其他事项详情实测对比
16. [15-government-certificate-enrichment.md](./15-government-certificate-enrichment.md) — 其他 5 项证照字段补充范围、接口依据及保护规则
17. [16-browser-session-recovery.md](./16-browser-session-recovery.md) — 各系统跨重启会话保存、只读校验与首页标签页恢复
18. [17-enterprise-management.md](./17-enterprise-management.md) — 企业资料共用、名称优先查询与信用代码兜底
19. [18-admin-production.md](./18-admin-production.md) — 后台登录保护、权限、配套客户端升级及上线部署
20. [19-windows-release.md](./19-windows-release.md) — Windows安装包、升级保全及正式分发验收
21. [20-publication-platform-entries.md](./20-publication-platform-entries.md) — 政务回流数据的两处公示平台登录入口与标签页保留
22. [21-government-completion-query.md](./21-government-completion-query.md) — 办结日期起止参数与排水许可新办固定内容规则
23. [22-d3dcompiler-compatibility.md](./22-d3dcompiler-compatibility.md) — 官方图形编译组件版本替换与Windows系统加载对照验证
24. [23-hrss-local-list-dashboard.md](./23-hrss-local-list-dashboard.md) — 人社18项列表台账、本地全屏看板、证书确认及本地测试交付
25. [24-kylin-internal-build.md](./24-kylin-internal-build.md) — 麒麟 V10 内部测试打包与验证范围
26. [25-windows-universal-compatibility.md](./25-windows-universal-compatibility.md) — Win7/Win10 自动选择运行环境的通用安装包与测试边界
27. [26-windows-prerequisites-bootstrap.md](./26-windows-prerequisites-bootstrap.md) — 缺失系统组件自动补齐、管理员授权、重启续装与隔离回归
28. [27-multiplatform-releases.md](./27-multiplatform-releases.md) — Windows、麒麟x86_64与ARM64版本分发及更新校验
29. [28-shenzhen-hazardous-chemicals.md](./28-shenzhen-hazardous-chemicals.md) — 深圳危化品5项回流、会话与双公示字段、后台权限及本地测试包
30. [29-kirin990-gbm-compatibility.md](./29-kirin990-gbm-compatibility.md) — 海思990缺失GBM接口的私有库专项测试包、来源与ARM64回归

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
