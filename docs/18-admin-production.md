# 管理后台上线配置

## 本次登录与权限规则

- 登录必须先取得一次性 PNG 图片验证码，2 分钟有效，提交即失效，刷新后旧验证码失效。
- 同一账号在 15 分钟窗口内连续输错 5 次，锁定完整 15 分钟；验证码错误不扣密码尝试次数。成功登录重置该账号计数。未知账号使用相同提示和密码计算路径。
- 来源 IP 在 15 分钟内累计 30 次密码失败也会受限；登录请求每 IP 每分钟最多 60 次，验证码每 IP 每 5 分钟最多 60 张。计数保存在 SQLite，重启服务不清空。代理后的同一公网出口共享来源限额。
- 新密码 12–128 位，至少包含大写、小写、数字、符号中的三类。旧账号登录后须升级密码才能执行管理写操作；升级会清除该账号的全部会话。
- 会话最长 8 小时，闲置 30 分钟过期，每账号最多 5 个会话。“账号与安全”支持退出其他会话、查看来源和时间；超管可查看安全日志及解除账号锁定。IP 触发的保护须等待窗口结束，账号解锁不会清除整个来源 IP 的计数。
- 登录页不再提供“记住登录”或七天自动登录。使用标准登录表单（`method=post`，稳定的账号/密码字段名称，`autocomplete=username/current-password`），由浏览器原生密码管理器决定是否提示保存和自动填充；本应用不在 localStorage、Cookie 或其他自建存储中保存明文密码。成功登录需账号密码和一次性验证码，会话过期后返回登录页，不静默恢复。是否弹出保存提示取决于浏览器设置、隐私模式和站点安全策略；HTTP 页面可能受浏览器额外限制。
- 升级启动时清空旧 `admin_remember_devices` 凭据，并撤销带 `remember_device_id` 的衍生会话，普通会话、账号密码与业务数据不变。旧客户端的 `POST /api/admin/session/restore` 仅返回 401 和 `PASSWORD_LOGIN_REQUIRED` 并清除旧 `df_remember` Cookie，不会创建或续期会话；接口保留同源保护和限流。新登录及退出同样清除旧 Cookie。“退出其他会话”、修改密码、角色变更和停用账号继续按原规则撤销普通会话。
- 超管管理账号、业务系统和版本；运营人员管理客户、授权、设备及企业资料；审计账号只读。版本发布和上线/下线还需输入当前账号密码。密码确认失败也纳入账号锁定。
- 登录安全事件记录来源 IP、账号、事件和时间，保留 90 天，定期随请求清理。不会记录密码、验证码答案、Cookie、授权签名或阿里云密钥。操作审计仍保留。
- 数据库迁移只增加表及字段；升级时旧会话清空，需要重新登录。客户、授权、设备和企业资料保留。

图片验证码只能提高自动化尝试成本，需与限流、账号保护、管理入口网络限制共同使用。

## 桌面云端接入与工具独立授权

桌面端默认接入 `http://193.112.96.168:9087` 的激活、签名授权校验、更新清单和企业资料查询接口，环境变量仍可覆盖。只有这个用户指定的 HTTP 源被允许用于企业查询，不放宽其他 HTTP 源或安装包 HTTPS 校验。内置公钥与部署签名密钥对应；桌面端不保存后台管理员账号密码。普通“设置”页仅展示使用偏好、应用更新和本地操作记录，不再展示当前授权或后台连接信息；主进程仍按原规则自动校验在线授权。界面每 30 秒及窗口重新获得焦点时读取本地授权状态，不增加相同频率的联网校验；健康检查成功不等于授权有效。

侧栏、工作台卡片、最近任务、系统组件和原系统标签按有效授权统一过滤，不展示未授权的系统或工具，也不提供“未授权”锁定页入口。主进程的组件清单也只返回已授权系统。仅有工具授权时直接进入工具，不展示工作台、业务系统分组或回流入口；没有可用系统或工具时进入设置。授权缩减后退出已撤销功能的页面和编辑弹窗；授权失效仍回到激活页。隐藏界面不替代主进程的系统、事项、工具和导出权限校验。

`src/core/tools/catalog.json` 是独立工具目录，后台运行代码须同时交付此文件。授权的 `allowedTools` 与 `allowedSystems` 分开签名、存储和检查；两者至少选择一项。可以只签发 `allowedTools: ["health-publicity"]`、`allowedSystems: []` 的在线或离线授权，不会因此开放业务系统。旧授权的工具权限默认为空，不自动扩大已签发的生产授权。要生成表格还须开启 `allowExport`。

