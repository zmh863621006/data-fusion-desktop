# 03. 插件规范与接口分析流程

## 1. 目标

所有真实业务系统都以插件形式接入。主程序不写系统专有登录、接口 URL、字段映射和业务规则。

## 2. 插件最小能力

一个插件至少实现：

```ts
interface BusinessSystemPlugin {
  id: string;
  name: string;
  version: string;
  auth: AuthAdapter;
  matters: BusinessMatter[];
  initialize(): Promise<void>;
  getSessionState(): Promise<SessionState>;
}
```

## 3. AuthAdapter

每个系统自行实现登录会话。

需要回答：
- 登录入口是什么
- 是否存在验证码
- 是否短信/扫码
- 是否经过统一身份认证
- Token 从哪个响应返回
- Token 在 Header、Cookie 还是两者都有
- 是否存在 CSRF Token
- Session 有效期
- 是否有 refresh 接口
- 登出接口
- 多域名 Cookie 范围

认证信息只在 Main Process / 插件边界内使用。

## 4. BusinessMatter

每一个业务事项独立声明：

- `id`
- `name`
- 查询条件 Schema
- 唯一键
- 列表查询接口
- 分页方式
- 返回字段
- 详情接口
- 状态字段
- 字典映射
- 同步策略

## 5. 接口分析标准流程

每接一个真实系统，按以下顺序建立分析文档。

### A. 系统基础信息

- 系统名称
- 系统域名
- 登录域名
- API 域名
- 前端技术特征（仅用于适配）
- 是否跨域
- 是否有网关

### B. 登录链路

记录从打开登录页到认证成功的完整合法流程：

```text
登录页
→ 初始化请求
→ 用户认证
→ 登录响应
→ Session/Token 建立
→ 首个已认证请求
```

分析重点不是绕过认证，而是准确复现用户本人正常登录后的会话使用方式。

### C. 会话字段

建立表格：

| 字段 | 来源 | 使用位置 | 是否敏感 | 有效期 |
|---|---|---|---|---|
| access_token | 登录响应 | Authorization | 是 | 待分析 |
| SESSION | Set-Cookie | Cookie | 是 | 待分析 |
| X-CSRF-TOKEN | 页面/响应 | Header | 是 | 待分析 |

真实系统分析后替换示例。

### D. 业务事项接口

每个事项至少记录：
- 列表 URL
- HTTP Method
- Content-Type
- 必须 Header
- Query/Body 参数
- 时间参数格式
- 页码参数
- 每页数量参数
- 总数返回位置
- 列表数组路径
- 错误码

### E. 字段分析

每个返回字段分类：
- 业务唯一标识
- 展示字段
- 状态字段
- 时间字段
- 可变字段
- 敏感字段
- 字典字段
- 无需落库字段

### F. 唯一键判定

优先使用业务系统天然稳定 ID，例如：
- 业务流水号
- 申请编号
- 事项实例 ID

只有系统确实没有稳定主键时才使用联合键。

禁止使用可能变化的名称、状态、更新时间作为唯一键。

### G. 状态模型

必须记录原始状态码与展示名称，例如：

```text
01 accepted  受理中
02 reviewing 审批中
03 completed 已办结
```

本地保存原始状态值，展示层再做中文映射。

## 6. 接口变更检测

系统变化快，因此插件需要对以下异常做明确识别：

- HTTP 状态变化
- 返回 JSON 路径变化
- 必填参数变化
- 字段类型变化
- 登录跳转异常
- Session 突然失效
- 分页协议变化

出现疑似结构变化时，优先报 `REMOTE_SCHEMA_CHANGED`，不要静默把错误页面当数据写入本地。

## 7. 插件 Manifest 建议

```ts
interface PluginManifest {
  id: string;
  name: string;
  version: string;
  coreApiVersion: string;
  supportedAppVersion: string;
  matters: string[];
}
```

主程序加载插件前先检查兼容版本。

## 8. 插件更新原则

- 系统插件与主程序独立版本
- 某系统变化只更新该插件
- 更新前保留上一个插件版本
- 新版本异常时支持回滚
- 插件升级如涉及本地表结构，必须提供 migration

## 9. 调试与记录

开发模式可以记录：
- URL
- Method
- 状态码
- 耗时
- 页码
- 返回条数

默认不记录：
- 完整 Token
- 密码
- 短信验证码
- 完整敏感 Cookie

需要排查时也只做脱敏日志。