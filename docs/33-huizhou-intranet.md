# 惠州政务内网部署改造

分支：`codex/huizhou-intranet`，基于已发布 1.1.11 的 `930cf9d`。2026-11-26 已在惠州政务云部署独立后台，管理入口为 `https://sjrh.hzszsj.cn:10001/fusion-assistant/`；原域名首页保留。源码根 `package.json` 版本仍是基础包版本，不用它冒充新的业务发布版本。深圳更新通道和腾讯后台未变更。

## 内网后台与存储

后台使用 Node 24、SQLite/WAL；当前模块运行依赖按实际导入完整交付，管理网页预构建。惠州业务记录直接以 JSON 接口上传、入库，不生成或上传 Excel 中间文件。后台是独立实例，业务数据库、更新 ASAR 和安装包保存在惠州服务器的数据盘。运行镜像已离线导入并在实际服务器验证 Node 24.22.0、SQLite 3.53.4、tar/xz 和非 root 只读容器运行。

复制 `admin-server/deploy/huizhou-intranet.env.example` 到服务器私有配置目录，填写真实内网 HTTPS 域名、管理来源、证书、签名私钥和数据库/文件路径；容器部署时改成容器内挂载路径，`ADMIN_HOST=0.0.0.0` 仅在私有容器网络使用。Node 服务不直接发布公网端口。代理示例为 `nginx.conf.example` 或已有容器的 `docker-http-nginx.conf.example`；外层 HTTPS 入口仍需要正确配置。

首次启动空库前另在私有环境设置强密码 `ADMIN_INITIAL_PASSWORD`（可选 `ADMIN_INITIAL_USERNAME`），建立管理员后不把初始密码放进交付文件。配置企业 APPCODE 后，还需在企业信息页按实际需求开启付费补全；只填写密钥不等于已启用或已验证接口额度。

`ADMIN_DEPLOYMENT=huizhou-intranet` 默认启用本地更新存储和业务接口接收，并拒绝显式 OSS 更新模式、外部更新源或启用深圳工商 OSS 导入。惠州不会初始化旧一窗 Excel/OSS 上传服务，其旧文件接口不可用。`ADMIN_BUSINESS_LOCAL_FEED_BASE` 只接受后台同源 HTTPS 目录；`/business-updates/` 必须与代理规则一致。普通默认部署保持既有行为。

`/business-updates/` 是签名程序文件下载入口，不受管理页 IP 白名单限制；内容不能夹带业务库、会话或密钥。`/api/returns/` 上传请求逐次检查设备签名授权；业务数据管理接口始终需要管理员登录，管理来源限制作用于 `/api/admin/`。

## 发布与客户端隔离

惠州构建显式启用持久上传队列，标准构建不启用，也不会自动将深圳用户台账上传到其他后台：

```sh
npm run build:huizhou
npm run build:huizhou:win7
```

构建分别进入 `out-huizhou/`、`out-huizhou-win7/`，不覆盖标准 `out/`、`out-win7/`。使用现有 `scripts/build-business-payload.mjs`，指定相应 `--source`、新的业务版本、实际目标平台/架构/Electron版本、惠州 `--backend-origin` 和 `--backend-revision`。例如下列命令只是参数示意，示例域名不能发布给用户：

```sh
node scripts/build-business-payload.mjs --version 1.2.0 --platform win32 --arch x64 --variant standard --electron-major 44 --source out-huizhou --backend-origin https://fusion.example.invalid --backend-revision 1
```

固定启动器由现有 `scripts/stage-business-shell.mjs --payload <payload.json> --deployment huizhou-intranet --feed-base https://<实际内网域名>/business-updates/` 生成。Windows兼容通道和麒麟目标需使用各自现有打包流程，不能将一个目标包直接标成其他架构。惠州包与深圳包使用独立发布目录和清单，不在深圳通道上传惠州构建。现有深圳启动器不会自动转入惠州，首装需交付惠州专用基础包。

惠州基础包使用独立 appId `cn.zzkj.datafusion.huizhou.desktop`，Windows 进程 `HuizhouDataFusion.exe`、默认安装目录 `%LOCALAPPDATA%\Programs\HuizhouDataFusion`、快捷方式“惠州数据融合助手”，以及 `huizhou-data-fusion-desktop` 资料目录（Win7/22 带 `-win7` 后缀）。麒麟包名为 `huizhou-data-fusion-desktop`，安装到 `/opt/huizhou-data-fusion`，使用独立桌面入口和图标。不自动迁移、清空或读取深圳资料及 pending。冻结的 1.2.0 业务 ASAR 保持原字节，受信固定壳向其内部提供正确的资料目录；Windows 业务 main 加载后恢复惠州 AppUserModelId。

