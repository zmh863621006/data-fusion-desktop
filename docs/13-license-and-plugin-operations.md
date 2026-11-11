# License 与发行操作

## 授权模式

### 在线激活

管理员后台为客户创建 License，选择允许使用的业务系统和功能，并生成一次性在线激活码。客户端向授权后台提交激活码和设备标识，后台绑定设备并返回签名 License。

在线授权支持后台停用设备、启动时刷新授权、获取签名更新清单和自动更新主程序。

### 离线激活

离线设备在激活页提供完整设备码。管理员后台选择客户、系统、功能和有效期后，生成绑定该设备的 `DFL1.` 授权文件。客户端只在本地用公钥验签，不请求互联网。

离线授权不支持自动更新。新增系统或升级程序时，由管理员人工安装签名的新版本；本地业务数据保持不变。

## 系统授权

`allowedSystems` 决定工作台可见和可用的业务系统，`allowedMatters` 可进一步限制系统内事项。业务组件代码统一随主程序发布，不允许终端用户动态安装代码插件。

## 密钥原则

- 私钥只部署在授权后台或保存在发行方离线设备中。
- 私钥禁止提交 Git、复制进桌面安装包或放进网站静态目录。
- 桌面客户端仅内置公钥。
- 测试密钥与生产密钥必须分开。

## 本地签发工具

```bash
npm run keys:generate -- private/license-private.pem private/license-public.pem
npm run license:issue -- grant.json private/license-private.pem customer-license.txt
```

## 管理后台

后台代码位于 `admin-server/`。首次启动：

```powershell
$env:ADMIN_INITIAL_PASSWORD = '替换为至少10位的强密码'
$env:ADMIN_LICENSE_PRIVATE_KEY = 'D:\secure\license-private.pem'
npm run admin:start
```

详细部署配置见 `admin-server/README.md`。
