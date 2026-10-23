import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Row, Col, Card, Form, Select, Input, InputNumber, Button, Space, Typography, Tag, Table, Checkbox, App as AntdApp } from 'antd';
import { SwapOutlined, ThunderboltOutlined, ClockCircleOutlined, FundOutlined, PlayCircleOutlined, BellOutlined, DeleteOutlined } from '@ant-design/icons';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState, AppDispatch } from '../store';
import { apiService } from '../services/api';
import { addMonitoringPair as addPairToStore, setRecentExecutions } from '../store/slices/arbitrageSlice';
import { addStrategy as addTwapToStore, setExecutions as setTwapExecutions } from '../store/slices/twapSlice';
import TradingViewPriceChart from '../components/TradingViewPriceChart';
import { storage } from '../utils/storage';
import { getApiBaseUrl } from '../utils/env';
import { normalizeMonitoringPairs, parseArbitrageExecutionsResponse, resolvePairExecutionCount } from '../adapters/arbitrageAdapter';
import { parseTwapExecutionsResponse } from '../adapters/twapAdapter';
import { useIsMobile, useIsSmallMobile } from '../utils/responsive';
import type { ApiResponse } from '../types/arbitrage';
import type { FundingRate } from '../types/positions';

type BorrowingRateRecord = {
  exchange: string;
  asset: string;
  interestRateHourly?: number;
  interestRateDaily?: number;
  timestamp?: number;
};

const { Text } = Typography;
const { Option } = Select;

type LegType = 'spot' | 'linear';
type SideType = 'buy' | 'sell';
type HistoryFilter = 'success' | 'failed' | 'manualDelete';

type TopPrice = { bid: number; ask: number };
type SpreadMonitorLeg = {
  exchange: string;
  symbol: string;
  type: LegType;
  side: SideType;
};
type SpreadMonitor = {
  id: string;
  leg1: SpreadMonitorLeg;
  leg2: SpreadMonitorLeg;
  threshold: number;
  enabled: boolean;
  createdAt: number;
};
type PriceCacheEntry = {
  ts: number;
  data: TopPrice;
};

const PRICE_CACHE_TTL_MS = 900;
const PRICE_POLL_INTERVAL_MS = 1000;
const SPREAD_MONITORS_STORAGE_KEY = 'trading_spread_monitors_v1';
const priceRequestCache = new Map<string, PriceCacheEntry>();
const inFlightPriceRequests = new Map<string, Promise<TopPrice>>();
const DEFAULT_HISTORY_FILTERS: HistoryFilter[] = ['success', 'failed', 'manualDelete'];