管理端以受信 `bootstrap.deployment` 区分安装器身份，惠州上传要求专用文件名、Windows 真正 PE 产品名和 DEB 包名/路径/桌面入口/图标/固定壳元数据。内部 Win7 组件不作为正式下载通道；Windows 通道发布包含两种运行时的兼容通用安装器。同版本同目标不可替换。标准深圳部署保留原默认身份校验。

管理后台支持本地业务包上传、发布和下载：保留 RSA-SHA256 签名、SHA256、目标与版本检查、后台地址修订和发布租约；本地清单与发布状态在同一 SQLite 事务提交，异常退出不会露出未发布草稿。ASAR 是只读文件，读取前检查文件身份、大小、摘要和路径。惠州部署还拒绝后台地址不匹配的业务包。当前强制版本不能直接下线，修复通过更高版本发布。

## 回流上传协议

惠州客户端在本地回流数据事务中，同时保存不可变的待传快照。后续网络请求不占用本地业务事务。上传队列按后台源、客户、许可证和设备绑定，不随激活切换重新归属；明文 proof、Cookie、原系统登录凭据不进入队列或后台业务表。

后台显式开放 `GET /api/returns/capabilities`。客户端收到启用标记后依次执行：

1. `POST /api/returns/batches`：提交本地批次 ID、系统、事项、起止时间与行数。
2. `POST /api/returns/batches/:id/chunks`：不可变序号分块，返回该块 SHA256。
3. `POST /api/returns/batches/:id/complete`：提交有序分块摘要清单。只有连续序号、摘要和总行数全部匹配，后台才原子标记完成。

三类请求均带当前设备签名授权，检查活跃客户、设备、许可证、系统及事项权限；进入写事务时再次校验实时权限。记录上传与本机文件导出是独立权限边界，合法业务记录无需先导出文件。相同批次/分块重传幂等，不同内容冲突；完成批次不可改写。空结果也有独立的已完成零行批次，不能以没有数据包误判上传失败。

每批最多50,000条、256MiB；每块最多100条、请求最多1MiB，客户端按约768KiB分块；单行最多128KiB、JSON嵌套最多32层。超过上限的批次保留本地并显示需处理，不静默丢弃。网络错误指数退避，退出保留未确认数据，重开继续；只有完成回执与数量一致才删除待传副本，原本机台账保留。权限撤销或内容冲突需处理后点击“立即重试”。

客户端“后台数据同步”显示待传、已传和需处理批次数。历史补传由用户显式触发，只读取当前授权可见的已完成任务，跳过任何已经归属其他授权/后台或已捕获的任务。旧版本没有归属信息的历史任务，用户须先确认属于当前客户；不会在新安装时自动上传全部旧台账。旧任务输出缺失或超出原导出上限时需先核对本地记录，不能伪造完整历史批次。

惠州一窗也使用 `deliveryMode='records'`，采集后直接进入同一 JSON 队列，不计算工作簿、不生成文件、不调用旧 Excel 推送器。页面按持久队列展示记录同步状态，重试只操作数据接口。旧深圳默认 `deliveryMode='workbook'`，兼容已有行为；惠州不会触发该路径。

## 管理端数据

“回流数据”支持客户、设备、系统、事项、接收日期、状态和关键词筛选。统计使用全库 COUNT，列表和详情分别分页。详情直接展示入库的业务字段，React转义文本；切换批次会取消/忽略过期请求。已完成批次可选下载原始 JSON 供核对，这不是上传媒介。正在接收的批次不会显示为已完成或允许完整批次下载。只读管理员沿用现有管理端只读权限。

业务数据保存在 `return_batches`、`return_batch_chunks`、`return_batch_rows`，审计记录不包含原始明细和授权 proof。批次按照客户、许可证、设备及本地任务 ID 绑定，不能用其他客户的批次 ID 上传或重新归属。

## 阿里云与备份

沿用 `ALIYUN_ENTERPRISE_APPCODE`，由部署人员在惠州后台私有环境配置同一实际值。它是企业补全接口的 APPCODE，不是 OSS AccessKey；不进入客户端、发布包或 Git。后台先查本地企业库，需要付费补全时才访问既有阿里云 HTTPS 企业接口。内网更新和用户回流留在政务内网；企业补全仍依赖获准的出口和接口额度。未用真实密钥发起付费测试。

备份须同时涵盖 SQLite 一致性快照、业务更新 ASAR、私有环境配置和签名密钥；只把同机目录复制称为本地备份，不能当成异机灾备。回退代码前备份当前业务库，优先回退代码和发布版本，不覆盖运行中新增回流记录。本次数据库迁移均为加法，旧业务数据不被清空。

