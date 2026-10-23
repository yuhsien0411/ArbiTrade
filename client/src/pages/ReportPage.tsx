/**
 * 報告頁面
 * 顯示套利和 TWAP 策略的績效報告
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Row, Col, Card, Statistic, Table, Space, Typography, Tag, Button,
  DatePicker, Alert, Tooltip, App as AntdApp
} from 'antd';
import {
  DollarOutlined, TrophyOutlined, SwapOutlined, CheckCircleOutlined,
  ReloadOutlined, DownloadOutlined, FilterOutlined
} from '@ant-design/icons';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../store';
import { apiService } from '../services/api';
import {
  setLoading,
  setError,
  setSummary,
  setArbitrageRecords,
  setTwapRecords,
  setNetValueStats
} from '../store/slices/reportSlice';
import type { 
  ReportSummary, 
  ArbitrageReportRecord, 
  TwapReportRecord,
  NetValueStats
} from '../store/slices/reportSlice';
import logger from '../utils/logger';
import dayjs, { Dayjs } from 'dayjs';
import AssetCurveChart from '../components/AssetCurveChart';

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

const ReportPage: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntdApp.useApp();
  const { summary, arbitrageRecords, twapRecords, netValueStats, loading, error } = useSelector(
    (state: RootState) => state.report
  );

  const [activeTab, setActiveTab] = useState<'all' | 'arbitrage' | 'twap'>('all');
  // 默認顯示最近7天的數據
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>([
    dayjs().subtract(7, 'day').startOf('day'),
    dayjs().endOf('day')
  ]);

  // 載入報告數據
  const loadReportData = useCallback(async () => {
    try {
      dispatch(setLoading(true));

      const params: any = {};
      if (dateRange) {
        params.from_date = dateRange[0].format('YYYY-MM-DD');
        params.to_date = dateRange[1].format('YYYY-MM-DD');
      }

      // 載入總覽數據
      const summaryRes: any = await apiService.getReportSummary({
        ...params,
        type: activeTab
      });

      if (summaryRes?.success && summaryRes?.data) {
        dispatch(setSummary(summaryRes.data as ReportSummary));
      }

      // 載入套利報告
      if (activeTab === 'all' || activeTab === 'arbitrage') {
        const arbRes: any = await apiService.getArbitrageReport(params);
        if (arbRes?.success && Array.isArray(arbRes?.data)) {
          dispatch(setArbitrageRecords(arbRes.data as ArbitrageReportRecord[]));
        }
      }

      // 載入 TWAP 報告
      if (activeTab === 'all' || activeTab === 'twap') {
        const twapRes: any = await apiService.getTwapReport(params);
        if (twapRes?.success && Array.isArray(twapRes?.data)) {
          dispatch(setTwapRecords(twapRes.data as TwapReportRecord[]));
        }
      }

      // 載入淨值統計（使用與報告相同的日期範圍）
      try {
        const netValueParams = {
          from_date: params.from_date || dayjs().subtract(7, 'day').format('YYYY-MM-DD'),
          to_date: params.to_date || dayjs().format('YYYY-MM-DD')
        };
        const netValueRes: any = await apiService.getNetValueStats(netValueParams);
        if (netValueRes?.success && netValueRes?.data) {
          dispatch(setNetValueStats(netValueRes.data as NetValueStats));
        }
      } catch (err) {
        logger.warn('載入淨值統計失敗', err, 'ReportPage');
        // 不影響主流程，繼續執行
      }

      dispatch(setLoading(false));
    } catch (err: any) {
      logger.error('載入報告數據失敗', err, 'ReportPage');
      dispatch(setError(err.message || '載入失敗'));
      message.error('載入報告數據失敗');
    }
  }, [dispatch, dateRange, activeTab, message]);

  // 初始載入
  useEffect(() => {
    loadReportData();
  }, [loadReportData]);

  // 快捷日期選擇
  const handleQuickDate = (days: number) => {
    if (days === 0) {
      // 今日
      setDateRange([dayjs().startOf('day'), dayjs().endOf('day')]);
    } else if (days === -1) {
      // 全部
      setDateRange(null);
    } else {
      // 近N日
      setDateRange([dayjs().subtract(days - 1, 'day').startOf('day'), dayjs().endOf('day')]);
    }
  };

  // 匯出 CSV
  const exportToCSV = (data: any[], filename: string) => {
    if (!data || data.length === 0) {
      message.warning('沒有數據可匯出');
      return;
    }

    const headers = Object.keys(data[0]);
    const csvContent = [
      headers.join(','),
      ...data.map(row => 
        headers.map(header => {
          const value = row[header];
          // 處理包含逗號的值
          if (typeof value === 'string' && value.includes(',')) {
            return `"${value}"`;
          }
          return value;
        }).join(',')
      )
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${filename}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    link.click();
    message.success('匯出成功');
  };

  // 套利報告表格列
  const arbitrageColumns = [
    {
      title: '時間',
      dataIndex: 'lastTime',
      key: 'lastTime',
      render: (time: number) => dayjs(time).format('MM-DD HH:mm:ss'),
      width: 130
    },
    {
      title: '策略ID',
      dataIndex: 'strategyId',
      key: 'strategyId',
      render: (id: string) => (
        <Tooltip title={id}>
          <Text code style={{ fontSize: '11px' }}>{id.slice(-8)}</Text>
        </Tooltip>
      ),
      width: 100
    },
    {
      title: '交易對',
      key: 'pair',
      render: (_: any, record: ArbitrageReportRecord) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: '12px', color: record.leg1Side === 'buy' ? '#52c41a' : '#ff4d4f' }}>
            {record.leg1Exchange} {record.leg1Symbol} ({record.leg1Type})
          </Text>
          <Text style={{ fontSize: '12px', color: record.leg2Side === 'buy' ? '#52c41a' : '#ff4d4f' }}>
            {record.leg2Exchange} {record.leg2Symbol} ({record.leg2Type})
          </Text>
        </Space>
      ),
      width: 200
    },
    {
      title: '平均價差',
      dataIndex: 'avgSpreadPercent',
      key: 'avgSpreadPercent',
      render: (spread: number) => (
        <Text className={spread > 0 ? 'price-positive' : 'price-negative'} strong>
          {spread.toFixed(4)}%
        </Text>
      ),
      sorter: (a: ArbitrageReportRecord, b: ArbitrageReportRecord) => a.avgSpreadPercent - b.avgSpreadPercent,
      width: 100
    },
    {
      title: '執行次數',
      key: 'executions',
      render: (_: any, record: ArbitrageReportRecord) => (
        <Text>{record.successCount}/{record.maxExecs}</Text>
      ),
      width: 100
    },
    {
      title: '總成交量',
      dataIndex: 'totalVolume',
      key: 'totalVolume',
      render: (volume: number) => volume.toFixed(4),
      sorter: (a: ArbitrageReportRecord, b: ArbitrageReportRecord) => a.totalVolume - b.totalVolume,
      width: 100
    },
    {
      title: '估算盈虧 (USDT)',
      dataIndex: 'estimatedPnl',
      key: 'estimatedPnl',
      render: (pnl: number) => (
        <Text className={pnl > 0 ? 'price-positive' : pnl < 0 ? 'price-negative' : ''} strong>
          {pnl > 0 ? '+' : ''}{pnl.toFixed(2)}
        </Text>
      ),
      sorter: (a: ArbitrageReportRecord, b: ArbitrageReportRecord) => a.estimatedPnl - b.estimatedPnl,
      width: 120
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          '完成': 'success',
          '進行中': 'processing',
          '失敗': 'error'
        };
        return <Tag color={colorMap[status] || 'default'}>{status}</Tag>;
      },
      width: 80
    }
  ];

  // TWAP 報告表格列
  const twapColumns = [
    {
      title: '時間',
      dataIndex: 'lastTime',
      key: 'lastTime',
      render: (time: number) => dayjs(time).format('MM-DD HH:mm:ss'),
      width: 130
    },
    {
      title: '策略ID',
      dataIndex: 'strategyId',
      key: 'strategyId',
      render: (id: string) => (
        <Tooltip title={id}>
          <Text code style={{ fontSize: '11px' }}>{id.slice(-8)}</Text>
        </Tooltip>
      ),
      width: 100
    },
    {
      title: '交易對',
      key: 'pair',
      render: (_: any, record: TwapReportRecord) => {
        const getSymbolWithSuffix = (symbol: string, type: string) => {
          return type === 'linear' ? `${symbol}.P` : symbol;
        };
        
        return (
          <Space direction="vertical" size={0}>
            <Text style={{ fontSize: '12px', color: record.leg1Side === 'buy' ? '#52c41a' : '#ff4d4f' }}>
              {record.leg1Exchange} {getSymbolWithSuffix(record.leg1Symbol, record.leg1Type)} ({record.leg1Type})
            </Text>
            <Text style={{ fontSize: '12px', color: record.leg2Side === 'buy' ? '#52c41a' : '#ff4d4f' }}>
              {record.leg2Exchange} {getSymbolWithSuffix(record.leg2Symbol, record.leg2Type)} ({record.leg2Type})
            </Text>
          </Space>
        );
      },
      width: 200
    },
    {
      title: '執行進度',
      key: 'progress',
      render: (_: any, record: TwapReportRecord) => (
        <Text>{record.executedCount}/{record.targetCount}</Text>
      ),
      width: 100
    },
    {
      title: '單次/總量',
      key: 'volume',
      render: (_: any, record: TwapReportRecord) => (
        <Space direction="vertical" size={0}>
          <Text style={{ fontSize: '11px' }}>單次: {record.sliceQty.toFixed(4)}</Text>
          <Text style={{ fontSize: '11px' }}>總量: {record.totalVolume.toFixed(4)}</Text>
        </Space>
      ),
      width: 120
    },
    {
      title: '平均間隔',
      dataIndex: 'avgInterval',
      key: 'avgInterval',
      render: (interval: number) => `${interval.toFixed(1)}秒`,
      width: 100
    },
    {
      title: '估算盈虧 (USDT)',
      dataIndex: 'estimatedPnl',
      key: 'estimatedPnl',
      render: (pnl: number) => (
        <Text className={pnl > 0 ? 'price-positive' : pnl < 0 ? 'price-negative' : ''} strong>
          {pnl > 0 ? '+' : ''}{pnl.toFixed(2)}
        </Text>
      ),
      sorter: (a: TwapReportRecord, b: TwapReportRecord) => a.estimatedPnl - b.estimatedPnl,
      width: 120
    },
    {
      title: '狀態',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          '完成': 'success',
          '暫停': 'warning',
          '取消': 'error',
          '失敗': 'error'
        };
        return <Tag color={colorMap[status] || 'default'}>{status}</Tag>;
      },
      width: 80
    }
  ];

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      <style>
        {`
          .price-positive {
            color: #52c41a !important;
          }
          .price-negative {
            color: #ff4d4f !important;
          }
        `}
      </style>

      {/* 頁面標題 */}
      <div style={{ marginBottom: 24 }}>
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Title level={2} style={{ margin: 0, color: '#fff' }}>
            📊 績效報告
          </Title>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={loadReportData} loading={loading}>
              刷新
            </Button>
          </Space>
        </Space>
      </div>

      {/* 錯誤提示 */}
      {error && (
        <Alert
          message="載入失敗"
          description={error}
          type="error"
          showIcon
          closable
          style={{ marginBottom: 24 }}
        />
      )}

      {/* 篩選條件 */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={16} align="middle">
          <Col span={8}>
            <Space>
              <FilterOutlined />
              <Text strong>日期範圍：</Text>
              <RangePicker
                value={dateRange}
                onChange={(dates) => setDateRange(dates as [Dayjs, Dayjs] | null)}
                format="YYYY-MM-DD"
                style={{ width: 280 }}
              />
            </Space>
          </Col>
          <Col span={16}>
            <Space>
              <Button size="small" onClick={() => handleQuickDate(0)}>今日</Button>
              <Button size="small" onClick={() => handleQuickDate(7)}>近7日</Button>
              <Button size="small" onClick={() => handleQuickDate(30)}>近30日</Button>
              <Button size="small" onClick={() => handleQuickDate(-1)}>全部</Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 資產曲線圖 */}
      <AssetCurveChart 
        data={netValueStats} 
        loading={loading}
        height={400}
        showStats={true}
      />

      {/* 統計卡片 */}
      {summary && (
        <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
          <Col xs={24} sm={12} md={6}>
            <Card className="stat-card">
              <Statistic
                title="總盈虧 (USDT)"
                value={summary.totalPnl}
                precision={2}
                prefix={<DollarOutlined />}
                valueStyle={{ 
                  color: summary.totalPnl > 0 ? '#52c41a' : 
                         summary.totalPnl < 0 ? '#ff4d4f' : '#8c8c8c' 
                }}
              />
            </Card>
          </Col>

          <Col xs={24} sm={12} md={6}>
            <Card className="stat-card">
              <Statistic
                title="勝率"
                value={summary.winRate}
                precision={2}
                suffix="%"
                prefix={<TrophyOutlined />}
                valueStyle={{ color: summary.winRate >= 50 ? '#52c41a' : '#ff4d4f' }}
              />
            </Card>
          </Col>

          <Col xs={24} sm={12} md={6}>
            <Card className="stat-card">
              <Statistic
                title="總成交量"
                value={summary.totalVolume}
                precision={4}
                prefix={<SwapOutlined />}
                valueStyle={{ color: '#1890ff' }}
              />
            </Card>
          </Col>

          <Col xs={24} sm={12} md={6}>
            <Card className="stat-card">
              <Statistic
                title="完成策略數"
                value={summary.completedStrategies}
                prefix={<CheckCircleOutlined />}
                valueStyle={{ color: '#722ed1' }}
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* 切換標籤 */}
      <Card style={{ marginBottom: 16 }}>
        <Space size="large">
          <Button
            type={activeTab === 'all' ? 'primary' : 'default'}
            onClick={() => setActiveTab('all')}
          >
            全部報告
          </Button>
          <Button
            type={activeTab === 'arbitrage' ? 'primary' : 'default'}
            onClick={() => setActiveTab('arbitrage')}
          >
            套利報告
          </Button>
          <Button
            type={activeTab === 'twap' ? 'primary' : 'default'}
            onClick={() => setActiveTab('twap')}
          >
            TWAP 報告
          </Button>
        </Space>
      </Card>

      {/* 套利報告表格 */}
      {(activeTab === 'all' || activeTab === 'arbitrage') && (
        <Card
          title={
            <Space>
              <span>🔄 套利執行報告</span>
              <Tag color="blue">{arbitrageRecords.length} 條記錄</Tag>
            </Space>
          }
          extra={
            <Button
              icon={<DownloadOutlined />}
              size="small"
              onClick={() => exportToCSV(arbitrageRecords, '套利報告')}
            >
              匯出 CSV
            </Button>
          }
          style={{ marginBottom: 16 }}
          className="card-shadow"
        >
          <Table
            columns={arbitrageColumns}
            dataSource={arbitrageRecords}
            rowKey="strategyId"
            loading={loading}
            size="small"
            scroll={{ x: 1000 }}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 條` }}
            locale={{ emptyText: '暫無套利報告數據' }}
          />
        </Card>
      )}

      {/* TWAP 報告表格 */}
      {(activeTab === 'all' || activeTab === 'twap') && (
        <Card
          title={
            <Space>
              <span>⏰ TWAP 執行報告</span>
              <Tag color="blue">{twapRecords.length} 條記錄</Tag>
            </Space>
          }
          extra={
            <Button
              icon={<DownloadOutlined />}
              size="small"
              onClick={() => exportToCSV(twapRecords, 'TWAP報告')}
            >
              匯出 CSV
            </Button>
          }
          className="card-shadow"
        >
          <Table
            columns={twapColumns}
            dataSource={twapRecords}
            rowKey="strategyId"
            loading={loading}
            size="small"
            scroll={{ x: 1000 }}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (total) => `共 ${total} 條` }}
            locale={{ emptyText: '暫無 TWAP 報告數據' }}
          />
        </Card>
      )}
    </div>
  );
};

export default ReportPage;