卫健局双公示工具位于桌面侧栏“工具”，无需业务系统登录。支持每次 1–50 份 DOCX，单份不超过 20 MB，包含解压大小与 XML 安全限制。原 Word 不修改、不上传；本地 SQLite 单独保存原文、提取依据和手工核对数据，按文件内容哈希去重，最多保留 500 份。移除仅删除本地工具记录，不删除源 Word。导出复用现有行政许可模板列及缺项提示/整行标红规则。

提取时合并标题换行，区分变更前后名称；机构主体的信用代码只从对应申请主体语句获取，不沿用设置单位代码；机构登记号不自动充当许可编号，机构负责人或业务办理人不充当法定代表人。日期仅采用批复机关落款后的明确日期，不能以页尾印发日期代替。许可类别、有效期和注销后的状态无明确依据时留空，须核实补填。许可机关和来源单位信用代码可在工具中统一配置，仅补空值。每个字段均可核对修改，修改不覆盖原文和提取依据。

## 桌面端须同步升级

### 已签发授权的范围调整

“授权管理 → 详情 → 调整授权”支持增减业务系统、独立工具和具体业务事项。修改针对整条授权及其全部绑定设备，不改变授权 ID、客户、在线/离线模式、有效期、设备数量、设备绑定、激活码以及导出等功能开关；不代替续期。新系统必须明确选择事项，不自动授予全部事项，至少保留一个系统或工具。停用/下线内容仅允许保留原有权限或移除，不能新增分配；只读账号没有操作权限。

接口为 `POST /api/admin/licenses/:id/scope`，提交完整的 `allowedSystems`、`allowedTools`、`allowedMatters` 和打开弹窗时的 `expectedScope`。原范围快照必须匹配服务器当前范围；事务中校验并更新三列，避免并发覆盖。冲突返回 409、`LICENSE_SCOPE_CONFLICT`，需刷新重新核对。实际变化记录 `license.scope_updated` 操作审计，包含 before/after 范围；无变化不写变更审计，不记录秘钥或凭据。停用/过期授权及停用客户不能调整。

在线设备下次签名授权校验时取得新的范围，仍使用原设备凭据，不需重新激活。旧版桌面可能需要重启才能刷新菜单；新版桌面会自动按本地授权结果收敛或增加入口。离线授权修改后须补发许可证并在原设备重新导入，已经交付的旧签名文件无法远程改写或即时撤回。历史“全部事项”权限在编辑时列出现有事项并提示，保存后转换为明确事项清单，不包含未来新增事项。

`POST /api/license/status` 现在要求 `{ licenseId, deviceId, proof }`，其中 proof 为原有签名 License。服务校验签名、设备绑定和数据库中的实时授权状态；已过期的签名凭据允许用于管理员续期后的恢复。

更新清单从带标识的 GET 改为 `POST /api/updates/manifest`，请求体同上。原 GET 返回 403；旧客户端无法刷新授权和检查更新。**后台与本次桌面构建应配套交付，上线前先安排旧客户端升级，避免被视为授权失效。** 企业补全的既有签名鉴权保留。

签名 License 在这里是设备绑定的持有凭据；本次未引入硬件设备私钥、挑战签名或抗复制设备认证。所有外网接口必须通过 HTTPS 访问，客户端签名凭据不得进入页面或日志。

## Linux 参考部署

麒麟 DEB 发布校验需要系统 `tar`，标准 XZ 压缩包还需要 `xz-utils`。专用容器运行镜像见 `admin-server/deploy/admin-runtime.Dockerfile`：锁定已验证的官方 Node24 Debian12 RepoDigest，只安装 `xz-utils` 及其必要依赖，最后以 UID/GID `18087:18087` 运行。默认使用腾讯云 Debian 镜像源，保留原 Debian 官方 keyring 和签名验证；未使用 `trusted=yes` 或关闭签名检查。APT 使用20秒连接超时、1次重试，更新源任一错误都会停止构建。

在仅包含部署文件的目录构建，避免把业务数据或密钥发送为 Docker build context。构建命令也应设置总时限，例如 `timeout 300s docker build --iidfile runtime-image.id -f admin-server/deploy/admin-runtime.Dockerfile -t data-fusion-admin-runtime:1.0.22-node24-xz admin-server/deploy`。不要在应用启动时安装依赖，也不要通过修改运行中容器替代可重建镜像。