## 验证与上线界限

本分支验证覆盖持久队列重启/响应丢失、分块摘要和幂等、撤权、客户隔离、管理查询和下载、本地更新发布/恢复，以及原 OSS 回归。管理页以合成数据完成桌面和移动实际渲染验证。

2026-11-26 接口版验收：Vitest 131个文件/1,126项通过，后台168项、启动器与业务打包50项、离线服务打包5项通过；TypeScript、管理网页及惠州常规/Win7编译通过。管理网页实际验证尺寸1520×1000、390×844。一窗records专项覆盖503条记录、空批次、事务失败回滚、重启与重试，验证不会生成Excel。用户明确采用直接接口上传后，原先准备的文件上传候选包作废，按 JSON 路径重新验证。打包回归中发现上游ASAR创建函数在写流结束前返回的问题，已在计算包大小和摘要前等待写流完成，并增加延迟写入回归。

离线后台包使用 `node scripts/package-huizhou-server.mjs --output release/huizhou-intranet-server-api-20261126` 生成；包含实际管理网页、后台模块、所需业务目录JSON、纯JS运行依赖、部署样例与SHA256清单。输出目录拒绝覆盖不同内容，不在服务器启动时安装依赖。候选包不含真实环境文件、密钥、业务库和用户会话；`server-package.json` 可用于逐文件核验。

接口版候选包曾移到项目外独立启动验证；实际服务器另以隔离临时库完成 503 条 JSON 记录、6 分块、幂等、分页、设备签名拒绝及管理员保护验收，不往生产库放合成业务记录。正式 HTTPS 已验证健康200、管理接口未登录401、接收能力启用、旧一窗Excel接口404及原首页字节未变。

## 实际部署与运维

后端在 `192.168.71.58` 的独立容器 `huizhou-fusion-admin`，数据根 `/srv/data/huizhou-fusion-assistant`，配置与私钥放在 `/etc/huizhou-fusion-assistant`。沿用原 `192.168.71.39` TLS 入口及 `*.hzszsj.cn` 证书，仅新增助手路径代理。后端 `19087` 只绑定业务网地址，专用 Docker 网络和 DOCKER-USER 规则只允许 `.39` 访问；已从另一政务主机验证无法直连。原 Java 服务及其他应用未重启。

容器使用非 root UID/GID 18087、只读根目录、只读代码/私钥挂载、cap-drop ALL、no-new-privileges、1 CPU/1GiB/128 PID限制、日志轮转和 unless-stopped 重启。SQLite 每日03:45做一致性同机备份，由 systemd timer 管理；这不代替异机灾备。切换新版代码前先做在线快照，旧容器/代码保留用于回退，不以旧快照覆盖新增业务。

正式业务版本1.2.0、后台修订1，五路签名 ASAR 已在内网发布，并完成实际 TLS 下载、RSA 签名及 SHA256 验证。基础包最终目录为 `release/huizhou-intranet-1.2.0-isolated`；原原型目录的壳/安装器已标记作废，其五路原业务 ASAR 仍有效。新固定壳在本机分别以 Electron44/22 加载业务代码，实际检查页面、IPC、SQLite、JSON队列、默认资料隔离、最终appId和旧深圳pending哨兵保留；通用器只做 `/CHECKOS` 无安装检查。Windows安装器尚未做 Authenticode 签名。

四个完整安装器通道（Windows兼容通用、麒麟x64、ARM64、海思990）也已通过真实管理API上传、密码确认发布、无跳转的完整HTTPS下载、SHA256和断点下载验证。正式数据目录保留4条安装器及5条业务更新发布记录。后台页面最后修订 `20261126-huizhou-web-r3` 已在正式域名完成1520px、390px、360px只读渲染验收，无页面横向溢出、外联或渲染错误。

阿里云企业 APPCODE 已沿用并在管理API启用，部署期间未发起付费企业查询。管理员凭据和验证证据位于 ignored 的 `private/deploy/huizhou-20261126/`，不进入 Git 或安装包。生产初始为空客户/授权/设备/回流，真实用户需由管理员配置相应授权。

尚需实际终端的小范围真实业务回流和持续容量观察。Win7操作系统、麒麟x64/ARM64/海思990硬件未做实机验收；构建、结构和本机运行检查不等于这些目标设备验收。

本轮独立身份改造验证：后台172项、固定壳与打包55项、TypeScript及管理网页构建通过。全量Vitest其余1,135项通过，1项安装交接测试在并行构建期间达到5秒上限；该完整测试文件单独复跑30项全部通过。正式页面验收发现并修复窄屏通道选择控件溢出，生产构建已在360px、390px和桌面宽度复验。
