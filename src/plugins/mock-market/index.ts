import type { BusinessSystemPlugin } from '../../core/plugins/types';
import type { AuthAdapter, AuthSession, SessionState } from '../../core/session/types';
import type { BusinessMatter } from '../../core/query/types';

class MockAuthAdapter implements AuthAdapter {
  private state: SessionState = {
    status: 'logged-out',
    systemId: 'mock-market',
  };

  async getState(): Promise<SessionState> {
    return this.state;
  }

  async login(): Promise<SessionState> {
    // TODO: Replace with the real system-specific login flow.
    this.state = {
      status: 'authenticated',
      systemId: 'mock-market',
      displayName: 'Mock 业务系统会话',
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    return this.state;
  }

  async logout(): Promise<void> {
    this.state = { status: 'logged-out', systemId: 'mock-market' };
  }

  async getSessionForRequest(): Promise<AuthSession> {
    if (this.state.status !== 'authenticated') {
      throw new Error('Business system login required');
    }
    return { accessToken: 'mock-token', expiresAt: this.state.expiresAt };
  }
}

const establishmentMatter: BusinessMatter = {
  id: 'enterprise-establishment',
  name: '企业设立登记',
  description: 'Mock 事项，用于验证动态查询与插件流程。',
  uniqueKey: ['businessNo'],
  querySchema: [
    { key: 'enterpriseName', label: '企业名称', type: 'text', placeholder: '请输入企业名称' },
    { key: 'creditCode', label: '统一社会信用代码', type: 'text' },
    { key: 'applyDate', label: '申请时间', type: 'date-range' },
    {
      key: 'status',
      label: '办理状态',
      type: 'select',
      options: [
        { label: '全部', value: '' },
        { label: '受理中', value: 'accepted' },
        { label: '审批中', value: 'reviewing' },
        { label: '已办结', value: 'completed' },
      ],
    },
  ],
  async query(context) {
    return {
      rows: [
        {
          businessNo: 'MOCK-20260912-001',
          enterpriseName: '示例企业有限公司',
          creditCode: '91440000MOCK000001',
          status: 'accepted',
          ...context.filters,
        },
      ],
      page: context.page,
      pageSize: context.pageSize,
      total: 1,
    };
  },
};

const auth = new MockAuthAdapter();

export const mockMarketPlugin: BusinessSystemPlugin = {
  id: 'mock-market',
  name: '市场准入系统（Mock）',
  version: '0.1.0',
  description: '用于搭建和验证系统插件框架，不连接真实业务系统。',
  auth,
  matters: [establishmentMatter],
  async initialize() {},
  async getSessionState() {
    return auth.getState();
  },
};