候选镜像先在无网络、只读根文件系统、UID18087下确认 Node、tar、xz，再只读挂载正式 DEB 调用实际部署的 `validateDebPackage`。完整发布链路测试使用独立可写临时目录，不挂载生产 `/data`、环境文件或签名私钥，不映射端口。通过后将不可变镜像 ID 写入 `/etc/data-fusion/runtime-image.env`，格式见 `admin-server/deploy/runtime-image.env.example`；文件只保存镜像标识。启动示例会在未显式提供 `NODE_IMAGE` 时读取此配置，并在启动前检查 Node/tar/xz 可执行。

实际 `/opt/data-fusion/start-http.sh` 是首次部署入口，检测到已有后台或代理会拒绝执行。更新运行镜像时只重建后台容器，保留原挂载、用户、只读根目录、网络静态IP、环境、资源限制、日志和健康检查，代理容器不动。旧容器配置和镜像 ID须先保存到受限备份目录，不能将完整 inspect 环境打印到日志；失败时以旧镜像和原参数恢复。

推荐 Node.js 24 LTS、Nginx、单个后台进程。当前 SQLite 和企业批次状态按单进程设计，不要直接配置 PM2 cluster 或多副本。支持在 Windows 使用相同环境变量启动；Nginx/systemd 模板为 Linux 示例。

1. 构建：`npm ci`、`npm --prefix admin-server/web ci`、`npm run admin:web:build`；客户端另执行 `npm run build`。运行后台只依赖 Node 内置模块，但需保持目录结构，包含 `admin-server/*.mjs`、`admin-server/public/` 和 `src/plugins/government-info/matter-catalog.json`。若使用 npm 启动或备份脚本，也须交付根目录 `package.json`。
2. 创建专用低权限服务用户 `data-fusion`，代码放 `/opt/data-fusion`，数据目录 `/var/lib/data-fusion`。代码目录只读，数据目录仅服务用户可写。
3. 将 `admin-server/.env.example` 的值填入 `/etc/data-fusion/admin.env`。私钥放 `/etc/data-fusion/license-private.pem`，配置文件和私钥只允许服务用户及管理员读取。首次建库使用独有强密码；确认账号建立后移除 `ADMIN_INITIAL_PASSWORD`。初始密码变量不能重置已有账号。
4. 生产模式强制配置 `ADMIN_COOKIE_SECURE=true`、`ADMIN_PUBLIC_ORIGIN=https://实际域名`、数据库路径及私钥路径。源地址不含路径和结尾 `/`。
5. 按 `admin-server/deploy/data-fusion-admin.service.example` 安装服务。`ADMIN_HOST=127.0.0.1`，8787 端口仅本机可访问，公网仅放通 HTTPS。
6. 修改 `admin-server/deploy/nginx.conf.example` 中域名、证书路径，并在三个管理 location 配置办公室/VPN 的真实固定出口 IP；模板默认拒绝外部访问管理页面。公网客户端 API 独立开放。执行 `nginx -t` 后再启用。
7. `ADMIN_TRUSTED_PROXIES` 只填写实际直连 Nginx 的 IP，如 `127.0.0.1,::1`。Nginx 必须覆盖 `X-Real-IP`。未经信任的直连请求伪造转发头无效。多层代理/CDN 需要在 Nginx 校验其来源后恢复真实 IP，不能直接信任用户提供的头。

不要将 `admin-server/data`、私钥、环境文件、开发 `.tmp` 文件、测试凭据打包到静态站点或客户端。后台只映射 `admin-server/public`，Nginx 不应把整个项目设为静态 root。正式环境使用生产构建，勿暴露 Vite 开发服务器。

## 备份、回退与验收

- 上线前备份完整 SQLite 和签名私钥。服务运行时使用 SQLite 在线备份；停服且连接关闭后可复制数据库。不要在运行中只复制主文件而遗漏 WAL。
- Node.js 24 可运行 `npm run admin:backup -- /站点之外的安全目录/admin-备份日期.sqlite` 生成在线一致性快照，已存在的目标文件会被拒绝覆盖。该命令读取 `ADMIN_DB_PATH`，未配置时使用本地默认库；生产运行前确认其指向正式库。签名私钥需另外安全备份。
- 备份放在站点之外并加访问控制；定期演练恢复。升级回退时先停服务，再恢复对应数据库快照与旧版本文件，不要覆盖运行中的数据库。
- 先用测试库验证：验证码刷新/失效、第五次密码错误锁定、锁定跨重启保留、正确密码登录、修改密码后旧会话退出、运营账号无法发布版本、超管密码确认、设备撤销后的客户端拒绝访问。
- 正式域名检查：HTTPS 证书有效，`df_admin` 和 `df_challenge` Cookie 带 `Secure`、`HttpOnly`、`SameSite=Strict`；跨站写请求拒绝；管理入口 IP 白名单生效；8787 公网不可直连；`/api/health` 返回 `{"status":"ok"}`。
- 启动后在“账号与安全 → 登录安全日志”核对来源 IP，避免代理 IP 被错误当作所有用户。测试外网激活、授权刷新、企业查库和更新流程时只使用测试授权。
- 意外 500 响应带请求编号，服务日志按 `x-request-id` 对应排查。代理和日志平台同样不得记录 Cookie、请求体中的凭据或付费服务密钥。

