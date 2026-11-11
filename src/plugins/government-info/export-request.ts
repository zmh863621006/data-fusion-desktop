export function buildExportParameters(startDate: string, endDate?: string): string {
  const query = {
    // The captured date bounds require JDBC TIMESTAMP (93), including in exports.
    parameters: [
      { name: 'bj_bjsj', value: startDate, flag: 16, sqlType: 93 },
      ...(endDate ? [{ name: 'bj_bjsj', value: endDate, flag: 17, sqlType: 93 }] : []),
    ],
    extendQuery: " 1=1  and (((sys_areaid>='440305000000000000' and sys_areaid<='440305999999999999' and (steptype=0 or (steptype=1 and stepname='结束')) )  and ((sbversion is not null and tjfs in ('0','1','2','3')) or signaturephoto is not null or fromareaid='101')) or (sbzt=8 and creator<>'2017补数据' and length(sblsh)<30))",
    order: 'sbsj desc',
    desFields: [
      { field: 'sqrmc', begin: 1, size: 1 },
      { field: 'sqrzjhm', begin: 4, size: 10 },
    ],
    fields: [
      "row_number() over(order by sbsj desc) as xh,sblsh_short,sblsh,sxmc,sqrmc,sqrzjhm,(case when lqfs='0' then '自取' when lqfs='1' then '邮寄' else '' end) as lqfs,sbsj,creator,(case when slzt='1' then '正常受理' when slzt='2' then '不予受理' when slzt='3' then '补件告知' when slzt='4' then '审核不通过' else '待受理' end) as slzt,sys_areaid,zgbm,stepname,bj_bjsj,fdbjsj ",
    ],
    pageNum: 1,
    pageSize: -9999,
    name: 'laam_ex_sb',
    getCodeValue: true,
    toCount: false,
    isgis: false,
    javaClass: 'com.longrise.LEAP.BLL.Cache.SearchBuilder',
  };
  const headers = [
    '序号', '市流水号', '申办流水号', '事项名称', '申请人', '证件号码', '领取方式', '申办时间',
    '创建人', '受理结果', '区域', '主管部门', '当前环节', '办结日期', '法定办结时间',
  ];
  return JSON.stringify([
    JSON.stringify(query),
    JSON.stringify(headers),
    'ecs_searchAll',
    '综合业务窗口材料交接登记表',
  ]);
}
