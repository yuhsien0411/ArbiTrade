/**
 * 系統介紹頁面
 */

import React from 'react';
import { Row, Col, Card, Space, Typography, Tag, Divider } from 'antd';
import {
  ThunderboltOutlined,
  SwapOutlined,
  ClockCircleOutlined,
  FundOutlined,
  SafetyOutlined,
  RocketOutlined,
  GlobalOutlined,
  BarChartOutlined,
  ApiOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;

const Dashboard: React.FC = () => {
  const features = [
    {
      icon: <SwapOutlined style={{ fontSize: 32, color: '#f0b90b' }} />,
      title: '跨交易所套利',
      description: '同時追蹤兩個交易腿的報價、深度與價差，協助快速建立並執行套利交易。',
      color: '#f0b90b',
    },
    {
      icon: <ClockCircleOutlined style={{ fontSize: 32, color: '#722ed1' }} />,
      title: 'TWAP 拆單執行',
      description: '把大額交易拆成多筆小單分段完成，降低滑價與市場衝擊，讓執行節奏更可控。',
      color: '#722ed1',
    },
    {
      icon: <FundOutlined style={{ fontSize: 32, color: '#1890ff' }} />,
      title: '倉位監控',
      description: '集中查看各交易所持倉、資產淨值與風險暴露，讓資金分布與部位變化一眼可讀。',
      color: '#1890ff',
    },
    {
      icon: <BarChartOutlined style={{ fontSize: 32, color: '#52c41a' }} />,
      title: '績效分析',
      description: '整理交易紀錄、資產曲線與報表數據，協助追蹤策略表現並回看每次執行結果。',
      color: '#52c41a',
    },
    {
      icon: <SafetyOutlined style={{ fontSize: 32, color: '#faad14' }} />,
      title: '風險控制',
      description: '透過 API 權限、交易參數與執行狀態檢查，降低誤操作與異常行情帶來的風險。',
      color: '#faad14',
    },
    {
      icon: <GlobalOutlined style={{ fontSize: 32, color: '#eb2f96' }} />,
      title: '多交易所支援',
      description: '目前支援 Binance、Bybit、OKX、Bitget、Aster 與 MEXC，依交易所能力提供現貨或合約功能。',
      color: '#eb2f96',
    },
  ];

  const exchanges = [
    { name: 'Binance', color: '#f0b90b' },
    { name: 'Bybit', color: '#fcd535' },
    { name: 'OKX', color: '#1890ff' },
    { name: 'Bitget', color: '#52c41a' },
    { name: 'Aster', color: '#7c3aed' },
    { name: 'MEXC', color: '#1677ff' },
  ];

  const techStack = [
    { name: 'React + TypeScript', desc: '現代化前端框架' },
    { name: 'Python FastAPI', desc: '高性能後端 API' },
    { name: 'Redux Toolkit', desc: '狀態管理' },
    { name: 'TradingView Charts', desc: '專業圖表展示' },
    { name: 'WebSocket', desc: '實時數據推送' },
  ];

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh', padding: '24px' }}>
      {/* 主標題區 */}
      <div style={{ textAlign: 'center', marginBottom: 48, padding: '40px 0' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16 }}>
            <ThunderboltOutlined style={{ fontSize: 64, color: '#f0b90b' }} />
            <Title level={1} style={{ margin: 0, color: '#fff', fontSize: 48 }}>
              ArbiTrade
            </Title>
          </div>
          <Title level={2} style={{ margin: 0, color: '#848e9c', fontWeight: 400 }}>
            多交易所量化套利與執行平台
          </Title>
          <Paragraph style={{ color: '#848e9c', fontSize: 18, maxWidth: 800, margin: '0 auto' }}>
            串接主流加密貨幣交易所，集中監控行情、倉位與資產淨值，
            並透過套利交易與 TWAP 拆單工具，讓策略執行更清楚、更穩定。
          </Paragraph>
        </Space>
      </div>

      {/* 核心功能 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <RocketOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          核心功能
        </Title>
        <Row gutter={[24, 24]}>
          {features.map((feature, index) => (
            <Col xs={24} sm={12} lg={8} key={index}>
              <Card
                hoverable
                style={{
                  background: '#1e2329',
                  border: `1px solid ${feature.color}33`,
                  borderRadius: 12,
                  height: '100%',
                }}
                bodyStyle={{ padding: 24 }}
              >
                <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                  <div>{feature.icon}</div>
                  <Title level={4} style={{ margin: 0, color: '#fff' }}>
                    {feature.title}
                  </Title>
                  <Paragraph style={{ color: '#848e9c', margin: 0, fontSize: 14 }}>
                    {feature.description}
                  </Paragraph>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <Divider style={{ borderColor: '#2b3139', margin: '48px 0' }} />

      {/* 支持的交易所 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <GlobalOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          支援的交易所
        </Title>
        <Row gutter={[16, 16]} justify="center">
          {exchanges.map((exchange, index) => (
            <Col key={index}>
              <Card
                style={{
                  background: '#1e2329',
                  border: `1px solid ${exchange.color}33`,
                  borderRadius: 8,
                  minWidth: 150,
                  textAlign: 'center',
                }}
                bodyStyle={{ padding: '20px 32px' }}
              >
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: 600 }}>
                  {exchange.name}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      <Divider style={{ borderColor: '#2b3139', margin: '48px 0' }} />

      {/* 技術架構 */}
      <div style={{ marginBottom: 64 }}>
        <Title level={2} style={{ color: '#fff', marginBottom: 32, textAlign: 'center' }}>
          <ApiOutlined style={{ marginRight: 8, color: '#f0b90b' }} />
          技術架構
        </Title>
        <Row gutter={[16, 16]} justify="center">
          {techStack.map((tech, index) => (
            <Col xs={24} sm={12} md={8} lg={6} key={index}>
              <Card
                style={{
                  background: '#1e2329',
                  border: '1px solid #2b3139',
                  borderRadius: 8,
                  textAlign: 'center',
                }}
                bodyStyle={{ padding: '20px' }}
              >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 600, display: 'block', marginBottom: 8 }}>
                  {tech.name}
                </Text>
                <Text style={{ color: '#848e9c', fontSize: 12, display: 'block' }}>
                  {tech.desc}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
      </div>

      {/* 開始使用 */}
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <Card
          style={{
            background: 'linear-gradient(135deg, rgba(240, 185, 11, 0.1) 0%, rgba(240, 185, 11, 0.05) 100%)',
            border: '1px solid #f0b90b33',
            borderRadius: 12,
            maxWidth: 600,
            margin: '0 auto',
          }}
          bodyStyle={{ padding: 32 }}
        >
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <ThunderboltOutlined style={{ fontSize: 48, color: '#f0b90b' }} />
            <Title level={3} style={{ margin: 0, color: '#fff' }}>
              準備開始交易？
            </Title>
            <Paragraph style={{ color: '#848e9c', fontSize: 16, margin: 0 }}>
              前往 <Tag color="gold" style={{ fontSize: 14, padding: '4px 12px' }}>交易</Tag> 開始創建您的第一個套利策略
            </Paragraph>
          </Space>
        </Card>
      </div>
    </div>
  );
};

export default Dashboard;