const loadSpreadMonitors = (): SpreadMonitor[] => {
  try {
    const raw = window.localStorage.getItem(SPREAD_MONITORS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveSpreadMonitors = (items: SpreadMonitor[]) => {
  try {
    window.localStorage.setItem(SPREAD_MONITORS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage may be unavailable.
  }
};

const getMonitorLegExecPrice = (leg: SpreadMonitorLeg, price?: TopPrice): number => {
  if (!price) return 0;
  return leg.side === 'buy' ? price.ask : price.bid;
};

const calculateMonitorSpread = (
  monitor: SpreadMonitor,
  prices?: { leg1?: TopPrice; leg2?: TopPrice },
) => {
  const leg1Exec = getMonitorLegExecPrice(monitor.leg1, prices?.leg1);
  const leg2Exec = getMonitorLegExecPrice(monitor.leg2, prices?.leg2);
  const buyPrice = monitor.leg1.side === 'buy' ? leg1Exec : leg2Exec;
  const sellPrice = monitor.leg1.side === 'sell' ? leg1Exec : leg2Exec;
  const valid = buyPrice > 0 && sellPrice > 0;
  const spread = valid ? sellPrice - buyPrice : 0;
  const spreadPct = valid ? (spread / buyPrice) * 100 : null;
  return { leg1Exec, leg2Exec, buyPrice, sellPrice, spread, spreadPct, valid };
};

const getHistoryResultType = (record: any): HistoryFilter => {
  if (record?.hasFailedRecord) return 'failed';
  if (record?.isManualDelete) return 'manualDelete';
  return record?.success === true ? 'success' : 'failed';
};

const normalizeDisplayLegType = (type?: unknown): 'spot' | 'future' => {
  const normalized = String(type || '').toLowerCase();
  return ['linear', 'future', 'contract', 'swap', 'perp', 'perpetual'].includes(normalized)
    ? 'future'
    : 'spot';
};

const getContractSuffix = (type?: unknown, suffix = '.P') => (
  normalizeDisplayLegType(type) === 'future' ? suffix : ''
);

type LegFundingDisplay = {
  label: string;
  rateText: string;
  timeText: string;
  color: string;
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
};

type FundingRateRecord = FundingRate & { settlementIntervalHours?: number | null };

const KNOWN_QUOTES = [
  'USDT', 'USDC', 'USD1', 'USD', 'BUSD', 'BTC', 'ETH', 'EUR', 'JPY', 'AUD', 'GBP', 'TRY', 'IDR', 'HKD', 'SGD', 'CAD',
];

const splitSymbol = (symbol?: string) => {
  if (!symbol) return { base: '', quote: '' };
  const upper = symbol.toUpperCase();
  for (const quote of KNOWN_QUOTES) {
    if (upper.endsWith(quote)) {
      return {
        base: upper.slice(0, upper.length - quote.length),
        quote,
      };
    }
  }
  // fallback：前半部視為 base，後半部視為 quote
  const midpoint = Math.max(1, Math.floor(upper.length / 2));
  return {
    base: upper.slice(0, midpoint),
    quote: upper.slice(midpoint),
  };
};

/**
 * 將後端 TWAP plan 列表轉成 Trading 頁面使用的 UI strategy。
 * 抽出共用函式，避免 refreshTwapStrategies 與 handleDeleteTwap 兩處重複 map。
 */
const mapTwapPlansToUi = (plans: any[]): any[] => {
  if (!Array.isArray(plans)) return [];

  const normalizeStatus = (state: string) => {
    switch (state) {
      case 'running': return 'active' as const;
      case 'paused': return 'paused' as const;
      case 'completed': return 'completed' as const;
      case 'cancelled': return 'cancelled' as const;
      case 'failed': return 'failed' as const;
      default: return 'active' as const;
    }
  };

  return plans
    .map((plan: any) => {
      const leg1 = plan.legs?.[0];
      const leg2 = plan.legs?.[1];

      if (!leg1 || !leg2) {
        console.error(`❌ TWAP 策略 ${plan.planId} 缺少 legs 數據:`, plan);
        return null;
      }

      return {
        id: plan.planId,
        leg1: {
          exchange: leg1?.exchange || 'ERROR',
          symbol: leg1?.symbol || 'ERROR',
          type: normalizeDisplayLegType(leg1?.category),
          side: leg1?.side || 'ERROR',
        },
        leg2: {
          exchange: leg2?.exchange || 'ERROR',
          symbol: leg2?.symbol || 'ERROR',
          type: normalizeDisplayLegType(leg2?.category),
          side: leg2?.side || 'ERROR',
        },
        totalAmount: plan.totalQty,
        timeInterval: plan.intervalMs,
        orderCount: plan.orderCount ?? plan.slicesTotal ?? Math.floor(plan.totalQty / plan.sliceQty),
        amountPerOrder: plan.sliceQty,
        priceType: 'market' as const,
        enabled: true,
        createdAt: plan.createdAt || Date.now(),
        executedOrders: plan.progress?.slicesDone || 0,
        totalTriggers: plan.totalTriggers ?? plan.progress?.slicesDone ?? 0,
        remainingAmount: Math.max(0, plan.progress?.remaining || plan.totalQty),
        nextExecutionTime: plan.progress?.nextExecutionTs || 0,
        status: normalizeStatus(plan.state),
        progress: plan.progress || null,
      };
    })
    .filter((s: any) => s !== null);
};

const getMarginAsset = (symbol: string, side: SideType) => {
  const { base, quote } = splitSymbol(symbol);
  if (side === 'buy') {
    return quote || 'USDT';
  }
  return base || symbol.toUpperCase();
};

const shouldHideStablecoinPosition = (symbol?: string, type?: string) => {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  const normalizedType = String(type || '').toLowerCase();

  if (!normalizedSymbol || !normalizedType) return false;

  const { base, quote } = splitSymbol(normalizedSymbol);
  const stableBaseAssets = new Set(['USDT', 'USDC', 'USD1', 'USD', 'BUSD', 'DAI', 'TUSD', 'BYUSDT']);
  const stableQuoteAssets = new Set(['USDT', 'USDC', 'USD1', 'USD', 'BUSD', 'DAI', 'TUSD', 'BYUSDT']);

  // 需求：穩定幣倉位不顯示
  if (normalizedSymbol === 'USDTUSDT' && normalizedType === 'margin') {
    return true;
  }

  // spot: 穩定幣對穩定幣（含 BY）不顯示
  if (normalizedType === 'spot' && stableBaseAssets.has(base) && stableQuoteAssets.has(quote)) {
    return true;
  }

  return false;
};

const toMillis = (value?: number | null): number | null => {
  if (!value || Number.isNaN(value)) return null;
  return value > 1e12 ? value : value * 1000;
};

const getFundingCycleHours = (nextFundingTime?: number | null, timestamp?: number | null) => {
  const nextMs = toMillis(nextFundingTime);
  const tsMs = toMillis(timestamp) ?? Date.now();
  if (!nextMs || nextMs <= tsMs) return null;
  const diffHours = (nextMs - tsMs) / 3600000;
  if (diffHours <= 0) return null;
  if (diffHours <= 1.5) return 1;
  if (diffHours <= 4.5) return 4;
  if (diffHours <= 12) return 8;
  return Math.round(diffHours);
};

// 根據數值本身的精度動態決定小數位數（避免所有數字都被強制顯示為 4 位小數）
const formatQuantity = (value: number | null | undefined): string => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '--';
  }

  // 如果是整數，直接返回
  if (Number.isInteger(value)) {
    return value.toString();
  }

  const str = value.toString();

  // 處理科學記數法
  if (str.includes('e') || str.includes('E')) {
    const absVal = Math.abs(value);
    if (absVal >= 1) {
      return value.toFixed(2);
    }
    if (absVal >= 0.01) {
      return value.toFixed(4);
    }
    return value.toFixed(8);
  }

  const parts = str.split('.');
  if (parts.length === 1) {
    return value.toString();
  }

  // 小數部分去掉尾隨 0，保留原始有效位數，但限制最大位數
  const decimalPart = parts[1].replace(/0+$/, '');
  const decimalPlaces = decimalPart.length;

  const absVal = Math.abs(value);
  const maxPlaces = absVal >= 1 ? 4 : 8;

  return value.toFixed(Math.min(decimalPlaces, maxPlaces));
};

const formatTimeLabel = (value?: number | null, prefix = '更新'): string => {
  const ms = toMillis(value);
  if (!ms) {
    return `${prefix} --`;
  }
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${prefix} ${hours}:${minutes}`;
};

const createInitialFundingDisplay = (label: string): LegFundingDisplay => ({
  label,
  rateText: '--',
  timeText: '等待選擇',
  color: '#848e9c',
  status: 'idle',
});

const Trading: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntdApp.useApp();
  const { exchanges } = useSelector((s: RootState) => s.system);
  const arbitrage = useSelector((s: RootState) => s.arbitrage);
  const twap = useSelector((s: RootState) => s.twap);
  const positionsSummary = useSelector((s: RootState) => s.positions.summary);

  // 歷史 useMemo 僅依賴執行紀錄；此二 ref 保持最新，供套利/TWAP 補全 leg 與策略狀態，避免每秒輪詢觸發重算
  const monitoringPairsRef = useRef(arbitrage.monitoringPairs);
  const twapStrategiesRef = useRef(twap.strategies);
  useEffect(() => {
    monitoringPairsRef.current = arbitrage.monitoringPairs;
  }, [arbitrage.monitoringPairs]);
  useEffect(() => {
    twapStrategiesRef.current = twap.strategies;
  }, [twap.strategies]);
  const isMobile = useIsMobile();
  const isSmallMobile = useIsSmallMobile();

  const [legsForm] = Form.useForm();
  const [pairForm] = Form.useForm();
  const [twapForm] = Form.useForm();

  const [activeTab, setActiveTab] = useState<'pair' | 'twap'>('pair');
  const [bottomTab, setBottomTab] = useState<'positions' | 'orders' | 'history'>('orders');
  const [historyFilters, setHistoryFilters] = useState<HistoryFilter[]>(DEFAULT_HISTORY_FILTERS);
  const [leg1Side, setLeg1Side] = useState<'buy' | 'sell'>('buy');
  const [leg2Side, setLeg2Side] = useState<'buy' | 'sell'>('sell');
  const [spreadMonitors, setSpreadMonitors] = useState<SpreadMonitor[]>(() => loadSpreadMonitors());
  const [spreadMonitorPrices, setSpreadMonitorPrices] = useState<Record<string, { leg1: TopPrice; leg2: TopPrice }>>({});
  const [leg2ManualSymbol, setLeg2ManualSymbol] = useState<boolean>(false);
  // 🔥 追蹤下一次點擊倉位時應該更新哪個 leg（1=leg1, 2=leg2）
  const [nextLegToUpdate, setNextLegToUpdate] = useState<1 | 2>(1);
  const [hiddenPositions, setHiddenPositions] = useState<string[]>(() => storage.load(storage.keys.UI_HIDDEN_POSITIONS, [] as string[]));
  const [legFundingInfo, setLegFundingInfo] = useState<{ leg1: LegFundingDisplay; leg2: LegFundingDisplay }>(() => ({
    leg1: createInitialFundingDisplay('資金費率'),
    leg2: createInitialFundingDisplay('借幣利率'),
  }));

  const updateLegFundingDisplay = (leg: 'leg1' | 'leg2', updates: Partial<LegFundingDisplay>) => {
    setLegFundingInfo(prev => ({
      ...prev,
      [leg]: {
        ...prev[leg],
        ...updates,
      },
    }));
  };

  const getInterestRateInfo = useCallback((exchange: string, asset: string) => {
    if (!exchange || !asset) {
      return { rate: null as number | null, timestamp: positionsSummary?.timestamp };
    }
    const exchangeKey = exchange.toLowerCase();
    const assetKey = asset.toUpperCase();

    const accounts = positionsSummary?.accounts || [];
    const account = accounts.find(acc => String(acc.exchange || '').toLowerCase() === exchangeKey);
    if (!account) {
      return { rate: null as number | null, timestamp: positionsSummary?.timestamp };
    }

    const balance = (account.balances || []).find((bal: any) => String(bal.asset || '').toUpperCase() === assetKey);
    if (!balance) {
      return { rate: null as number | null, timestamp: account.timestamp || positionsSummary?.timestamp };
    }

    const rateValue = typeof balance.interestRateDaily === 'number'
      ? balance.interestRateDaily
      : null;

    return { rate: rateValue, timestamp: account.timestamp || positionsSummary?.timestamp };
  }, [positionsSummary]);

  const fetchFundingRateRecord = useCallback(
    async (exchange: string, symbol: string): Promise<FundingRateRecord | null> => {
      const normalizedExchange = exchange.toLowerCase();
      const normalizedSymbol = symbol.toUpperCase();
      const attempts = [
        { exchange, symbols: normalizedSymbol },
        { symbols: normalizedSymbol },
      ];

      for (const params of attempts) {
        try {
          const response = await apiService.getFundingRates(params);
          const payload = ((): ApiResponse<FundingRateRecord[]> | undefined => {
            if (response && typeof response === 'object') {
              if ('success' in (response as any)) {
                return response as unknown as ApiResponse<FundingRateRecord[]>;
              }
              if ((response as any)?.data && typeof (response as any).data === 'object' && 'success' in (response as any).data) {
                return (response as any).data as ApiResponse<FundingRateRecord[]>;
              }
            }
            return undefined;
          })();
          const records: FundingRateRecord[] = payload?.success ? payload.data || [] : [];
          if (!records.length) continue;

          const match = records.find((item) => {
            const itemExchange = String(item?.exchange || '').toLowerCase();
            const itemSymbol = String(item?.symbol || '').toUpperCase();
            if ('exchange' in params) {
              return itemExchange === normalizedExchange && itemSymbol === normalizedSymbol;
            }
            return itemSymbol === normalizedSymbol;
          });

          if (match) {
            return match;
          }
        } catch (error) {
          // ignore and try next fallback
        }
      }

      return null;
    },
    []
  );

  const fetchBorrowingRateRecord = useCallback(
    async (exchange: string, asset: string) => {
      if (!exchange || !asset) return null;
      const normalizedExchange = exchange.toLowerCase();
      const normalizedAsset = asset.toUpperCase();
      if (normalizedExchange === 'mexc') return null;
      const attempts = [
        { exchange, assets: normalizedAsset },
        { assets: normalizedAsset },
      ];

      for (const params of attempts) {
        try {
          const response = await apiService.getBorrowingRates(params);
          const payload = ((): ApiResponse<BorrowingRateRecord[]> | undefined => {
            if (response && typeof response === 'object') {
              if ('success' in (response as any)) {
                return response as unknown as ApiResponse<BorrowingRateRecord[]>;
              }
              if ((response as any)?.data && typeof (response as any).data === 'object' && 'success' in (response as any).data) {
                return (response as any).data as ApiResponse<BorrowingRateRecord[]>;
              }
            }
            return undefined;
          })();

          const records = (payload?.success ? payload.data || [] : []) as BorrowingRateRecord[];
          if (!records.length) continue;

          const match = records.find((item) => {
            const itemExchange = String(item?.exchange || '').toLowerCase();
            const itemAsset = String(item?.asset || '').toUpperCase();
            if ('exchange' in params) {
              return itemExchange === normalizedExchange && itemAsset === normalizedAsset;
            }
            return itemAsset === normalizedAsset;
          });

          if (match) {
            return match;
          }
        } catch (error) {
          // 忽略並嘗試下一種參數
        }
      }

      return null;
    },
    []
  );

  // 持久化隱藏清單
  useEffect(() => {
    try {
      storage.save(storage.keys.UI_HIDDEN_POSITIONS, hiddenPositions);
    } catch {}
  }, [hiddenPositions]);

  useEffect(() => {
    saveSpreadMonitors(spreadMonitors);
  }, [spreadMonitors]);

  const availableExchanges = useMemo(() => {
    const base = [
      { key: 'bybit', name: 'Bybit', connected: true },
      { key: 'binance', name: 'Binance', connected: true },
      { key: 'okx', name: 'OKX', connected: true },
      { key: 'bitget', name: 'Bitget', connected: true },
      { key: 'aster', name: 'Aster', connected: true },
      { key: 'mexc', name: 'MEXC', connected: true },
    ];

    const runtimeMap = new Map(
      Object.entries(exchanges).map(([key, ex]) => [
        String(key).toLowerCase(),
        { key, name: ex.name || key, connected: !!ex.connected },
      ])
    );

    // 永遠至少顯示 base 清單（確保 ASTER 在前端可見），若後端有狀態則覆蓋
    return base.map((item) => runtimeMap.get(item.key) || item);
  }, [exchanges]);

  useEffect(() => {
    legsForm.setFieldsValue({
      leg1_exchange: 'bybit',
      leg1_symbol: 'ETHUSDT',
      leg1_type: 'linear',
      leg1_side: 'buy',
      leg2_exchange: 'binance',
      leg2_symbol: 'ETHUSDT',
      leg2_type: 'linear',
      leg2_side: 'sell',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // 只在組件掛載時執行一次

  // 自動同步：Symbol2 跟隨 Symbol1（非強制）
  const leg1SymbolWatch = Form.useWatch('leg1_symbol', legsForm);
  const leg2SymbolWatch = Form.useWatch('leg2_symbol', legsForm);
  
  // 監聽 legs 表單變化
  const leg1ExchangeWatch = Form.useWatch('leg1_exchange', legsForm);
  const leg2ExchangeWatch = Form.useWatch('leg2_exchange', legsForm);
  const leg1TypeWatch = Form.useWatch('leg1_type', legsForm);
  const leg2TypeWatch = Form.useWatch('leg2_type', legsForm);

  const renderLegSummary = (leg: 'leg1' | 'leg2'): React.ReactNode => {
    const isFirst = leg === 'leg1';
    const exchange = (isFirst ? leg1ExchangeWatch : leg2ExchangeWatch) || (isFirst ? 'bybit' : 'binance');
    const symbol = (isFirst ? leg1SymbolWatch : leg2SymbolWatch) || 'ETHUSDT';
    const type = (isFirst ? leg1TypeWatch : leg2TypeWatch) || (isFirst ? 'linear' : 'spot');
    const side = isFirst ? leg1Side : leg2Side;
    const info = legFundingInfo[leg];

    const label = isFirst ? 'Leg 1' : 'Leg 2';
    const typeLabel = type === 'linear' ? '合約' : '現貨';
    const typeColor = type === 'linear' ? 'blue' : 'green';
    const sideLabel = side === 'buy' ? 'BUY' : 'SELL';
    const sideColor = side === 'buy' ? 'green' : 'red';

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 200,
        }}
      >
        <Space size={6} align="center">
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: 600 }}>
            {`${label}: ${String(exchange).toUpperCase()} ${String(symbol).toUpperCase()}`}
          </Text>
          <Tag color={typeColor} style={{ margin: 0, fontSize: 11 }}>
            {typeLabel}
          </Tag>
          <Tag color={sideColor} style={{ margin: 0, fontSize: 11 }}>
            {sideLabel}
          </Tag>
        </Space>
        <Space size={6} align="center">
          <Text style={{ color: '#848e9c', fontSize: 11 }}>
            {info?.label || '資金費率'}
          </Text>
          <Text style={{ color: info?.color || '#848e9c', fontSize: 11, fontWeight: 600 }}>
            {info?.rateText ?? '--'}
          </Text>
          <Text style={{ color: '#848e9c', fontSize: 11 }}>
            {info?.timeText ?? ''}
          </Text>
        </Space>
      </div>
    );
  };

  // Leg1 資金費率 (合約)
  useEffect(() => {
    if (leg1TypeWatch !== 'linear') return;

    const exchangeRaw = String(leg1ExchangeWatch || '').trim();
    const symbolRaw = String(leg1SymbolWatch || '').trim();

    if (!exchangeRaw || !symbolRaw) {
      updateLegFundingDisplay('leg1', {
        label: '資金費率',
        rateText: '--',
        timeText: '等待選擇',
        color: '#848e9c',
        status: 'idle',
      });
      return;
    }

    let cancelled = false;
    const symbolKey = symbolRaw.toUpperCase();

    const loadFundingRate = async () => {
      updateLegFundingDisplay('leg1', {
        label: '資金費率',
        rateText: '載入中...',
        timeText: '請稍候',
        color: '#848e9c',
        status: 'loading',
      });
      const record = await fetchFundingRateRecord(exchangeRaw, symbolKey);
      if (cancelled) return;

      if (record) {
        // 使用當前費率（實際結算週期的費率），而不是8小時標準化費率
        const rawRate = Number(record.fundingRate ?? record.fundingRate8h ?? 0);
        const percent = rawRate * 100;
        const rateText = `${percent >= 0 ? '+' : ''}${percent.toFixed(4)}%`;
        const cycleHours =
          typeof record.settlementIntervalHours === 'number'
            ? record.settlementIntervalHours
            : getFundingCycleHours(record.nextFundingTime, record.timestamp);
        const timeLabel = record.nextFundingTime
          ? formatTimeLabel(record.nextFundingTime, '結算')
          : formatTimeLabel(record.timestamp, '更新');
        updateLegFundingDisplay('leg1', {
          label: '資金費率',
          rateText,
          timeText: cycleHours ? `${timeLabel} (${cycleHours}H)` : timeLabel,
          color: percent >= 0 ? '#0ecb81' : '#f6465d',
          status: 'ready',
        });
      } else {
        updateLegFundingDisplay('leg1', {
          label: '資金費率',
          rateText: '--',
          timeText: '暫無資費資料',
          color: '#848e9c',
          status: 'empty',
        });
      }
    };

    loadFundingRate();
    const interval = window.setInterval(loadFundingRate, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [leg1ExchangeWatch, leg1SymbolWatch, leg1TypeWatch, fetchFundingRateRecord]);

  // Leg2 資金費率 (合約)
  useEffect(() => {
    if (leg2TypeWatch !== 'linear') return;

    const exchangeRaw = String(leg2ExchangeWatch || '').trim();
    const symbolRaw = String(leg2SymbolWatch || '').trim();

    if (!exchangeRaw || !symbolRaw) {
      updateLegFundingDisplay('leg2', {
        label: '資金費率',
        rateText: '--',
        timeText: '等待選擇',
        color: '#848e9c',
        status: 'idle',
      });
      return;
    }

    let cancelled = false;
    const symbolKey = symbolRaw.toUpperCase();

    const loadFundingRate = async () => {
      updateLegFundingDisplay('leg2', {
        label: '資金費率',
        rateText: '載入中...',
        timeText: '請稍候',
        color: '#848e9c',
        status: 'loading',
      });
      const record = await fetchFundingRateRecord(exchangeRaw, symbolKey);
      if (cancelled) return;

      if (record) {
        // 使用當前費率（實際結算週期的費率），而不是8小時標準化費率
        const rawRate = Number(record.fundingRate ?? record.fundingRate8h ?? 0);
        const percent = rawRate * 100;
        const rateText = `${percent >= 0 ? '+' : ''}${percent.toFixed(4)}%`;
        const cycleHours =
          typeof record.settlementIntervalHours === 'number'
            ? record.settlementIntervalHours
            : getFundingCycleHours(record.nextFundingTime, record.timestamp);
        const timeLabel = record.nextFundingTime
          ? formatTimeLabel(record.nextFundingTime, '結算')
          : formatTimeLabel(record.timestamp, '更新');
        updateLegFundingDisplay('leg2', {
          label: '資金費率',
          rateText,
          timeText: cycleHours ? `${timeLabel} (${cycleHours}H)` : timeLabel,
          color: percent >= 0 ? '#0ecb81' : '#f6465d',
          status: 'ready',
        });
      } else {
        updateLegFundingDisplay('leg2', {
          label: '資金費率',
          rateText: '--',
          timeText: '暫無資費資料',
          color: '#848e9c',
          status: 'empty',
        });
      }
    };

    loadFundingRate();
    const interval = window.setInterval(loadFundingRate, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [leg2ExchangeWatch, leg2SymbolWatch, leg2TypeWatch, fetchFundingRateRecord]);

  // Leg1 借幣利率 (現貨槓桿)
  useEffect(() => {
    if (leg1TypeWatch !== 'spot') return;

    const exchangeRaw = String(leg1ExchangeWatch || '').trim();
    const symbolRaw = String(leg1SymbolWatch || '').trim();
    const side = leg1Side;

    if (!exchangeRaw || !symbolRaw) {
      updateLegFundingDisplay('leg1', {
        label: '借幣利率',
        rateText: '--',
        timeText: '等待選擇',
        color: '#848e9c',
        status: 'idle',
      });
      return;
    }

    const targetAsset = getMarginAsset(symbolRaw, side);
    if (!targetAsset) {
      updateLegFundingDisplay('leg1', {
        label: '借幣利率',
        rateText: '--',
        timeText: '未找到利率資料',
        color: '#848e9c',
        status: 'empty',
      });
      return;
    }

    let cancelled = false;

    const loadBorrowingRate = async () => {
      updateLegFundingDisplay('leg1', {
        label: '借幣利率',
        rateText: `${targetAsset} 載入中...`,
        timeText: '請稍候',
        color: '#848e9c',
        status: 'loading',
      });

      const record = await fetchBorrowingRateRecord(exchangeRaw, targetAsset);
      if (cancelled) return;

      // Bybit 返回的是小時利率，前端直接使用小時利率，不乘以 24
      if (record && typeof record.interestRateHourly === 'number') {
        const rateHourly = record.interestRateHourly;
        const timestampMs = toMillis(record.timestamp);
        const settlementMs = typeof timestampMs === 'number' ? timestampMs + 60 * 60 * 1000 : null;
        updateLegFundingDisplay('leg1', {
          label: '借幣利率',
          rateText: `${targetAsset} ${rateHourly >= 0 ? '+' : ''}${(rateHourly * 100).toFixed(4)}%`,
          timeText: settlementMs
            ? `${formatTimeLabel(settlementMs, '結算')} (1H)`
            : '結算 --',
          color: '#f0b90b',
          status: 'ready',
        });
      } else if (record && typeof record.interestRateDaily === 'number') {
        // 兼容其他交易所的日利率（如 Binance）
        const rateDaily = record.interestRateDaily;
        const timestampMs = toMillis(record.timestamp);
        const settlementMs = typeof timestampMs === 'number' ? timestampMs + 60 * 60 * 1000 : null;
        updateLegFundingDisplay('leg1', {
          label: '借幣利率',
          rateText: `${targetAsset} ${rateDaily >= 0 ? '+' : ''}${(rateDaily * 100).toFixed(4)}%`,
          timeText: settlementMs
            ? `${formatTimeLabel(settlementMs, '結算')} (1H)`
            : '結算 --',
          color: '#f0b90b',
          status: 'ready',
        });
      } else {
        const fallback = getInterestRateInfo(exchangeRaw, targetAsset);
        const hasFallback = typeof fallback.rate === 'number' && !Number.isNaN(fallback.rate);
        updateLegFundingDisplay('leg1', {
          label: '借幣利率',
          rateText: hasFallback
            ? `${targetAsset} ${fallback.rate! >= 0 ? '+' : ''}${(fallback.rate! * 100).toFixed(4)}%`
            : `${targetAsset} --`,
          timeText: hasFallback
            ? formatTimeLabel(fallback.timestamp, '更新')
            : '未找到利率資料',
          color: hasFallback ? '#f0b90b' : '#848e9c',
          status: hasFallback ? 'ready' : 'empty',
        });
      }
    };

    loadBorrowingRate();
    const interval = window.setInterval(loadBorrowingRate, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    leg1TypeWatch,
    leg1ExchangeWatch,
    leg1SymbolWatch,
    leg1Side,
    fetchBorrowingRateRecord,
    getInterestRateInfo,
    positionsSummary,
  ]);

  // Leg2 借幣利率 (現貨槓桿)
  useEffect(() => {
    if (leg2TypeWatch !== 'spot') return;

    const exchangeRaw = String(leg2ExchangeWatch || '').trim();
    const symbolRaw = String(leg2SymbolWatch || '').trim();
    const side = leg2Side;

    if (!exchangeRaw || !symbolRaw) {
      updateLegFundingDisplay('leg2', {
        label: '借幣利率',
        rateText: '--',
        timeText: '等待選擇',
        color: '#848e9c',
        status: 'idle',
      });
      return;
    }

    const targetAsset = getMarginAsset(symbolRaw, side);
    if (!targetAsset) {
      updateLegFundingDisplay('leg2', {
        label: '借幣利率',
        rateText: '--',
        timeText: '未找到利率資料',
        color: '#848e9c',
        status: 'empty',
      });
      return;
    }

    let cancelled = false;

    const loadBorrowingRate = async () => {
      updateLegFundingDisplay('leg2', {
        label: '借幣利率',
        rateText: `${targetAsset} 載入中...`,
        timeText: '請稍候',
        color: '#848e9c',
        status: 'loading',
      });

      const record = await fetchBorrowingRateRecord(exchangeRaw, targetAsset);
      if (cancelled) return;

      // Bybit 返回的是小時利率，前端直接使用小時利率，不乘以 24
      if (record && typeof record.interestRateHourly === 'number') {
        const rateHourly = record.interestRateHourly;
        const timestampMs = toMillis(record.timestamp);
        const settlementMs = typeof timestampMs === 'number' ? timestampMs + 60 * 60 * 1000 : null;
        updateLegFundingDisplay('leg2', {
          label: '借幣利率',
          rateText: `${targetAsset} ${rateHourly >= 0 ? '+' : ''}${(rateHourly * 100).toFixed(4)}%`,
          timeText: settlementMs
            ? `${formatTimeLabel(settlementMs, '結算')} (1H)`
            : '結算 --',
          color: '#f0b90b',
          status: 'ready',
        });
      } else if (record && typeof record.interestRateDaily === 'number') {
        // 兼容其他交易所的日利率（如 Binance）
        const rateDaily = record.interestRateDaily;
        const timestampMs = toMillis(record.timestamp);
        const settlementMs = typeof timestampMs === 'number' ? timestampMs + 60 * 60 * 1000 : null;
        updateLegFundingDisplay('leg2', {
          label: '借幣利率',
          rateText: `${targetAsset} ${rateDaily >= 0 ? '+' : ''}${(rateDaily * 100).toFixed(4)}%`,
          timeText: settlementMs
            ? `${formatTimeLabel(settlementMs, '結算')} (1H)`
            : '結算 --',
          color: '#f0b90b',
          status: 'ready',
        });
      } else {
        const fallback = getInterestRateInfo(exchangeRaw, targetAsset);
        const hasFallback = typeof fallback.rate === 'number' && !Number.isNaN(fallback.rate);
        updateLegFundingDisplay('leg2', {
          label: '借幣利率',
          rateText: hasFallback
            ? `${targetAsset} ${fallback.rate! >= 0 ? '+' : ''}${(fallback.rate! * 100).toFixed(4)}%`
            : `${targetAsset} --`,
          timeText: hasFallback
            ? formatTimeLabel(fallback.timestamp, '更新')
            : '未找到利率資料',
          color: hasFallback ? '#f0b90b' : '#848e9c',
          status: hasFallback ? 'ready' : 'empty',
        });
      }
    };

    loadBorrowingRate();
    const interval = window.setInterval(loadBorrowingRate, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    leg2TypeWatch,
    leg2ExchangeWatch,
    leg2SymbolWatch,
    leg2Side,
    fetchBorrowingRateRecord,
    getInterestRateInfo,
    positionsSummary,
  ]);

  const isSpotBlocked = (ex?: string) => {
    const v = String(ex || '').toLowerCase();
    return v === 'bitget' || v === 'aster';
  };
  const isLinearBlocked = (ex?: string) => String(ex || '').toLowerCase() === 'mexc';

  // Bitget/Aster spot are disabled here; OKX spot margin is selectable.
  useEffect(() => {
    if (isSpotBlocked(leg1ExchangeWatch) && leg1TypeWatch !== 'linear') {
      legsForm.setFieldValue('leg1_type', 'linear');
    }
    if (isLinearBlocked(leg1ExchangeWatch) && leg1TypeWatch !== 'spot') {
      legsForm.setFieldValue('leg1_type', 'spot');
    }
  }, [leg1ExchangeWatch, leg1TypeWatch, legsForm]);

  useEffect(() => {
    if (isSpotBlocked(leg2ExchangeWatch) && leg2TypeWatch !== 'linear') {
      legsForm.setFieldValue('leg2_type', 'linear');
    }
    if (isLinearBlocked(leg2ExchangeWatch) && leg2TypeWatch !== 'spot') {
      legsForm.setFieldValue('leg2_type', 'spot');
    }
  }, [leg2ExchangeWatch, leg2TypeWatch, legsForm]);
  
  useEffect(() => {
    if (!leg2ManualSymbol) {
      if (leg1SymbolWatch && leg2SymbolWatch !== leg1SymbolWatch) {
        legsForm.setFieldValue('leg2_symbol', leg1SymbolWatch);
      }
    }
  }, [leg1SymbolWatch, leg2ManualSymbol, leg2SymbolWatch, legsForm]);

  const getPriceKey = useCallback((exchange: string, symbol: string, type: LegType) => {
    return `${exchange.toLowerCase()}|${symbol.toUpperCase()}|${type === 'linear' ? 'linear' : 'spot'}`;
  }, []);

  const fetchTop = useCallback(async (exchange: string, symbol: string, type: LegType): Promise<TopPrice> => {
    const normalizedExchange = exchange.toLowerCase();
    const normalizedSymbol = symbol.toUpperCase();
    const normalizedType = type === 'linear' ? 'linear' : 'spot';
    const key = getPriceKey(normalizedExchange, normalizedSymbol, normalizedType);
    const cached = priceRequestCache.get(key);
    const now = Date.now();

    if (cached && now - cached.ts < PRICE_CACHE_TTL_MS) {
      return cached.data;
    }

    const existingRequest = inFlightPriceRequests.get(key);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
      try {
        const base = getApiBaseUrl();
        const needsCategory = normalizedExchange === 'bybit' || normalizedExchange === 'binance';
        const url = needsCategory
          ? `${base}/api/prices/${normalizedExchange}/${normalizedSymbol}?category=${normalizedType}`
          : `${base}/api/prices/${normalizedExchange}/${normalizedSymbol}`;
        const res = await fetch(url);
        const data = await res.json();
        const bid = Number(data?.data?.bids?.[0]?.[0] || 0);
        const ask = Number(data?.data?.asks?.[0]?.[0] || 0);
        const price = bid > 0 && ask > 0 ? { bid, ask } : { bid: 0, ask: 0 };
        priceRequestCache.set(key, { ts: Date.now(), data: price });
        return price;
      } catch (e) {
        return { bid: 0, ask: 0 };
      } finally {
        inFlightPriceRequests.delete(key);
      }
    })();

    inFlightPriceRequests.set(key, request);
    return request;
  }, [getPriceKey]);

  // 價格輪詢已改為使用 pairPrices state（在 useEffect 中處理）

  // 定期刷新 TWAP 策略列表（WS 補償，10s）
  useEffect(() => {
    const refreshTwapStrategies = async () => {
      try {
        const twapRes = await apiService.getTwapStrategies();
        if (twapRes.data) {
          const strategies = mapTwapPlansToUi(twapRes.data);
          dispatch({ type: 'twap/setStrategies', payload: strategies });
        }
      } catch (e) {
        // 靜默失敗，不影響用戶體驗
      }
    };

    // 立即執行一次（初始化載入）
    refreshTwapStrategies();

    // 改為低頻輪詢作為 WS 事件補償（WS 送 twapExecuted/twapPlanCompleted 即時更新）
    const twapPollInterval = window.setInterval(refreshTwapStrategies, 10000);

    return () => {
      window.clearInterval(twapPollInterval);
    };
  }, [dispatch]);

  // 定期刷新 PAIR 監控對列表（WS 不便時的補償，降為 10s）
  useEffect(() => {
    const refreshMonitoringPairs = async () => {
      try {
        const pairsRes = await apiService.getMonitoringPairs();
        if (pairsRes.success && pairsRes.data) {
          dispatch({
            type: 'arbitrage/setMonitoringPairs',
            payload: normalizeMonitoringPairs(pairsRes.data),
          });
        }
      } catch (e) {
        // 靜默失敗，不影響用戶體驗
      }
    };

    refreshMonitoringPairs();

    const pairsPollInterval = window.setInterval(refreshMonitoringPairs, 10000);

    return () => {
      window.clearInterval(pairsPollInterval);
    };
  }, [dispatch]);

  // 定期刷新交易所實際持倉（倉位無 WS，保持中頻 5s 輪詢）
  useEffect(() => {
    const refreshPositions = async () => {
      try {
        const apiBase = getApiBaseUrl();
        const res = await fetch(`${apiBase}/api/positions/summary`);
        const data = await res.json();
        if (data?.success) {
          dispatch({ type: 'positions/setSummary', payload: data.data });
        }
      } catch (e) {
        // 靜默失敗
      }
    };

    refreshPositions();

    const positionsInterval = window.setInterval(refreshPositions, 5000);

    return () => {
      window.clearInterval(positionsInterval);
    };
  }, [dispatch]);

  // 🔥 簡化：監控表格直接顯示交易所實際持倉（不需要判斷開關倉）
  const allPositionsData = useMemo(() => {
    // 直接從 positionsSummary 獲取所有實際持倉
    const allRealPositions: any[] = [];
    
    // 穩定幣列表（不應顯示在倉位監控中）
    const stableCoins = ['USDT', 'USDC', 'USD1', 'USD', 'BUSD', 'DAI', 'TUSD', 'BYUSDT'];
    
    if (positionsSummary?.accounts) {
      positionsSummary.accounts.forEach(acc => {
        // 處理合約持倉和現貨槓桿持倉（從 positions 中）
        acc.positions.forEach(pos => {
          // 只顯示有持倉的項目（sizeBase !== 0）
          if (Math.abs(pos.sizeBase || 0) > 0) {
            const positionType =
              (pos.type as string) === 'linear' || (pos.type as string) === 'perp_linear'
                ? 'linear'
                : (pos.type as string) === 'spot_margin'
                  ? 'margin'
                  : 'spot';

            if (shouldHideStablecoinPosition(pos.symbol, positionType)) {
              return;
            }

            allRealPositions.push({
              id: `${acc.exchange}_${pos.symbol}_${pos.side}`, // 唯一ID
              exchange: acc.exchange,
              symbol: pos.symbol,
              // 🔥 正確分類持倉類型
              // spot_margin = 現貨槓桿（借貸），應該顯示為 margin 類型
              // spot_cash = 純現貨（不借貸），顯示為 spot 類型
              // linear/perp_linear = 合約，顯示為 linear 類型
              type: positionType,
              side: pos.side === 'long' ? 'buy' : 'sell', // 轉換為 buy/sell
              // 直接使用交易所數據
              realData: {
                size: Math.abs(pos.sizeBase),
                entryPrice: pos.entryPrice,
                markPrice: pos.markPrice,
                unrealizedPnl: pos.unrealizedPnlUSDT,
                realizedPnlUSDT: pos.realizedPnlUSDT,
                liquidationPrice: pos.liquidationPrice,
                leverage: pos.leverage,
                margin: pos.marginUSDT,
                notionalUSDT: pos.notionalUSDT,
                marginMode: pos.marginMode,
              }
            });
          }
        });
        
        // 🔥 處理純現貨餘額（從 balances 中，沒有借幣的）
        if (acc.balances && Array.isArray(acc.balances)) {
          acc.balances.forEach((balance: any) => {
            const asset = String(balance.asset || '').toUpperCase();
            const netBalance = balance.netBalance || 0;
            const borrowed = balance.borrowed || 0;
            const usdtValue = balance.usdtValue || 0;
            
            // 跳過穩定幣
            if (stableCoins.includes(asset)) {
              return;
            }
            
            // 只處理純現貨（沒有借幣，且有餘額）
            if (borrowed === 0 && Math.abs(netBalance) > 0 && Math.abs(usdtValue) > 1) {
              // 構建交易對符號（例如：BTC -> BTCUSDT）
              const symbol = `${asset}USDT`;
              
              // 計算標記價格（使用 USDT 價值 / 數量）
              const markPrice = netBalance !== 0 ? Math.abs(usdtValue / netBalance) : 0;
              
              // 判斷方向（餘額為正 = 多頭，餘額為負 = 空頭）
              const side = netBalance > 0 ? 'buy' : 'sell';

              if (shouldHideStablecoinPosition(symbol, 'spot')) {
                return;
              }
              
              allRealPositions.push({
                id: `${acc.exchange}_${symbol}_${side}_spot_cash`, // 唯一ID（添加 spot_cash 後綴避免與 positions 衝突）
                exchange: acc.exchange,
                symbol: symbol,
                type: 'spot', // 純現貨
                side: side,
                realData: {
                  size: Math.abs(netBalance),
                  entryPrice: markPrice, // 現貨使用當前價格作為 entryPrice
                  markPrice: markPrice,
                  unrealizedPnl: 0, // 純現貨沒有未實現盈虧
                  realizedPnlUSDT: 0, // 純現貨沒有已實現盈虧
                  liquidationPrice: null, // 現貨沒有強平價格
                  leverage: 1, // 現貨無槓桿
                  margin: Math.abs(usdtValue), // 現貨全額佔用
                  notionalUSDT: Math.abs(usdtValue),
                  marginMode: 'cross',
                }
              });
            }
          });
        }
      });
    }
    
    return allRealPositions;
  }, [positionsSummary]);

  // 🔥 已移除平倉檢測邏輯（直接顯示交易所持倉，不需要判斷開關倉）

  // 載入執行記錄（套利和 TWAP）- 優先從持久化數據讀取，解決刷新後價格丟失問題
  useEffect(() => {
    const loadExecutions = async () => {
      try {
        // 載入套利執行記錄（參考 ArbitragePage.tsx 的實現）
        // 立即載入，不等待其他數據，確保刷新後能快速顯示價格
        const arbRes = await apiService.getArbitrageExecutions();
        console.log('🔍 套利執行記錄 API 響應:', arbRes);
        
        // 以 adapter 統一解析後端多種形狀 → { recent, history }
        const { recent: persistedRecent, history } = parseArbitrageExecutionsResponse(arbRes);
        // 內存中的執行記錄仍可能出現於 data.executions 或根層 executions
        const data = (arbRes as any)?.data || history || {};
        let memExecutions: any[] = Array.isArray(data.executions)
          ? data.executions
          : Array.isArray((arbRes as any)?.executions)
            ? (arbRes as any).executions
            : [];
        
        // 合併：優先使用持久化數據（更完整），然後補充內存數據（避免重複）
        const allExecutions = [...persistedRecent];
        
        // 如果內存中有持久化數據中沒有的記錄，也加入（基於 pairId 去重）
        const persistedPairIds = new Set(persistedRecent.map((e: any) => e.pairId || e.id).filter(Boolean));
        memExecutions.forEach((e: any) => {
          const eId = e.pairId || e.id;
          if (eId && !persistedPairIds.has(eId)) {
            allExecutions.push(e);
          }
        });
        
        console.log('📊 解析後的套利執行記錄 - 持久化:', persistedRecent.length, '條, 內存:', memExecutions.length, '條, 合併:', allExecutions.length, '條');
        
        if (allExecutions.length > 0) {
          dispatch(setRecentExecutions(allExecutions));
        } else {
          dispatch(setRecentExecutions([]));
        }

        // 載入 TWAP 執行記錄（參考 TwapPage.tsx 的實現）
        const twapRes = await apiService.getTwapExecutions();
        console.log('🔍 TWAP 執行記錄 API 響應:', twapRes);
        
        const twapRecent = parseTwapExecutionsResponse(twapRes).recent;
        
        // ✅ V3 改進：將 JSONL 格式轉換為前端格式（支援新舊格式）
        const convertedTwapExecutions = twapRecent
          .filter((record: any) => {
            // ✅ V3 改進：支持多種 ID 字段（strategyId, twapId, planId）
            return record && (record.strategyId || record.twapId || record.planId);
          })
          .map((record: any) => {
            // ✅ V3 向後兼容：檢測是舊格式（單腿）還是新格式（完整）
            const isLegacyFormat = 'legIndex' in record;
            
            if (isLegacyFormat) {
              // 舊格式：單腿記錄
              const strategyId = record.strategyId || record.twapId || record.planId;
              return {
                strategyId,
                planId: strategyId,
                timestamp: record.ts || record.timestamp || Date.now(),
                ts: record.ts || record.timestamp || Date.now(),
                qty: record.qty || 0,
                amount: record.qty || 0,
                success: record.success === true,
                orderId: record.orderId,
                legIndex: record.legIndex,
                sliceIndex: record.sliceIndex,
                price: record.price,
                symbol: record.symbol,
                exchange: record.exchange,
                type: record.type,
                side: record.side,
                error: record.error,
                _isLegacyFormat: true
              };
            } else {
              // ✅ V3 新格式：完整記錄（包含 leg1 和 leg2）
              const strategyId = record.strategyId || record.twapId || record.planId;
              return {
                strategyId,
                planId: strategyId,
                timestamp: record.ts || record.timestamp || Date.now(),
                ts: record.ts || record.timestamp || Date.now(),
                qty: record.qty || 0,
                amount: record.qty || 0,
                sliceQty: record.sliceQty || record.qty || 0,
                totalAmount: record.totalAmount,
                orderCount: record.orderCount,
                status: record.status || 'unknown',
                success: record.status === 'success',
                sliceIndex: record.sliceIndex,
                totalTriggers: record.totalTriggers, // ✅ V3 新增字段
                spread: record.spread,
                spreadPercent: record.spreadPercent,
                intervalMs: record.intervalMs,
                // leg1 信息
                leg1: record.leg1 ? {
                  exchange: record.leg1.exchange,
                  symbol: record.leg1.symbol,
                  type: record.leg1.type,
                  side: record.leg1.side,
                  orderId: record.leg1.orderId,
                  price: record.leg1.price,
                  priceUpdated: record.leg1.priceUpdated
                } : null,
                // leg2 信息
                leg2: record.leg2 ? {
                  exchange: record.leg2.exchange,
                  symbol: record.leg2.symbol,
                  type: record.leg2.type,
                  side: record.leg2.side,
                  orderId: record.leg2.orderId,
                  price: record.leg2.price,
                  priceUpdated: record.leg2.priceUpdated
                } : null,
                // 回滾相關
                isRollback: record.isRollback || false,
                originalSliceIndex: record.originalSliceIndex,
                _isUnifiedFormat: true
              };
            }
          });
        
        console.log('📊 解析後的 TWAP 執行記錄:', convertedTwapExecutions.length, '條');
        if (convertedTwapExecutions.length > 0) {
          dispatch(setTwapExecutions(convertedTwapExecutions));
        } else {
          dispatch(setTwapExecutions([]));
        }
      } catch (e) {
        console.error('❌ 載入執行記錄失敗:', e);
      }
    };

    // 立即執行一次
    loadExecutions();

    // 每 5 秒刷新一次執行記錄
    const executionsInterval = window.setInterval(loadExecutions, 5000);

    return () => {
      window.clearInterval(executionsInterval);
    };
  }, [dispatch]);

  // 執行記錄改用 Redux 中的 arbitrage.recentExecutions 與 twap.executions 合併處理

  const handleCreatePair = async () => {
    try {
      const v = pairForm.getFieldsValue();
      const legs = legsForm.getFieldsValue();
      const payload = {
        pairId: `pair_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        leg1: {
          exchange: String(legs.leg1_exchange || 'bybit'),
          symbol: String(legs.leg1_symbol || 'ETHUSDT').toUpperCase(),
          type: (legs.leg1_type || 'spot') as LegType,
          side: (legs.leg1_side || 'buy') as SideType,
        },
        leg2: {
          exchange: String(legs.leg2_exchange || 'binance'),
          symbol: String(legs.leg2_symbol || 'ETHUSDT').toUpperCase(),
          type: (legs.leg2_type || 'spot') as LegType,
          side: (legs.leg2_side || 'sell') as SideType,
        },
        threshold: Number(v.threshold ?? 0.1),
        qty: Number(v.qty ?? 0.1),
        enabled: true,
        maxExecs: Number(v.maxExecs ?? 1),
      } as any;
      const res = await apiService.upsertArbitragePair(payload);
      if ((res as any)?.success === false) throw new Error((res as any)?.error || '創建失敗');
      dispatch(addPairToStore({
        id: payload.pairId,
        leg1: payload.leg1,
        leg2: payload.leg2,
        threshold: payload.threshold,
        qty: payload.qty,
        amount: payload.qty,
        enabled: true,
        maxExecs: payload.maxExecs,
        createdAt: Date.now(),
        totalTriggers: 0,
        lastTriggered: null,
      } as any));
      message.success('✅ 已新增套利監控對');
    } catch (e: any) {
      message.error(e?.message || '新增失敗');
    }
  };

  const handleAddSpreadMonitor = useCallback(() => {
    const v = pairForm.getFieldsValue();
    const legs = legsForm.getFieldsValue();
    const monitor: SpreadMonitor = {
      id: `monitor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      leg1: {
        exchange: String(legs.leg1_exchange || 'bybit'),
        symbol: String(legs.leg1_symbol || 'ETHUSDT').toUpperCase(),
        type: (legs.leg1_type || 'spot') as LegType,
        side: (legs.leg1_side || leg1Side || 'buy') as SideType,
      },
      leg2: {
        exchange: String(legs.leg2_exchange || 'binance'),
        symbol: String(legs.leg2_symbol || 'ETHUSDT').toUpperCase(),
        type: (legs.leg2_type || 'spot') as LegType,
        side: (legs.leg2_side || leg2Side || 'sell') as SideType,
      },
      threshold: Number(v.threshold ?? 0),
      enabled: true,
      createdAt: Date.now(),
    };

    setSpreadMonitors(prev => [monitor, ...prev]);
    setBottomTab('orders');
    message.success('已新增差價監控');
  }, [pairForm, legsForm, leg1Side, leg2Side, message]);

  const handleCreateTwap = async () => {
    try {
      const v = twapForm.getFieldsValue();
      const legs = legsForm.getFieldsValue();
      const payload = {
        name: `TWAP_${Date.now()}`,
        totalQty: Number(v.sliceQty) * Number(v.orderCount),
        sliceQty: Number(v.sliceQty),
        intervalMs: Math.max(1, Number(v.intervalSec || 10)) * 1000,
        legs: [
          {
            exchange: String(legs.leg1_exchange || 'bybit'),
            symbol: String(legs.leg1_symbol || 'ETHUSDT').toUpperCase(),
            side: (legs.leg1_side || 'buy') as SideType,
            type: 'market',
            category: (legs.leg1_type === 'linear' ? 'linear' : 'spot') as 'linear' | 'spot',
          },
          {
            exchange: String(legs.leg2_exchange || 'binance'),
            symbol: String(legs.leg2_symbol || 'ETHUSDT').toUpperCase(),
            side: (legs.leg2_side || 'sell') as SideType,
            type: 'market',
            category: (legs.leg2_type === 'linear' ? 'linear' : 'spot') as 'linear' | 'spot',
          },
        ],
      };
      const res: any = await apiService.addTwapStrategy(payload);
      if (res?.success) {
        const planId = res?.data?.planId || `twap_${Date.now()}`;
        
        // 自動啟動 TWAP 策略
        try {
          await apiService.controlTwapStrategy(planId, 'start');
          message.success('✅ 已新增並啟動 TWAP 策略');
        } catch (startError: any) {
          message.warning(`TWAP 策略已創建但啟動失敗: ${startError?.message || '未知錯誤'}`);
        }
        
        dispatch(addTwapToStore({
          id: planId,
          leg1: {
            exchange: payload.legs[0].exchange,
            symbol: payload.legs[0].symbol,
            type: payload.legs[0].category === 'linear' ? 'future' : 'spot',
            side: payload.legs[0].side,
          },
          leg2: {
            exchange: payload.legs[1].exchange,
            symbol: payload.legs[1].symbol,
            type: payload.legs[1].category === 'linear' ? 'future' : 'spot',
            side: payload.legs[1].side,
          },
          totalAmount: payload.totalQty,
          timeInterval: payload.intervalMs,
          orderCount: Math.round(payload.totalQty / payload.sliceQty),
          amountPerOrder: payload.sliceQty,
          priceType: 'market',
          enabled: true,
          createdAt: Date.now(),
          executedOrders: 0,
          remainingAmount: payload.totalQty,
          nextExecutionTime: 0,
          status: 'running',  // 改為 running 狀態
        } as any));
      } else {
        throw new Error(res?.message || '新增失敗');
      }
    } catch (e: any) {
      message.error(e?.message || '新增失敗');
    }
  };

  // 獲取實時價格的輔助函數
  const [pairPrices, setPairPrices] = useState<Record<string, { leg1: any; leg2: any }>>({});

  const ongoingData = useMemo(() => {
    // 🔥 修復：為 pairs 和 strategies 的 key 添加前綴，確保唯一性
    const pairs = (arbitrage.monitoringPairs || []).filter(p => p.enabled).map(p => ({ key: `pair_${p.id}`, type: 'pair', ...p }));
    // 只顯示 active, running, paused 狀態的 TWAP 策略
    // 過濾掉 completed, failed, cancelled 狀態
    const strategies = (twap.strategies || [])
      .filter((s: any) => ['active', 'running', 'paused'].includes(String(s.status || s.state)))
      .map((s: any) => ({ key: `twap_${s.id}`, type: 'twap', ...s }));
    return [...pairs, ...strategies];
  }, [arbitrage.monitoringPairs, twap.strategies]);

  // 歷史記錄：顯示已完成的訂單（套利與 TWAP）- 參考舊版實現
  const historyData = useMemo(() => {
    const monitoringPairs = monitoringPairsRef.current;
    const twapStrategiesSnapshot = twapStrategiesRef.current;

    console.log('📋 生成歷史記錄 - 套利執行:', arbitrage.recentExecutions?.length || 0, 'TWAP 執行:', twap.executions?.length || 0);
    
    // 🔥 處理套利執行記錄（按 pairId 聚合，計算各自的均價）
    // 包含所有執行記錄（成功和失敗的），不再過濾
    const allExecs = (arbitrage.recentExecutions || [])
      .filter((e: any) => {
        if (!e || typeof e !== 'object') return false;
        return true; // 包含所有有效記錄
      });
    
    // 🔥 按 pairId 聚合執行記錄，計算各自的均價
    // 使用 Map 來存儲每個 pairId 的統計信息，包括成功和失敗的記錄
    const pairStats = new Map<string, any>();
    
    allExecs.forEach((e: any) => {
      // 🔥 優先使用原始的 pairId 進行聚合（確保每個 pairId 的記錄獨立顯示）
      // 這樣可以避免不同 pairId 但相同 leg1/leg2 的記錄被錯誤聚合
      // 例如：手動刪除的記錄不應該與其他 pairId 的成功記錄聚合在一起
      let pairId: string;
      
      // 🔥 優先使用原始的 pairId
      if (e?.pairId) {
        pairId = e.pairId;
      } else if (e?.opportunity?.pairConfig?.id) {
        pairId = e.opportunity.pairConfig.id;
      } else if (e?.leg1 && e?.leg2) {
        // 如果沒有 pairId，則根據 leg1 和 leg2 的信息生成唯一 ID（作為備選方案）
        const leg1Key = `${e.leg1.exchange}_${e.leg1.symbol}_${e.leg1.type || 'spot'}_${e.leg1.side}`;
        const leg2Key = `${e.leg2.exchange}_${e.leg2.symbol}_${e.leg2.type || 'spot'}_${e.leg2.side}`;
        pairId = `pair_${leg1Key}_${leg2Key}`;
      } else if (e?.opportunity?.pairConfig?.leg1 && e?.opportunity?.pairConfig?.leg2) {
        // 如果沒有直接的 leg1/leg2，從 opportunity 中獲取
        const leg1 = e.opportunity.pairConfig.leg1;
        const leg2 = e.opportunity.pairConfig.leg2;
        const leg1Key = `${leg1.exchange}_${leg1.symbol}_${leg1.type || 'spot'}_${leg1.side}`;
        const leg2Key = `${leg2.exchange}_${leg2.symbol}_${leg2.type || 'spot'}_${leg2.side}`;
        pairId = `pair_${leg1Key}_${leg2Key}`;
      } else {
        // 最後的備選：生成一個臨時 ID
        pairId = `pair_${e?.timestamp || e?.ts || Date.now()}`;
      }
      
      // 提取 leg1 和 leg2 信息
      let leg1 = {};
      let leg2 = {};
      
      if (e?.leg1 && e?.leg2) {
        leg1 = {
          exchange: e.leg1.exchange,
          symbol: e.leg1.symbol,
          type: e.leg1.type || 'spot',
          side: e.leg1.side,
        };
        leg2 = {
          exchange: e.leg2.exchange,
          symbol: e.leg2.symbol,
          type: e.leg2.type || 'spot',
          side: e.leg2.side,
        };
      } else if (e?.opportunity?.pairConfig?.leg1 && e?.opportunity?.pairConfig?.leg2) {
        leg1 = e.opportunity.pairConfig.leg1;
        leg2 = e.opportunity.pairConfig.leg2;
      } else if (e?.pairId) {
        const pair = monitoringPairs?.find((p: any) => p.id === e.pairId);
        if (pair?.leg1 && pair?.leg2) {
          leg1 = pair.leg1;
          leg2 = pair.leg2;
        }
      }
      
      // 提取執行價格
      const leg1Price = e?.leg1?.price ? parseFloat(e.leg1.price) : null;
      const leg2Price = e?.leg2?.price ? parseFloat(e.leg2.price) : null;
      
      // 初始化或更新統計
      if (!pairStats.has(pairId)) {
        pairStats.set(pairId, {
          pairId,
          leg1,
          leg2,
          leg1Prices: [],
          leg2Prices: [],
          timestamps: [],
          successStates: [], // 🔥 記錄每個執行記錄的成功狀態
          leg1Qtys: [], // 🔥 記錄 leg1 的成交數量
          leg2Qtys: [], // 🔥 記錄 leg2 的成交數量
          executionRecords: [], // 🔥 記錄所有執行記錄（用於查找失敗次數）
          thresholds: [], // 🔥 記錄設定差價（threshold）
          isManualDelete: false, // 🔥 標記是否為手動刪除
          hasFailedRecord: false, // 🔥 標記是否存在失敗記錄（優先於手動刪除顯示）
          manualDeleteRecords: [], // 🔥 記錄所有手動刪除且沒有成交的記錄
          totalAmount: null, // ✅ V3 新增：記錄預期總成交量（新格式）
          maxExecs: null, // 🔥 記錄預期執行次數（舊格式，向下兼容）
          expectedQtyPerExecution: null, // 🔥 記錄每次執行的預期數量
        });
      }
      
      const stats = pairStats.get(pairId);
      
      // 🔥 記錄預期總成交量（優先使用 totalAmount，否則使用 maxExecs）
      // ✅ V3 改進：新的統一格式使用 totalAmount 字段
      if (e?.totalAmount !== null && e?.totalAmount !== undefined && stats.totalAmount === null) {
        stats.totalAmount = e.totalAmount;
      }
      // 向下兼容：如果沒有 totalAmount，使用 maxExecs
      if (e?.maxExecs !== null && e?.maxExecs !== undefined && stats.maxExecs === null) {
        stats.maxExecs = e.maxExecs;
      }
      const qty = e?.qty || e?.amount || 0;
      // 🔥 優先使用有成交的記錄的 qty，如果沒有則使用任何記錄的 qty（包括 qty: 0）
      // 這樣即使所有記錄都是手動刪除且 qty: 0，也能從 maxExecs 計算預期數量（雖然 qty 為 0）
      if (stats.expectedQtyPerExecution === null) {
        // 優先使用有成交的記錄
        if (qty > 0) {
          stats.expectedQtyPerExecution = qty;
        } else if (stats.expectedQtyPerExecution === null) {
          // 如果還沒有記錄，即使 qty: 0 也記錄（用於計算，雖然結果會是 0）
          stats.expectedQtyPerExecution = 0;
        }
      } else if (qty > 0 && stats.expectedQtyPerExecution === 0) {
        // 如果之前記錄的是 0，但現在有成交記錄，更新為實際數量
        stats.expectedQtyPerExecution = qty;
      }
      
      // 🔥 提取設定差價（threshold）
      // ⚠️ 只從執行記錄本身中提取，不從監控對配置中讀取（因為監控對可能已被刪除）
      // 這樣可以確保顯示的是執行時的實際設定差價，而不是當前監控對的設定
      let threshold: number | null = null;
      if (typeof e?.threshold === 'number') {
        threshold = e.threshold;
      } else if (typeof e?.opportunity?.pairConfig?.threshold === 'number') {
        threshold = e.opportunity.pairConfig.threshold;
      } else if (typeof e?.opportunity?.threshold === 'number') {
        threshold = e.opportunity.threshold;
      }
      // ⚠️ 不再從監控對配置中讀取，避免讀取到已刪除監控對的錯誤數據
      
      // 🔥 檢查是否為手動刪除
      const isManualDelete = e?.status === 'cancelled' || e?.reason === 'manual';
      if (isManualDelete) {
        stats.isManualDelete = true;
        // 🔥 記錄手動刪除且沒有成交的記錄
        const qty = e?.qty || e?.amount || 0;
        if (qty === 0) {
          stats.manualDeleteRecords.push({
            timestamp: e?.timestamp || e?.ts || Date.now(),
            qty: 0,
          });
        }
      }
      // 🔥 檢查是否存在失敗記錄（結果欄優先顯示失敗）
      const status = String(e?.status || '').toLowerCase();
      if (status === 'failed') {
        stats.hasFailedRecord = true;
      }
      
      // 🔥 如果找到 threshold，記錄它（包括手動刪除的記錄，也要顯示設定差價）
      if (threshold !== null) {
        stats.thresholds.push(threshold);
      }
      
      // 🔥 記錄成功狀態
      const isSuccess = e?.success === true || e?.status === 'success' || e?.opportunity?.status === 'success';
      stats.successStates.push(isSuccess);
      
      // 🔥 記錄執行記錄（用於查找失敗次數）
      stats.executionRecords.push({
        isSuccess,
        timestamp: e?.timestamp || e?.ts || Date.now(),
      });
      
      // 🔥 提取成交數量
      // 套利執行記錄：qty 在頂層，leg1 和 leg2 共用相同的數量
      // 注意：qty 已經在上面提取過了，這裡直接使用
      const leg1Qty = isSuccess ? qty : 0; // 只有成功時才計入數量
      const leg2Qty = isSuccess ? qty : 0; // 只有成功時才計入數量
      
      // 只有成功的記錄才計算價格和數量
      if (isSuccess) {
        if (leg1Price !== null && leg1Price > 0) {
          stats.leg1Prices.push(leg1Price);
        }
        if (leg2Price !== null && leg2Price > 0) {
          stats.leg2Prices.push(leg2Price);
        }
        if (leg1Qty > 0) {
          stats.leg1Qtys.push(leg1Qty);
        }
        if (leg2Qty > 0) {
          stats.leg2Qtys.push(leg2Qty);
        }
      }
      stats.timestamps.push(e?.timestamp || e?.ts || Date.now());
    });
    
    // 🔥 計算各自的均價和價差百分比
    const arbExecs = Array.from(pairStats.values()).map((stats: any) => {
      // 計算各自的均價
      const leg1AvgPrice = stats.leg1Prices.length > 0 
        ? stats.leg1Prices.reduce((sum: number, p: number) => sum + p, 0) / stats.leg1Prices.length 
        : null;
      const leg2AvgPrice = stats.leg2Prices.length > 0 
        ? stats.leg2Prices.reduce((sum: number, p: number) => sum + p, 0) / stats.leg2Prices.length 
        : null;
      
      // 🔥 計算價差百分比：根據交易方向正確計算
      // +A-B（leg1 買入，leg2 賣出）：(leg2賣出價 - leg1買入價) / leg1買入價 * 100
      // -A+B（leg1 賣出，leg2 買入）：(leg1賣出價 - leg2買入價) / leg2買入價 * 100
      let spreadPercent: number | null = null;
      if (leg1AvgPrice !== null && leg2AvgPrice !== null && leg1AvgPrice > 0 && leg2AvgPrice > 0) {
        const leg1Side = stats.leg1?.side || 'buy';
        const leg2Side = stats.leg2?.side || 'sell';
        
        if (leg1Side === 'buy' && leg2Side === 'sell') {
          // +A-B：leg1 買入，leg2 賣出
          // 價差 = leg2賣出價 - leg1買入價
          const spread = leg2AvgPrice - leg1AvgPrice;
          spreadPercent = (spread / leg1AvgPrice) * 100;
        } else if (leg1Side === 'sell' && leg2Side === 'buy') {
          // -A+B：leg1 賣出，leg2 買入
          // 價差 = leg1賣出價 - leg2買入價
          const spread = leg1AvgPrice - leg2AvgPrice;
          spreadPercent = (spread / leg2AvgPrice) * 100;
        } else {
          // 其他情況，使用舊的計算方式作為備用
          spreadPercent = ((leg1AvgPrice - leg2AvgPrice) / leg2AvgPrice) * 100;
        }
      }
      
      // 獲取最後一次執行時間
      const lastTimestamp = stats.timestamps.length > 0 
        ? Math.max(...stats.timestamps) 
        : Date.now();
      
      // 🔥 判斷整體是否成功：如果所有執行記錄都成功，則標記為成功；否則標記為失敗
      const isOverallSuccess = stats.successStates && stats.successStates.length > 0 
        ? stats.successStates.every((s: boolean) => s === true)
        : false;
      
      // 🔥 計算總成交數量
      let leg1TotalQty = stats.leg1Qtys.reduce((sum: number, qty: number) => sum + qty, 0);
      let leg2TotalQty = stats.leg2Qtys.reduce((sum: number, qty: number) => sum + qty, 0);
      
      // 🔥 如果所有記錄都是手動刪除且沒有成交，則顯示 0/0
      // 檢查是否所有執行記錄都是手動刪除且沒有成交
      const allManualDeleteNoTrade = stats.executionRecords.length > 0 && 
        stats.executionRecords.length === stats.manualDeleteRecords.length &&
        stats.executionRecords.every((rec: any) => {
          return stats.manualDeleteRecords.some((mdr: any) => mdr.timestamp === rec.timestamp);
        });
      
      if (allManualDeleteNoTrade) {
        leg1TotalQty = 0;
        leg2TotalQty = 0;
      }
      
      // 🔥 查找失敗時是第幾次執行
      let failedAtExecution = null;
      if (!isOverallSuccess && stats.executionRecords.length > 0) {
        // 按時間排序
        const sortedRecords = [...stats.executionRecords].sort((a, b) => a.timestamp - b.timestamp);
        for (let i = 0; i < sortedRecords.length; i++) {
          if (!sortedRecords[i].isSuccess) {
            failedAtExecution = i + 1; // 第幾次執行（從1開始）
            break;
          }
        }
      }
      
      // 🔥 獲取設定差價（threshold）
      // ⚠️ 只從執行記錄中獲取，不從監控對配置中讀取（避免讀取到已刪除監控對的錯誤數據）
      // 如果有多個 threshold，使用第一個（通常應該都相同）
      let threshold: number | null = null;
      if (stats.thresholds && stats.thresholds.length > 0) {
        threshold = stats.thresholds[0];
      }
      // ⚠️ 不再從監控對配置中讀取，如果執行記錄中沒有 threshold，就顯示 null（會顯示為 --）
      
      // 🔥 計算預期全部成交數量
      // ✅ V3 改進：優先使用 totalAmount（新格式），否則使用 maxExecs * qty（舊格式）
      const expectedTotalQty = stats.totalAmount !== null && stats.totalAmount !== undefined
        ? stats.totalAmount
        : (stats.maxExecs && stats.expectedQtyPerExecution
            ? stats.maxExecs * stats.expectedQtyPerExecution
            : null);
      
      return {
        key: `arb_${stats.pairId}`,
        strategyId: stats.pairId,
        type: 'pair',
        leg1: stats.leg1,
        leg2: stats.leg2,
        timestamp: lastTimestamp,
        success: isOverallSuccess, // 🔥 根據實際執行結果判斷
        leg1AvgPrice, // 🔥 Leg1 均價
        leg2AvgPrice, // 🔥 Leg2 均價
        spreadPercent, // 🔥 實際價差百分比
        threshold, // 🔥 設定差價（threshold）
        executionCount: Math.max(stats.leg1Prices.length, stats.leg2Prices.length), // 執行次數
        leg1TotalQty, // 🔥 Leg1 總成交數量
        leg2TotalQty, // 🔥 Leg2 總成交數量
        failedAtExecution, // 🔥 失敗時是第幾次執行
        isManualDelete: stats.isManualDelete || false, // 🔥 手動刪除標記
        hasFailedRecord: stats.hasFailedRecord || false, // 🔥 是否有失敗記錄
        expectedTotalQty, // 🔥 預期全部成交數量
      };
    });
      
    // 處理 TWAP 執行記錄（參考 TwapPage.tsx 的實現）
    // 注意：TWAP 執行記錄需要按策略聚合，只顯示完成的策略
    const twapStrategiesById = new Map();
    (twapStrategiesSnapshot || []).forEach((s: any) => {
      twapStrategiesById.set(s.id, s);
    });
    
    // 🔥 收集所有有執行記錄的策略ID（不僅僅是成功的）
    const allTwapStrategyIds = new Set<string>();
    (twap.executions || []).forEach((e: any) => {
      // ✅ V3 改進：支持多種 ID 字段（strategyId, twapId, planId）
      const strategyId = e.strategyId || e.twapId || e.planId;
      if (strategyId) {
        allTwapStrategyIds.add(strategyId);
      }
    });
    
    // 🔥 將策略轉換為歷史記錄，並計算入場價和差價
    const twapExecs = Array.from(allTwapStrategyIds)
      .map((strategyId: string) => {
        const strategy = twapStrategiesById.get(strategyId);
        
        // 🔥 收集該策略的所有執行記錄（包括成功和失敗的）
        const allStrategyExecutions = (twap.executions || [])
          .filter((e: any) => {
            // ✅ V3 改進：支持多種 ID 字段匹配
            const execStrategyId = e.strategyId || e.twapId || e.planId;
            return execStrategyId === strategyId;
          });
        
        // 🔥 如果策略配置沒有找到，從執行記錄中提取 leg1 和 leg2 信息
        let leg1, leg2;
        if (strategy && strategy.leg1 && strategy.leg2) {
          // 優先使用策略配置中的信息
          leg1 = strategy.leg1;
          leg2 = strategy.leg2;
        } else {
          // 從執行記錄中提取 leg1 和 leg2 信息（用於歷史策略）
          // ✅ V3 新格式：查找第一條有效的成功執行記錄（忽略取消記錄中的 null leg）
          const firstValidRecord = allStrategyExecutions.find((e: any) => 
            e.leg1 && e.leg2 
          ) as any;
          
          if (firstValidRecord && firstValidRecord.leg1 && firstValidRecord.leg2) {
            // ✅ V3 新格式：從 leg1/leg2 對象中提取
            leg1 = {
              exchange: firstValidRecord.leg1.exchange || 'ERROR',
              symbol: firstValidRecord.leg1.symbol || 'ERROR',
              type: normalizeDisplayLegType(firstValidRecord.leg1.type),
              side: (firstValidRecord.leg1.side || 'ERROR') as 'buy' | 'sell',
            };
            leg2 = {
              exchange: firstValidRecord.leg2.exchange || 'ERROR',
              symbol: firstValidRecord.leg2.symbol || 'ERROR',
              type: normalizeDisplayLegType(firstValidRecord.leg2.type),
              side: (firstValidRecord.leg2.side || 'ERROR') as 'buy' | 'sell',
            };
          } else {
            // V2 舊格式：使用 legIndex
            const leg0Record = allStrategyExecutions.find((e: any) => e.legIndex === 0) as any;
            const leg1Record = allStrategyExecutions.find((e: any) => e.legIndex === 1) as any;
            
            if (leg0Record && leg1Record) {
              leg1 = {
                exchange: leg0Record.exchange || 'ERROR',
                symbol: leg0Record.symbol || 'ERROR',
                type: normalizeDisplayLegType(leg0Record.type),
                side: (leg0Record.side || 'ERROR') as 'buy' | 'sell',
              };
              leg2 = {
                exchange: leg1Record.exchange || 'ERROR',
                symbol: leg1Record.symbol || 'ERROR',
                type: normalizeDisplayLegType(leg1Record.type),
                side: (leg1Record.side || 'ERROR') as 'buy' | 'sell',
              };
            } else {
              // 如果連執行記錄都沒有 leg 信息，跳過這個策略
              console.warn(`⚠️ TWAP 策略 ${strategyId} 沒有找到策略配置和執行記錄信息，跳過`);
              return null;
            }
          }
        }
        
        // 🔥 按 sliceIndex/totalTriggers 分組，檢查每個 slice 的兩條腿是否都成功
        // ✅ V3 改進：統一格式使用 totalTriggers，舊格式使用 sliceIndex
        const sliceMap = new Map<number, { leg0: any, leg1: any }>();
        allStrategyExecutions.forEach((e: any) => {
          // ✅ V3: 優先使用 totalTriggers（新統一格式），否則使用 sliceIndex（舊格式）
          const sliceIndex = e.totalTriggers !== null && e.totalTriggers !== undefined 
            ? e.totalTriggers - 1  // totalTriggers 從 1 開始，sliceIndex 從 0 開始
            : (e.sliceIndex ?? 0);
          
          if (!sliceMap.has(sliceIndex)) {
            sliceMap.set(sliceIndex, { leg0: null, leg1: null });
          }
          const slice = sliceMap.get(sliceIndex)!;
          
          // ✅ V3 新格式：記錄有 leg1/leg2 對象（一條記錄包含兩條腿）
          // 注意：取消記錄的 leg1 和 leg2 可能是 null，需要檢查
          if (e.leg1 && e.leg2) {
            // V3 格式：創建虛擬的 leg0/leg1 記錄
            slice.leg0 = {
              success: e.status === 'success',
              price: e.leg1.price,
              qty: e.qty,
              timestamp: e.ts || e.timestamp,
              orderId: e.leg1.orderId,
              exchange: e.leg1.exchange,
              symbol: e.leg1.symbol,
              type: e.leg1.type,
              side: e.leg1.side,
            };
            slice.leg1 = {
              success: e.status === 'success',
              price: e.leg2.price,
              qty: e.qty,
              timestamp: e.ts || e.timestamp,
              orderId: e.leg2.orderId,
              exchange: e.leg2.exchange,
              symbol: e.leg2.symbol,
              type: e.leg2.type,
              side: e.leg2.side,
            };
          } else {
            // V2 舊格式：使用 legIndex
            const legIndex = typeof e.legIndex === 'number' ? e.legIndex : (e.legIndex ? parseInt(e.legIndex, 10) : null);
            if (legIndex === 0) {
              slice.leg0 = e;
            } else if (legIndex === 1) {
              slice.leg1 = e;
            }
          }
        });
        
        // 🔥 檢查每個 slice 是否成功（兩條腿都成功才算成功）
        // 對於 TWAP 策略，如果任何一個 slice 的兩條腿沒有都成功，整個策略應該被視為失敗
        let isOverallSuccess = true;
        let hasAnySlice = false;
        
        sliceMap.forEach((slice, sliceIndex) => {
          hasAnySlice = true;
          
          // 明確檢查 success 字段
          // 注意：success 可能是 true、false 或 undefined
          const leg0Exists = !!slice.leg0;
          const leg1Exists = !!slice.leg1;
          const leg0Success = leg0Exists && slice.leg0.success === true;
          const leg1Success = leg1Exists && slice.leg1.success === true;
          
          // 必須兩條腿都存在且都成功才算成功
          if (leg0Exists && leg1Exists) {
            if (!leg0Success || !leg1Success) {
              isOverallSuccess = false;
            }
          } else {
            // 如果缺少任何一條腿，視為失敗（不完整）
            isOverallSuccess = false;
          }
        });
        
        // 如果沒有任何 slice 記錄，默認為失敗
        if (!hasAnySlice) {
          isOverallSuccess = false;
        }
        
        // 🔥 收集所有執行記錄（成功和失敗的）來計算數量和失敗次數
        const allExecutions = allStrategyExecutions;
        // 🔥 用於計算均價：只使用有價格的成功記錄
        const successfulExecutionsWithPrice = allExecutions
          .filter((e: any) => {
            // ✅ V3 新格式：檢查 status === 'success' 並且有 leg1/leg2 價格
            if (e.leg1 && e.leg2) {
              return e.status === 'success' && (e.leg1.price || e.leg2.price);
            }
            // V2 舊格式：檢查 success === true 並且有 price
            return e.success === true && e.price;
          });
        // 🔥 用於計算總數量：使用所有成功的記錄（不管有沒有價格）
        const allSuccessfulExecutions = allExecutions
          .filter((e: any) => {
            // ✅ V3 新格式：檢查 status === 'success'
            if (e.leg1 && e.leg2) {
              return e.status === 'success';
            }
            // V2 舊格式：檢查 success === true
            return e.success === true;
          });
        
        // 🔥 按 legIndex 分組，計算各自的平均價格和總數量
        const leg1Prices: number[] = [];
        const leg2Prices: number[] = [];
        const leg1Qtys: number[] = [];
        const leg2Qtys: number[] = [];
        const timestamps: number[] = [];
        
        // 🔥 記錄所有 slice 的執行順序（用於查找失敗次數）
        const sliceExecutionOrder: Array<{ sliceIndex: number; isSuccess: boolean; timestamp: number }> = [];
        
        // 🔥 計算均價（只使用有價格的成功記錄）
        successfulExecutionsWithPrice.forEach((e: any) => {
          const timestamp = e.timestamp || e.ts || Date.now();
          
          // ✅ V3 新格式：從 leg1/leg2 對象中提取價格
          if (e.leg1 && e.leg2) {
            const leg1Price = parseFloat(e.leg1.price);
            const leg2Price = parseFloat(e.leg2.price);
            
            if (!isNaN(leg1Price) && leg1Price > 0) {
              leg1Prices.push(leg1Price);
              timestamps.push(timestamp);
            }
            if (!isNaN(leg2Price) && leg2Price > 0) {
              leg2Prices.push(leg2Price);
            }
          } else {
            // V2 舊格式：使用 price 和 legIndex
            const price = parseFloat(e.price);
            const legIndex = typeof e.legIndex === 'number' ? e.legIndex : parseInt(e.legIndex, 10);
            
            if (!isNaN(price) && price > 0 && (legIndex === 0 || legIndex === 1)) {
              if (legIndex === 0) {
                leg1Prices.push(price);
              } else if (legIndex === 1) {
                leg2Prices.push(price);
              }
              timestamps.push(timestamp);
            }
          }
        });
        
        // 🔥 計算總數量（使用所有成功的記錄）
        allSuccessfulExecutions.forEach((e: any) => {
          const qty = e.qty || e.amount || 0;
          
          // ✅ V3 新格式：一條記錄包含兩條腿，數量相同
          if (e.leg1 && e.leg2) {
            if (qty > 0) {
              leg1Qtys.push(qty);
              leg2Qtys.push(qty);
            }
          } else {
            // V2 舊格式：使用 legIndex
            const legIndex = typeof e.legIndex === 'number' ? e.legIndex : parseInt(e.legIndex, 10);
            
            if (qty > 0 && (legIndex === 0 || legIndex === 1)) {
              if (legIndex === 0) {
                leg1Qtys.push(qty);
              } else if (legIndex === 1) {
                leg2Qtys.push(qty);
              }
            }
          }
        });
        
        // 🔥 調試信息：檢查數量計算
        console.log(`📊 TWAP 策略 ${strategyId} 數量統計:`, {
          總執行記錄數: allStrategyExecutions.length,
          成功記錄數: allSuccessfulExecutions.length,
          leg0成功數: leg1Qtys.length,
          leg1成功數: leg2Qtys.length,
          leg0總數量: leg1Qtys.reduce((sum, qty) => sum + qty, 0),
          leg1總數量: leg2Qtys.reduce((sum, qty) => sum + qty, 0),
        });
        
        // 🔥 記錄每個 slice 的成功狀態（用於查找失敗次數）
        sliceMap.forEach((slice, sliceIndex) => {
          const leg0Success = slice.leg0?.success === true;
          const leg1Success = slice.leg1?.success === true;
          const sliceSuccess = leg0Success && leg1Success;
          const sliceTimestamp = Math.max(
            slice.leg0?.timestamp || slice.leg0?.ts || 0,
            slice.leg1?.timestamp || slice.leg1?.ts || 0
          );
          sliceExecutionOrder.push({
            sliceIndex,
            isSuccess: sliceSuccess,
            timestamp: sliceTimestamp,
          });
        });
        
        // 🔥 按時間排序，找到失敗時是第幾次執行
        sliceExecutionOrder.sort((a, b) => a.timestamp - b.timestamp);
        let failedAtExecution = null;
        if (!isOverallSuccess) {
          for (let i = 0; i < sliceExecutionOrder.length; i++) {
            if (!sliceExecutionOrder[i].isSuccess) {
              failedAtExecution = i + 1; // 第幾次執行（從1開始）
              break;
            }
          }
        }
        
        // 🔥 計算各自的均價
        const leg1AvgPrice = leg1Prices.length > 0
          ? leg1Prices.reduce((sum, p) => sum + p, 0) / leg1Prices.length
          : null;
        const leg2AvgPrice = leg2Prices.length > 0
          ? leg2Prices.reduce((sum, p) => sum + p, 0) / leg2Prices.length
          : null;
        
        // 🔥 計算價差百分比：根據交易方向正確計算
        // +A-B（leg1 買入，leg2 賣出）：(leg2賣出價 - leg1買入價) / leg1買入價 * 100
        // -A+B（leg1 賣出，leg2 買入）：(leg1賣出價 - leg2買入價) / leg2買入價 * 100
        let spreadPercent: number | null = null;
        if (leg1AvgPrice !== null && leg2AvgPrice !== null && leg1AvgPrice > 0 && leg2AvgPrice > 0) {
          const leg1Side = leg1?.side || 'buy';
          const leg2Side = leg2?.side || 'sell';
          
          if (leg1Side === 'buy' && leg2Side === 'sell') {
            // +A-B：leg1 買入，leg2 賣出
            // 價差 = leg2賣出價 - leg1買入價
            const spread = leg2AvgPrice - leg1AvgPrice;
            spreadPercent = (spread / leg1AvgPrice) * 100;
          } else if (leg1Side === 'sell' && leg2Side === 'buy') {
            // -A+B：leg1 賣出，leg2 買入
            // 價差 = leg1賣出價 - leg2買入價
            const spread = leg1AvgPrice - leg2AvgPrice;
            spreadPercent = (spread / leg2AvgPrice) * 100;
          } else {
            // 其他情況，使用舊的計算方式作為備用
            spreadPercent = ((leg1AvgPrice - leg2AvgPrice) / leg2AvgPrice) * 100;
          }
        }
        
        // 找到該策略的最後一次執行時間
        const allTimestamps = allStrategyExecutions
          .map((e: any) => e.timestamp || e.ts || 0)
          .filter((ts: number) => ts > 0);
        const lastTimestamp = allTimestamps.length > 0
          ? Math.max(...allTimestamps)
          : (strategy?.createdAt || Date.now());
        
        // 🔥 計算總成交數量
        const leg1TotalQty = leg1Qtys.reduce((sum, qty) => sum + qty, 0);
        const leg2TotalQty = leg2Qtys.reduce((sum, qty) => sum + qty, 0);
        
        // 🔥 檢查是否為手動取消
        // ✅ V3 改進：也從執行記錄中檢查 cancelled 狀態
        const hasCancelledRecord = allStrategyExecutions.some((e: any) => 
          e.status === 'cancelled' || e.status === 'CANCELLED'
        );
        const hasFailedRecord = allStrategyExecutions.some((e: any) =>
          e.status === 'failed' || e.status === 'FAILED'
        );
        const isManualCancel = strategy?.status === 'cancelled' || 
                              strategy?.progress?.state === 'cancelled' ||
                              strategy?.progress?.state === 'CANCELLED' ||
                              hasCancelledRecord;
        
        return {
          key: `twap_${strategyId}`,
          strategyId,
          type: 'twap',
          leg1, // 🔥 使用提取的 leg1（優先策略配置，否則從執行記錄提取）
          leg2, // 🔥 使用提取的 leg2（優先策略配置，否則從執行記錄提取）
          timestamp: lastTimestamp,
          success: isOverallSuccess, // 🔥 根據實際執行結果判斷
          leg1AvgPrice, // 🔥 Leg1 均價
          leg2AvgPrice, // 🔥 Leg2 均價
          spreadPercent, // 🔥 價差百分比
          executionCount: Math.max(leg1Prices.length, leg2Prices.length), // 執行次數
          leg1TotalQty, // 🔥 Leg1 總成交數量
          leg2TotalQty, // 🔥 Leg2 總成交數量
          failedAtExecution, // 🔥 失敗時是第幾次執行
          isManualDelete: isManualCancel || false, // 🔥 手動刪除標記
          hasFailedRecord: hasFailedRecord || false, // 🔥 是否有失敗記錄
          // �� 計算預期全部成交數量 = totalAmount 或 orderCount * amountPerOrder
          // 🔥 計算預期全部成交數量：優先從策略配置中獲取，如果不存在則從執行記錄中讀取
          expectedTotalQty: (() => {
            if (strategy?.totalAmount) {
              return strategy.totalAmount;
            } else if (strategy?.orderCount && strategy?.amountPerOrder) {
              return strategy.orderCount * strategy.amountPerOrder;
            } else {
              // ✅ V3 改進：優先從執行記錄中讀取 totalAmount（新格式記錄包含此欄位）
              const firstRecordWithTotalAmount = allStrategyExecutions.find((e: any) => 
                e.totalAmount !== null && e.totalAmount !== undefined
              ) as any;
              if (firstRecordWithTotalAmount?.totalAmount) {
                return firstRecordWithTotalAmount.totalAmount;
              }
              
              // 🔥 如果執行記錄中也沒有，嘗試估算
              const maxSliceIndex = Math.max(...Array.from(sliceMap.keys()), -1);
              const firstSuccessfulExecution = allSuccessfulExecutions.find((e: any) => (e as any).qty && (e as any).qty > 0);
              const sliceQty = (firstSuccessfulExecution as any)?.qty || 0;
              
              if (maxSliceIndex >= 0 && sliceQty > 0) {
                // 估算預期數量 = (最大 sliceIndex + 1) * sliceQty
                return (maxSliceIndex + 1) * sliceQty;
              }
              return null;
            }
          })(),
        };
      })
      .filter((e: any) => e !== null) as any[];
    
    const allHistory = [...arbExecs, ...twapExecs].sort((a: any, b: any) => (b?.timestamp || 0) - (a?.timestamp || 0));
    console.log('📋 最終歷史記錄數量:', allHistory.length, '- 套利:', arbExecs.length, 'TWAP:', twapExecs.length);
    return allHistory;
  }, [arbitrage.recentExecutions, twap.executions]);

  const filteredHistoryData = useMemo(() => {
    const selectedFilters = new Set(historyFilters);
    return historyData.filter((record: any) => selectedFilters.has(getHistoryResultType(record)));
  }, [historyData, historyFilters]);

  const toggleHistoryFilter = useCallback((filter: HistoryFilter, checked: boolean) => {
    setHistoryFilters(prev => {
      if (checked) {
        return prev.includes(filter) ? prev : [...prev, filter];
      }
      return prev.filter(item => item !== filter);
    });
  }, []);

  // 輪詢所有監控對（pair/TWAP）的實時價格（用於「訂單」標籤頁）
  useEffect(() => {
    const fetchAllPairPrices = async () => {
      // 🔥 使用 ongoingData（監控對列表），而不是 allPositionsData（實際持倉）
      // allPositionsData 現在只包含實際持倉，沒有 leg1/leg2 結構
      const pairs = ongoingData;
      if (pairs.length === 0) return;

      const pairLegs = pairs.map((pair) => {
        const leg1Type = (pair.leg1?.type === 'future' ? 'linear' : (pair.leg1?.type || 'spot')) as LegType;
        const leg2Type = (pair.leg2?.type === 'future' ? 'linear' : (pair.leg2?.type || 'spot')) as LegType;
        const leg1Exchange = pair.leg1?.exchange;
        const leg1Symbol = pair.leg1?.symbol;
        const leg2Exchange = pair.leg2?.exchange;
        const leg2Symbol = pair.leg2?.symbol;

        return {
          id: pair.id,
          leg1: leg1Exchange && leg1Symbol
            ? { exchange: leg1Exchange, symbol: leg1Symbol, type: leg1Type, key: getPriceKey(leg1Exchange, leg1Symbol, leg1Type) }
            : null,
          leg2: leg2Exchange && leg2Symbol
            ? { exchange: leg2Exchange, symbol: leg2Symbol, type: leg2Type, key: getPriceKey(leg2Exchange, leg2Symbol, leg2Type) }
            : null,
        };
      });

      const uniqueLegs = new Map<string, { exchange: string; symbol: string; type: LegType }>();
      pairLegs.forEach((pair) => {
        if (pair.leg1) uniqueLegs.set(pair.leg1.key, pair.leg1);
        if (pair.leg2) uniqueLegs.set(pair.leg2.key, pair.leg2);
      });

      const priceEntries = await Promise.all(
        Array.from(uniqueLegs.entries()).map(async ([key, leg]) => {
          const price = await fetchTop(leg.exchange, leg.symbol, leg.type);
          return [key, price] as const;
        }),
      );
      const priceByKey = new Map<string, TopPrice>(priceEntries);

      const results = pairLegs.map((pair) => ({
        id: pair.id,
        leg1: pair.leg1 ? priceByKey.get(pair.leg1.key) || { bid: 0, ask: 0 } : { bid: 0, ask: 0 },
        leg2: pair.leg2 ? priceByKey.get(pair.leg2.key) || { bid: 0, ask: 0 } : { bid: 0, ask: 0 },
      }));
      const pricesMap: Record<string, any> = {};
      results.forEach(r => {
        pricesMap[r.id] = { leg1: r.leg1, leg2: r.leg2 };
      });
      setPairPrices(pricesMap);
    };

    fetchAllPairPrices();
    // WS 的 priceUpdate 會推送實時價差，此輪詢保留為初始化 + 斷線補償。
    const interval = setInterval(fetchAllPairPrices, PRICE_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [ongoingData, fetchTop, getPriceKey]);

  useEffect(() => {
    const fetchSpreadMonitorPrices = async () => {
      const activeMonitors = spreadMonitors.filter(monitor => monitor.enabled);
      if (activeMonitors.length === 0) {
        setSpreadMonitorPrices({});
        return;
      }

      const uniqueLegs = new Map<string, { exchange: string; symbol: string; type: LegType }>();
      activeMonitors.forEach((monitor) => {
        uniqueLegs.set(
          getPriceKey(monitor.leg1.exchange, monitor.leg1.symbol, monitor.leg1.type),
          { exchange: monitor.leg1.exchange, symbol: monitor.leg1.symbol, type: monitor.leg1.type },
        );
        uniqueLegs.set(
          getPriceKey(monitor.leg2.exchange, monitor.leg2.symbol, monitor.leg2.type),
          { exchange: monitor.leg2.exchange, symbol: monitor.leg2.symbol, type: monitor.leg2.type },
        );
      });

      const entries = await Promise.all(
        Array.from(uniqueLegs.entries()).map(async ([key, leg]) => {
          const price = await fetchTop(leg.exchange, leg.symbol, leg.type);
          return [key, price] as const;
        }),
      );
      const priceByKey = new Map<string, TopPrice>(entries);
      const nextPrices: Record<string, { leg1: TopPrice; leg2: TopPrice }> = {};

      activeMonitors.forEach((monitor) => {
        nextPrices[monitor.id] = {
          leg1: priceByKey.get(getPriceKey(monitor.leg1.exchange, monitor.leg1.symbol, monitor.leg1.type)) || { bid: 0, ask: 0 },
          leg2: priceByKey.get(getPriceKey(monitor.leg2.exchange, monitor.leg2.symbol, monitor.leg2.type)) || { bid: 0, ask: 0 },
        };
      });

      setSpreadMonitorPrices(nextPrices);
    };

    fetchSpreadMonitorPrices();
    const interval = window.setInterval(fetchSpreadMonitorPrices, PRICE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [spreadMonitors, fetchTop, getPriceKey]);

  const handleDeletePair = async (pairId: string) => {
    try {
      await apiService.removeMonitoringPair(pairId);
      message.success('已移除監控對');
      // 刷新監控對列表
      const pairsRes = await apiService.getMonitoringPairs();
      if (pairsRes.success && pairsRes.data) {
        dispatch({
          type: 'arbitrage/setMonitoringPairs',
          payload: normalizeMonitoringPairs(pairsRes.data),
        });
      }
    } catch (e: any) {
      message.error(e?.message || '移除失敗');
    }
  };

  const handleDeleteTwap = async (twapId: string) => {
    try {
      await apiService.removeTwapStrategy(twapId);
      message.success('已刪除 TWAP 策略');
      // 刷新 TWAP 策略列表（與 refreshTwapStrategies 共用 mapTwapPlansToUi）
      const twapRes = await apiService.getTwapStrategies();
      if (twapRes.data) {
        dispatch({ type: 'twap/setStrategies', payload: mapTwapPlansToUi(twapRes.data) });
      }
      // 本地隱藏，防止後端仍回傳或頁面刷新又出現
      setHiddenPositions(prev => Array.from(new Set([...prev, twapId])));
    } catch (e: any) {
      message.error(e?.message || '刪除失敗');
    }
  };

  const handleToggleSpreadMonitor = useCallback((monitorId: string) => {
    setSpreadMonitors(prev => prev.map(monitor => (
      monitor.id === monitorId ? { ...monitor, enabled: !monitor.enabled } : monitor
    )));
  }, []);

  const handleDeleteSpreadMonitor = useCallback((monitorId: string) => {
    setSpreadMonitors(prev => prev.filter(monitor => monitor.id !== monitorId));
    setSpreadMonitorPrices(prev => {
      const next = { ...prev };
      delete next[monitorId];
      return next;
    });
  }, []);

  const handleApplySpreadMonitor = useCallback((monitor: SpreadMonitor) => {
    legsForm.setFieldsValue({
      leg1_exchange: monitor.leg1.exchange,
      leg1_symbol: monitor.leg1.symbol,
      leg1_type: monitor.leg1.type,
      leg1_side: monitor.leg1.side,
      leg2_exchange: monitor.leg2.exchange,
      leg2_symbol: monitor.leg2.symbol,
      leg2_type: monitor.leg2.type,
      leg2_side: monitor.leg2.side,
    });
    pairForm.setFieldsValue({ threshold: monitor.threshold });
    setLeg1Side(monitor.leg1.side);
    setLeg2Side(monitor.leg2.side);
    setLeg2ManualSymbol(monitor.leg2.symbol !== monitor.leg1.symbol);
    setActiveTab('pair');
    message.success('已回填監控設定');
  }, [legsForm, pairForm, message]);


  const ongoingColumns = [
    { 
      title: '類型', 
      dataIndex: 'type', 
      key: 'type', 
      width: 80, 
      render: (v: string) => v === 'pair' ? <Tag color="blue">PAIR</Tag> : <Tag color="purple">TWAP</Tag> 
    },
    { 
      title: 'Leg1', 
      key: 'leg1', 
      width: 180, 
      render: (_: any, r: any) => {
        // 🔥 修復：正確處理 type 字段（可能是 'linear', 'future', 或 'spot'）
        const typeLabel = getContractSuffix(r.leg1?.type, '.p');
        // 🔥 修復：改為小寫顯示 exchange 和 symbol
        const exchange = String(r.leg1?.exchange || '').toLowerCase();
        const symbol = String(r.leg1?.symbol || '').toLowerCase();
        const sideLabel = r.leg1?.side === 'buy' ? 'buy' : 'sell';
        return (
          <div>
            <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
              {`${exchange} ${symbol}${typeLabel}`}
            </Text>
            <br />
            <Tag color={r.leg1?.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
              {sideLabel}
            </Tag>
          </div>
        );
      }
    },
    { 
      title: 'Leg2', 
      key: 'leg2', 
      width: 180, 
      render: (_: any, r: any) => {
        // 🔥 修復：正確處理 type 字段（可能是 'linear', 'future', 或 'spot'）
        const typeLabel = getContractSuffix(r.leg2?.type, '.p');
        // 🔥 修復：改為小寫顯示 exchange 和 symbol
        const exchange = String(r.leg2?.exchange || '').toLowerCase();
        const symbol = String(r.leg2?.symbol || '').toLowerCase();
        const sideLabel = r.leg2?.side === 'buy' ? 'buy' : 'sell';
        return (
          <div>
            <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
              {`${exchange} ${symbol}${typeLabel}`}
            </Text>
            <br />
            <Tag color={r.leg2?.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
              {sideLabel}
            </Tag>
          </div>
        );
      }
    },
    {
      title: '當前價差',
      key: 'currentSpread',
      width: 140,
      render: (_: any, r: any) => {
        if (r.type !== 'pair') {
          return <Text style={{ color: '#848e9c', fontSize: 11 }}>-</Text>;
        }

        const prices = pairPrices[r.id];
        if (!prices || !prices.leg1 || !prices.leg2) {
          return <Text style={{ color: '#848e9c', fontSize: 11 }}>載入中...</Text>;
        }

        // 計算價差
        const leg1Side = r.leg1?.side || 'buy';
        const leg2Side = r.leg2?.side || 'sell';
        const leg1Price = leg1Side === 'buy' ? prices.leg1.ask : prices.leg1.bid;
        const leg2Price = leg2Side === 'buy' ? prices.leg2.ask : prices.leg2.bid;

        if (!leg1Price || !leg2Price || leg1Price === 0 || leg2Price === 0) {
          return <Text style={{ color: '#848e9c', fontSize: 11 }}>無數據</Text>;
        }

        // 計算價差百分比
        const buyPrice = leg1Side === 'buy' ? leg1Price : leg2Price;
        const sellPrice = leg1Side === 'sell' ? leg1Price : leg2Price;
        const spread = sellPrice - buyPrice;
        const spreadPct = (spread / buyPrice) * 100;

        // 判斷是否達到觸發條件
        const threshold = r.threshold || 0;
        const isTriggered = spreadPct >= threshold;

        return (
          <div>
            <Text 
              style={{ 
                fontSize: 13, 
                fontWeight: 600,
                color: isTriggered ? '#0ecb81' : spreadPct >= threshold * 0.8 ? '#f0b90b' : '#848e9c'
              }}
            >
              {spreadPct >= 0 ? '+' : ''}{spreadPct.toFixed(3)}%
            </Text>
            {isTriggered && (
              <div>
                <Tag color="success" style={{ fontSize: 10, marginTop: 4 }}>✓ 已達觸發</Tag>
              </div>
            )}
          </div>
        );
      }
    },
    {
      title: '狀態', 
      key: 'status', 
      width: 100, 
      render: (_: any, r: any) => r.type === 'pair' ? (
        r.enabled ? <Tag color="processing">監控中</Tag> : <Tag>停用</Tag>
      ) : (
        <Tag color={r.status === 'active' ? 'processing' : r.status === 'paused' ? 'warning' : 'default'}>
          {r.status || '未知'}
        </Tag>
      )
    },
    {
      title: '執行次數',
      key: 'triggers',
      width: 110,
      render: (_: any, r: any) => {
        // 統一顯示為「已執行/總次數」，PAIR 對齊 TWAP 的進度體驗
        const executedCount = r.type === 'twap'
          ? (r.totalTriggers ?? r.progress?.slicesDone ?? r.executedOrders ?? 0)
          // PAIR has had both fields in the wild; use the largest valid count so stale totalTriggers=0 does not hide executionsCount.
          : resolvePairExecutionCount(r);
        const targetCount = r.type === 'twap'
          ? (r.orderCount ?? r.progress?.slicesTotal ?? 0)
          // 部分資料流會帶 orderCount（統一格式），保留向下兼容
          : (r.maxExecs ?? r.orderCount ?? 0);
        return (
          <Text style={{ fontSize: 12, color: '#f0b90b', fontWeight: 600 }}>
            {executedCount}/{targetCount}
          </Text>
        );
      }
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: any, r: any) => (
        <Space>
          <Button
            size="small"
            type="text"
            danger
            onClick={() => {
              if (r.type === 'pair') {
                handleDeletePair(r.id);
              } else {
                handleDeleteTwap(r.id);
              }
            }}
            style={{ color: '#f6465d', fontSize: 12 }}
          >
            刪除
          </Button>
        </Space>
      )
    }
  ];

  // 响应式尺寸计算（手機直/橫向降低固定高度，避免跑版）
  // 再加長圖表：手機再提升高度，同時兼顧直/橫向不溢出
  const renderSpreadMonitorPanel = () => {
    const monitorColumns = [
      {
        title: 'LEG1',
        key: 'leg1',
        width: '36%',
        render: (_: any, r: SpreadMonitor) => (
          <div style={{ minWidth: 0 }}>
            <Text
              ellipsis={{ tooltip: `${r.leg1.exchange.toLowerCase()} ${r.leg1.symbol.toLowerCase()}${getContractSuffix(r.leg1.type, '.p')}` }}
              style={{ display: 'block', fontSize: 12, color: '#fff', fontWeight: 600 }}
            >
              {`${r.leg1.exchange.toLowerCase()} ${r.leg1.symbol.toLowerCase()}${getContractSuffix(r.leg1.type, '.p')}`}
            </Text>
            <Tag color={r.leg1.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
              {r.leg1.side}
            </Tag>
          </div>
        ),
      },
      {
        title: 'SPREAD',
        key: 'spread',
        width: '28%',
        render: (_: any, r: SpreadMonitor) => {
          const calc = calculateMonitorSpread(r, spreadMonitorPrices[r.id]);
          const isTriggered = typeof calc.spreadPct === 'number' && calc.spreadPct >= r.threshold;
          return (
            <div style={{ minWidth: 0 }}>
              <Text style={{ color: isTriggered ? '#0ecb81' : '#fff', fontSize: 13, fontWeight: 700 }}>
                {calc.spreadPct === null ? '--' : `${calc.spreadPct >= 0 ? '+' : ''}${calc.spreadPct.toFixed(3)}%`}
              </Text>
              <div style={{ color: '#848e9c', fontSize: 11, display: 'inline', marginRight: 4 }}>
                目標 {r.threshold >= 0 ? '+' : ''}{r.threshold.toFixed(4)}%
              </div>
              <Space
                size={2}
                onClick={(e) => e.stopPropagation()}
                style={{ maxWidth: '100%', flexWrap: 'nowrap', display: 'inline-flex', verticalAlign: 'middle' }}
              >
                <Button
                  size="small"
                  type="text"
                  icon={<BellOutlined />}
                  title={r.enabled ? '提醒中' : '提醒關'}
                  onClick={() => handleToggleSpreadMonitor(r.id)}
                  style={{
                    width: 18,
                    height: 18,
                    minWidth: 18,
                    padding: 0,
                    overflow: 'hidden',
                    color: r.enabled ? '#f0b90b' : '#848e9c',
                    fontSize: 11,
                  }}
                >
                  {r.enabled ? '提醒中' : '提醒關'}
                </Button>
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  title="移除"
                  onClick={() => handleDeleteSpreadMonitor(r.id)}
                  style={{
                    width: 18,
                    height: 18,
                    minWidth: 18,
                    padding: 0,
                    overflow: 'hidden',
                    fontSize: 11,
                  }}
                >
                  移除
                </Button>
              </Space>
            </div>
          );
        },
      },
      {
        title: 'LEG2',
        key: 'leg2',
        width: '36%',
        render: (_: any, r: SpreadMonitor) => (
          <div style={{ minWidth: 0 }}>
            <Text
              ellipsis={{ tooltip: `${r.leg2.exchange.toLowerCase()} ${r.leg2.symbol.toLowerCase()}${getContractSuffix(r.leg2.type, '.p')}` }}
              style={{ display: 'block', fontSize: 12, color: '#fff', fontWeight: 600 }}
            >
              {`${r.leg2.exchange.toLowerCase()} ${r.leg2.symbol.toLowerCase()}${getContractSuffix(r.leg2.type, '.p')}`}
            </Text>
            <Tag color={r.leg2.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
              {r.leg2.side}
            </Tag>
          </div>
        ),
      },
      {
        title: '狀態',
        key: 'status',
        width: 92,
        render: (_: any, r: SpreadMonitor) => {
          const calc = calculateMonitorSpread(r, spreadMonitorPrices[r.id]);
          if (!r.enabled) return <Tag>暫停</Tag>;
          if (!calc.valid) return <Tag color="default">載入中</Tag>;
          return calc.spreadPct !== null && calc.spreadPct >= r.threshold
            ? <Tag color="success">已達標</Tag>
            : <Tag color="processing">監控中</Tag>;
        },
      },
      {
        title: '操作',
        key: 'action',
        width: 120,
        render: (_: any, r: SpreadMonitor) => (
          <Space size={4} onClick={(e) => e.stopPropagation()}>
            <Button size="small" onClick={() => handleToggleSpreadMonitor(r.id)}>
              {r.enabled ? '暫停' : '啟用'}
            </Button>
            <Button size="small" type="text" danger onClick={() => handleDeleteSpreadMonitor(r.id)}>
              刪除
            </Button>
          </Space>
        ),
      },
    ];
    const visibleMonitorColumns = monitorColumns.filter(
      column => column.key !== 'status' && column.key !== 'action',
    );

    return (
      <div
        style={{
          border: '1px solid #2b3139',
          borderRadius: 8,
          background: '#181d24',
          height: isMobile ? 'auto' : 260,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid #2b3139',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Space size={8}>
            <FundOutlined style={{ color: '#f0b90b' }} />
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>差價監控</Text>
          </Space>
          <Tag color="gold" style={{ margin: 0 }}>{spreadMonitors.length}</Tag>
        </div>

        {spreadMonitors.length > 0 ? (
          <Table
            size="small"
            rowKey="id"
            dataSource={spreadMonitors}
            columns={visibleMonitorColumns}
            pagination={false}
            tableLayout="fixed"
            style={{ background: 'transparent', width: '100%' }}
            onRow={(record: SpreadMonitor) => ({
              onClick: () => handleApplySpreadMonitor(record),
              style: { cursor: 'pointer' },
            })}
          />
        ) : (
          <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>--</div>
            <Text style={{ color: '#848e9c' }}>尚無差價監控</Text>
            <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>在 PAIRS 的立即執行下方點「新增監控」</div>
          </div>
        )}
      </div>
    );
  };
  const chartHeight = isMobile ? (isSmallMobile ? 360 : 420) : 520;
  // 卡片高度改為自適應；手機給最低高度避免橫向時圖表被擠掉
  const cardMinHeight = isMobile ? 360 : 580;
  const cardPadding = isMobile ? (isSmallMobile ? '8px 12px' : '12px 16px') : '16px 20px';
  const gutterSize = isMobile ? (isSmallMobile ? 8 : 12) : 16;

  return (
    <div style={{ 
      background: 'linear-gradient(135deg, #0b0e11 0%, #0f1419 100%)', 
      minHeight: '100vh', 
      padding: cardPadding 
    }}>

      <Row gutter={[gutterSize, gutterSize]} align="stretch">
        {/* 左側：價差圖表區 */}
        <Col xxl={16} xl={16} lg={24} md={24} sm={24} xs={24} style={{ display: 'flex' }}>
          <Card
            title={
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: isMobile ? 'flex-start' : 'center', 
                width: '100%', 
                position: 'relative',
                flexWrap: isMobile ? 'wrap' : 'nowrap',
              }}>
                {!isMobile && (
                  <div style={{ position: 'absolute', left: 0 }}>
                    <Space size={12}>
                      <SwapOutlined style={{ color: '#f0b90b', fontSize: 16 }} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>價差監控</span>
                    </Space>
                  </div>
                )}
                <Space 
                  size={isMobile ? 8 : 20} 
                  align="center" 
                  wrap 
                  style={{ 
                    fontSize: isMobile ? 11 : 12, 
                    justifyContent: isMobile ? 'flex-start' : 'center',
                    width: isMobile ? '100%' : 'auto',
                    marginTop: isMobile ? 8 : 0,
                  }}
                >
                  {renderLegSummary('leg1')}
                  <div style={{ color: '#848e9c', fontSize: isMobile ? 12 : 14 }}>⇄</div>
                  {renderLegSummary('leg2')}
                </Space>
              </div>
            }
            style={{
              background: 'linear-gradient(145deg, #161a1e, #1e2329)',
              border: '1px solid #2b3139',
              borderRadius: 12,
              width: '100%',
              height: '100%',
              minHeight: cardMinHeight,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
            styles={{
              header: {
                background: 'linear-gradient(135deg, #1e2329, #252a30)',
                borderBottom: '1px solid #2b3139',
                color: '#fff',
                padding: isMobile ? '10px 12px' : '12px 16px',
                minHeight: 'auto',
                borderRadius: '12px 12px 0 0',
              },
              body: {
                padding: isMobile ? '8px' : '12px',
                background: 'transparent',
                overflow: 'hidden',
                height: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }
            }}
          >
            {/* TradingView 價格圖表 */}
            <div style={{ 
              overflow: 'visible', 
              borderRadius: '8px',
              position: 'relative',
              width: '100%',
              height: isMobile ? `${chartHeight}px` : '100%',
              maxWidth: '100%',
              paddingBottom: '8px',
            }}>
              <TradingViewPriceChart
                leg1Exchange={(leg1ExchangeWatch || 'bybit')}
                leg1Symbol={String(leg1SymbolWatch || '').toUpperCase()}
                leg1Type={(leg1TypeWatch || 'linear') as 'spot' | 'linear'}
                leg1Side={leg1Side}
                leg2Exchange={(leg2ExchangeWatch || 'binance')}
                leg2Symbol={String(leg2SymbolWatch || '').toUpperCase()}
                leg2Type={(leg2TypeWatch || 'spot') as 'spot' | 'linear'}
                leg2Side={leg2Side}
                height={chartHeight}
              />
            </div>
          </Card>
        </Col>

        {/* 右側：PAIRS / TWAP 控制面板 */}
        <Col xxl={8} xl={8} lg={24} md={24} sm={24} xs={24} style={{ display: 'flex' }}>
          <Card
            style={{
              background: 'linear-gradient(145deg, #161a1e, #1e2329)',
              border: '1px solid #2b3139',
              borderRadius: 12,
              width: '100%',
              height: '100%',
              minHeight: cardMinHeight,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            }}
            styles={{
              body: {
                padding: 0,
                background: 'transparent',
                height: 'auto',
                display: 'flex',
                flexDirection: 'column',
              }
            }}
            variant="borderless"
          >
            {/* 頂部標籤切換 */}
            <div style={{ 
              background: 'linear-gradient(135deg, #1e2329, #252a30)', 
              display: 'flex',
              borderBottom: '1px solid #2b3139',
              borderRadius: '12px 12px 0 0',
            }}>
              <div
                onClick={() => setActiveTab('pair')}
                style={{
                  flex: 1,
                  padding: '14px 16px',
                  cursor: 'pointer',
                  borderBottom: activeTab === 'pair' ? '3px solid #f0b90b' : '3px solid transparent',
                  background: activeTab === 'pair' ? 'rgba(240, 185, 11, 0.08)' : 'transparent',
                  transition: 'all 0.3s',
                  textAlign: 'center',
                }}
              >
                <Space size={8}>
                  <ThunderboltOutlined style={{ 
                    color: activeTab === 'pair' ? '#f0b90b' : '#848e9c',
                    fontSize: 15,
                  }} />
                  <Text style={{ 
                    color: activeTab === 'pair' ? '#f0b90b' : '#848e9c', 
                    fontSize: 14, 
                    fontWeight: activeTab === 'pair' ? 700 : 500,
                    letterSpacing: '0.5px',
                  }}>
                    PAIRS
                  </Text>
                </Space>
              </div>
              <div
                onClick={() => setActiveTab('twap')}
                style={{
                  flex: 1,
                  padding: '14px 16px',
                  cursor: 'pointer',
                  borderBottom: activeTab === 'twap' ? '3px solid #f0b90b' : '3px solid transparent',
                  background: activeTab === 'twap' ? 'rgba(240, 185, 11, 0.08)' : 'transparent',
                  transition: 'all 0.3s',
                  textAlign: 'center',
                }}
              >
                <Space size={8}>
                  <ClockCircleOutlined style={{ 
                    color: activeTab === 'twap' ? '#f0b90b' : '#848e9c',
                    fontSize: 15,
                  }} />
                  <Text style={{ 
                    color: activeTab === 'twap' ? '#f0b90b' : '#848e9c', 
                    fontSize: 14, 
                    fontWeight: activeTab === 'twap' ? 700 : 500,
                    letterSpacing: '0.5px',
                  }}>
                    TWAP
                  </Text>
                </Space>
              </div>
            </div>

            <div style={{ 
              padding: isMobile ? (isSmallMobile ? '12px' : '12px 16px') : '16px 20px',
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
            }}>
              {/* 共用 Legs 參數區 */}
              <Form form={legsForm} layout="vertical" style={{ marginBottom: 8 }}>
                  <Row gutter={isMobile ? 8 : 12}>
                    {/* Leg 1 */}
                    <Col span={isMobile ? 24 : 12} style={{ marginBottom: isMobile ? 12 : 0 }}>
                      <div style={{ 
                        background: '#1e2329', 
                        padding: isMobile ? '10px 8px' : '12px 10px', 
                        borderRadius: 6, 
                        marginBottom: 12,
                        border: '1px solid #2b3139',
                      }}>
                        <div style={{ 
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 12,
                        }}>
                          <div style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: '#0ecb81',
                          }}></div>
                          <Text style={{ 
                            color: '#fff', 
                            fontSize: 12, 
                            fontWeight: 600,
                          }}>
                            Leg 1
                          </Text>
                        </div>
                        
                        <Form.Item 
                          name="leg1_exchange" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Exchange1</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Select 
                            size="small" 
                            style={{ 
                              width: '100%',
                            }}
                            className="exchange-select-uppercase"
                          >
                            {availableExchanges.map(ex => (
                              <Option key={`p1_${ex.key}`} value={ex.key}>
                                {ex.name}
                              </Option>
                            ))}
                          </Select>
                        </Form.Item>

                        <Form.Item 
                          name="leg1_symbol" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Symbol1</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Input 
                            size="small" 
                            placeholder="ETHUSDT"
                            style={{ 
                              background: '#0b0e11', 
                              border: '1px solid #2b3139', 
                              color: '#fff',
                              fontWeight: 500,
                              borderRadius: 6,
                              transition: 'all 0.3s ease',
                              textTransform: 'uppercase',
                            }} 
                            onFocus={(e) => {
                              e.target.style.borderColor = '#f0b90b';
                              e.target.style.boxShadow = '0 0 0 2px rgba(240, 185, 11, 0.2)';
                            }}
                            onBlur={(e) => {
                              e.target.style.borderColor = '#2b3139';
                              e.target.style.boxShadow = 'none';
                            }}
                          />
                        </Form.Item>

                        <Form.Item 
                          name="leg1_type" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Category1</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Select size="small" style={{ width: '100%' }}>
                            <Option value="linear" disabled={isLinearBlocked(leg1ExchangeWatch)}>合約</Option>
                            <Option value="spot" disabled={isSpotBlocked(leg1ExchangeWatch)}>現貨</Option>
                          </Select>
                        </Form.Item>

                        {/* 買/賣按鈕組 */}
                        <div style={{ marginBottom: 0 }}>
                          <Text style={{ 
                            color: '#848e9c', 
                            fontSize: 11,
                            display: 'block',
                            marginBottom: 6,
                          }}>
                            方向
                          </Text>
                          <Form.Item name="leg1_side" noStyle initialValue="buy">
                            <div style={{ width: '100%', display: 'flex', gap: 8 }}>
                              <Button
                                type={leg1Side === 'buy' ? 'primary' : 'default'}
                                size="middle"
                                style={{
                                  flex: 1,
                                  background: leg1Side === 'buy' ? 'green' : '#2b3139',
                                  border: 'none',
                                  color: leg1Side === 'buy' ? '#fff' : '#848e9c',
                                  fontWeight: 600,
                                  height: 36,
                                  transition: 'all 0.3s',
                                  boxShadow: 'none',
                                  borderRadius: 8,
                                }}
                                onClick={() => {
                                  setLeg1Side('buy');
                                  legsForm.setFieldValue('leg1_side', 'buy');
                                }}
                              >
                                buy
                              </Button>
                              <Button
                                type={leg1Side === 'sell' ? 'primary' : 'default'}
                                size="middle"
                                style={{
                                  flex: 1,
                                  background: leg1Side === 'sell' ? 'red' : '#2b3139',
                                  border: 'none',
                                  color: leg1Side === 'sell' ? '#fff' : '#848e9c',
                                  fontWeight: 600,
                                  height: 36,
                                  transition: 'all 0.3s',
                                  boxShadow: 'none',
                                  borderRadius: 8,
                                }}
                                onClick={() => {
                                  setLeg1Side('sell');
                                  legsForm.setFieldValue('leg1_side', 'sell');
                                }}
                              >
                                sell
                              </Button>
                            </div>
                          </Form.Item>
                        </div>
                      </div>
                    </Col>

                    {/* Leg 2 */}
                    <Col span={isMobile ? 24 : 12} style={{ marginBottom: isMobile ? 12 : 0 }}>
                      <div style={{ 
                        background: '#1e2329', 
                        padding: '12px 10px', 
                        borderRadius: 6, 
                        marginBottom: 12,
                        border: '1px solid #2b3139',
                      }}>
                        <div style={{ 
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          marginBottom: 12,
                        }}>
                          <div style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            background: '#f6465d',
                          }}></div>
                          <Text style={{ 
                            color: '#fff', 
                            fontSize: 12, 
                            fontWeight: 600,
                          }}>
                            Leg 2
                          </Text>
                        </div>
                        
                        <Form.Item 
                          name="leg2_exchange" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Exchange2</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Select 
                            size="small" 
                            style={{ 
                              width: '100%',
                            }}
                            className="exchange-select-uppercase"
                          >
                            {availableExchanges.map(ex => (
                              <Option key={`p2_${ex.key}`} value={ex.key}>
                                {ex.name}
                              </Option>
                            ))}
                          </Select>
                        </Form.Item>

                        <Form.Item 
                          name="leg2_symbol" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Symbol2 (自動同步)</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Input 
                            size="small" 
                            placeholder="ETHUSDT"
                            style={{ 
                              background: '#0b0e11', 
                              border: '1px solid #2b3139', 
                              color: '#fff',
                              fontWeight: 500,
                              textTransform: 'uppercase',
                            }} 
                            onChange={(e) => {
                              const val = e?.target?.value;
                              setLeg2ManualSymbol(val !== (leg1SymbolWatch || ''));
                            }}
                            onBlur={(e) => {
                              const val = e?.target?.value;
                              setLeg2ManualSymbol(val !== (leg1SymbolWatch || ''));
                            }}
                          />
                        </Form.Item>

                        <Form.Item 
                          name="leg2_type" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>Category2</Text>} 
                          style={{ marginBottom: 10 }}
                        >
                          <Select size="small" style={{ width: '100%' }}>
                            <Option value="linear" disabled={isLinearBlocked(leg2ExchangeWatch)}>合約</Option>
                            <Option value="spot" disabled={isSpotBlocked(leg2ExchangeWatch)}>現貨</Option>
                          </Select>
                        </Form.Item>

                        {/* 買/賣按鈕組 */}
                        <div style={{ marginBottom: 0 }}>
                          <Text style={{ 
                            color: '#848e9c', 
                            fontSize: 11,
                            display: 'block',
                            marginBottom: 6,
                          }}>
                            方向
                          </Text>
                          <Form.Item name="leg2_side" noStyle initialValue="sell">
                            <div style={{ width: '100%', display: 'flex', gap: 8 }}>
                              <Button
                                type={leg2Side === 'buy' ? 'primary' : 'default'}
                                size="middle"
                                style={{
                                  flex: 1,
                                  background: leg2Side === 'buy' ? 'green' : '#2b3139',
                                  border: 'none',
                                  color: leg2Side === 'buy' ? '#fff' : '#848e9c',
                                  fontWeight: 600,
                                  height: 36,
                                  transition: 'all 0.3s',
                                  boxShadow: 'none',
                                  borderRadius: 8,
                                }}
                                onClick={() => {
                                  setLeg2Side('buy');
                                  legsForm.setFieldValue('leg2_side', 'buy');
                                }}
                              >
                                buy
                              </Button>
                              <Button
                                type={leg2Side === 'sell' ? 'primary' : 'default'}
                                size="middle"
                                style={{
                                  flex: 1,
                                  background: leg2Side === 'sell' ? 'red' : '#2b3139',
                                  border: 'none',
                                  color: leg2Side === 'sell' ? '#fff' : '#848e9c',
                                  fontWeight: 600,
                                  height: 36,
                                  transition: 'all 0.3s',
                                  boxShadow: 'none',
                                  borderRadius: 8,
                                }}
                                onClick={() => {
                                  setLeg2Side('sell');
                                  legsForm.setFieldValue('leg2_side', 'sell');
                                }}
                              >
                                sell
                              </Button>
                            </div>
                          </Form.Item>
                        </div>
                      </div>
                    </Col>
                  </Row>
              </Form>

              {activeTab === 'pair' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <Form
                    form={pairForm}
                    layout="vertical"
                    style={{ flex: 1 }}
                    initialValues={{
                      qty: 0.1,
                      threshold: 0.1,
                      maxExecs: 1,
                    }}
                  >
                    {/* 參數設置 - 僅 PAIRS */}
                    <Row gutter={10}>
                      <Col span={8}>
                        <Form.Item 
                          name="qty" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>數量</Text>}
                          style={{ marginBottom: 12 }}
                        >
                          <InputNumber 
                            size="middle" 
                            min={0.0001} 
                            step={0.01}
                            placeholder="0.10"
                            style={{ 
                              width: '100%', 
                              background: '#1e2329', 
                              border: '1px solid #2b3139',
                            }} 
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item 
                          name="threshold" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>價差 (%)</Text>}
                          style={{ marginBottom: 12 }}
                        >
                          <InputNumber 
                            size="middle" 
                            step={0.01}
                            placeholder="0.10"
                            style={{ 
                              width: '100%', 
                              background: '#1e2329', 
                              border: '1px solid #2b3139',
                            }} 
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item 
                          name="maxExecs" 
                          label={<Text style={{ color: '#848e9c', fontSize: 11 }}>次數</Text>}
                          style={{ marginBottom: 12 }}
                        >
                          <InputNumber 
                            size="middle" 
                            min={1} 
                            step={1}
                            placeholder="1"
                            style={{ 
                              width: '100%', 
                              background: '#1e2329', 
                              border: '1px solid #2b3139',
                            }} 
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Form>

                  {/* 執行按鈕 - 固定在底部 */}
                  <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      block
                      size="large"
                      onClick={handleCreatePair}
                      style={{
                        background: 'linear-gradient(135deg, #f0b90b 0%, #f8d12f 100%)',
                        borderColor: '#f0b90b',
                        color: '#0b0e11',
                        fontWeight: 700,
                        height: 48,
                        fontSize: 15,
                        borderRadius: 10,
                        boxShadow: '0 6px 16px rgba(240, 185, 11, 0.4)',
                        transition: 'all 0.3s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-2px)';
                        e.currentTarget.style.boxShadow = '0 8px 20px rgba(240, 185, 11, 0.5)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 6px 16px rgba(240, 185, 11, 0.4)';
                      }}
                    >
                      ⚡ 立即執行
                    </Button>
                  </div>
                </div>
              )}

              {activeTab === 'pair' && (
                <div style={{ marginTop: 12 }}>
                  <Button
                    block
                    size="large"
                    onClick={handleAddSpreadMonitor}
                    style={{
                      background: '#2b3139',
                      borderColor: '#3a414a',
                      color: '#f0b90b',
                      fontWeight: 700,
                      height: 44,
                      fontSize: 14,
                      borderRadius: 10,
                    }}
                  >
                    新增監控
                  </Button>
                </div>
              )}

              {activeTab === 'twap' && (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <Form
                    form={twapForm}
                    layout="vertical"
                    style={{ flex: 1 }}
                    initialValues={{
                      sliceQty: 0.1,
                      orderCount: 2,
                      intervalSec: 10,
                    }}
                  >
                    {/* TWAP 專屬參數 */}
                    <Row gutter={10}>
                      <Col span={8}>
                        <Form.Item name="sliceQty" label={<Text style={{ color: '#848e9c', fontSize: 11 }}>數量</Text>} style={{ marginBottom: 12 }}>
                          <InputNumber 
                            size="middle" 
                            min={0.0001} 
                            step={0.01} 
                            placeholder="0.10"
                            style={{ width: '100%', background: '#1e2329', border: '1px solid #2b3139' }} 
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="intervalSec" label={<Text style={{ color: '#848e9c', fontSize: 11 }}>間隔(秒)</Text>} style={{ marginBottom: 12 }}>
                          <InputNumber 
                            size="middle" 
                            min={1} 
                            step={1} 
                            placeholder="10"
                            style={{ width: '100%', background: '#1e2329', border: '1px solid #2b3139' }} 
                          />
                        </Form.Item>
                      </Col>
                      <Col span={8}>
                        <Form.Item name="orderCount" label={<Text style={{ color: '#848e9c', fontSize: 11 }}>次數</Text>} style={{ marginBottom: 12 }}>
                          <InputNumber 
                            size="middle" 
                            min={1} 
                            step={1} 
                            placeholder="1"
                            style={{ width: '100%', background: '#1e2329', border: '1px solid #2b3139' }} 
                          />
                        </Form.Item>
                      </Col>
                    </Row>
                  </Form>

                  {/* 執行按鈕 - 固定在底部 */}
                  <div style={{ marginTop: 'auto', paddingTop: 16 }}>
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      block
                      size="large"
                      onClick={handleCreateTwap}
                      style={{
                        background: 'linear-gradient(135deg, #722ed1 0%, #9254de 100%)',
                        borderColor: '#722ed1',
                        color: '#fff',
                        fontWeight: 700,
                        height: 48,
                        fontSize: 15,
                        borderRadius: 10,
                        boxShadow: '0 6px 16px rgba(114, 46, 209, 0.4)',
                        transition: 'all 0.3s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-2px)';
                        e.currentTarget.style.boxShadow = '0 8px 20px rgba(114, 46, 209, 0.5)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.boxShadow = '0 6px 16px rgba(114, 46, 209, 0.4)';
                      }}
                    >
                      🕘 立即執行
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </Col>
      </Row>

      {/* 底部：監控 / 執行中訂單 / 歷史記錄 */}
        <Card
          title={<Space><FundOutlined style={{ color: '#f0b90b' }} /><span style={{ color: '#fff', fontWeight: 600 }}>📊 訂單與監控</span></Space>}
          style={{
            marginTop: isMobile ? 12 : 20,
            background: 'linear-gradient(145deg, #161a1e, #1e2329)',
            borderRadius: 12,
            border: '1px solid #2b3139',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          }}
          styles={{
            header: {
              background: 'linear-gradient(135deg, #1e2329, #252a30)',
              borderBottom: '1px solid #2b3139',
              color: '#fff',
              padding: isMobile ? (isSmallMobile ? '10px 12px' : '12px 16px') : '16px 20px',
              borderRadius: '12px 12px 0 0',
            },
            body: { padding: 0, background: 'transparent' },
          }}
        >
        <div style={{ borderBottom: '1px solid #2b3139', display: 'flex' }}>
          <div
            onClick={() => setBottomTab('positions')}
            style={{
              order: 2,
              flex: 1,
              padding: isMobile ? (isSmallMobile ? '10px 12px' : '12px 14px') : '12px 16px',
              cursor: 'pointer',
              borderBottom: bottomTab === 'positions' ? '2px solid #f0b90b' : '2px solid transparent',
              background: bottomTab === 'positions' ? 'rgba(240, 185, 11, 0.1)' : 'transparent',
            }}
          >
            <Space>
              <FundOutlined style={{ color: bottomTab === 'positions' ? '#f0b90b' : '#848e9c' }} />
              <Text style={{ color: bottomTab === 'positions' ? '#f0b90b' : '#848e9c', fontSize: 13, fontWeight: bottomTab === 'positions' ? 600 : 400 }}>倉位 ({allPositionsData.length})</Text>
            </Space>
          </div>
          <div
            onClick={() => setBottomTab('orders')}
            style={{
              order: 0,
              flex: 1,
              padding: isMobile ? (isSmallMobile ? '10px 12px' : '12px 14px') : '12px 16px',
              cursor: 'pointer',
              borderBottom: bottomTab === 'orders' ? '2px solid #f0b90b' : '2px solid transparent',
              background: bottomTab === 'orders' ? 'rgba(240, 185, 11, 0.1)' : 'transparent',
            }}
          >
            <Space>
              <FundOutlined style={{ color: bottomTab === 'orders' ? '#f0b90b' : '#848e9c' }} />
              <Text style={{ color: bottomTab === 'orders' ? '#f0b90b' : '#848e9c', fontSize: 13, fontWeight: bottomTab === 'orders' ? 600 : 400 }}>監控與執行中 ({spreadMonitors.length + ongoingData.length})</Text>
            </Space>
          </div>
          <div
            onClick={() => setBottomTab('history')}
            style={{
              order: 3,
              flex: 1,
              padding: isMobile ? (isSmallMobile ? '10px 12px' : '12px 14px') : '12px 16px',
              cursor: 'pointer',
              borderBottom: bottomTab === 'history' ? '2px solid #f0b90b' : '2px solid transparent',
              background: bottomTab === 'history' ? 'rgba(240, 185, 11, 0.1)' : 'transparent',
            }}
          >
            <Space>
              <FundOutlined style={{ color: bottomTab === 'history' ? '#f0b90b' : '#848e9c' }} />
              <Text style={{ color: bottomTab === 'history' ? '#f0b90b' : '#848e9c', fontSize: 13, fontWeight: bottomTab === 'history' ? 600 : 400 }}>歷史記錄 ({filteredHistoryData.length})</Text>
            </Space>
          </div>
        </div>

        <div style={{ padding: isMobile ? (isSmallMobile ? 12 : 14) : 16 }}>
          {bottomTab === 'orders' && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr)',
                gap: isMobile ? 12 : 16,
                alignItems: 'start',
              }}
            >
              {/*
                暫時隱藏左下方「差價監控」面板，之後要調整時可從這裡恢復。
                {renderSpreadMonitorPanel()}
              */}
              <div
                style={{
                  border: '1px solid #2b3139',
                  borderRadius: 8,
                  background: '#181d24',
                  minHeight: 260,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid #2b3139',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <Space size={8}>
                    <FundOutlined style={{ color: '#f0b90b' }} />
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: 700 }}>執行中訂單</Text>
                  </Space>
                  <Tag color="blue" style={{ margin: 0 }}>{ongoingData.length}</Tag>
                </div>

                {ongoingData.length > 0 ? (
                  <Table
                    size="small"
                    rowKey="key"
                    dataSource={ongoingData}
                    columns={ongoingColumns}
                    pagination={{ pageSize: 5, size: 'small' }}
                    style={{
                      background: 'transparent',
                    }}
                    onRow={(record: any) => ({
                      onClick: () => {
                        if (record.leg1 && record.leg2) {
                          const leg1Type = record.leg1.type === 'future' || record.leg1.type === 'linear'
                            ? 'linear'
                            : record.leg1.type === 'margin'
                              ? 'spot'
                              : (record.leg1.type || 'spot');

                          const leg2Type = record.leg2.type === 'future' || record.leg2.type === 'linear'
                            ? 'linear'
                            : record.leg2.type === 'margin'
                              ? 'spot'
                              : (record.leg2.type || 'spot');

                          legsForm.setFieldsValue({
                            leg1_exchange: record.leg1.exchange,
                            leg1_symbol: record.leg1.symbol.toUpperCase(),
                            leg1_type: leg1Type,
                            leg1_side: record.leg1.side || 'buy',
                            leg2_exchange: record.leg2.exchange,
                            leg2_symbol: record.leg2.symbol.toUpperCase(),
                            leg2_type: leg2Type,
                            leg2_side: record.leg2.side || 'sell',
                          });

                          setLeg1Side(record.leg1.side === 'sell' ? 'sell' : 'buy');
                          setLeg2Side(record.leg2.side === 'sell' ? 'sell' : 'buy');
                          setNextLegToUpdate(1);

                          message.success(
                            `已回填 ${record.leg1.exchange.toUpperCase()} ${record.leg1.symbol} / ${record.leg2.exchange.toUpperCase()} ${record.leg2.symbol}`
                          );
                        } else {
                          message.warning('這筆資料缺少 leg 資訊，無法回填');
                        }
                      },
                      style: { cursor: 'pointer' },
                    })}
                  />
                ) : (
                  <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>--</div>
                    <Text style={{ color: '#848e9c' }}>尚無執行中訂單</Text>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>建立 PAIR 或 TWAP 後會顯示在這裡</div>
                  </div>
                )}
              </div>
            </div>
          )}
          {false && (
            ongoingData.length > 0 ? (
              <Table
                size="small"
                rowKey="key"
                dataSource={ongoingData}
                columns={ongoingColumns}
                pagination={{ pageSize: 5, size: 'small' }}
                style={{
                  background: 'transparent',
                }}
                onRow={(record: any) => ({
                  onClick: () => {
                    // 🔥 點擊執行中訂單時，一次性將 leg1 和 leg2 都帶入圖表
                    if (record.leg1 && record.leg2) {
                      // 處理類型轉換（future -> linear, margin -> spot）
                      const leg1Type = record.leg1.type === 'future' || record.leg1.type === 'linear' 
                        ? 'linear' 
                        : record.leg1.type === 'margin' 
                          ? 'spot' 
                          : (record.leg1.type || 'spot');
                      
                      const leg2Type = record.leg2.type === 'future' || record.leg2.type === 'linear' 
                        ? 'linear' 
                        : record.leg2.type === 'margin' 
                          ? 'spot' 
                          : (record.leg2.type || 'spot');

                      // 同時更新 leg1 和 leg2
                      legsForm.setFieldsValue({
                        leg1_exchange: record.leg1.exchange,
                        leg1_symbol: record.leg1.symbol.toUpperCase(),
                        leg1_type: leg1Type,
                        leg1_side: record.leg1.side || 'buy',
                        leg2_exchange: record.leg2.exchange,
                        leg2_symbol: record.leg2.symbol.toUpperCase(),
                        leg2_type: leg2Type,
                        leg2_side: record.leg2.side || 'sell',
                      });

                      // 更新 side 狀態
                      setLeg1Side(record.leg1.side === 'sell' ? 'sell' : 'buy');
                      setLeg2Side(record.leg2.side === 'sell' ? 'sell' : 'buy');

                      // 重置下一次點擊的目標（因為已經同時設置了兩個 leg）
                      setNextLegToUpdate(1);

                      message.success(
                        `✅ 已載入圖表：${record.leg1.exchange.toUpperCase()} ${record.leg1.symbol} ↔ ${record.leg2.exchange.toUpperCase()} ${record.leg2.symbol}`
                      );
                    } else {
                      message.warning('該訂單數據不完整，無法載入圖表');
                    }
                  },
                  style: { cursor: 'pointer' },
                })}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
                <Text style={{ color: '#848e9c' }}>暫無執行中訂單</Text>
                <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>執行套利或TWAP策略後，訂單將顯示在這裡</div>
              </div>
            )
          )}
          {false && (
            spreadMonitors.length > 0 ? (
              <Table
                size="small"
                rowKey="id"
                dataSource={spreadMonitors}
                pagination={{ pageSize: 5, size: 'small' }}
                style={{ background: 'transparent' }}
                onRow={(record: SpreadMonitor) => ({
                  onClick: () => handleApplySpreadMonitor(record),
                  style: { cursor: 'pointer' },
                })}
                columns={[
                  {
                    title: 'Leg1',
                    key: 'leg1',
                    width: 180,
                    render: (_: any, r: SpreadMonitor) => (
                      <div>
                        <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                          {`${r.leg1.exchange.toLowerCase()} ${r.leg1.symbol.toLowerCase()}${getContractSuffix(r.leg1.type, '.p')}`}
                        </Text>
                        <br />
                        <Tag color={r.leg1.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
                          {r.leg1.side}
                        </Tag>
                      </div>
                    ),
                  },
                  {
                    title: 'Leg2',
                    key: 'leg2',
                    width: 180,
                    render: (_: any, r: SpreadMonitor) => (
                      <div>
                        <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                          {`${r.leg2.exchange.toLowerCase()} ${r.leg2.symbol.toLowerCase()}${getContractSuffix(r.leg2.type, '.p')}`}
                        </Text>
                        <br />
                        <Tag color={r.leg2.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
                          {r.leg2.side}
                        </Tag>
                      </div>
                    ),
                  },
                  {
                    title: '報價',
                    key: 'prices',
                    width: 260,
                    render: (_: any, r: SpreadMonitor) => {
                      const prices = spreadMonitorPrices[r.id];
                      const calc = calculateMonitorSpread(r, prices);
                      return (
                        <div style={{ fontSize: 11 }}>
                          <div><Text style={{ color: '#848e9c' }}>Leg1 Bid/Ask:</Text> <Text style={{ color: '#fff' }}>{prices?.leg1?.bid || '--'} / {prices?.leg1?.ask || '--'}</Text></div>
                          <div><Text style={{ color: '#848e9c' }}>Leg2 Bid/Ask:</Text> <Text style={{ color: '#fff' }}>{prices?.leg2?.bid || '--'} / {prices?.leg2?.ask || '--'}</Text></div>
                          <div><Text style={{ color: '#848e9c' }}>採用價:</Text> <Text style={{ color: '#f0b90b' }}>{calc.leg1Exec || '--'} / {calc.leg2Exec || '--'}</Text></div>
                        </div>
                      );
                    },
                  },
                  {
                    title: '價差',
                    key: 'spread',
                    width: 140,
                    render: (_: any, r: SpreadMonitor) => {
                      const calc = calculateMonitorSpread(r, spreadMonitorPrices[r.id]);
                      const isTriggered = typeof calc.spreadPct === 'number' && calc.spreadPct >= r.threshold;
                      return (
                        <div>
                          <Text style={{ color: isTriggered ? '#0ecb81' : '#848e9c', fontSize: 13, fontWeight: 700 }}>
                            {calc.spreadPct === null ? '--' : `${calc.spreadPct >= 0 ? '+' : ''}${calc.spreadPct.toFixed(4)}%`}
                          </Text>
                          <div style={{ color: '#848e9c', fontSize: 11 }}>
                            目標 {r.threshold >= 0 ? '+' : ''}{r.threshold.toFixed(4)}%
                          </div>
                        </div>
                      );
                    },
                  },
                  {
                    title: '狀態',
                    key: 'status',
                    width: 110,
                    render: (_: any, r: SpreadMonitor) => {
                      const calc = calculateMonitorSpread(r, spreadMonitorPrices[r.id]);
                      if (!r.enabled) return <Tag>已暫停</Tag>;
                      if (!calc.valid) return <Tag color="default">讀取中</Tag>;
                      return calc.spreadPct !== null && calc.spreadPct >= r.threshold
                        ? <Tag color="success">已達標</Tag>
                        : <Tag color="processing">監控中</Tag>;
                    },
                  },
                  {
                    title: '操作',
                    key: 'action',
                    width: 150,
                    render: (_: any, r: SpreadMonitor) => (
                      <Space onClick={(e) => e.stopPropagation()}>
                        <Button size="small" onClick={() => handleToggleSpreadMonitor(r.id)}>
                          {r.enabled ? '暫停' : '啟用'}
                        </Button>
                        <Button size="small" type="text" danger onClick={() => handleDeleteSpreadMonitor(r.id)}>
                          刪除
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📈</div>
                <Text style={{ color: '#848e9c' }}>暫無差價監控</Text>
                <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>在 PAIRS 的立即執行下面點「新增監控」</div>
              </div>
            )
          )}
          {bottomTab === 'positions' && (
            allPositionsData.length > 0 ? (
              <Table
                size="small"
                rowKey={(record) => record.id}
                dataSource={allPositionsData.map((pos: any) => {
                  const realData = pos.realData;
                  
                  // 🔥 簡化：直接使用交易所實際持倉數據
                  const entryPrice = realData?.entryPrice || 0;
                  const qty = realData?.size || 0;
                  const markPrice = realData?.markPrice || 0;
                  const unrealizedPnl = realData?.unrealizedPnl || 0;
                  const realizedPnl = realData?.realizedPnlUSDT || 0;
                  const value = realData?.notionalUSDT || (qty * markPrice);
                  const margin = realData?.margin || (value / (realData?.leverage || 1));
                  const roi = margin > 0 ? (unrealizedPnl / margin * 100) : 0;
                  const baseAsset = splitSymbol(pos.symbol).base || pos.symbol;
                  
                  return {
                    id: pos.id,
                    exchange: pos.exchange,
                    symbol: pos.symbol,
                    type: pos.type,
                    side: pos.side,
                    contracts: `${pos.exchange.toUpperCase()} ${pos.symbol}${pos.type === 'linear' ? ' Perp' : pos.type === 'margin' ? ' Margin' : pos.type === 'spot' ? ' Spot' : ''}`,
                    leverage: pos.type === 'spot' ? '-' : (realData?.leverage && realData.leverage > 1 ? `${realData.leverage}x` : '-'),
                    marginMode: (realData?.marginMode === 'cross' || realData?.marginMode === 'crossed') ? 'Cross' : 'Isolated',
                    qty: qty,
                    entryPrice: entryPrice,
                    value: value,
                    unrealizedPnl: unrealizedPnl,
                    roi: roi,
                    realizedPnl: realizedPnl,
                    liqPrice: realData?.liquidationPrice,
                    markPrice: markPrice,
                    baseAsset: baseAsset,
                  };
                })}
                columns={[
                  {
                    title: 'Contracts',
                    key: 'contracts',
                    width: 200,
                    render: (_: any, record: any) => {
                      return (
                        <Space direction="vertical" size={2}>
                          <Space>
                            <div style={{
                              width: 4,
                              height: 40,
                              background: record.side === 'buy' ? '#0ecb81' : '#f6465d',
                              borderRadius: 2,
                              marginRight: 8
                            }} />
                            <Space direction="vertical" size={0}>
                              <Text style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>
                                {record.contracts}
                              </Text>
                              <Space size={4}>
                                <Tag color={record.marginMode === 'Cross' ? 'blue' : 'default'} style={{ margin: 0, fontSize: 10 }}>
                                  {record.marginMode}
                                </Tag>
                                <Text style={{ color: '#848e9c', fontSize: 11 }}>
                                  {record.leverage}
                                </Text>
                              </Space>
                            </Space>
                          </Space>
                        </Space>
                      );
                    },
                  },
                  {
                    title: 'Qty',
                    key: 'qty',
                    width: 120,
                    render: (_: any, record: any) => (
                      <Text style={{ color: '#fff', fontSize: 13 }}>
                        {record.side === 'buy' ? '+' : '-'}{formatQuantity(record.qty)} {record.baseAsset}
                      </Text>
                    ),
                  },
                  {
                    title: 'Entry Price',
                    key: 'entryPrice',
                    width: 120,
                    render: (_: any, record: any) => {
                      // spot 和 margin 類型不顯示進場價格
                      if (record.type === 'spot' || record.type === 'margin') {
                        return (
                          <Text style={{ color: '#848e9c', fontSize: 13 }}>
                            -
                          </Text>
                        );
                      }
                      return (
                        <Text style={{ color: '#fff', fontSize: 13 }}>
                          {record.entryPrice > 0 ? record.entryPrice.toFixed(8) : '--'}
                        </Text>
                      );
                    },
                  },
                  {
                    title: 'Value',
                    key: 'value',
                    width: 120,
                    render: (_: any, record: any) => {
                      const value = record.value || 0;
                      return (
                        <Text style={{ color: '#fff', fontSize: 13 }}>
                          {value > 0 ? value.toFixed(2) : '0.00'} USDT
                        </Text>
                      );
                    },
                  },
                  {
                    title: 'Unrealized P&L (ROI)',
                    key: 'unrealizedPnl',
                    width: 180,
                    render: (_: any, record: any) => {
                      // spot 和 margin 類型不顯示未實現盈虧
                      if (record.type === 'spot' || record.type === 'margin') {
                        return (
                          <Text style={{ color: '#848e9c', fontSize: 13 }}>
                            -
                          </Text>
                        );
                      }
                      const unpnl = record.unrealizedPnl || 0;
                      const roi = record.roi || 0;
                      return (
                        <Space direction="vertical" size={2}>
                          <Text style={{ 
                            color: unpnl >= 0 ? '#0ecb81' : '#f6465d', 
                            fontSize: 13,
                            fontWeight: 600
                          }}>
                            {unpnl >= 0 ? '+' : ''}{Math.abs(unpnl) < 0.0001 ? '0.0000' : unpnl.toFixed(4)} USDT
                          </Text>
                          <Text style={{ 
                            color: roi >= 0 ? '#0ecb81' : '#f6465d', 
                            fontSize: 11
                          }}>
                            ({roi >= 0 ? '+' : ''}{Math.abs(roi) < 0.01 ? '0.00' : roi.toFixed(2)}%)
                          </Text>
                        </Space>
                      );
                    },
                  },
                  {
                    title: 'Realized P&L',
                    key: 'realizedPnl',
                    width: 130,
                    render: (_: any, record: any) => {
                      const rpnl = record.realizedPnl || 0;
                      // 如果已實現盈虧為 0，顯示更簡潔
                      if (Math.abs(rpnl) < 0.0001) {
                        return (
                          <Text style={{ 
                            color: '#848e9c', 
                            fontSize: 13,
                            fontWeight: 500
                          }}>
                            --
                          </Text>
                        );
                      }
                      return (
                        <Text style={{ 
                          color: rpnl >= 0 ? '#0ecb81' : '#f6465d', 
                          fontSize: 13,
                          fontWeight: 600
                        }}>
                          {rpnl >= 0 ? '+' : ''}{rpnl.toFixed(4)} USDT
                        </Text>
                      );
                    },
                  },
                  {
                    title: 'Liq. Price',
                    key: 'liqPrice',
                    width: 120,
                    render: (_: any, record: any) => {
                      const liqPrice = record.liqPrice;
                      // 如果強平價格為 0、null 或 undefined，顯示 '--'
                      if (!liqPrice || liqPrice <= 0) {
                        return (
                          <Text style={{ color: '#848e9c', fontSize: 13 }}>
                            --
                          </Text>
                        );
                      }
                      return (
                        <Text style={{ color: '#ff4d4f', fontSize: 13, fontWeight: 500 }}>
                          {liqPrice.toFixed(4)}
                        </Text>
                      );
                    },
                  },
                ]}
                pagination={false}
                scroll={{ x: 1400 }}
                style={{
                  background: 'transparent',
                }}
                onRow={(record: any) => ({
                  onClick: () => {
                    // 🔥 交替更新 leg1 和 leg2
                    // 第1次點擊 → leg1，第2次點擊 → leg2，第3次點擊 → leg1（循環）
                    const chartType = record.type === 'margin' ? 'spot' : record.type;
                    
                    if (nextLegToUpdate === 1) {
                      // 更新 leg1
                      legsForm.setFieldsValue({
                        leg1_exchange: record.exchange,
                        leg1_symbol: record.symbol.toUpperCase(),
                        leg1_type: chartType,
                        leg1_side: record.side,
                      });
                      setLeg1Side(record.side === 'sell' ? 'sell' : 'buy');
                      setNextLegToUpdate(2); // 下次更新 leg2
                      message.success(`✅ 已設置 Leg1：${record.exchange.toUpperCase()} ${record.symbol}，下次點擊將設置 Leg2`);
                    } else {
                      // 更新 leg2
                      legsForm.setFieldsValue({
                        leg2_exchange: record.exchange,
                        leg2_symbol: record.symbol.toUpperCase(),
                        leg2_type: chartType,
                        leg2_side: record.side,
                      });
                      setLeg2Side(record.side === 'sell' ? 'sell' : 'buy');
                      setNextLegToUpdate(1); // 下次更新 leg1
                      message.success(`✅ 已設置 Leg2：${record.exchange.toUpperCase()} ${record.symbol}，下次點擊將設置 Leg1`);
                    }
                  },
                  style: { cursor: 'pointer' },
                })}
              />
            ) : (
              <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
                <Text style={{ color: '#848e9c' }}>暫無監控</Text>
                <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>
                  新增監控對或執行 TWAP 後，監控將顯示在這裡
                </div>
              </div>
            )
          )}
          {bottomTab === 'history' && (
            historyData.length > 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 12 }}>
                  <Space size={16} wrap>
                    <Checkbox
                      checked={historyFilters.includes('success')}
                      onChange={(e) => toggleHistoryFilter('success', e.target.checked)}
                    >
                      <Text style={{ color: '#0ecb81', fontSize: 12 }}>成功</Text>
                    </Checkbox>
                    <Checkbox
                      checked={historyFilters.includes('failed')}
                      onChange={(e) => toggleHistoryFilter('failed', e.target.checked)}
                    >
                      <Text style={{ color: '#f6465d', fontSize: 12 }}>失敗</Text>
                    </Checkbox>
                    <Checkbox
                      checked={historyFilters.includes('manualDelete')}
                      onChange={(e) => toggleHistoryFilter('manualDelete', e.target.checked)}
                    >
                      <Text style={{ color: '#aeb4bc', fontSize: 12 }}>手動刪除</Text>
                    </Checkbox>
                  </Space>
                </div>
              <Table
                size="small"
                rowKey="key"
                dataSource={filteredHistoryData}
                pagination={{ pageSize: 5, size: 'small' }}
                columns={[
                  {
                    title: '類型',
                    dataIndex: 'type',
                    key: 'type',
                    width: 80,
                    render: (v: string) => v === 'pair' ? <Tag color="blue">PAIR</Tag> : <Tag color="purple">TWAP</Tag>
                  },
                  {
                    title: 'Leg1',
                    key: 'leg1',
                    render: (_: any, r: any) => {
                      if (r.leg1 && r.leg1.exchange && r.leg1.symbol) {
                        const typeLabel = getContractSuffix(r.leg1.type);
                        const sideLabel = r.leg1.side === 'buy' ? 'buy' : r.leg1.side === 'sell' ? 'sell' : '';
                        return (
                          <div>
                            <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                              {`${r.leg1.exchange.toUpperCase()} ${r.leg1.symbol}${typeLabel}`}
                            </Text>
                            {sideLabel && (
                              <>
                                <br />
                                <Tag color={r.leg1.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
                                  {sideLabel}
                                </Tag>
                              </>
                            )}
                          </div>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>-</span>;
                    }
                  },
                  {
                    title: 'Leg2',
                    key: 'leg2',
                    render: (_: any, r: any) => {
                      if (r.leg2 && r.leg2.exchange && r.leg2.symbol) {
                        const typeLabel = getContractSuffix(r.leg2.type);
                        const sideLabel = r.leg2.side === 'buy' ? 'buy' : r.leg2.side === 'sell' ? 'sell' : '';
                        return (
                          <div>
                            <Text style={{ fontSize: 12, color: '#fff', fontWeight: 500 }}>
                              {`${r.leg2.exchange.toUpperCase()} ${r.leg2.symbol}${typeLabel}`}
                            </Text>
                            {sideLabel && (
                              <>
                                <br />
                                <Tag color={r.leg2.side === 'buy' ? 'green' : 'red'} style={{ fontSize: 10, marginTop: 4 }}>
                                  {sideLabel}
                                </Tag>
                              </>
                            )}
                          </div>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>-</span>;
                    }
                  },
                  {
                    title: 'Strategy ID',
                    dataIndex: 'strategyId',
                    key: 'strategyId',
                    width: 220,
                    render: (v: string) => (
                      <Text style={{ color: '#aeb4bc', fontSize: 12 }}>
                        {v || '--'}
                      </Text>
                    ),
                  },
                  {
                    title: 'Leg1 均價',
                    key: 'leg1AvgPrice',
                    width: 120,
                    render: (_: any, r: any) => {
                      if (r.leg1AvgPrice !== null && r.leg1AvgPrice !== undefined) {
                        return (
                          <Text style={{ color: '#fff', fontSize: 13 }}>
                            ${r.leg1AvgPrice.toFixed(4)}
                          </Text>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>--</span>;
                    }
                  },
                  {
                    title: 'Leg2 均價',
                    key: 'leg2AvgPrice',
                    width: 120,
                    render: (_: any, r: any) => {
                      if (r.leg2AvgPrice !== null && r.leg2AvgPrice !== undefined) {
                        return (
                          <Text style={{ color: '#fff', fontSize: 13 }}>
                            ${r.leg2AvgPrice.toFixed(4)}
                          </Text>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>--</span>;
                    }
                  },
                  {
                    title: '設定差價%',
                    key: 'threshold',
                    width: 100,
                    render: (_: any, r: any) => {
                      if (r.threshold !== null && r.threshold !== undefined) {
                        return (
                          <Text style={{ 
                            color: '#f0b90b', 
                            fontSize: 13, 
                            fontWeight: 500 
                          }}>
                            {r.threshold >= 0 ? '+' : ''}{r.threshold.toFixed(2)}%
                          </Text>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>--</span>;
                    }
                  },
                  {
                    title: '實際差價%',
                    key: 'spreadPercent',
                    width: 100,
                    render: (_: any, r: any) => {
                      if (r.spreadPercent !== null && r.spreadPercent !== undefined) {
                        const isPositive = r.spreadPercent >= 0;
                        return (
                          <Text style={{ 
                            color: isPositive ? '#0ecb81' : '#f6465d', 
                            fontSize: 13, 
                            fontWeight: 500 
                          }}>
                            {isPositive ? '+' : ''}{r.spreadPercent.toFixed(2)}%
                          </Text>
                        );
                      }
                      return <span style={{ color: '#848e9c' }}>--</span>;
                    }
                  },
                  {
                    title: '成交數量',
                    key: 'quantity',
                    width: 180, // 🔥 增加寬度以容納三個數字
                    render: (_: any, r: any) => {
                      // 🔥 顯示格式：leg1/leg2/預期數量
                      const leg1Qty = r.leg1TotalQty || 0;
                      const leg2Qty = r.leg2TotalQty || 0;
                      const expectedTotalQty = r.expectedTotalQty;
                      
                      if (expectedTotalQty !== null && expectedTotalQty !== undefined) {
                        return (
                          <Text style={{ color: '#fff', fontSize: 13 }}>
                            {formatQuantity(leg1Qty)}/{formatQuantity(leg2Qty)}/{formatQuantity(expectedTotalQty)}
                          </Text>
                        );
                      } else {
                        // 如果沒有預期數量，只顯示實際成交數量
                        return (
                          <Text style={{ color: '#fff', fontSize: 13 }}>
                            {formatQuantity(leg1Qty)}/{formatQuantity(leg2Qty)}/--
                          </Text>
                        );
                      }
                    }
                  },
                  {
                    title: '時間',
                    dataIndex: 'timestamp',
                    key: 'timestamp',
                    width: 160,
                    render: (ts: number) => {
                      const date = new Date(ts);
                      const year = date.getFullYear();
                      const month = String(date.getMonth() + 1).padStart(2, '0');
                      const day = String(date.getDate()).padStart(2, '0');
                      const hours = String(date.getHours()).padStart(2, '0');
                      const minutes = String(date.getMinutes()).padStart(2, '0');
                      const seconds = String(date.getSeconds()).padStart(2, '0');
                      return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
                    }
                  },
                  {
                    title: '結果',
                    key: 'success',
                    width: 80,
                    render: (_: any, r: any) => {
                      // 🔥 若同時有 failed 與 cancelled，優先顯示失敗
                      if (r.hasFailedRecord) {
                        return (
                          <Tag color="error">
                            失敗
                          </Tag>
                        );
                      }
                      // 🔥 優先顯示手動刪除標記
                      if (r.isManualDelete) {
                        return (
                          <Tag color="default">
                            手動刪除
                          </Tag>
                        );
                      }
                      // 🔥 根據實際的成功狀態顯示結果
                      const isSuccess = r.success === true;
                      return (
                        <Tag color={isSuccess ? "success" : "error"}>
                          {isSuccess ? "成功" : "失敗"}
                        </Tag>
                      );
                    }
                  }
                ]}
                onRow={(record: any) => ({
                  onClick: () => {
                    // 🔥 點擊歷史訂單時，一次性將 leg1 和 leg2 都帶入圖表
                    if (record.leg1 && record.leg2) {
                      // 處理類型轉換（future -> linear, margin -> spot）
                      const leg1Type = record.leg1.type === 'future' || record.leg1.type === 'linear' 
                        ? 'linear' 
                        : record.leg1.type === 'margin' 
                          ? 'spot' 
                          : (record.leg1.type || 'spot');
                      
                      const leg2Type = record.leg2.type === 'future' || record.leg2.type === 'linear' 
                        ? 'linear' 
                        : record.leg2.type === 'margin' 
                          ? 'spot' 
                          : (record.leg2.type || 'spot');

                      // 同時更新 leg1 和 leg2
                      legsForm.setFieldsValue({
                        leg1_exchange: record.leg1.exchange,
                        leg1_symbol: record.leg1.symbol.toUpperCase(),
                        leg1_type: leg1Type,
                        leg1_side: record.leg1.side || 'buy',
                        leg2_exchange: record.leg2.exchange,
                        leg2_symbol: record.leg2.symbol.toUpperCase(),
                        leg2_type: leg2Type,
                        leg2_side: record.leg2.side || 'sell',
                      });

                      // 更新 side 狀態
                      setLeg1Side(record.leg1.side === 'sell' ? 'sell' : 'buy');
                      setLeg2Side(record.leg2.side === 'sell' ? 'sell' : 'buy');

                      // 重置下一次點擊的目標（因為已經同時設置了兩個 leg）
                      setNextLegToUpdate(1);

                      message.success(
                        `✅ 已載入圖表：${record.leg1.exchange.toUpperCase()} ${record.leg1.symbol} ↔ ${record.leg2.exchange.toUpperCase()} ${record.leg2.symbol}`
                      );
                    } else {
                      message.warning('該歷史記錄數據不完整，無法載入圖表');
                    }
                  },
                  style: { cursor: 'pointer' },
                })}
              />
              </>
            ) : (
            <div style={{ textAlign: 'center', padding: 40, color: '#848e9c' }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🕘</div>
              <Text style={{ color: '#848e9c' }}>暫無歷史記錄</Text>
              <div style={{ marginTop: 8, fontSize: 12, color: '#5e6673' }}>
                <a href="/reports" style={{ color: '#f0b90b' }}>前往績效報告頁</a> 查看完整歷史
              </div>
            </div>
            )
          )}
        </div>
      </Card>
    </div>
  );
};

export default Trading;
