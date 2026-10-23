import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DownloadOutlined,
  ReloadOutlined,
  SearchOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { apiService } from '../services/api';
import type { TradeRecordQueryParams } from '../services/api';
import { useIsMobile } from '../utils/responsive';

const { RangePicker } = DatePicker;
const { Text, Title } = Typography;

type RecordMode = 'all' | 'arbitrage' | 'twap';
type RecordResult = 'all' | 'success' | 'failed' | 'manual_cancel' | 'rolled_back';

interface TradeRecordLeg {
  exchange?: string | null;
  symbol?: string | null;
  type?: string | null;
  side?: string | null;
  price?: number | null;
  orderId?: string | null;
  orderTransport?: string | null;
  priceUpdated?: boolean;
}

interface TradeRecord {
  id: string;
  ts: number;
  datetime: string;
  mode: 'arbitrage' | 'twap';
  resultType: Exclude<RecordResult, 'all'>;
  status?: string | null;
  reason?: string | null;
  error?: string | null;
  displayReason?: string;
  strategyId?: string | null;
  pairId?: string | null;
  twapId?: string | null;
  qty?: number | null;
  totalAmount?: number | null;
  orderCount?: number | null;
  spread?: number | null;
  spreadPercent?: number | null;
  threshold?: number | null;
  intervalMs?: number | null;
  isRollback?: boolean;
  leg1?: TradeRecordLeg;
  leg2?: TradeRecordLeg;
}

interface TradeRecordGroup extends TradeRecord {
  groupKey: string;
  groupRecords: TradeRecord[];
  groupSize: number;
  leg1AvgPrice?: number | null;
  leg2AvgPrice?: number | null;
  actualSpreadPercent?: number | null;
  settingSpreadPercent?: number | null;
  tradedQtyText: string;
}

interface TradeRecordResponse {
  records: TradeRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const EXCHANGE_OPTIONS = ['bybit', 'binance', 'okx', 'bitget', 'aster', 'mexc'].map((exchange) => ({
  label: exchange.toUpperCase(),
  value: exchange,
}));
const EXCHANGE_VALUES = EXCHANGE_OPTIONS.map((option) => option.value);
const ALL_EXCHANGES_VALUE = '__all__';
const RESULT_OPTIONS: Array<{ label: string; value: Exclude<RecordResult, 'all'> }> = [
  { label: '成功', value: 'success' },
  { label: '失敗', value: 'failed' },
  { label: '手動取消', value: 'manual_cancel' },
  { label: '回滾', value: 'rolled_back' },
];
const RESULT_VALUES = RESULT_OPTIONS.map((option) => option.value);
const ALL_RESULTS_VALUE = '__all__';

const cardStyle: React.CSSProperties = {
  background: '#1e2329',
  border: '1px solid #2b3139',
  borderRadius: 8,
};

const labelStyle: React.CSSProperties = {
  color: '#848e9c',
  fontSize: 12,
  marginBottom: 6,
  display: 'block',
};

const getResultLabel = (result: TradeRecord['resultType']) => {
  switch (result) {
    case 'success':
      return { text: '成功', color: 'success' };
    case 'failed':
      return { text: '失敗', color: 'error' };
    case 'manual_cancel':
      return { text: '手動取消', color: 'warning' };
    case 'rolled_back':
      return { text: '回滾', color: 'processing' };
    default:
      return { text: result || '未知', color: 'default' };
  }
};

const formatNumber = (value?: number | null, digits = 6) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const numeric = Number(value);
  return numeric.toFixed(Math.abs(numeric) >= 1 ? Math.min(digits, 4) : digits);
};

const formatPrice = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  return Number(value).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

const getStrategyKey = (record: TradeRecord) => (
  record.strategyId || record.pairId || record.twapId || record.id
);

const sortRecordsByTimeDesc = (nextRecords: TradeRecord[]) => (
  [...nextRecords].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
);

const getGroupReason = (groupRecords: TradeRecord[]) => {
  const failedRecord = groupRecords.find((record) => record.resultType === 'failed');
  const record = failedRecord || groupRecords.find((item) => item.displayReason || item.error || item.reason);
  return record?.displayReason || record?.error || record?.reason || '--';
};

