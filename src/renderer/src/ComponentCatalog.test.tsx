import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComponentCatalog } from './ComponentCatalog';
import type { ComponentSummary } from '../../core/plugins/components';
import type { LicenseStatus } from '../../core/license/types';
const components:ComponentSummary[]=[{id:'government-info',kind:'system',name:'政务综合信息平台',version:'1.0.0',description:'系统说明',authorized:true},
 {id:'health-publicity',kind:'tool',name:'卫健局双公示工具',version:'2.3.4',description:'目录中的工具说明',authorized:true}];
const render=(systems:string[],tools:string[])=>renderToStaticMarkup(<ComponentCatalog components={components}
 license={{state:'active',deviceId:'fixture',grant:{licenseId:'fixture',expiresAt:Date.now()+60000,allowedSystems:systems,allowedTools:tools}} as LicenseStatus}
 onOpenSystem={()=>{}} onOpenTool={()=>{}}/>);
describe('component table',()=>{
 it('uses matching table rows for systems and tools, with catalog versions and descriptions',()=>{
  const html=render(['government-info'],['health-publicity']);expect(html.match(/class="plugin-card"/g)).toHaveLength(2);
  expect(html).toContain('v2.3.4');expect(html).toContain('目录中的工具说明');expect(html).toContain('打开工具');expect(html).toContain('进入系统');
  expect(html).not.toContain('home-tool-card');expect(html).toContain('当前密钥已授权');
 });
 it('shows one tool row for a tool-only key',()=>{
  const html=render([],['health-publicity']);expect(html.match(/class="plugin-card"/g)).toHaveLength(1);expect(html).not.toContain('政务综合信息平台');expect(html).toContain('v2.3.4');
 });
 it('hides tool metadata and actions when its key permission is absent',()=>{
  const html=render(['government-info'],[]);expect(html).not.toContain('卫健局双公示工具');expect(html).not.toContain('打开工具');
 });
});