本地验证不能代替服务器的证书、防火墙、访问名单及备份恢复检查。发布前须在实际部署环境完成本节验收。

## 用户明确选择 IP + HTTP 时

仅在明确选择 HTTP 的部署中设置 `ADMIN_ALLOW_INSECURE_HTTP=true`、`ADMIN_COOKIE_SECURE=false`、`ADMIN_PUBLIC_ORIGIN=http://实际IP:端口`。此模式仍使用 `NODE_ENV=production`，默认须填写 `ADMIN_MANAGEMENT_ALLOWED_IPS`（明确的管理人员公网出口 IP，逗号分隔）。如果明确要求任何 IP 均可访问登录页，设置 `ADMIN_MANAGEMENT_PUBLIC=true` 并同步将反向代理的管理入口改为 `allow all`。应用会优先采用这个显式公开设置，管理数据和写接口仍然要求正常登录及角色权限。

HTTP 没有传输加密，IP 白名单不能替代加密。登录密码、会话、签名授权均可能被链路上的第三方读取，服务不会把此模式标记为 HTTPS 或设置无效的 Secure Cookie。切换 HTTPS 时关闭该例外，更新源地址并恢复 `ADMIN_COOKIE_SECURE=true`。

## 桌面安装包托管及版本发布（2026-10-29）

新增 `admin-server/update-releases.mjs`。数据库仅加法新增 `update_artifacts`，不替换原更新、客户、授权、设备或企业表。旧HTTPS外链版本仍可查询、发布/停用；新上传不覆盖同版本或旧产物。

1. 上传：`POST /api/admin/updates/upload?version=1.0.3&filename=DataFusion-Setup-1.0.3-x64.exe`，Body直接为File/二进制流，`Content-Type: application/octet-stream`。沿用登录、CSRF及管理入口保护，只限超级管理员；单管理员每小时12次、同时最多2个上传、10分钟总时限、60秒网络空闲时限、500MB上限。常规JSON接口仍保留1MB和30秒总读取时限。
2. 说明：推荐 `x-release-notes-base64` 头保存UTF-8标准base64，解码后不超过1000字符；兼容查询参数 `notes`，但中文长说明应使用头，避免Nginx请求行长度限制。可选 `x-content-sha256` 用于客户端预计算摘要，服务器始终自行计算并核对。
3. 校验：流式写临时文件、固定内存前缀检查MZ/PE、扫描NSIS标记、校验声明长度和可选摘要；只保存受控UUID文件名。结构检查不是杀毒或代码签名，发布者须使用可信构建产物。取消、超时、账号撤销、无效内容和写入失败清理本次临时文件及未发布记录，不清除旧版本。
   若服务进程崩溃，超过上传总时限加2分钟后，管理员重新上传同版本可回收该条从未完成、从未发布的旧占位和部分文件；ready草稿或曾经发布过的版本绝不因此替换。回收写操作审计，不在启动时扫描删除其他文件。
4. 上传返回201版本记录，含 `id/version/url/sha256/bytes/fileName/managed/status`；成功是 `draft`、`enabled=0`，尚未对外提供下载或进入签名清单。后台bootstrap的updates数组包含这些附加字段；处理中为 `uploading`。
5. 发布/停用：沿用 `PATCH /api/admin/updates/:id`，Body `{enabled:true或false,confirmPassword:当前密码}`。发布前重新流式核对磁盘SHA256；人工操作等待校验完成，避免迟到发布覆盖另一发布动作。发布为 `published`，停用为 `disabled`。不接受通过上传接口替换同版本内容。
6. 客户端清单：保留已签名POST设备凭据鉴权，按最高启用稳定版本选择；托管产物增加 `id/bytes/fileName/installer:'nsis'/platform:'win32'/arch:'x64'`，旧版本客户端可忽略新增字段。更新清单固定使用原产品RSA私钥，不新建生产签名密钥。
7. 公共下载：`GET/HEAD /api/releases/:id/DataFusion-Setup-<version>-x64.exe`，只限ready且已发布记录；支持单Range、If-Range和ETag，不提供目录浏览、任意路径或未发布文件。停用后阻止新下载，但保留原产物用于恢复/审计。路径与存储名不从用户文件路径推断。

