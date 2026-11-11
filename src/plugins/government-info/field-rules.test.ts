import { describe, expect, it } from 'vitest';
import {
  calculateFillStatus,
  enrichConstructionWaste,
  enrichDrainagePermit,
  enrichGreenSpaceOccupation,
  enrichTreeFellingRelocation,
  extractContentByType,
  applyFixedDrainagePermitContent,
  NEW_DRAINAGE_PERMIT_CONTENT,
  NEW_DRAINAGE_PERMIT_MATTER,
} from './field-rules';

describe('government information source field rules', () => {
  it('keeps the full content without a trailing authority marker, as Java split does', () => {
    const result = enrichConstructionWaste({ cityLsh: '1', sxmc: '垃圾', applyer: '单位' },
      { zjbh: '编号：编号：123' }, { paragraphs: [], tables: [[['许可正文']]] });
    expect(result.xknr).toBe('许可正文');
    expect(result.xkbh).toBe('123');
  });
  it('uses the same eight fields for completion and excludes the end date', () => {
    const complete = {
      cityLsh: '1', sxmc: 'x', xkbh: '1', qymc: '2', frdb: '3', xydm: '4',
      xknr: '5', ajmc: '6', xkjdrq: '7', yxqs: '8', yxqe: '',
    };
    expect(calculateFillStatus(complete)).toBe('1');
    expect(calculateFillStatus({ ...complete, frdb: '' })).toBe('0');
  });

  it('keeps change/renewal naming and content unchanged', () => {
    const result = enrichDrainagePermit(
      { cityLsh: '1', sxmc: '污水排入排水管网许可证核发（变更或延续）', applyer: '申请人' },
      { zjbh: '许可号', zzsj: '2026-09-01', zjyxqstart: '2026-09-01', zjyxqend: '2027-09-01' },
      '测试企业',
    );
    expect(result).toMatchObject({ qymc: '测试企业', ajmc: '测试企业污水排入排水管网许可证核发', xkbh: '许可号' });
    expect(result.xknr).toContain('《深圳经济特区排水条例》');
  });

  it('prefixes each enterprise name to the exact approved new-permit body', () => {
    const expected = '根据《城镇排水与污水处理条例》（中华人民共和国国务院令第641号）以及《城镇污水排入排水管网许可管理办法》（2015年1月22日住房和城乡建设部令第21号发布，根据2022年12月1日住房和城乡建设部令第56号修正）的规定，经审查，准予在许可范围内（详见副本）向城镇排水设施排放污水。\n特发此证';
    for (const company of ['测试企业甲', '测试企业乙']) {
      const result = enrichDrainagePermit({ cityLsh: company, sxmc: NEW_DRAINAGE_PERMIT_MATTER },
        { zjbh: '许可号', zzsj: '2026-11-03' }, company);
      expect(result).toMatchObject({ qymc: company, ajmc: `${company}污水排入排水管网许可证核发`, xkbh: '许可号',
        xknr: `${company}：${expected}`, xkNr: `${company}：${expected}` });
    }
    expect(NEW_DRAINAGE_PERMIT_CONTENT).toBe(expected);
    const unrelated = { sxmc: '城市建筑垃圾处置（排放）核准', xknr: '原许可内容', xkNr: '原导出内容' };
    expect(applyFixedDrainagePermitContent(unrelated)).toBe(unrelated);
  });

  it.each([
    { qymc: ' 详情企业 ', xkXdrMc: '公示企业', applyer: '申请企业', expected: '详情企业：' },
    { qymc: ' ', xkXdrMc: ' 公示企业 ', applyer: '申请企业', expected: '公示企业：' },
    { qymc: '', xkXdrMc: '', applyer: ' 申请企业 ', expected: '申请企业：' },
    { qymc: '', applyer: '', expected: '' },
  ])('uses the available enterprise identity without duplicating the prefix ($expected)', ({ expected, ...identity }) => {
    const row = { sxmc: NEW_DRAINAGE_PERMIT_MATTER, ...identity, xknr: '旧企业：旧内容' };
    const normalized = applyFixedDrainagePermitContent(row);
    expect(normalized).toMatchObject({ xknr: `${expected}${NEW_DRAINAGE_PERMIT_CONTENT}`, xkNr: `${expected}${NEW_DRAINAGE_PERMIT_CONTENT}` });
    expect(applyFixedDrainagePermitContent(normalized)).toEqual(normalized);
  });

  it('extracts opinion fragments and converts square-metre symbols', () => {
    expect(extractContentByType('拟同意砍伐城市树木10株，迁移城市树木20株。', '砍伐')).toBe('砍伐城市树木10株');
    expect(extractContentByType('临时占用绿地15.5㎡；其他', '临时')).toBe('临时占用绿地15.5平方米');
  });

  it('keeps the green-space slicing rule from the source project', () => {
    const result = enrichGreenSpaceOccupation(
      { cityLsh: '1', sxmc: '占用城市绿地审批', applyer: '申请人' },
      { zjbh: '文号' },
      '经现场查勘，拟同意临时占用城市绿地158.68㎡，呈局领导审批',
    );
    expect(result).toMatchObject({ ajmc: '临时占用城市绿地', xknr: '临时占用城市绿地158.68平方米' });
  });

  it('splits combined document numbers and creates the _001 green-space record', () => {
    const [green, tree] = enrichTreeFellingRelocation(
      { cityLsh: 'CITY-1', sxmc: '砍伐、迁移城市树木', applyer: '申请人' },
      { zjbh: '深城许字【2026】第123号、124号' },
      '同意临时占用绿地10㎡，同意砍伐城市树木2株。',
    );
    expect(green.cityLsh).toBe('CITY-1_001');
    expect(green.xkbh).toBe('深城许字【2026】第123号');
    expect(tree.xkbh).toBe('深城许字【2026】第124号');
    expect(tree.ajmc).toBe('砍伐城市树木');
  });
});
