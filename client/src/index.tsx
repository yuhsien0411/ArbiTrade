/**
 * React應用入口文件
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhTW from 'antd/locale/zh_TW';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-tw';

import App from './App';
import { store } from './store';
import './index.css';
import './styles/cex-theme.css';

// 設置dayjs為繁體中文
dayjs.locale('zh-tw');

// Ant Design CEX 深色主題配置
const theme = {
  token: {
    colorPrimary: '#f0b90b',      // 金色為主色
    colorSuccess: '#0ecb81',      // 綠色
    colorWarning: '#f0b90b',      // 警告黃
    colorError: '#f6465d',        // 紅色
    colorBgBase: '#0b0e11',       // 基礎背景
    colorBgContainer: '#161a1e',  // 容器背景
    colorBorder: '#2b3139',       // 邊框色
    colorText: '#eaecef',         // 文字色
    colorTextSecondary: '#848e9c',// 次要文字
    borderRadius: 6,
    fontSize: 14,
  },
  algorithm: undefined,  // 使用深色模式
  components: {
    Layout: {
      bodyBg: '#0b0e11',
      headerBg: '#1e2329',
      siderBg: '#1e2329',
    },
    Card: {
      colorBgContainer: '#161a1e',
      colorBorderSecondary: '#2b3139',
    },
    Table: {
      colorBgContainer: 'transparent',
      headerBg: '#1e2329',
      borderColor: '#2b3139',
    },
    Input: {
      colorBgContainer: '#1e2329',
      colorBorder: '#2b3139',
    },
    Select: {
      colorBgContainer: '#1e2329',
      colorBorder: '#2b3139',
    },
    Button: {
      primaryColor: '#0b0e11',
      defaultBg: '#2b3139',
      defaultColor: '#eaecef',
    },
  },
};

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <Provider store={store}>
      <BrowserRouter
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <ConfigProvider 
          locale={zhTW} 
          theme={theme}
        >
          <AntdApp>
            <App />
          </AntdApp>
        </ConfigProvider>
      </BrowserRouter>
    </Provider>
  </React.StrictMode>
);
