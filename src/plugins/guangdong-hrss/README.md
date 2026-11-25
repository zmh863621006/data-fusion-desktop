# 广东人社门户列表插件

`matter-catalog.json` 是客户端和授权后台共用的18项台账名称、事项编号及分组来源；`catalog.ts` 在其基础上声明每项列表接口、请求方式、固定参数、中文列名、敏感列和字段白名单。

## 已核对的原项目依据

来源：`D:/code/shenzhenRS/ruoyi-system/src/main/java/com/ruoyi/fusion/`。原统一任务类型15类拆分为18项台账：灵活就业拆两类，新跟踪服务拆三个人群。政务综合、房屋租赁、旧跟踪服务、无实现的就业困难查询占位服务均不属于本插件目录。

- `constants/RSContants.java:8-179`：列表接口地址；`:207-253`：当前任务类型。旧控制器type编号与当前任务编号不同。
- `service/impl/RSJYSYServiceImpl.java:75-91,114-119`：失业自2025-05-01起逐天查询，`aac004=""`、`bae085="01"`、`bae001="163374"`、`bbd068="01"`。先GET `/syxx/page/cnt`，再GET `/syxx/page`，列表字段为`records`。原 `RSRZServiceImpl.getSyXx` 将count的total另加到列表响应，故插件仅对这个拥有countPath的接口允许列表省略total，显式total仍须一致。count为0不请求列表页。
- `service/impl/RSRZServiceImpl.java:160-181`：会话验证使用当日失业count，验证实参`aac004="1"`，与采集实参不同。原后端八小时Redis缓存不是远端凭据TTL；恢复快照后由主进程进行真实会话验证。
- 用户于2026-11-04确认门户登录入口为 `https://hrss.gdgov.cn/sso/login.html`；`service/impl/RSRZServiceImpl.java:194-244` 中的就业SSO service目的页面仅用于已验证会话的业务首页，不能替代未登录入口。插件监听同分区已完成业务请求的`Access-Token`头，不猜测localStorage键，也不增加二维码接口链。
- `service/impl/RSLHJYServiceImpl.java:68-72,168-171`：`LHJYBT_20`高校毕业生、`LHJYBT_10`困难人员。
- `service/impl/RSNewGZFWServiceImpl.java:83,110-138`：101高校、102困难、103失业；103的创建时间为当月起至当前，其他两类无时间限制；使用pagenum/pagesize。地区、状态与范围参数保留原值。
- `service/impl/RSYCXKGServiceImpl.java:61-96`：WGBT为独立Cookie，POST表单；confid和原whereCls保留，rowstart沿用1..N页号，pageSize=200。whereCls语义及rowstart真实服务端语义尚未实网验证，若返回重复/缺页会整体失败。
- `service/impl/RSQNJXXYBAServiceImpl.java:84-125,218-235`、`RSQNJXDWSBServiceImpl.java:64-68,107-109,180-182`：青年见习有审核、查询两个列表。本插件将原先只计数的备案审核分支也保留为“审核列表”记录，与“查询列表”具有独立稳定键，不宣称为去重人数。

## 字段和完整性

不请求详情、附件、学历补齐或远端大屏统计接口，没有getDetail。只有原见习列表明确具有的`aac011Name`映射为学历；其他台账不声明学历列。原失业/见习列表的`aac006`保留为出生日期，其他人口年龄可由本地统计模块从合法的列表证件号推算。

仅投影声明的标量字段，不展开原始JSON、不复制未知字段和嵌套对象。缺失列为空；金额保留原字符串，不猜测元/分转换。原见习姓名误取单位地址、跟踪社区误取地区两个映射不复制：姓名使用明确姓名字段，跟踪不展示无法确认的社区列。

所有页面都必须满足总数、预期页长和稳定业务键。页数上限10,000、原始记录上限200,000，超过上限、缺页、条数变化、重复页面、同源同日重复编号或编号缺失会整体报错，不返回部分成功。不同失业日期分区若出现完全相同自然键和列表内容，可合并为一条；内容冲突则失败。每页前后检查取消信号。内部recordKey为来源和自然业务编号的SHA-256，不含明文证件号，也不列为展示/导出列。

## 验证范围

定向单测使用合成响应验证18项目录、中文和敏感列、接口白名单、凭据分离、恢复、分页完整性、取消、日期参数及无详情请求；不调用真实接口。实际门户权限、列表包层、WGBT过滤条件和原站SSO仍须在授权网络环境验收。

### 中文应用名与主进程请求兼容

2026-11-25 在授权登录会话中确认：Electron 默认 User-Agent 中的中文产品名 `数据融合助手/1.1.11` 会使人社接口返回 HTTP 500；保持 token、Cookie、接口及引擎版本不变，仅将产品名改为 ASCII 的 `DataFusion` 即返回 HTTP 200。人社默认请求适配器因此规范化 User-Agent 的产品名，保留实际操作系统、Chrome 和 Electron 版本；中文界面名称不变。

此次实网验证覆盖补贴列表、原失业登记 count 校验及助手登录状态恢复，不代表全部事项已完成实网验收；未提交业务修改或执行整批回流。
