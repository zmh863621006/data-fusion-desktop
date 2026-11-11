import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Form, Popconfirm, Select, Space, Tabs, Tag } from 'antd';
import { ModalForm, PageContainer, ProFormSelect, ProFormText, ProTable } from '@ant-design/pro-components';
import { adminApi } from './api';
import type { AdminSession, AdminUser, SecurityEvent } from './types';

const passwordHint = '12–128 位，包含大写字母、小写字母、数字、符号中的至少三类';
const passwordRule = { validator: (_: unknown,value: string) => value && value.length >= 12 && value.length <= 128 && [/[A-Z]/,/[a-z]/,/\d/,/[^A-Za-z0-9]/].filter(rule=>rule.test(value)).length >= 3 ? Promise.resolve() : Promise.reject(new Error(passwordHint)) };
const time = (value:number) => new Date(value).toLocaleString('zh-CN',{hour12:false});
const eventNames:Record<string,string> = {'login.success':'登录成功','login.restored':'恢复记住的登录','login.failed':'账号或密码错误','login.locked':'触发账号锁定','captcha.failed':'验证码校验失败','sensitive.password_failed':'敏感操作密码确认失败'};

export function SecurityPage({ role, onLoggedOut }: { role?: string; onLoggedOut: () => void }) {
  const { message,modal } = App.useApp();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sessions,setSessions] = useState<AdminSession[]>([]);
  const [passwordForm]=Form.useForm();
  const [createOpen, setCreateOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const roles = [{ label: '超级管理员', value: 'admin' }, { label: '运营人员', value: 'operator' }, { label: '只读审计', value: 'viewer' }];
  const reload = useCallback(async () => { try { setUsers(await adminApi.users()); } catch { /* centralized API notification */ } },[]);
  const reloadSessions = useCallback(async()=>{try{setSessions(await adminApi.sessions());}catch{/* centralized API notification */}},[]);
  useEffect(() => { if (role === 'admin') void reload(); void reloadSessions(); }, [role,reload,reloadSessions]);
  const accounts = <><Alert type="info" showIcon message="超级管理员管理账号、系统和版本；运营人员管理客户、授权及企业资料；审计账号只读。" />
    <ProTable<AdminUser> rowKey="id" headerTitle="后台账号" dataSource={users} search={false} options={{ reload }} pagination={{pageSize:10}} scroll={{x:700}} columns={[
      { title: '账号', dataIndex: 'username' },
      { title: '角色', render: (_, row) => <Select aria-label={`${row.username} 的账号角色`} value={row.role} options={roles} style={{minWidth:130}} onChange={value=>modal.confirm({title:`确认修改 ${row.username} 的角色？`,content:'该账号的现有登录会话将失效。',onOk:async()=>{await adminApi.updateUser(row.id,{role:value});await reload();message.success('账号角色已更新');}})} /> },
      { title: '状态', render: (_, row) => <Space><Tag color={row.enabled?'success':'default'}>{row.enabled?'启用':'停用'}</Tag>{Boolean(row.lockedForSeconds) && <Tag color="warning">暂时锁定</Tag>}</Space> },
      { title: '操作', render: (_, row) => <Space>{Boolean(row.lockedForSeconds) && <Popconfirm title="确认解除该账号的登录锁定？" onConfirm={async()=>{await adminApi.unlockUser(row.id);await reload();message.success('账号已解锁');}}><Button type="link">解锁</Button></Popconfirm>}<Popconfirm title={row.enabled ? '停用账号并清除其会话？' : '重新启用账号？'} onConfirm={async () => { await adminApi.updateUser(row.id, { enabled: !row.enabled }); await reload(); message.success('账号状态已更新'); }}><Button danger={Boolean(row.enabled)} type="link">{row.enabled ? '停用' : '启用'}</Button></Popconfirm></Space> },
    ]} /></>;
  const sessionTable = <><Alert type="info" showIcon message="单次会话最长 8 小时，闲置 30 分钟过期，过期后需重新登录。账号密码可由浏览器保存并自动填充；修改密码会退出全部会话。" action={<Popconfirm title="确认退出其他登录会话？" onConfirm={async()=>{await adminApi.revokeOtherSessions();await reloadSessions();message.success('其他登录会话已撤销');}}><Button>退出其他会话</Button></Popconfirm>} />
    <ProTable<AdminSession> rowKey="id" headerTitle="活动会话" dataSource={sessions} search={false} options={{reload:reloadSessions}} pagination={false} scroll={{x:800}} columns={[
      {title:'来源地址',dataIndex:'ip_address',render:(_,row)=><Space>{row.ip_address}{Boolean(row.current)&&<Tag color="blue">当前会话</Tag>}</Space>},
      {title:'浏览器',dataIndex:'user_agent',ellipsis:true},
      {title:'登录时间',dataIndex:'created_at',render:(_,row)=>time(row.created_at)},
      {title:'最近活动',dataIndex:'last_seen_at',render:(_,row)=>time(row.last_seen_at)},
    ]}/></>;
  const securityTable = <ProTable<SecurityEvent> rowKey="id" headerTitle="登录安全日志" search={false} pagination={{pageSize:20,showSizeChanger:false}} scroll={{x:700}} request={async params=>{const result=await adminApi.securityEvents(params.current??1);return {data:result.rows,total:result.total,success:true};}} columns={[
    {title:'时间',dataIndex:'created_at',render:(_,row)=>time(row.created_at)},
    {title:'账号',dataIndex:'username',renderText:value=>value||'—'},
    {title:'来源地址',dataIndex:'ip_address'},
    {title:'事件',dataIndex:'event',render:(_,row)=><Tag color={['login.success','login.restored'].includes(row.event)?'success':'warning'}>{eventNames[row.event]??row.event}</Tag>},
  ]}/>;
  return <PageContainer title="账号与安全" subTitle="登录保护、账号权限、活动会话和安全事件"
    extra={<Space wrap><Button onClick={() => setPasswordOpen(true)}>修改我的密码</Button>{role === 'admin' && <Button type="primary" onClick={() => setCreateOpen(true)}>新增账号</Button>}</Space>}>
    <Tabs className="security-tabs" items={[...(role==='admin'?[{key:'accounts',label:'后台账号',children:accounts}]:[]),{key:'sessions',label:'我的登录会话',children:sessionTable},...(role==='admin'?[{key:'events',label:'登录安全日志',children:securityTable}]:[])]}/>
    <ModalForm title="新增后台账号" open={createOpen} onOpenChange={setCreateOpen} modalProps={{ destroyOnClose: true }} onFinish={async (values) => { try { await adminApi.createUser(values); await reload(); message.success('账号已创建'); return true; } catch { return false; } }}>
      <ProFormText name="username" label="账号" rules={[{ required: true, pattern: /^[A-Za-z0-9_.-]{3,80}$/, message: '3–80 位字母、数字、点、下划线或短横线' }]} />
      <ProFormText.Password name="password" label="初始密码" extra={passwordHint} fieldProps={{autoComplete:'new-password'}} rules={[passwordRule]} />
      <ProFormSelect name="role" label="角色" options={roles} rules={[{ required: true }]} />
    </ModalForm>
    <ModalForm<{ oldPassword: string; newPassword: string; confirmation:string }> form={passwordForm} title="修改密码" open={passwordOpen} onOpenChange={setPasswordOpen} modalProps={{ destroyOnClose: true }} onFinish={async (values) => { try { await adminApi.password({oldPassword:values.oldPassword,newPassword:values.newPassword}); message.success('密码已修改，请重新登录'); onLoggedOut(); return true; } catch { return false; } }}>
      <ProFormText.Password name="oldPassword" label="当前密码" fieldProps={{autoComplete:'current-password'}} rules={[{ required: true, max: 256 }]} />
      <ProFormText.Password name="newPassword" label="新密码" extra={passwordHint} fieldProps={{autoComplete:'new-password'}} rules={[passwordRule]} />
      <ProFormText.Password name="confirmation" label="再次输入新密码" dependencies={['newPassword']} fieldProps={{autoComplete:'new-password'}} rules={[{required:true},{validator:(_,value)=>value===passwordForm.getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次输入的密码不一致'))}]} />
    </ModalForm>
  </PageContainer>;
}
