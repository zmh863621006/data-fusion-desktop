# 授权管理后台

后台与桌面端使用同一套 RSA License 协议，负责客户、在线激活码、离线许可证、设备、授权停用和主程序整包更新清单。

管理前端使用 React + Ant Design + ProComponents，源码位于 `admin-server/web`，构建产物输出到 `admin-server/public`并由同一 Node 服务提供。

上线配置、登录保护规则和客户端升级顺序见 [后台上线说明](../docs/18-admin-production.md)。生产环境参考配置位于 `deploy/`；`npm run admin:start` 可读取 `admin-server/.env`。

## 构建管理前端

```powershell
npm --prefix admin-server/web install
npm run admin:web:build
```

开发时可同时启动 API 服务和 Vite 前端：

```powershell
npm run admin:start
npm run admin:web:dev
```

## 启动

首次启动必须设置管理员密码和 License 私钥路径：

```powershell
$env:ADMIN_INITIAL_PASSWORD = '请替换为强密码'
$env:ADMIN_LICENSE_PRIVATE_KEY = 'D:\secure\license-private.pem'
npm run admin:start
```

默认仅监听 `127.0.0.1:8787`。生产环境应放在 HTTPS 反向代理后面，并通过防火墙限制管理页面来源。不要把私钥放在网站静态目录、Git 仓库或桌面安装包中。

## 桌面端地址

在线客户端配置：

```text
DATA_FUSION_ACTIVATION_URL=https://license.example.com/api/activate
DATA_FUSION_LICENSE_STATUS_URL=https://license.example.com/api/license/status
DATA_FUSION_UPDATE_URL=https://license.example.com/api/updates/manifest
```

后台在线激活返回签名 License；新版客户端每次启动及运行中每 5 分钟刷新授权状态（请求不重叠）。网络临时不可用时继续使用尚未过期的本地签名授权，后台明确返回停用时本地授权失效，后续受授权约束的操作被拒绝。此机制不承诺中断已经发出的业务请求，也不能对断网设备实现即时停用。

更新仅发布主程序整包：后台保存 HTTPS 下载地址和 SHA256，客户端校验签名清单和文件摘要后才启动安装程序。业务系统组件随主程序统一发布。

## 数据

默认 SQLite 位于 `admin-server/data/admin.sqlite`，可通过 `ADMIN_DB_PATH` 修改。生产环境必须备份该数据库。

## 本轮后台整改（2026-09-22）

- 政务目录与客户端共用 `src/plugins/government-info/matter-catalog.json`，按水务局、城管局、其他及事项顺序展示 18 个事项。旧 `double-publicity-return` 停止分配；服务启动时将数据库中的旧组合权限迁移为 18 项，保留原授权范围。客户端验签后同样兼容已签发的旧离线许可证，不绕过签名校验。
- 签发一份在线授权后，可在“授权详情 → 补发/追加激活码”生成新码，每次生成会撤销尚未使用的旧码，已激活设备不受影响。每码只绑定一台设备，同设备重试幂等；容量不足时先在设备管理停用旧设备，再发新码换机。被停用设备不能用已经消费的旧码重新激活。
- 授权详情支持续期；已过期但未停用的授权也可续期。在线客户端下次刷新获取新期限；离线授权需补发许可证并重新导入。
- 新离线授权强制单设备并保存设备码，支持补发。老离线授权若从未保存设备码，无法凭空恢复绑定，不允许不安全补发，需要重新签发。
- 客户停用阻止激活、在线状态刷新和更新清单获取。业务系统的“允许分配授权”开关只控制新授权分配，不追溯撤销既有授权；如需撤销，使用授权/客户停用。离线许可证不能被远程即时撤销。
- 增加账号与安全页面：超级管理员管理账号，运营人员管理业务，只读审计账号仅可读取。最少保留一个启用的超级管理员。修改密码、角色或停用账号会清除相关会话；初始密码仅首次建库有效，不是密码重置入口。
- 登录采用一次性图片验证码，账号输错 5 次锁定 15 分钟，来源 IP 另有限额，计数持久保存。`ADMIN_TRUSTED_PROXIES` 可显式指定受信代理，由其覆盖 `X-Real-IP`；公网部署配合反向代理限流。
- 生产设置 `NODE_ENV=production`、`ADMIN_COOKIE_SECURE=true`；在 HTTPS 反向代理后显式设置 `ADMIN_PUBLIC_ORIGIN=https://实际后台域名`。管理员写请求检查来源，除独立受限安装包上传使用二进制流外要求 JSON，错误不返回数据库或文件系统内部信息。
- 审计新增服务端历史分页、账号与操作类型筛选；客户、授权、系统、版本状态过滤生效。前端未实现所有业务表的服务端分页，大规模数据仍需后续优化。
- 更新清单按最高有效数字版本选择，而非最后插入顺序。当前发布接受稳定版 `数字.数字.数字`。

