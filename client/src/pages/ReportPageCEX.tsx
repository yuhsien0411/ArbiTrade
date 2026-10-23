import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Row, Col, Button, Space, Typography, Empty, Spin } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiService } from '../services/api';
import dayjs from 'dayjs';

const { Text, Title } = Typography;

type TimeRange = 'day' | 'week' | 'month' | 'all';
type ExchangeKey = 'total' | 'bybit' | 'binance' | 'okx' | 'bitget' | 'aster' | 'mexc';
type ExchangeOnlyKey = Exclude<ExchangeKey, 'total'>;

interface NetValueRecord {
  timestamp: number;
  datetime: string;
  totalValue: number;
  exchangeTotals?: Partial<Record<ExchangeOnlyKey, number>>;
  exchanges?: Partial<Record<ExchangeOnlyKey, Record<string, number>>>;
}

interface ChartDataPoint {
  time: string;
  timestamp: number;
  total?: number;
  bybit?: number;
  binance?: number;
  okx?: number;
  bitget?: number;
  aster?: number;
  mexc?: number;
}

const EXCHANGES: Array<{ key: ExchangeKey; label: string; color: string; activeText: string }> = [
  { key: 'total', label: '總計', color: '#7b61ff', activeText: '#fff' },
  { key: 'bybit', label: 'Bybit', color: '#f5c542', activeText: '#000' },
  { key: 'binance', label: 'Binance', color: '#ff2d2d', activeText: '#fff' },
  { key: 'okx', label: 'OKX', color: '#e8e8e8', activeText: '#000' },
  { key: 'bitget', label: 'Bitget', color: '#17c9c9', activeText: '#000' },
  { key: 'aster', label: 'Aster', color: '#ff7a1a', activeText: '#000' },
  { key: 'mexc', label: 'MEXC', color: '#00c087', activeText: '#000' },
];

const EXCHANGE_ONLY = EXCHANGES.filter((item) => item.key !== 'total') as Array<{
  key: ExchangeOnlyKey;
  label: string;
  color: string;
  activeText: string;
}>;

const rangeLabels: Record<TimeRange, string> = {
  day: '日',
  week: '週',
  month: '月',
  all: '全部',
};

const cardStyle: React.CSSProperties = {
  background: '#1e2329',
  border: '1px solid #2b3139',
  borderRadius: '8px',
  height: '100%',
};

