# 房屋租赁：房屋编码自动绑定

本系统是办件操作辅助：在原系统手工登录，工作台输入受理编号、产权证号及房屋编码Excel，生成独立任务。客户端只负责定位办件、确认该办件产权、查询房屋、检查已有关系及挂接；不保存合同、不修改产权基本资料、不删除关系。

来源为用户2026-11-27提供的四份HAR及其中原站页面脚本。原始数据和凭据不进入仓库。RPC复用LEAP的Data-Type14/16编解码，原站请求头为`QS`中的sid、`LSYS-AREA=4403`、`LSYS-NAME=ZIB`、`lrqvt=3`。原站Base.js退出逻辑由Index.html切换到同目录Login.html，插件使用独立持久分区，不复用政务系统会话。

一次只读`app_getLogicModuleOperations('ZLindex2','true','true')`必须返回正确模块名、真实用户标识及18位管理区域才确认已登录。sid存在不视为已验证；页面回到登录页、401/403、登录HTML均失效。会话由主进程密钥库保存，renderer只获得状态。

`resolveTarget`先精确定位`tysl_transactor.transactno`，再从该办件的`tysl_contractproperty`核对产权类型和号码后精确查询`property`，不依据证号在全域随意选择。`findHouse`按完整房屋编码定位`viewcodehouse`，沿用共享文本编码规范，不固定业务位数；只去首尾空白，保留前导零与完整原值，源查询结果再做全文相等核对。编码同时设有合理的API长度上限，避免异常输入，不将此上限视为业务长度规定。校验唯一性、未删除、有效性及目标产权区域。内部主键不要求UUID，也不假设等于房屋编码，取源数据实际id。`isBound`查`propertyhouse`。`bindHouse`提交`insertOrupdatePropertyHouse`，参数为一层RPC参数包裹的`[[{beanname,propertyid,houseid,housecode,buildingid,delmark,cardid}]]`。

原始页面CardPropertyNew→ProprietaryModity→PropertyHouseManager路径中的cardid默认为null；客户端保持该上下文，不猜测业主编码卡。对象带有客户端内部会话代次约束，切换账号或重新获得SID后必须重新定位目标和房屋，避免旧目标跨账号写入。

写操作最多提交一次；断网、超时或返回不明确，均不能直接重发。任务层应回读关系，确认存在才记成功；无法确认则记录待核查，后续重试先查已有关系。当前HAR中的两次房屋样本均已存在关联，没有真实成功写入的请求/响应；本实现以页面脚本明确的参数为依据，仍需用户提供一条未绑定房屋的真实成功挂接过程完成实网验收。离线测试不得被表述为实网挂接成功。
