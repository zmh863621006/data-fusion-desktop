import type { HrssColumn, HrssMatterDefinition } from './catalog';

const column = (key: string, label: string): HrssColumn => ({ key, label, sources: [key] });

/** Pure metadata: catalog consumers also run in the renderer, without Node's crypto or HTML parser. */
export const HRSS_TRAINING_PROFILE: Pick<HrssMatterDefinition, 'columns' | 'sources'> = {
  columns: [
    column('caseId', '业务流水号'), column('unitName', '单位名称'), column('applyBh', '申请编号'),
    column('applyDate', '申请日期'), column('applyAddress', '申请受理地点'), column('currentLink', '当前环节'),
    column('completedDate', '办结日期'), column('completedResult', '办结结果'), column('payStatus', '支付结果'),
    column('payDate', '拨付日期'), column('recoveryStatus', '资金追回状态'),
    column('handlingRecordCount', '办理记录数'), column('handlingRecordStatus', '办理记录状态'),
  ],
  sources: [
    { id: 'training-progress', path: '/ZXZJ/gltPage.do', method: 'POST', pagination: 'training', identity: [['caseId']] },
    { id: 'training-completed', path: '/ZXZJ/gltPage.do', method: 'POST', pagination: 'training', identity: [['caseId']] },
  ],
};