const ReportPageCEX: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [netValueData, setNetValueData] = useState<NetValueRecord[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>('week');
  const [selectedExchanges, setSelectedExchanges] = useState<Record<ExchangeKey, boolean>>({
    total: true,
    bybit: true,
    binance: true,
    okx: true,
    bitget: true,
    aster: true,
    mexc: true,
  });

  const loadNetValueData = useCallback(async () => {
    try {
      setLoading(true);

      let fromDate: string | undefined;
      const toDate = dayjs().format('YYYY-MM-DD');

      switch (timeRange) {
        case 'day':
          fromDate = dayjs().subtract(1, 'day').format('YYYY-MM-DD');
          break;
        case 'week':
          fromDate = dayjs().subtract(7, 'day').format('YYYY-MM-DD');
          break;
        case 'month':
          fromDate = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
          break;
        case 'all':
          fromDate = undefined;
          break;
      }

      const params = fromDate ? { from_date: fromDate, to_date: toDate } : {};
      const response: any = await apiService.getNetValueHistory(params);
      setNetValueData(response?.success && Array.isArray(response?.data) ? response.data : []);
    } catch (error) {
      console.error('Failed to load net value history', error);
      setNetValueData([]);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    loadNetValueData();
  }, [loadNetValueData]);

  const readExchangeValue = (
    record: NetValueRecord,
    exchange: ExchangeOnlyKey,
    zeroAsUndefined = false,
  ): number | undefined => {
    const totalFromBackend = record.exchangeTotals?.[exchange];
    if (typeof totalFromBackend === 'number') {
      return zeroAsUndefined && totalFromBackend === 0 ? undefined : totalFromBackend;
    }

    const balances = record.exchanges?.[exchange];
    if (!balances) return zeroAsUndefined ? undefined : 0;

    const value = Object.values(balances).reduce((sum, item) => sum + Number(item || 0), 0);
    return zeroAsUndefined && value === 0 ? undefined : value;
  };

  const currentValues = useMemo(() => {
    const empty = EXCHANGE_ONLY.reduce(
      (acc, item) => ({ ...acc, [item.key]: 0 }),
      { total: 0, totalChange: 0, totalChangePercent: 0 } as Record<ExchangeKey, number> & {
        totalChange: number;
        totalChangePercent: number;
      },
    );

    if (netValueData.length === 0) return empty;

    const latest = netValueData[netValueData.length - 1];
    const earliest = netValueData[0];
    const totalValue = Number(latest.totalValue || 0);
    const earliestTotal = Number(earliest.totalValue || 0);
    const totalChange = totalValue - earliestTotal;

    return {
      ...empty,
      total: totalValue,
      bybit: readExchangeValue(latest, 'bybit') || 0,
      binance: readExchangeValue(latest, 'binance') || 0,
      okx: readExchangeValue(latest, 'okx') || 0,
      bitget: readExchangeValue(latest, 'bitget') || 0,
      aster: readExchangeValue(latest, 'aster') || 0,
      mexc: readExchangeValue(latest, 'mexc') || 0,
      totalChange,
      totalChangePercent: earliestTotal > 0 ? (totalChange / earliestTotal) * 100 : 0,
    };
  }, [netValueData]);

  const chartData = useMemo<ChartDataPoint[]>(() => {
    return netValueData.map((record) => ({
      time: dayjs(record.timestamp * 1000).format('MM-DD HH:mm'),
      timestamp: record.timestamp,
      total: record.totalValue !== 0 ? record.totalValue : undefined,
      bybit: readExchangeValue(record, 'bybit', true),
      binance: readExchangeValue(record, 'binance', true),
      okx: readExchangeValue(record, 'okx', true),
      bitget: readExchangeValue(record, 'bitget', true),
      aster: readExchangeValue(record, 'aster', true),
      mexc: readExchangeValue(record, 'mexc', true),
    }));
  }, [netValueData]);

  const toggleExchange = (exchange: ExchangeKey) => {
    setSelectedExchanges((prev) => ({
      ...prev,
      [exchange]: !prev[exchange],
    }));
  };

  const customTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || payload.length === 0) return null;

    return (
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.85)',
          border: '1px solid #333',
          borderRadius: '4px',
          padding: '12px',
          color: '#fff',
        }}
      >
        <Text style={{ color: '#999', fontSize: '12px', display: 'block', marginBottom: '8px' }}>
          {label}
        </Text>
        {payload.map((item: any) => (
          <div key={item.dataKey} style={{ marginBottom: '4px' }}>
            <Text style={{ color: item.color, fontSize: '13px' }}>
              {item.name}: <strong>{Number(item.value || 0).toFixed(2)} USDT</strong>
            </Text>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh', padding: '0' }}>
      <Row gutter={[12, 12]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} md={8}>
          <Card style={cardStyle} bodyStyle={{ padding: '16px' }}>
            <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
              總淨值 (USDT)
            </Text>
            <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
              {currentValues.total.toFixed(2)}
            </Text>
            <Text
              style={{
                color: currentValues.totalChange >= 0 ? '#0ecb81' : '#f6465d',
                fontSize: '13px',
                display: 'block',
                marginTop: '8px',
              }}
            >
              {currentValues.totalChange >= 0 ? '+' : ''}
              {currentValues.totalChange.toFixed(2)} ({currentValues.totalChangePercent >= 0 ? '+' : ''}
              {currentValues.totalChangePercent.toFixed(2)}%)
            </Text>
          </Card>
        </Col>

        {EXCHANGE_ONLY.map((exchange) => (
          <Col key={exchange.key} xs={24} sm={12} md={8}>
            <Card style={cardStyle} bodyStyle={{ padding: '16px' }}>
              <Text style={{ color: '#848e9c', fontSize: '13px', display: 'block', marginBottom: '8px' }}>
                {exchange.label} (USDT)
              </Text>
              <Text style={{ color: '#ffffff', fontSize: '24px', fontWeight: 'bold', display: 'block', lineHeight: '1.2' }}>
                {currentValues[exchange.key].toFixed(2)}
              </Text>
            </Card>
          </Col>
        ))}
      </Row>

      <Card
        style={{
          background: '#1e2329',
          border: '1px solid #2b3139',
          borderRadius: '8px',
          marginBottom: 24,
        }}
        bodyStyle={{ padding: '16px 24px' }}
      >
        <Row align="middle" justify="space-between" gutter={[16, 16]}>
          <Col>
            <Space size="middle">
              <Text style={{ color: '#848e9c', fontSize: '14px' }}>時間範圍：</Text>
              <Space size="small">
                {(Object.keys(rangeLabels) as TimeRange[]).map((range) => (
                  <Button
                    key={range}
                    type={timeRange === range ? 'primary' : 'default'}
                    size="small"
                    onClick={() => setTimeRange(range)}
                    style={{
                      background: timeRange === range ? '#f0b90b' : 'transparent',
                      borderColor: timeRange === range ? '#f0b90b' : '#2b3139',
                      color: timeRange === range ? '#000' : '#848e9c',
                    }}
                  >
                    {rangeLabels[range]}
                  </Button>
                ))}
              </Space>
            </Space>
          </Col>

          <Col>
            <Space size="middle" wrap>
              <Text style={{ color: '#848e9c', fontSize: '14px' }}>顯示：</Text>
              <Space size="small" wrap>
                {EXCHANGES.map((exchange) => (
                  <Button
                    key={exchange.key}
                    type={selectedExchanges[exchange.key] ? 'primary' : 'default'}
                    size="small"
                    onClick={() => toggleExchange(exchange.key)}
                    style={{
                      background: selectedExchanges[exchange.key] ? exchange.color : 'transparent',
                      borderColor: selectedExchanges[exchange.key] ? exchange.color : '#2b3139',
                      color: selectedExchanges[exchange.key] ? exchange.activeText : '#848e9c',
                      fontWeight: selectedExchanges[exchange.key] ? 600 : 400,
                      transition: 'all 0.3s ease',
                    }}
                  >
                    {exchange.label}
                  </Button>
                ))}
              </Space>
              <Button
                icon={<ReloadOutlined />}
                size="small"
                onClick={loadNetValueData}
                loading={loading}
                style={{
                  background: 'transparent',
                  borderColor: '#2b3139',
                  color: '#848e9c',
                  transition: 'all 0.3s ease',
                }}
              >
                刷新
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card
        style={{
          background: '#1e2329',
          border: '1px solid #2b3139',
          borderRadius: '8px',
        }}
        bodyStyle={{ padding: '24px' }}
      >
        <Title level={4} style={{ color: '#ffffff', marginBottom: 24 }}>
          淨值走勢
        </Title>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '100px 0' }}>
            <Spin size="large" />
          </div>
        ) : chartData.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={<Text style={{ color: '#848e9c' }}>暫無淨值資料</Text>}
            style={{ padding: '100px 0' }}
          />
        ) : (
          <ResponsiveContainer width="100%" height={500}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2b3139" />
              <XAxis
                dataKey="time"
                stroke="#848e9c"
                tick={{ fill: '#848e9c', fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#848e9c"
                tick={{ fill: '#848e9c', fontSize: 12 }}
                tickFormatter={(value) => `${Number(value).toFixed(0)}`}
              />
              <Tooltip content={customTooltip} />
              <Legend
                wrapperStyle={{ color: '#848e9c' }}
                iconType="line"
                formatter={(value) => <span style={{ color: '#848e9c' }}>{value}</span>}
              />

              {EXCHANGES.map((exchange) => (
                selectedExchanges[exchange.key] && (
                  <Line
                    key={exchange.key}
                    type="monotone"
                    dataKey={exchange.key}
                    name={exchange.label}
                    stroke={exchange.color}
                    strokeWidth={exchange.key === 'total' ? 3 : 2}
                    dot={false}
                    activeDot={{ r: exchange.key === 'total' ? 6 : 5 }}
                  />
                )
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>
    </div>
  );
};

export default ReportPageCEX;
