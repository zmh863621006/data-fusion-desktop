import { publicationPlatform } from '../../core/publication/platforms';
import { HAZCHEM_SYSTEM_ID, HAZCHEM_SYSTEM_NAME } from '../../plugins/shenzhen-hazardous-chemicals/catalog';
import { EQUIPMENT_SYSTEM_ID } from '../../plugins/guangdong-special-equipment/catalog';
import { FOOD_DRUG_SYSTEM_ID } from '../../plugins/guangdong-food-drug/catalog';

export const taskStatusLabel = (status: string): string => ({ queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消' })[status] ?? status;

const systemNames: Record<string, string> = {
  'market-access': '市场准入', 'government-info': '政务综合',
  'transport-practitioner': '道路运输从业人员', 'oversize-transport': '大件运输', 'online-car-permit': '网约车车证',
  'guangdong-hrss': '广东人社一体化',
  'guangdong-population': '全员人口',
  'shenzhen-integrated-services': '深圳一体化',
  'shenzhen-one-window': '深圳市一窗综合',
  'shenzhen-housing-rental': '深圳市房屋租赁',
  [HAZCHEM_SYSTEM_ID]: HAZCHEM_SYSTEM_NAME,
  [EQUIPMENT_SYSTEM_ID]: '特种设备监管',
  [FOOD_DRUG_SYSTEM_ID]: '智慧食药监',
};
const descriptions: Record<string, string> = {
  'market-access': '市场主体设立、变更等业务记录', 'government-info': '跨部门事项回流与证照字段核对',
  'transport-practitioner': '从业资格业务与办结记录', 'oversize-transport': '超限运输许可与企业信息', 'online-car-permit': '运输证办理记录与字段核对',
  'guangdong-hrss': '就业服务与补贴列表回流、本地台账及数据看板',
  'shenzhen-one-window': '城管事项完整业务详情回流、定时采集与推送后台',
  'shenzhen-housing-rental': '按受理编号与产权证号，批量挂接 Excel 房屋编码',
  'shenzhen-hazardous-chemicals': '按已办流程关联制证数据，核对并导出双公示',
  [EQUIPMENT_SYSTEM_ID]: '使用登记和作业人员考核回流、核对与双公示导出',
  [FOOD_DRUG_SYSTEM_ID]: '按办结日期回流食品生产和第三类医疗器械经营许可',
};
export const shortSystemName = (id: string, fallback = id): string => systemNames[id] ?? publicationPlatform(id)?.tabName ?? fallback;
export const systemDescription = (id: string, fallback?: string): string => descriptions[id] ?? fallback ?? '进入工作区，查询并核对业务数据';

export function taskProgressPercent(progress: { current: number; total?: number }, status: string): number | undefined {
  if (status === 'completed') return 100;
  if (!progress.total || progress.total <= 0 || !Number.isFinite(progress.current) || !Number.isFinite(progress.total)) return undefined;
  return Math.round(Math.max(0, Math.min(100, progress.current / progress.total * 100)));
}