const getWeightedAveragePrice = (
  groupRecords: TradeRecord[],
  getPrice: (record: TradeRecord) => number | null | undefined,
) => {
  let weightedTotal = 0;
  let weightTotal = 0;
  const prices: number[] = [];

  groupRecords.forEach((record) => {
    const price = Number(getPrice(record));
    if (!Number.isFinite(price)) return;

    const qty = Number(record.qty || 0);
    prices.push(price);
    if (qty > 0) {
      weightedTotal += price * qty;
      weightTotal += qty;
    }
  });

  if (weightTotal > 0) return weightedTotal / weightTotal;
  if (prices.length === 0) return null;
  return prices.reduce((sum, price) => sum + price, 0) / prices.length;
};

const getAverageValue = (
  groupRecords: TradeRecord[],
  getValue: (record: TradeRecord) => number | null | undefined,
) => {
  const values = groupRecords
    .map((record) => Number(getValue(record)))
    .filter((value) => Number.isFinite(value));

  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const formatPercent = (value?: number | null, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const numeric = Number(value);
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${formatNumber(numeric, digits)}%`;
};

const renderLeg = (leg?: TradeRecordLeg) => {
  if (!leg) return <Text style={{ color: '#848e9c' }}>--</Text>;
  return (
    <Space direction="vertical" size={2}>
      <Space size={4} wrap>
        <Tag color="blue" style={{ margin: 0 }}>{String(leg.exchange || '--').toUpperCase()}</Tag>
        <Text style={{ color: '#fff', fontSize: 13 }}>{leg.symbol || '--'}</Text>
      </Space>
      <Text style={{ color: '#848e9c', fontSize: 12 }}>
        {leg.type || '--'} / {leg.side || '--'}
      </Text>
    </Space>
  );
};

const TradeRecordsPage: React.FC = () => {
  const { message } = AntdApp.useApp();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [records, setRecords] = useState<TradeRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [mode, setMode] = useState<RecordMode>('all');
  const [results, setResults] = useState<Array<Exclude<RecordResult, 'all'>>>([]);
  const [symbol, setSymbol] = useState('');
  const [exchanges, setExchanges] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs]>([
    dayjs().subtract(7, 'day'),
    dayjs(),
  ]);

  const buildParams = useCallback((nextPage = page, nextPageSize = pageSize): TradeRecordQueryParams => {
    return {
      type: mode,
      result: results.length > 0 ? results.join(',') as TradeRecordQueryParams['result'] : 'all',
      symbol: symbol.trim() || undefined,
      exchange: exchanges.length > 0 ? exchanges.join(',') : undefined,
      from_date: dateRange[0]?.format('YYYY-MM-DD'),
      to_date: dateRange[1]?.format('YYYY-MM-DD'),
      limit: nextPageSize,
      offset: (nextPage - 1) * nextPageSize,
    };
  }, [dateRange, exchanges, mode, page, pageSize, results, symbol]);

  const requestRecords = useCallback(async (
    params: TradeRecordQueryParams,
    nextPage: number,
    nextPageSize: number,
  ) => {
    try {
      setLoading(true);
      const response: any = await apiService.getTradeRecords(params);
      const payload: TradeRecordResponse | undefined = response?.success ? response.data : undefined;
      const nextRecords = payload && Array.isArray(payload.records) ? payload.records : [];
      setRecords(nextRecords);
      setTotal(Number(payload?.total || 0));
      setPage(nextPage);
      setPageSize(nextPageSize);
    } catch (error: any) {
      message.error(error?.message || '載入交易紀錄失敗');
      setRecords([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [message]);

  const loadRecords = useCallback(async (nextPage = page, nextPageSize = pageSize) => {
    await requestRecords(buildParams(nextPage, nextPageSize), nextPage, nextPageSize);
  }, [buildParams, page, pageSize, requestRecords]);

  useEffect(() => {
    loadRecords(1, pageSize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = () => {
    loadRecords(1, pageSize);
  };

  const handleReset = () => {
    const nextRange: [Dayjs, Dayjs] = [dayjs().subtract(7, 'day'), dayjs()];
    const nextParams: TradeRecordQueryParams = {
      type: 'all',
      result: 'all',
      from_date: nextRange[0].format('YYYY-MM-DD'),
      to_date: nextRange[1].format('YYYY-MM-DD'),
      limit: pageSize,
      offset: 0,
    };

    setMode('all');
    setResults([]);
    setSymbol('');
    setExchanges([]);
    setDateRange(nextRange);
    requestRecords(nextParams, 1, pageSize);
  };

  const handleExchangeChange = (values: string[]) => {
    if (values.includes(ALL_EXCHANGES_VALUE)) {
      const isAlreadyAllSelected = exchanges.length === EXCHANGE_VALUES.length;
      setExchanges(isAlreadyAllSelected ? [] : EXCHANGE_VALUES);
      return;
    }
    setExchanges(values);
  };

  const handleResultChange = (values: string[]) => {
    if (values.includes(ALL_RESULTS_VALUE)) {
      const isAlreadyAllSelected = results.length === RESULT_VALUES.length;
      setResults(isAlreadyAllSelected ? [] : RESULT_VALUES);
      return;
    }
    setResults(values as Array<Exclude<RecordResult, 'all'>>);
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const { limit, offset, ...params } = buildParams(1, pageSize);
      const response: any = await apiService.exportTradeRecords(params);
      const blob = response instanceof Blob
        ? response
        : new Blob([response], { type: 'text/csv;charset=utf-8;' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `trade_records_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      message.success('交易紀錄已匯出');
    } catch (error: any) {
      message.error(error?.message || '匯出交易紀錄失敗');
    } finally {
      setExporting(false);
    }
  };

  const groupedRecords = useMemo<TradeRecordGroup[]>(() => {
    const groups = new Map<string, TradeRecord[]>();

    records.forEach((record) => {
      const key = getStrategyKey(record);
      const groupRecords = groups.get(key) || [];
      groupRecords.push(record);
      groups.set(key, groupRecords);
    });

    return Array.from(groups.entries()).map(([groupKey, groupRecords]) => {
      const sortedGroupRecords = sortRecordsByTimeDesc(groupRecords);
      const latestRecord = sortedGroupRecords[0];
      const totalQty = sortedGroupRecords.reduce((sum, record) => sum + Number(record.qty || 0), 0);
      const failedCount = sortedGroupRecords.filter((record) => record.resultType === 'failed').length;
      const leg1AvgPrice = getWeightedAveragePrice(sortedGroupRecords, (record) => record.leg1?.price);
      const leg2AvgPrice = getWeightedAveragePrice(sortedGroupRecords, (record) => record.leg2?.price);
      const calculatedSpreadPercent = leg1AvgPrice && leg2AvgPrice
        ? ((leg1AvgPrice - leg2AvgPrice) / leg2AvgPrice) * 100
        : null;
      const actualSpreadPercent = calculatedSpreadPercent ?? getAverageValue(sortedGroupRecords, (record) => record.spreadPercent);
      const settingSpreadPercent = getAverageValue(sortedGroupRecords, (record) => record.threshold);
      const tradedQtyText = latestRecord.totalAmount
        ? `${formatNumber(totalQty, 4)}/${formatNumber(latestRecord.totalAmount, 4)}`
        : formatNumber(totalQty, 4);
      const displayReason = failedCount > 0
        ? `${failedCount} failed / ${sortedGroupRecords.length} records`
        : getGroupReason(sortedGroupRecords);

      return {
        ...latestRecord,
        id: `strategy-group-${groupKey}`,
        groupKey,
        groupRecords: sortedGroupRecords,
        groupSize: sortedGroupRecords.length,
        strategyId: latestRecord.strategyId || latestRecord.pairId || latestRecord.twapId || groupKey,
        qty: totalQty,
        leg1AvgPrice,
        leg2AvgPrice,
        actualSpreadPercent,
        settingSpreadPercent,
        tradedQtyText,
        displayReason,
      };
    });
  }, [records]);

  const columns = useMemo<ColumnsType<TradeRecordGroup>>(() => [
    {
      title: '類型',
      dataIndex: 'mode',
      key: 'mode',
      width: 90,
      fixed: isMobile ? undefined : 'left',
      render: (value: TradeRecord['mode']) => (
        <Tag color={value === 'twap' ? 'purple' : 'blue'} style={{ margin: 0 }}>
          {value === 'twap' ? 'TWAP' : 'PAIR'}
        </Tag>
      ),
    },
    {
      title: 'Leg1',
      dataIndex: 'leg1',
      key: 'leg1',
      width: 260,
      render: renderLeg,
    },
    {
      title: 'Leg2',
      dataIndex: 'leg2',
      key: 'leg2',
      width: 260,
      render: renderLeg,
    },
    {
      title: 'Strategy ID',
      dataIndex: 'strategyId',
      key: 'strategyId',
      width: 220,
      ellipsis: true,
      render: (value: string | null, record: TradeRecordGroup) => (
        <Space size={6} wrap>
          <Text style={{ color: '#d8dce1', fontSize: 12 }}>{value || '--'}</Text>
          <Tag color="default" style={{ margin: 0 }}>{record.groupSize}</Tag>
        </Space>
      ),
    },
    {
      title: 'Leg1 均價',
      key: 'leg1AvgPrice',
      width: 130,
      align: 'right',
      render: (_: unknown, record: TradeRecordGroup) => (
        <Text style={{ color: '#fff', fontSize: 12 }}>{formatPrice(record.leg1AvgPrice)}</Text>
      ),
    },
    {
      title: 'Leg2 均價',
      key: 'leg2AvgPrice',
      width: 130,
      align: 'right',
      render: (_: unknown, record: TradeRecordGroup) => (
        <Text style={{ color: '#fff', fontSize: 12 }}>{formatPrice(record.leg2AvgPrice)}</Text>
      ),
    },
    {
      title: '設定差價%',
      key: 'settingSpreadPercent',
      width: 130,
      align: 'right',
      render: (_: unknown, record: TradeRecordGroup) => (
        <Text style={{ color: '#d8dce1', fontSize: 12 }}>{formatPercent(record.settingSpreadPercent, 2)}</Text>
      ),
    },
    {
      title: '實際差價%',
      key: 'actualSpreadPercent',
      width: 130,
      align: 'right',
      render: (_: unknown, record: TradeRecordGroup) => (
        <Text style={{ color: Number(record.actualSpreadPercent || 0) >= 0 ? '#0ecb81' : '#f6465d', fontSize: 12 }}>
          {formatPercent(record.actualSpreadPercent, 2)}
        </Text>
      ),
    },
    {
      title: '成交數量',
      key: 'tradedQty',
      width: 150,
      align: 'right',
      render: (_: unknown, record: TradeRecordGroup) => (
        <Text style={{ color: '#fff', fontSize: 12 }}>{record.tradedQtyText}</Text>
      ),
    },
    {
      title: '時間',
      dataIndex: 'datetime',
      key: 'datetime',
      width: 170,
      render: (value: string) => <Text style={{ color: '#fff', fontSize: 12 }}>{value || '--'}</Text>,
    },
    {
      title: '結果',
      dataIndex: 'resultType',
      key: 'resultType',
      width: 100,
      render: (value: TradeRecord['resultType'], record: TradeRecordGroup) => {
        const failedCount = record.groupRecords.filter((item) => item.resultType === 'failed').length;
        if (failedCount > 0) {
          return <Tag color="error" style={{ margin: 0 }}>{failedCount}/{record.groupSize}</Tag>;
        }
        const meta = getResultLabel(value);
        return <Tag color={meta.color} style={{ margin: 0 }}>{meta.text}</Tag>;
      },
    },
  ], [isMobile]);

  const detailColumns = useMemo<ColumnsType<TradeRecord>>(() => [
    {
      title: '時間',
      dataIndex: 'datetime',
      key: 'datetime',
      width: 170,
      render: (value: string) => <Text style={{ color: '#fff', fontSize: 12 }}>{value || '--'}</Text>,
    },
    {
      title: '結果',
      dataIndex: 'resultType',
      key: 'resultType',
      width: 90,
      render: (value: TradeRecord['resultType']) => {
        const meta = getResultLabel(value);
        return <Tag color={meta.color} style={{ margin: 0 }}>{meta.text}</Tag>;
      },
    },
    { title: 'Leg1', dataIndex: 'leg1', key: 'leg1', width: 180, render: renderLeg },
    { title: 'Leg2', dataIndex: 'leg2', key: 'leg2', width: 180, render: renderLeg },
    {
      title: '數量',
      dataIndex: 'qty',
      key: 'qty',
      width: 100,
      align: 'right',
      render: (value: number | null) => <Text style={{ color: '#fff' }}>{formatNumber(value)}</Text>,
    },
    {
      title: '成交價',
      key: 'price',
      width: 170,
      render: (_: unknown, item: TradeRecord) => (
        <Space direction="vertical" size={2}>
          <Text style={{ color: '#fff', fontSize: 12 }}>L1 {formatPrice(item.leg1?.price)}</Text>
          <Text style={{ color: '#fff', fontSize: 12 }}>L2 {formatPrice(item.leg2?.price)}</Text>
        </Space>
      ),
    },
    {
      title: '價差',
      key: 'spread',
      width: 130,
      align: 'right',
      render: (_: unknown, item: TradeRecord) => (
        <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Text style={{ color: Number(item.spread || 0) >= 0 ? '#0ecb81' : '#f6465d', fontSize: 12 }}>
            {formatNumber(item.spread)}
          </Text>
          <Text style={{ color: '#848e9c', fontSize: 12 }}>
            {item.spreadPercent === null || item.spreadPercent === undefined ? '--' : `${formatNumber(item.spreadPercent, 4)}%`}
          </Text>
        </Space>
      ),
    },
    {
      title: '訂單 ID',
      key: 'orderIds',
      width: 220,
      render: (_: unknown, item: TradeRecord) => (
        <Space direction="vertical" size={2}>
          <Text style={{ color: '#d8dce1', fontSize: 12 }}>L1 {item.leg1?.orderId || '--'}</Text>
          <Text style={{ color: '#d8dce1', fontSize: 12 }}>L2 {item.leg2?.orderId || '--'}</Text>
        </Space>
      ),
    },
  ], []);

  const expandedRowRender = (record: TradeRecordGroup) => (
    <div style={{ padding: isMobile ? 8 : 16, background: '#161a1e', borderRadius: 6 }}>
      <Table<TradeRecord>
        rowKey="id"
        columns={detailColumns}
        dataSource={record.groupRecords}
        pagination={false}
        size="small"
        scroll={{ x: 1250 }}
        style={{ marginBottom: 12 }}
      />
      <Descriptions
        size="small"
        column={isMobile ? 1 : 2}
        labelStyle={{ color: '#848e9c' }}
        contentStyle={{ color: '#fff' }}
      >
        <Descriptions.Item label="Leg1 Order ID">{record.leg1?.orderId || '--'}</Descriptions.Item>
        <Descriptions.Item label="Leg2 Order ID">{record.leg2?.orderId || '--'}</Descriptions.Item>
        <Descriptions.Item label="Leg1 Transport">{record.leg1?.orderTransport || '--'}</Descriptions.Item>
        <Descriptions.Item label="Leg2 Transport">{record.leg2?.orderTransport || '--'}</Descriptions.Item>
        <Descriptions.Item label="完整原因" span={isMobile ? 1 : 2}>
          {record.error || record.displayReason || record.reason || '--'}
        </Descriptions.Item>
        <Descriptions.Item label="Raw Status">{record.status || '--'}</Descriptions.Item>
        <Descriptions.Item label="Raw Reason">{record.reason || '--'}</Descriptions.Item>
        <Descriptions.Item label="Threshold">{record.threshold ?? '--'}</Descriptions.Item>
        <Descriptions.Item label="Interval">{record.intervalMs ? `${record.intervalMs} ms` : '--'}</Descriptions.Item>
        <Descriptions.Item label="Rollback">{record.isRollback ? 'true' : 'false'}</Descriptions.Item>
        <Descriptions.Item label="Pair / TWAP">
          {record.pairId || record.twapId || '--'}
        </Descriptions.Item>
      </Descriptions>
    </div>
  );

  return (
    <div style={{ background: '#0b0e11', minHeight: '100vh' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Row justify="space-between" align="middle" gutter={[12, 12]}>
          <Col>
            <Title level={3} style={{ color: '#fff', margin: 0 }}>交易紀錄</Title>
          </Col>
          <Col>
            <Text style={{ color: '#848e9c' }}>共 {total} 筆</Text>
          </Col>
        </Row>

        <Card style={cardStyle} bodyStyle={{ padding: 16 }}>
          <Row gutter={[12, 12]} align="bottom">
            <Col xs={24} sm={12} md={6} lg={4}>
              <Text style={labelStyle}>類型</Text>
              <Select
                value={mode}
                onChange={setMode}
                style={{ width: '100%' }}
                options={[
                  { label: '全部', value: 'all' },
                  { label: '套利', value: 'arbitrage' },
                  { label: 'TWAP', value: 'twap' },
                ]}
              />
            </Col>
            <Col xs={24} sm={12} md={6} lg={4}>
              <Text style={labelStyle}>結果</Text>
              <Select
                mode="multiple"
                value={results}
                onChange={handleResultChange}
                maxTagCount="responsive"
                placeholder="全部"
                style={{ width: '100%' }}
                options={[
                  {
                    label: results.length === RESULT_VALUES.length ? '取消全選' : '全選',
                    value: ALL_RESULTS_VALUE,
                  },
                  ...RESULT_OPTIONS,
                ]}
              />
            </Col>
            <Col xs={24} sm={12} md={6} lg={4}>
              <Text style={labelStyle}>幣種</Text>
              <Input
                value={symbol}
                onChange={(event) => setSymbol(event.target.value)}
                onPressEnter={handleSearch}
                placeholder="ETHUSDT"
                allowClear
              />
            </Col>
            <Col xs={24} sm={12} md={6} lg={4}>
              <Text style={labelStyle}>交易所</Text>
              <Select
                mode="multiple"
                value={exchanges}
                onChange={handleExchangeChange}
                allowClear
                placeholder="全部"
                maxTagCount="responsive"
                style={{ width: '100%' }}
                options={[
                  {
                    label: exchanges.length === EXCHANGE_VALUES.length ? '取消全選' : '全選',
                    value: ALL_EXCHANGES_VALUE,
                  },
                  ...EXCHANGE_OPTIONS,
                ]}
              />
            </Col>
            <Col xs={24} md={12} lg={6}>
              <Text style={labelStyle}>時間範圍</Text>
              <RangePicker
                value={dateRange}
                onChange={(value) => {
                  if (value?.[0] && value?.[1]) {
                    setDateRange([value[0], value[1]]);
                  }
                }}
                style={{ width: '100%' }}
              />
            </Col>
            <Col xs={24} lg={2}>
              <Space size={8} wrap>
                <Tooltip title="查詢">
                  <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch} loading={loading} />
                </Tooltip>
                <Tooltip title="重置">
                  <Button icon={<UndoOutlined />} onClick={handleReset} />
                </Tooltip>
                <Tooltip title="刷新">
                  <Button icon={<ReloadOutlined />} onClick={() => loadRecords(page, pageSize)} loading={loading} />
                </Tooltip>
                <Tooltip title="匯出">
                  <Button icon={<DownloadOutlined />} onClick={handleExport} loading={exporting} />
                </Tooltip>
              </Space>
            </Col>
          </Row>
        </Card>

        <Card style={cardStyle} bodyStyle={{ padding: 0 }}>
          <Table<TradeRecordGroup>
            rowKey="groupKey"
            columns={columns}
            dataSource={groupedRecords}
            loading={loading}
            scroll={{ x: 1800 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<Text style={{ color: '#848e9c' }}>沒有交易紀錄</Text>}
                />
              ),
            }}
            expandable={{ expandedRowRender }}
            pagination={{
              current: page,
              pageSize,
              total,
              showSizeChanger: true,
              pageSizeOptions: [50, 100, 200, 500],
              showTotal: (count) => `共 ${count} 筆`,
              onChange: (nextPage, nextPageSize) => loadRecords(nextPage, nextPageSize),
            }}
          />
        </Card>
      </Space>
    </div>
  );
};

export default TradeRecordsPage;
