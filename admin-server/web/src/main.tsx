import React from 'react';
import ReactDOM from 'react-dom/client';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AdminApp from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{
      token: {
        colorPrimary: '#007aff', colorInfo: '#007aff', colorSuccess: '#248a3d', colorWarning: '#b66b00', colorError: '#d92d20',
        colorText: '#1d1d1f', colorTextSecondary: '#6e6e73', colorTextTertiary: '#76767d',
        colorBgLayout: '#ffffff', colorBorder: '#d9d9df', colorBorderSecondary: '#e5e5ea',
        borderRadius: 6, borderRadiusLG: 10, controlHeight: 36, controlHeightLG: 42, fontSize: 14,
        fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif',
        boxShadow: '0 8px 32px rgba(29, 29, 31, 0.08)',
      },
      components: {
        Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
        Card: { headerFontSize: 16, headerHeight: 48, bodyPadding: 18 },
        Table: { headerBg: '#f5f5f7', headerColor: '#424245', headerSplitColor: '#e5e5ea', rowHoverBg: '#f7faff', cellPaddingBlock: 12, cellPaddingInline: 14 },
        Modal: { titleFontSize: 19, contentBg: '#ffffff', headerBg: '#ffffff' },
        Drawer: { footerPaddingBlock: 16, footerPaddingInline: 24 },
        Tabs: { titleFontSize: 14 },
        Tag: { defaultBg: '#f5f5f7', defaultColor: '#6e6e73' },
      },
    }}>
      <AntApp><AdminApp /></AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
