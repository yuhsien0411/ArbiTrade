/**
 * 資產曲線圖組件
 * 專業的淨值變化趨勢圖表
 */

import React, { useMemo } from 'react';
import { Line } from '@ant-design/plots';
import { Card, Space, Typography, Statistic, Row, Col, Empty } from 'antd';
import { 
  RiseOutlined, 
  FallOutlined, 
  LineChartOutlined,
  TrophyOutlined,
  FallOutlined as LowIcon
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { formatTimeMDHM } from '../utils/formatters';

const { Text } = Typography;

export interface AssetRecord {
  ts: number;
  datetime: string;
  totalUSDT: number;
  balances: Record<string, Record<string, number>>;
}

export interface AssetCurveData {
  current: number;
  change24h: number;
  change24hPercent: number;
  change7d: number;
  change7dPercent: number;
  highest: number;
  lowest: number;
  records: AssetRecord[];
}

interface AssetCurveChartProps {
  data: AssetCurveData | null;
  loading?: boolean;
  height?: number;
  showStats?: boolean;
}

const AssetCurveChart: React.FC<AssetCurveChartProps> = ({
  data,
  loading = false,
  height = 400,
  showStats = true
}) => {
  // 準備圖表數據
  const chartData = useMemo(() => {
    if (!data || !data.records || data.records.length === 0) {
      return [];
    }

    return data.records.map(record => ({
      time: formatTimeMDHM(record.ts), // 統一使用 formatTimeMDHM 確保時區一致
      timestamp: record.ts,
      value: record.totalUSDT,
      datetime: record.datetime
    }));
  }, [data]);

  // 計算收益率
  const returnRate = useMemo(() => {
    if (!data || data.records.length === 0) return 0;
    const first = data.records[0].totalUSDT;
    const last = data.current;
    return first > 0 ? ((last - first) / first * 100) : 0;
  }, [data]);

  // 圖表配置
  const config = {
    data: chartData,
    xField: 'time',
    yField: 'value',
    height,
    smooth: true,
    animation: {
      appear: {
        animation: 'path-in',
        duration: 1000,
      },
    },
    // 線條樣式
    lineStyle: {
      lineWidth: 3,
      stroke: '#1890ff',
    },
    // 面積填充
    areaStyle: {
      fill: 'l(270) 0:#ffffff 0.5:#d6e4ff 1:#1890ff',
      fillOpacity: 0.4,
    },
    // 數據點（只在數據少時顯示）
    point: chartData.length < 100 ? {
      size: 4,
      shape: 'circle',
      style: {
        fill: '#1890ff',
        stroke: '#fff',
        lineWidth: 2,
      },
    } : false,
    // Tooltip 配置
    tooltip: {
      showTitle: true,
      title: (datum: any) => datum.datetime || datum.time,
      formatter: (datum: any) => {
        // 計算相對第一個點的變化
        const firstValue = chartData[0]?.value || datum.value;
        const change = datum.value - firstValue;
        const changePercent = firstValue > 0 ? (change / firstValue * 100) : 0;
        
        return {
          name: '淨值',
          value: `${datum.value.toFixed(2)} USDT (${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%)`,
        };
      },
      showCrosshairs: true,
      crosshairs: {
        type: 'xy',
        line: {
          style: {
            stroke: '#1890ff',
            lineWidth: 1,
            lineDash: [4, 4],
          },
        },
      },
    },
    // X 軸配置
    xAxis: {
      title: {
        text: '時間',
        style: {
          fontSize: 12,
          fill: '#666',
        },
      },
      label: {
        autoRotate: false,
        autoHide: true,
        autoEllipsis: true,
        rotate: -45,
        offset: 10,
        style: {
          fontSize: 10,
          fill: '#666',
          textAlign: 'end',
        },
        // 只顯示部分標籤
        formatter: (text: string, item: any, index: number) => {
          // 數據點太多時，只顯示每6小時的標籤
          if (chartData.length > 200 && index % 6 !== 0) {
            return '';
          }
          // 數據點中等時，只顯示每3小時的標籤
          if (chartData.length > 100 && index % 3 !== 0) {
            return '';
          }
          return text;
        },
      },
      line: {
        style: {
          stroke: '#d9d9d9',
        },
      },
      tickLine: {
        style: {
          stroke: '#d9d9d9',
        },
      },
    },
    // Y 軸配置
    yAxis: {
      title: {
        text: '資產淨值 (USDT)',
        style: {
          fontSize: 12,
          fill: '#666',
        },
      },
      label: {
        formatter: (v: string) => {
          const num = Number(v);
          if (num >= 10000) {
            return `${(num / 10000).toFixed(1)}萬`;
          }
          return `${num.toFixed(0)}`;
        },
        style: {
          fontSize: 11,
          fill: '#666',
        },
      },
      grid: {
        line: {
          style: {
            stroke: '#f0f0f0',
            lineWidth: 1,
            lineDash: [4, 4],
          },
        },
      },
    },
    // 圖例
    legend: false,
    // 滑塊（數據多時顯示，默認顯示最近部分）
    slider: chartData.length > 168 ? {  // 7天以上才顯示滑塊
      start: Math.max(0, 1 - (168 / chartData.length)),  // 默認顯示最近7天
      end: 1,
      textStyle: {
        fontSize: 10,
      },
      handlerStyle: {
        width: 14,
        height: 24,
        fill: '#1890ff',
        radius: 4,
      },
      trendCfg: {
        isArea: true,
        areaStyle: {
          fill: '#e6f7ff',
        },
        lineStyle: {
          stroke: '#1890ff',
          lineWidth: 1,
        },
      },
    } : undefined,
  };

  // 無數據狀態
  if (!data || chartData.length === 0) {
    return (
      <Card>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暫無資產數據"
          style={{ padding: '60px 0' }}
        />
      </Card>
    );
  }

  return (
    <Card
      loading={loading}
      title={
        <Space>
          <LineChartOutlined style={{ fontSize: 20, color: '#1890ff' }} />
          <span style={{ fontSize: 16, fontWeight: 600 }}>資產曲線</span>
        </Space>
      }
      extra={
        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            數據點: {chartData.length} 個
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            期間: {dayjs(chartData[0].timestamp).format('MM-DD')} ~ {dayjs(chartData[chartData.length - 1].timestamp).format('MM-DD')}
          </Text>
        </Space>
      }
      bodyStyle={{ padding: showStats ? '24px' : '24px 24px 12px' }}
    >
      {/* 統計卡片 */}
      {showStats && (
        <Row gutter={16} style={{ marginBottom: 24 }}>
          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: '#f0f5ff', border: 'none' }}>
              <Statistic
                title={<Text style={{ fontSize: 12, color: '#666' }}>當前淨值</Text>}
                value={data.current}
                precision={2}
                suffix="USDT"
                valueStyle={{ color: '#1890ff', fontSize: 18, fontWeight: 600 }}
              />
            </Card>
          </Col>
          
          <Col xs={12} sm={6}>
            <Card 
              size="small" 
              style={{ 
                background: data.change24h >= 0 ? '#f6ffed' : '#fff2f0', 
                border: 'none' 
              }}
            >
              <Statistic
                title={<Text style={{ fontSize: 12, color: '#666' }}>24小時</Text>}
                value={Math.abs(data.change24h)}
                precision={2}
                prefix={data.change24h >= 0 ? <RiseOutlined /> : <FallOutlined />}
                suffix={`USDT (${data.change24hPercent >= 0 ? '+' : ''}${data.change24hPercent.toFixed(2)}%)`}
                valueStyle={{ 
                  color: data.change24h >= 0 ? '#52c41a' : '#ff4d4f',
                  fontSize: 16,
                  fontWeight: 600
                }}
              />
            </Card>
          </Col>

          <Col xs={12} sm={6}>
            <Card 
              size="small" 
              style={{ 
                background: data.change7d >= 0 ? '#f6ffed' : '#fff2f0', 
                border: 'none' 
              }}
            >
              <Statistic
                title={<Text style={{ fontSize: 12, color: '#666' }}>7天</Text>}
                value={Math.abs(data.change7d)}
                precision={2}
                prefix={data.change7d >= 0 ? <RiseOutlined /> : <FallOutlined />}
                suffix={`USDT (${data.change7dPercent >= 0 ? '+' : ''}${data.change7dPercent.toFixed(2)}%)`}
                valueStyle={{ 
                  color: data.change7d >= 0 ? '#52c41a' : '#ff4d4f',
                  fontSize: 16,
                  fontWeight: 600
                }}
              />
            </Card>
          </Col>

          <Col xs={12} sm={6}>
            <Card size="small" style={{ background: '#fafafa', border: 'none' }}>
              <Statistic
                title={<Text style={{ fontSize: 12, color: '#666' }}>期間收益率</Text>}
                value={Math.abs(returnRate)}
                precision={2}
                prefix={returnRate >= 0 ? <RiseOutlined /> : <FallOutlined />}
                suffix="%"
                valueStyle={{ 
                  color: returnRate >= 0 ? '#52c41a' : '#ff4d4f',
                  fontSize: 16,
                  fontWeight: 600
                }}
              />
            </Card>
          </Col>
        </Row>
      )}

      {/* 附加統計信息 */}
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Space>
            <TrophyOutlined style={{ color: '#faad14', fontSize: 16 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>最高:</Text>
            <Text strong style={{ fontSize: 14 }}>{data.highest.toFixed(2)} USDT</Text>
          </Space>
        </Col>
        <Col span={12}>
          <Space>
            <LowIcon style={{ color: '#ff4d4f', fontSize: 16 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>最低:</Text>
            <Text strong style={{ fontSize: 14 }}>{data.lowest.toFixed(2)} USDT</Text>
          </Space>
        </Col>
      </Row>

      {/* 圖表 */}
      <div style={{ marginTop: 16 }}>
        <Line {...config} />
      </div>

      {/* 說明文字 */}
      <div style={{ marginTop: 12, textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          💡 提示：圖表展示賬戶總淨值變化趨勢，數據每小時記錄一次
        </Text>
      </div>
    </Card>
  );
};

export default AssetCurveChart;