首次使用新版服务前请备份 SQLite（停服复制数据库，或使用 SQLite backup；运行时不要只复制主库而遗漏 WAL）。启动将执行幂等增量迁移，不删除既有客户和授权。私钥保持原文件，不重新生成生产密钥。

## 人社列表回流组件

后台目录新增独立系统 `guangdong-hrss`（广东省集中式人力资源和社会保障一体化门户系统），与桌面端共用 `src/plugins/guangdong-hrss/matter-catalog.json`。18 个台账按就业服务、就业创业补贴、青年就业见习、重点群体跟踪服务分组，可在签发或调整授权时选择。部署后台时需一并交付这份 JSON，目录层次与源码保持一致。

目录注册采用幂等增量写入，不扩展已有客户授权，也不重新启用人工停用的系统或事项。已有密钥需由管理员明确调整授权范围才可使用此组件。人社明细及大屏统计保留桌面本机；后台不采集人社记录，不向人社组件开放企业补全或阿里云查询权限。本轮仅进行本地开发及测试，未更新生产后台。

## 深圳危化品回流组件

目录新增独立系统 `shenzhen-hazardous-chemicals`（深圳市危险化学品安全生产风险监测预警系统），与桌面端共用 `src/plugins/shenzhen-hazardous-chemicals/matter-catalog.json`。包含危险化学品经营许可新领、延期、变更、注销和第三类非药品类易制毒化学品经营备案五项业务。部署目录注册代码时须一并交付这份 JSON。

注册目录仅新增系统和事项元数据，保留人工停用标记，也不会自动增加已签发许可证的权限。后台管理员可以在签发授权或“授权详情 → 调整授权”中明确选择系统和事项；桌面端随后按原有签名授权和设备校验刷新权限。此系统的缺失企业资料可使用既有企业补全接口，仍要求有效签名、正常设备和具体事项权限，并沿用缓存优先、付费查询开关及限额。

## 企业信息管理

企业库由政务、大件运输、网约车车证及卫健工具共用。原系统/本地已有法人和有效信用代码的记录不请求后台；缺项时先查后台企业库，仍未补齐且付费查询已开启时，由后台自动查询阿里云（名称优先、有效信用代码兜底），完成后才保存回流结果。后台配置 `ALIYUN_ENTERPRISE_APPCODE`，由超级管理员开启付费查询；桌面配置 `DATA_FUSION_ENTERPRISE_URL`。缓存命中不消耗阿里云额度；新企业可能触发付费请求，具有去重、并发/分钟限额及失败冷却。生产密钥不写入仓库，配置后需重启相应进程。

完整规则、部署、回填时机与边界见 [统一企业信息管理](../docs/17-enterprise-management.md)。本轮没有调用真实付费接口或迁移真实数据库。

## 回归验证

```powershell
npm run test:admin
npm run admin:web:build
npm run typecheck
npm test
npm run build
```

后台接口测试使用临时 RSA 密钥及内存/唯一临时测试数据库，绝不连接现有 `admin-server/data/admin.sqlite`。覆盖目录迁移、多设备/换机、一次性码重试、客户停用、离线补发/续期、权限、Cookie、登录限流、审计分页和版本选择。CI 运行后台接口测试和前端构建。

## 托管桌面版本发布

超级管理员可上传 `数据融合助手-安装包-<数字.数字.数字>-x64.exe`（最大500MB），兼容旧的 `DataFusion-Setup-<版本>-x64.exe`。服务器以流式方式计算SHA256并验证Windows PE及NSIS结构标记。中文名在公开URL、HTTP下载文件名和OSS V4签名中使用UTF-8编码；存储名仍使用服务端UUID。上传是未发布草稿；发布/停用仍需要当前管理员密码确认。结构检查不是杀毒扫描或Windows Authenticode签名，也不把未知EXE认定为可信来源。

安装包保存在数据库旁的 `releases/`，不进入代码或管理网页静态目录；可配置 `ADMIN_UPDATE_DIRECTORY`。公开下载源使用 `ADMIN_UPDATE_PUBLIC_ORIGIN`，默认继承 `ADMIN_PUBLIC_ORIGIN`，只接受固定完整HTTP/HTTPS源且不信任请求Host。保留HTTP管理后台时，可仅为更新源配置有效HTTPS，并代理 `/api/releases/` 和 `/api/updates/manifest`；旧桌面只接受HTTPS安装包URL。

API和代理要求见 [生产说明](../docs/18-admin-production.md#桌面安装包托管及版本发布2026-10-29)。实际安装包离线联调命令：`node scripts/verify-update-release-pipeline.mjs release/<version>/数据融合助手-安装包-<version>-x64.exe`，使用一次性RSA、临时测试库和本机HTTP服务，不连接生产。
