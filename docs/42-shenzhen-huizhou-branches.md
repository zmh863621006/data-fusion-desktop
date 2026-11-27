# 深圳主线与惠州同步

按2026-11-28用户确认，后续主要在 `codex/shenzhen-establishment-oss` 开发功能，再将源码合入 `codex/huizhou-intranet`。两套部署共用实现，分别构建和发布。

## 本次共同基线

检查发现最近深圳1.1.16功能提交实际位于惠州分支，深圳分支仍停在1.1.11。此次先将深圳分支快进到已存在的 `4e1cb5e` 共同基线，不重写历史、不丢弃惠州改造。该基线同时支持标准深圳模式与惠州模式，默认标准构建仍使用深圳配置。后续提交遵循上面的主线到下游方向。

本次已包含房屋租赁绑定、深圳一体化办理过程、人社会话初始化、F12、账号配置、系统名称/图标及断网补查等改动。已经在深圳发布的安装包不是惠州发布包，源码包含功能不代表惠州现网已升级。

## 每次同步

1. 在干净且无其他会话占用的深圳分支开发、测试、提交。
2. 切换惠州分支，合并深圳分支，解决部署差异；保留合并记录。
3. 检查惠州 JSON 上传队列、一窗 records 模式、后台目录和授权范围、同源内网更新及独立安装身份。
4. 分别构建和验收；需要上线时走各自后台的正常发布流程，验证签名、完整下载和版本选择。

```sh
git switch codex/shenzhen-establishment-oss
# 开发、检查并提交功能
git switch codex/huizhou-intranet
git merge --no-ff codex/shenzhen-establishment-oss
npm run build:huizhou
npm run build:huizhou:win7
```

## 部署差异

| 项目 | 深圳 | 惠州 |
| --- | --- | --- |
| 构建模式 | 标准构建 | `huizhou-intranet` |
| 更新及安装包 | 既有腾讯云后台/OSS通道 | `https://sjrh.hzszsj.cn:10001` 同源政务内网 |
| 业务输出 | 保持深圳既有流程 | JSON分块上传、入库及持久重试 |
| 产物目录 | `out/`、`out-win7/` | `out-huizhou/`、`out-huizhou-win7/` |
| 安装及资料目录 | 深圳原身份 | 独立惠州身份，不读取深圳pending |
| 发布版本 | 目前1.1.16 | 已发布1.2.0，后续独立递增 |

不能把深圳ASAR只改版本号后发布到惠州：是否启用JSON队列和一窗records模式由构建期部署标志决定，必须重新执行惠州构建。后台域名、修订号、目标架构、最低基础版本和内网feed也必须显式校验。两套生产数据库不参与代码合并。

可用 `scripts/build-huizhou-release.mjs` 构建五路业务包和四路正式安装器。它只使用本地已准备的运行时，明确固定源码提交、惠州模式、目标及独立身份，拒绝覆盖旧产物或采用深圳/OSS更新源，不登录或发布服务器。例如在已提交、合并后的惠州分支上执行：

```sh
node scripts/build-huizhou-release.mjs --version 1.2.1 --min-shell-version 1.2.0 --backend-origin https://sjrh.hzszsj.cn:10001 --backend-revision 1 --feed-base https://sjrh.hzszsj.cn:10001/business-updates/ --expected-commit <完整提交ID> --output release/huizhou-intranet-1.2.1
```

本次针对深圳一体化新增真实持久队列集成检查：共享本地台账的两种授权事项分别生成惠州JSON批次，保留原事项ID、客户/设备归属和完整办理过程，断网时数据仍在队列中。房屋绑定属于原站写操作，Excel清单仅在本地解析，不自动当成回流文件上传；历史补传只选择真正的已完成回流任务。