`ADMIN_UPDATE_DIRECTORY` 默认数据库同级 `releases/`（如 `ADMIN_DB_PATH=/data/admin.sqlite` 则为 `/data/releases`），应落在服务账号可写的数据挂载内、站点之外。`ADMIN_UPDATE_PUBLIC_ORIGIN` 是独立的完整源（例如 `https://193.112.96.168`），未设置则继承 `ADMIN_PUBLIC_ORIGIN`；不能含路径、凭据、query或末尾斜线，不能取请求Host。有效HTTPS更新入口可与HTTP管理入口并存，不需要把管理后台也搬到HTTPS。

### 阿里云 OSS 更新分发（2026-10-29）

生产后台已接入 `admin-server/update-oss.mjs`，复用“检查当前项目”中既有深圳区域私有 Bucket `shenzhen-sjrh`，新建独立目录 `data-fusion/updates/`。安装包对象位于 `data-fusion/updates/windows-x64/<版本>/DataFusion-Setup-<版本>-x64.exe`。客户端不携带 OSS Secret；后台授权及 RSA 签名更新清单仍由原 HTTPS 入口提供，安装包直接从 OSS 下载。

后台从安装包目录的上一级读取 `update-oss.secure.json`，本机生产路径是 `/var/lib/data-fusion/update-oss.secure.json`，容器内为 `/data/update-oss.secure.json`。字段为 `endpoint`、`bucket`、`prefix`、`accessKeyId`、`accessKeySecret`、可选 `securityToken`。该文件由服务用户持有，权限0600，不能提交、打包或放入公开目录；首次配置后需重启后台加载。未配置时继续使用服务器本地分发。

上传阶段先完成原有 EXE/NSIS、长度和 SHA256 校验，再流式上传私有 OSS 对象，检查 MD5、对象长度及 SHA256 元数据，全部成功才完成草稿。对象禁止覆盖；相同版本同一内容可复用，冲突拒绝发布。镜像失败或等待期间账号撤销时，不产生可发布的本地草稿。发布仍需超级管理员密码确认；已发布版本再次确认发布可将已有服务器产物关联到已经上传的相同 OSS 对象。

`update_artifacts` 仅加法新增 `oss_key`。草稿不下发 OSS 下载令牌，发布后更新清单按对象签发至少23小时有效的 GET 地址；客户端每4小时重新检查，下载超时10分钟，安装前重新校验授权与发布状态。已签发的 OSS 链接在到期前可能仍可下载，停用版本后不再下发新链接。临时链接和 AccessKey Secret 不得进入日志。

旧 `/api/releases/...exe` 地址继续提供本地兼容下载。给同事分享时，可在地址后加 `?download=oss`，后台以不缓存的302响应跳转到新签发的 OSS 链接；大文件流量不经过腾讯云。客户端更新清单直接使用 OSS 地址，无需跟随重定向或重新打包桌面应用。

1.0.6已完成真实私有上传、无签名访问拒绝、Range、完整下载SHA256及原桌面更新代码的联调。后台仅窄部署两个分发模块，数据库在线一致性备份位于 `/var/lib/data-fusion/backups/update-oss-20261029-a1/`，业务表校验不变。验证报告位于 `private/deploy/update-oss-20261029/`，报告不含密钥或临时签名URL。

Nginx需给上传精确location放宽至 `client_max_body_size 500m; client_body_timeout 60s; proxy_request_buffering off; proxy_read_timeout 600s; proxy_send_timeout 600s;`，并保留同样管理入口限制/限流。其他JSON接口继续1MB。下载 `/api/releases/` 使用流式代理、`proxy_buffering off; proxy_read_timeout 600s; send_timeout 600s;`。HTTPS更新入口应只增加所需路径，保留已有站点和证书配置；参考配置在 `admin-server/deploy/`，不可直接覆盖线上配置。

专用测试覆盖草稿/密码确认、角色及CSRF、固定HTTP/HTTPS源和Host注入、文件结构、摘要、尺寸、并发、取消/超时、登录撤销、Range/ETag、迁移幂等与旧HTTPS外链兼容。`scripts/verify-update-release-pipeline.mjs` 可用实际约117MB安装包验证流式上传→发布→签名清单→完整下载SHA→Range，全部在临时本地库中完成，不执行安装器、不调用生产或付费服务。
