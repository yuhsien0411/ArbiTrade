/**
 * 系統設定頁面
 * 風險控制、API設定等
 */

import React, { useState, useEffect, useCallback } from 'react';
import { 
  Row, Col, Card, Form, Button, Space, Typography, 
  Divider, Alert, Input, Modal, Select, List, Tag, Popconfirm, App as AntdApp
} from 'antd';
import { 
  ApiOutlined, ReloadOutlined, EditOutlined,
  PlusOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined
} from '@ant-design/icons';
import { apiService } from '../services/api';
import logger from '../utils/logger';

// 導入交易所 SVG Logo
import { ReactComponent as BybitLogo } from '../assets/bybit.svg';
import { ReactComponent as BinanceLogo } from '../assets/binance.svg';
import { ReactComponent as OkxLogo } from '../assets/okx.svg';
import { ReactComponent as BitgetLogo } from '../assets/bitget.svg';
import { ReactComponent as AsterLogo } from '../assets/aster.svg';
import { ReactComponent as MexcLogo } from '../assets/mexc.svg';

const { Title } = Typography;
// TextArea 暫時不使用，已移除

const SettingsPage = (): React.ReactElement => {
  const { message } = AntdApp.useApp();
  
  const [apiForm] = Form.useForm();
  const [loading, setLoading] = useState(false);
  // 編輯模式狀態暫時不使用，已移除
  // const [isEditMode, setIsEditMode] = useState(false);
  
  // API管理相關狀態
  const [isApiModalVisible, setIsApiModalVisible] = useState(false);
  const [apiConfigs, setApiConfigs] = useState<any[]>([]);
  const [editingApi, setEditingApi] = useState<any>(null);
  
  // 支援的交易所列表
  // 獲取交易所圖標的幫助函數
  const getExchangeIcon = (exchange: string, size: number = 24) => {
    switch (exchange.toLowerCase()) {
      case 'bybit':
        return <BybitLogo width={size} height={size} />;
      case 'binance':
        return <BinanceLogo width={size} height={size} />;
      case 'okx':
        return <OkxLogo width={size} height={size} />;
      case 'bitget':
        return <BitgetLogo width={size} height={size} />;
      case 'aster':
        return <AsterLogo width={size} height={size} />;
      case 'mexc':
        return <MexcLogo width={size} height={size} />;
      default:
        return <ApiOutlined style={{ fontSize: size }} />;
    }
  };
  
  // 支援的交易所列表
  const supportedExchanges = [
    {
      key: 'bybit',
      name: 'Bybit',
      icon: getExchangeIcon('bybit'),
      fields: ['apiKey', 'secret'],
      status: 'active',
      description: '統一帳戶，現貨槓桿、USDT-M 合約',
      color: '#f7a600'
    },
    {
      key: 'binance',
      name: 'Binance',
      icon: getExchangeIcon('binance'),
      fields: ['apiKey', 'secret'],
      status: 'active',
      description: '統一帳戶，現貨槓桿、USDT-M 合約',
      color: '#f0b90b'
    },
    {
      key: 'okx',
      name: 'OKX',
      icon: getExchangeIcon('okx'),
      fields: ['apiKey', 'secret', 'password'],
      status: 'active',
      description: '全倉跨幣種保證金模式，現貨槓桿、USDT-M 合約',
      requiresPassword: true,
      color: '#1890ff'
    },
    {
      key: 'bitget',
      name: 'Bitget',
      icon: getExchangeIcon('bitget'),
      fields: ['apiKey', 'secret', 'password'],
      status: 'active',
      description: '經典帳戶，USDT-M 永續合約',
      requiresPassword: true,
      color: '#00b897'
    },
    {
      key: 'aster',
      name: 'Aster',
      icon: getExchangeIcon('aster'),
      fields: ['apiKey', 'secret', 'signer'],
      status: 'active',
      description: '經典帳戶，USDT-M 永續合約',
      color: '#7c3aed'
    },
    {
      key: 'mexc',
      name: 'MEXC',
      icon: getExchangeIcon('mexc'),
      fields: ['apiKey', 'secret'],
      status: 'active',
      description: '經典帳戶，現貨',
      color: '#1677ff'
    }
  ];

  const parseUsdtAmount = (value: any): number => {
    const amount = Number.parseFloat(String(value ?? '').replace(/,/g, ''));
    return Number.isFinite(amount) ? amount : 0;
  };

  const formatUsdtAmount = (value: any): string => {
    const amount = parseUsdtAmount(value);
    if (!Number.isFinite(amount)) return '0.00';
    return amount.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const formatAssetAmount = (value: any): string => {
    const amount = parseUsdtAmount(value);
    if (!Number.isFinite(amount)) return '0';
    return amount.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 8,
    });
  };

  // 載入API配置列表（從 .env 環境變數讀取）
  const loadApiConfigs = useCallback(async () => {
    try {
      const response = await apiService.getApiSettings();
      logger.info('API Settings Response', response, 'SettingsPage');
      
      if (response && response.data) {
        const configs = [];
        
        logger.info('API Settings Data', response.data, 'SettingsPage');
        
        // 檢查Bybit配置（使用 hasApiKey 和 hasSecret 判斷）
        if (response.data.bybit && (response.data.bybit.hasApiKey || response.data.bybit.connected)) {
          logger.info('Adding Bybit config', null, 'SettingsPage');
          configs.push({
            id: 'bybit',
            exchange: 'bybit',
            name: 'Bybit',
            icon: getExchangeIcon('bybit'),
            status: response.data.bybit.connected ? 'connected' : 'configured',
            connected: response.data.bybit.connected,
            hasApiKey: response.data.bybit.hasApiKey,
            hasSecret: response.data.bybit.hasSecret
          });
        }
        
        // 檢查Binance配置
        if (response.data.binance && (response.data.binance.hasApiKey || response.data.binance.connected)) {
          logger.info('Adding Binance config', null, 'SettingsPage');
          configs.push({
            id: 'binance',
            exchange: 'binance',
            name: 'Binance',
            icon: getExchangeIcon('binance'),
            status: response.data.binance.connected ? 'connected' : 'configured',
            connected: response.data.binance.connected,
            hasApiKey: response.data.binance.hasApiKey,
            hasSecret: response.data.binance.hasSecret
          });
        }
        
        // 檢查OKX配置
        if (response.data.okx && (response.data.okx.hasApiKey || response.data.okx.connected)) {
          logger.info('Adding OKX config', null, 'SettingsPage');
          configs.push({
            id: 'okx',
            exchange: 'okx',
            name: 'OKX',
            icon: getExchangeIcon('okx'),
            status: response.data.okx.connected ? 'connected' : 'configured',
            connected: response.data.okx.connected,
            hasApiKey: response.data.okx.hasApiKey,
            hasSecret: response.data.okx.hasSecret,
            hasPassword: response.data.okx.hasPassword
          });
        }
        
        // 檢查Bitget配置
        if (response.data.bitget && (response.data.bitget.hasApiKey || response.data.bitget.connected)) {
          logger.info('Adding Bitget config', null, 'SettingsPage');
          configs.push({
            id: 'bitget',
            exchange: 'bitget',
            name: 'Bitget',
            icon: getExchangeIcon('bitget'),
            status: response.data.bitget.connected ? 'connected' : 'configured',
            connected: response.data.bitget.connected,
            hasApiKey: response.data.bitget.hasApiKey,
            hasSecret: response.data.bitget.hasSecret,
            hasPassword: response.data.bitget.hasPassword
          });
        }

        // 檢查 Aster 配置
        if (response.data.aster && (response.data.aster.hasApiKey || response.data.aster.connected)) {
          logger.info('Adding Aster config', null, 'SettingsPage');
          configs.push({
            id: 'aster',
            exchange: 'aster',
            name: 'Aster',
            icon: getExchangeIcon('aster'),
            status: response.data.aster.connected ? 'connected' : 'configured',
            connected: response.data.aster.connected,
            hasApiKey: response.data.aster.hasApiKey,
            hasSecret: response.data.aster.hasSecret,
            hasSigner: response.data.aster.hasSigner
          });
        }

        if (response.data.mexc && (response.data.mexc.hasApiKey || response.data.mexc.connected)) {
          logger.info('Adding MEXC config', null, 'SettingsPage');
          configs.push({
            id: 'mexc',
            exchange: 'mexc',
            name: 'MEXC',
            icon: getExchangeIcon('mexc'),
            status: response.data.mexc.connected ? 'connected' : 'configured',
            connected: response.data.mexc.connected,
            hasApiKey: response.data.mexc.hasApiKey,
            hasSecret: response.data.mexc.hasSecret
          });
        }
        
        logger.info('Final configs', configs, 'SettingsPage');
        setApiConfigs(configs);
      } else {
        logger.info('No API data received, setting empty configs', null, 'SettingsPage');
        setApiConfigs([]);
      }
    } catch (error) {
      logger.error('載入API配置失敗', { message: error instanceof Error ? error.message : 'Request failed' }, 'SettingsPage');
      setApiConfigs([]); // 確保在錯誤時也清空配置
    }
  }, []);

  const loadCurrentSettings = useCallback(async () => {
    try {
      // 載入API設定狀態
      const response = await apiService.getApiSettings();
      if (response.data) {
        apiForm.setFieldsValue({
          bybitApiKey: (response.data.bybit && response.data.bybit.apiKey) ? '***已配置***' : '',
          bybitSecret: (response.data.bybit && response.data.bybit.secret) ? '***已配置***' : '',
        });
      }
    } catch (error) {
      logger.error('載入設定失敗', { message: error instanceof Error ? error.message : 'Request failed' }, 'SettingsPage');
      // 設置默認值
      apiForm.setFieldsValue({
        bybitApiKey: '',
        bybitSecret: '',
      });
    }
  }, [apiForm]);

  // 載入當前設定
  useEffect(() => {
    loadCurrentSettings();
    loadApiConfigs();
  }, [loadCurrentSettings, loadApiConfigs]);

  // 打開新增API模態框
  const handleAddApi = () => {
    setEditingApi(null);
    apiForm.resetFields();
    apiForm.setFieldsValue({ exchange: 'bybit' });
    setIsApiModalVisible(true);
  };

  // 儲存的憑證不下載到瀏覽器；只提交有填寫的欄位。
  const handleEditApi = (config: any) => {
    setEditingApi(config);
    apiForm.resetFields();
    apiForm.setFieldsValue({ exchange: config.exchange });
    setIsApiModalVisible(true);
  };

  // 刪除API配置
  const handleDeleteApi = async (config: any) => {
    try {
      setLoading(true);
      
      logger.info('Deleting API settings for exchange', config.exchange, 'SettingsPage');
      
      const response = await apiService.deleteApiSettings(config.exchange);
      
      logger.info('API settings delete response', response, 'SettingsPage');
      
      if ((response as any).success) {
        message.success(`已刪除 ${config.name} API配置`);
        
        // 重新載入 API 配置列表
        await loadApiConfigs();
      } else {
        message.error('刪除API配置失敗：服務器回應異常');
      }
      
    } catch (error: any) {
      logger.error('API settings delete error', { message: error instanceof Error ? error.message : 'Request failed' }, 'SettingsPage');
      message.error('刪除API配置失敗: ' + (error.message || '未知錯誤'));
    } finally {
      setLoading(false);
    }
  };

  // 保存API配置
  const handleSaveApi = async (values: any) => {
    try {
      setLoading(true);
      
      const { exchange, apiKey, secret, password, signer } = values;
      const exchangeInfo = supportedExchanges.find(e => e.key === exchange);
      
      // 準備 API 設定資料
      const apiSettings: any = {
        [exchange]: {}
      };
      
      // 只有當用戶輸入值時才添加
      if (apiKey && apiKey.trim() !== '') {
        apiSettings[exchange].apiKey = apiKey.trim();
      }
      if (secret && secret.trim() !== '') {
        apiSettings[exchange].secret = secret.trim();
      }
      // OKX 和 Bitget 需要 password
      if (password && password.trim() !== '') {
        apiSettings[exchange].password = password.trim();
      }
      if (signer && signer.trim() !== '') {
        apiSettings[exchange].signer = signer.trim();
      }
      
      logger.info('Sending API settings update', { exchange }, 'SettingsPage');
      
      const response = await apiService.updateApiSettings(apiSettings);
      
      logger.info('API settings update response', response, 'SettingsPage');
      
      if ((response as any).success) {
        message.success(`${exchangeInfo?.name} API配置已保存`);
        setIsApiModalVisible(false);
        await loadApiConfigs(); // 重新載入配置列表
      } else {
        message.error((response as any).error || '保存API配置失敗');
      }
      
    } catch (error: any) {
      logger.error('API settings update error', { message: error instanceof Error ? error.message : 'Request failed' }, 'SettingsPage');
      message.error('保存API配置失敗: ' + (error.message || '未知錯誤'));
    } finally {
      setLoading(false);
    }
  };

  // 測試API連接
  const handleTestApiConnection = async (config: any) => {
    try {
      setLoading(true);
      
      const response = await apiService.testApiConnection(config.exchange);
      const responseData = response.data;
      logger.info('API Test Response', responseData, 'SettingsPage');
      const testResults = responseData?.test_results || {};
      const targetResult = testResults[config.exchange];
      const isTargetExchangeSuccess = Boolean(targetResult?.success);
      
      // 檢查後端實際返回的成功響應格式
      if (responseData && responseData.connected && isTargetExchangeSuccess) {
        const connectedExchanges = responseData.exchanges || [];
        
        // 更新本地狀態 - 將連接狀態設為true
        setApiConfigs(prevConfigs => 
          prevConfigs.map(cfg => 
            connectedExchanges.includes(cfg.exchange)
              ? { ...cfg, connected: true, status: 'connected' }
              : cfg
          )
        );
        
        // 顯示詳細的帳戶狀態信息
        let accountStatusMessage = `${config.name} API 連接測試成功！\n`;
        
        const testResult = testResults[config.exchange];
        if (testResult && testResult.success && testResult.account_info) {
          const accountInfo = testResult.account_info;
          
          if (config.exchange === 'bybit') {
            accountStatusMessage += `🟡 Bybit 帳戶狀態：\n`;
            if (accountInfo.totalEquity !== undefined) {
              const equityValue = parseFloat(accountInfo.totalEquity);
              accountStatusMessage += `• 帳戶淨值：${equityValue.toFixed(2)} USDT\n`;
            }
            accountStatusMessage += `• 保證金模式：${accountInfo.marginModeText || accountInfo.marginMode}\n`;
            accountStatusMessage += `• 帳戶類型：${accountInfo.unifiedMarginStatusText || accountInfo.unifiedMarginStatus}\n`;
            accountStatusMessage += `• 帶單帳戶：${accountInfo.isMasterTrader ? '是' : '否'}\n`;
            accountStatusMessage += `• 現貨對衝：${accountInfo.spotHedgingStatusText || (accountInfo.spotHedgingStatus === 'ON' ? '已開啟' : '未開啟')}\n`;

          } else if (config.exchange === 'binance') {
            accountStatusMessage += `🟨 Binance 帳戶狀態：\n`;
            accountStatusMessage += `• 帳戶類型：${accountInfo.accountType || '未知'}\n`;
            
            // 顯示 Portfolio Margin 狀態
            if (accountInfo.accountType === 'PORTFOLIO_MARGIN' || accountInfo.portfolioMarginEnabled) {
              accountStatusMessage += `• 統一交易帳戶：✅ 已開通\n`;
              if (accountInfo.accountEquity) {
                const equityValue = parseFloat(accountInfo.accountEquity);
                accountStatusMessage += `• 帳戶權益：${equityValue.toFixed(2)} USD\n`;
              }


            } else {
              accountStatusMessage += `• 統一交易帳戶：❌ 未開通 \n`;
            }
            

          } else if (config.exchange === 'okx') {
            accountStatusMessage += `🔵 OKX 帳戶狀態：\n`;
            accountStatusMessage += `• 帳戶模式：${accountInfo.accountModeText || accountInfo.accountMode || '未知'}\n`;
            if (accountInfo.positionModeText || accountInfo.positionMode) {
              accountStatusMessage += `• 持倉模式：${accountInfo.positionModeText || accountInfo.positionMode}\n`;
            }

            if (accountInfo.totalEquity) {
              accountStatusMessage += `• 帳戶權益：${accountInfo.totalEquity}\n`;
            }


            
          } else if (config.exchange === 'bitget') {
            accountStatusMessage += `🟣 Bitget 帳戶狀態：\n`;
            accountStatusMessage += `• 帳戶模式：${accountInfo.accountModeText || accountInfo.accountMode || '未知'}\n`;
            if (accountInfo.totalEquity) {
              accountStatusMessage += `• 帳戶權益：${accountInfo.totalEquity}\n`;
            }

            if (accountInfo.note) {
              accountStatusMessage += `\n📌 ${accountInfo.note}\n`;
            }
            
          } else if (config.exchange === 'mexc') {
            accountStatusMessage += `MEXC 現貨帳戶狀態：\n`;
            accountStatusMessage += `• 帳戶模式：${accountInfo.accountMode || 'spot'}\n`;
            if (accountInfo.totalEquity) {
              accountStatusMessage += `• 淨值：${accountInfo.totalEquity}\n`;
            }
            if (Array.isArray(accountInfo.balances) && accountInfo.balances.length > 0) {
              accountStatusMessage += `• 資產餘額：\n`;
              accountInfo.balances.slice(0, 5).forEach((balance: any) => {
                accountStatusMessage += `  - ${balance.asset}: ${balance.total} (~${balance.usdtValue} USDT)\n`;
              });
            }
            if (accountInfo.note) {
              accountStatusMessage += `\n${accountInfo.note}\n`;
            }
          }
        }
        
        // 顯示成功消息和帳戶狀態
        message.success({
          content: accountStatusMessage,
          duration: 3, // 3秒自動消失
          style: { whiteSpace: 'pre-line' } // 支持換行
        });
        
        // 重新載入配置列表以更新狀態
        await loadApiConfigs();
      } else {
        // 顯示失敗的詳細信息
        let errorMessage = `${config.name} API 連接測試失敗！\n\n`;
        
        const testResult = testResults[config.exchange];
        if (testResult && !testResult.success) {
          errorMessage += `${testResult.message}\n`;
          if (testResult.error_code) {
            errorMessage += `錯誤代碼: ${testResult.error_code}\n`;
          }
        }
        
        message.error({
          content: errorMessage,
          duration: 3, // 3秒自動消失
          style: { whiteSpace: 'pre-line' }
        });
        
        // 重新載入配置列表以更新狀態
        await loadApiConfigs();
      }
      
    } catch (error: any) {
      logger.error('API Test Error', { message: error instanceof Error ? error.message : 'Request failed' }, 'SettingsPage');
      message.error(`API 連接測試失敗: ${error.message || '未知錯誤'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      {/* 頁面標題 */}
      <div style={{ marginBottom: 24 }}>
        <Title level={2} style={{ margin: 0, color: '#fff' }}>
          ⚙️ 系統設定
        </Title>
      </div>

                        <div>
        {/* API設定區域 */}
          <Card className="card-shadow">
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Button 
                  type="primary" 
                  icon={<PlusOutlined />} 
                  onClick={handleAddApi}
                  loading={loading}
                >
                  新增 API
                </Button>

              </Space>
            </div>

            {/* .env 設定提示 */}
            <Alert
              message="API 金鑰可依照個人需求綁定IP白名單，請勿開啟提幣功能"

              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />

            {/* API配置列表 */}
            {apiConfigs.length > 0 ? (
              <List
                dataSource={apiConfigs}
                renderItem={(config) => (
                  <List.Item
                    actions={[
                      <Button 
                        type="link" 
                        icon={<EditOutlined />} 
                        onClick={() => handleEditApi(config)}
                        loading={loading}
                      >
                        編輯
                      </Button>,
                      <Button 
                        type="link" 
                        icon={<ReloadOutlined />} 
                        onClick={() => handleTestApiConnection(config)}
                        loading={loading}
                      >
                        測試
                      </Button>,
                      <Popconfirm
                        title="確定要刪除此API配置嗎？"
                        description="刪除後將無法恢復，請謹慎操作。"
                        onConfirm={() => handleDeleteApi(config)}
                        okText="確定"
                        cancelText="取消"
                      >
                        <Button 
                          type="link" 
                          danger 
                          icon={<DeleteOutlined />}
                          loading={loading}
                        >
                          刪除
                        </Button>
                      </Popconfirm>
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<span style={{ fontSize: '24px' }}>{config.icon}</span>}
                      title={
                        <Space>
                          <span>{config.name}</span>
                          <Tag 
                            color={config.connected ? 'green' : config.hasApiKey ? 'blue' : 'orange'}
                            icon={config.connected ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                          >
                            {config.connected ? '已連接' : config.hasApiKey ? '已配置' : '未配置'}
                          </Tag>
                        </Space>
                      }
                      description={`${config.name} 交易所API配置`}
                    />
                  </List.Item>
                )}
              />
            ) : (
              <div style={{ 
                textAlign: 'center', 
                padding: '40px 0',
                color: '#999'
              }}>
                <ApiOutlined style={{ fontSize: '48px', marginBottom: '16px' }} />
                <div>尚未配置任何API</div>
                <div style={{ fontSize: '12px', marginTop: '8px' }}>
                  請在 .env 檔案中設定 API 金鑰，或點擊「新增 API」查看設定說明
                </div>
              </div>
            )}

            {/* 支援的交易所說明 */}
            <Divider style={{ margin: '32px 0 24px' }} />
            <div style={{ marginBottom: 20 }}>
              <Typography.Title level={4} style={{ color: '#fff', marginBottom: 8 }}>
                🏦 支援的交易所
              </Typography.Title>
              <Typography.Text type="secondary" style={{ fontSize: '14px' }}>
                選擇要配置的交易所。不同交易所支援的市場類型與 API 欄位不同，請依實際帳戶權限設定。
              </Typography.Text>
                    </div>
            
            <Row gutter={[20, 20]}>
              {supportedExchanges.map((exchange) => {
                // 檢查是否已配置
                const isConfigured = apiConfigs.some(config => config.exchange === exchange.key);
                const configData = apiConfigs.find(config => config.exchange === exchange.key);
                
                return (
                  <Col xs={24} sm={12} md={12} lg={6} key={exchange.key}>
                    <Card
                      style={{
                        background: 'linear-gradient(145deg, #1e2329, #2b3139)',
                        border: '1px solid #2b3139',
                        borderRadius: '8px',
                        minHeight: '156px',
                        cursor: 'pointer',
                        transition: 'all 0.3s ease',
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                      styles={{ 
                        body: {
                          padding: '18px 20px 16px',
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          gap: 14,
                          textAlign: 'left'
                        }
                      }}
                      hoverable
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-4px)';
                        e.currentTarget.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.3)';
                        e.currentTarget.style.borderColor = exchange.color;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = 'none';
                        e.currentTarget.style.borderColor = '#2b3139';
                      }}
                      onClick={() => {
                        if (isConfigured) {
                          handleEditApi(configData);
                        } else {
                          setEditingApi({ exchange: exchange.key, name: exchange.name });
                          setIsApiModalVisible(true);
                        }
                      }}
                    >
                      {/* 狀態指示器 */}
                      <div style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: isConfigured ? 
                          (configData?.connected ? '#52c41a' : '#faad14') : '#666',
                        boxShadow: isConfigured ? 
                          (configData?.connected ? '0 0 8px #52c41a' : '0 0 8px #faad14') : 'none'
                      }} />
                      
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        minHeight: 72,
                        paddingRight: 16,
                      }}>
                        {/* Logo */}
                        <div style={{ 
                          width: 58,
                          height: 58,
                          borderRadius: 8,
                          background: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid rgba(255, 255, 255, 0.06)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flex: '0 0 58px',
                          filter: isConfigured ? 'none' : 'grayscale(0.3) opacity(0.8)'
                        }}>
                          {React.cloneElement(exchange.icon as React.ReactElement, { 
                            width: 36, height: 36 
                          })}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>

                        {/* 交易所名稱 */}
                        <div style={{ 
                          fontSize: '18px', 
                          fontWeight: 700, 
                          color: '#fff',
                          marginBottom: 6,
                          lineHeight: 1.2
                        }}>
                          {exchange.name}
                        </div>
                        
                        {/* 描述 */}
                        <div style={{ 
                          fontSize: '12px', 
                          color: '#848e9c',
                          lineHeight: 1.45,
                          minHeight: 34,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden'
                        }}>
                      {exchange.description}
                    </div>
                        </div>
                      </div>
                      
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                      }}>
                        {/* 狀態標籤 */}
                        <div style={{ flex: '0 0 auto' }}>
                          <Tag 
                            color={isConfigured ? 
                              (configData?.connected ? 'success' : 'warning') : 'default'
                            }
                            style={{ 
                              fontSize: '11px',
                              borderRadius: '12px',
                              padding: '2px 8px',
                              margin: 0
                            }}
                          >
                            {isConfigured ? 
                              (configData?.connected ? '✅ 已連接' : '⚙️ 已配置') : 
                              '🔧 待配置'
                            }
                    </Tag>
                        </div>
                        
                        {/* 操作按鈕 */}
                        <div style={{
                          flex: 1,
                          padding: '5px 12px',
                          background: isConfigured ? 
                            (configData?.connected ? 'rgba(82, 196, 26, 0.1)' : 'rgba(250, 173, 20, 0.1)') :
                            'rgba(255, 255, 255, 0.05)',
                          borderRadius: '14px',
                          fontSize: '12px',
                          lineHeight: 1.2,
                          textAlign: 'center',
                          whiteSpace: 'nowrap',
                          color: isConfigured ? 
                            (configData?.connected ? '#52c41a' : '#faad14') : '#848e9c',
                          border: `1px solid ${isConfigured ? 
                            (configData?.connected ? 'rgba(82, 196, 26, 0.2)' : 'rgba(250, 173, 20, 0.2)') :
                            'rgba(255, 255, 255, 0.1)'}`
                        }}>
                          {isConfigured ? '點擊編輯' : '點擊配置'}
                        </div>
                      </div>
                      
                      {/* 裝飾性漸變 */}
                      <div style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: '2px',
                        background: `linear-gradient(90deg, ${
                          exchange.key === 'bybit' ? '#f7a600' : 
                          exchange.key === 'binance' ? '#f0b90b' :
                          exchange.key === 'okx' ? '#1890ff' : exchange.color
                        }, transparent)`
                      }} />
                  </Card>
                </Col>
                );
              })}
            </Row>
          </Card>

          {/* API配置模態框 */}
          <Modal
            title={editingApi ? `編輯 ${editingApi.name} API` : '新增 API 配置'}
            open={isApiModalVisible}
            onCancel={() => setIsApiModalVisible(false)}
            footer={null}
            width={600}
          >
            {editingApi && (
              <Alert
                message="已儲存的憑證不會顯示；只填寫要更換的欄位，留空會保留原值。"
                type="info"
                style={{ marginBottom: 16 }}
              />
            )}
            <Form
              form={apiForm}
              layout="vertical"
              onFinish={handleSaveApi}
              initialValues={{ exchange: 'bybit' }}
            >
              <Form.Item
                name="exchange"
                label="選擇交易所"
                rules={[{ required: true, message: '請選擇交易所' }]}
              >
                <Select
                  placeholder="請選擇要配置的交易所"
                  disabled={!!editingApi}
                >
                  {supportedExchanges.map((exchange) => (
                    <Select.Option 
                      key={exchange.key} 
                      value={exchange.key}
                      disabled={false} // 允許選擇所有交易所，但在保存時會有提示
                    >
                      <Space>
                        <span>{exchange.icon}</span>
                        <span>{exchange.name}</span>
                        <Tag 
                          color={exchange.status === 'active' ? 'green' : 'orange'} 
                          style={{ fontSize: '12px' }}
                        >
                          {exchange.status === 'active' ? '可用' : '開發中'}
                        </Tag>
                      </Space>
                    </Select.Option>
                  ))}
                </Select>
              </Form.Item>

              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[]}
              >
                <Input.Password placeholder="請輸入API Key（留空保留原值）" />
              </Form.Item>

              <Form.Item
                name="secret"
                label="Secret Key"
                rules={[]}
              >
                <Input.Password placeholder="請輸入Secret Key（留空保留原值）" />
              </Form.Item>

              <Form.Item shouldUpdate={(prevValues, currentValues) => prevValues.exchange !== currentValues.exchange}>
                {({ getFieldValue }) => {
                  const selectedExchange = supportedExchanges.find(e => e.key === getFieldValue('exchange'));
                  
                  return (
                    <>
                      {/* OKX 和 Bitget 需要 Passphrase 欄位 */}
                      {selectedExchange?.fields.includes('password') && (
                        <Form.Item
                          name="password"
                          label="Passphrase"
                          rules={[{ required: false, message: '請輸入 API Passphrase' }]}
                          extra={
                            selectedExchange.key === 'okx' 
                              ? 'OKX APIPassphrase 是在創建 API Key 時設置的密碼（不是登錄密碼）'
                              : selectedExchange.key === 'bitget'
                              ? 'Bitget API Passphrase 是在創建 API Key 時設置的密碼（不是登錄密碼）'
                              : undefined
                          }
                        >
                          <Input.Password placeholder="請輸入 API Passphrase（留空保留原值）" />
                        </Form.Item>
                      )}

                      {/* Aster 需要 signer（API 錢包地址） */}
                      {selectedExchange?.fields.includes('signer') && (
                        <Form.Item
                          name="signer"
                          label="Signer Address"
                          rules={[{ required: false, message: '請輸入 Signer Address' }]}
                          extra="Aster 專用：API Wallet 地址（不是主帳戶地址）"
                        >
                          <Input placeholder="請輸入 signer 地址（留空保留原值）" />
                        </Form.Item>
                      )}
                      
                      {selectedExchange?.status === 'coming_soon' && (
                        <Alert
                          message="開發中功能"
                          description={`${selectedExchange.name} 交易所功能正在開發中。您可以填入API資訊，但暫時無法保存和使用。請期待後續版本更新！`}
                          type="info"
                          showIcon
                          style={{ marginBottom: 16 }}
                        />
                      )}
                    </>
                  );
                }}
              </Form.Item>

              <Alert
                message="安全提醒"
                description="API密鑰具有交易權限，請妥善保管。建議使用子帳戶API並限制IP白名單。本系統使用真實交易平台，所有交易都將在實際市場中執行。"
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
              />

              <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
                <Space>
                  <Button onClick={() => setIsApiModalVisible(false)}>
                    取消
                  </Button>
                  <Button type="primary" htmlType="submit" loading={loading}>
                    {editingApi ? '更新配置' : '保存配置'}
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          </Modal>
                  </div>
    </div>
  );
};

export default SettingsPage;
