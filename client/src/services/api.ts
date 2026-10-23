/**
 * API服務
 * 處理與後端API的通訊
 */

import axios from 'axios';
import logger from '../utils/logger';
import { getApiBaseUrl } from '../utils/env';
import type { 
  PairConfig, 
  CreatePairRequest, 
  UpdatePairRequest, 
  EngineControlRequest,
  ExecutionHistoryResponse,
  ApiResponse,
  EngineStatus
} from '../types/arbitrage';
import type { FundingRate } from '../types/positions';

export interface TradeRecordQueryParams {
  type?: 'all' | 'arbitrage' | 'twap';
  symbol?: string;
  exchange?: string;
  result?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

// 創建axios實例
const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// 請求攔截器
api.interceptors.request.use(
  (config) => {
    logger.info('API Request', {
      method: config.method?.toUpperCase(),
      url: config.url,
      baseURL: config.baseURL,
      fullURL: `${config.baseURL}${config.url}`,
      data: config.data,
      params: config.params,
      headers: config.headers,
      timestamp: new Date().toISOString()
    }, 'API');
    return config;
  },
  (error) => {
    logger.error('API Request Error', error, 'API');
    return Promise.reject(error);
  }
);

// 響應攔截器
api.interceptors.response.use(
  (response) => {
    logger.info('API Response', {
      method: response.config.method?.toUpperCase(),
      url: response.config.url,
      status: response.status,
      statusText: response.statusText,
      data: response.data,
      responseTime: response.headers['x-response-time'] || 'N/A',
      timestamp: new Date().toISOString()
    }, 'API');
    return response.data;
  },
  (error) => {
    logger.error('API Response Error', {
      method: error.config?.method?.toUpperCase() || 'UNKNOWN',
      url: error.config?.url || 'UNKNOWN',
      status: error.response?.status || 'NO_RESPONSE',
      statusText: error.response?.statusText || 'NETWORK_ERROR',
      message: error.message,
      responseData: error.response?.data,
      timestamp: new Date().toISOString()
    }, 'API');
    
    // 統一錯誤處理
    const errorMessage = error.response?.data?.error || error.message || '網路錯誤';
    return Promise.reject(new Error(errorMessage));
  }
);

// API接口定義
export const apiService = {
  // 系統狀態
  getStatus: () => api.get('/status'),
  
  // 交易所信息
  getExchanges: () => api.get('/api/exchanges'),
  
  // 新增：交易所狀態（與 /api/exchanges 等價，便於對齊 pmC.md）
  getExchangeStatus: async (): Promise<ApiResponse<Record<string, ExchangeInfo>>> => {
    try {
      const res = await api.get('/api/exchanges');
      return res as unknown as ApiResponse<Record<string, ExchangeInfo>>;
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },

  // 新增：獲取指定交易所的 symbols（僅用真實資料，不使用 mock）
  getSymbols: async (exchange: string): Promise<ApiResponse<string[]>> => {
    try {
      const res = await api.get('/api/exchanges');
      const data = (res as unknown as ApiResponse<Record<string, ExchangeInfo>>).data;
      if (!data || !data[exchange]) {
        return { success: true, data: [] };
      }
      const symbolsInfo = data[exchange].symbols;
      const symbols: string[] = [];
      if (symbolsInfo?.spot) symbols.push(...symbolsInfo.spot);
      if ((symbolsInfo as any)?.future) symbols.push(...(symbolsInfo as any).future);
      if (symbolsInfo?.linear) symbols.push(...symbolsInfo.linear);
      if (symbolsInfo?.inverse) symbols.push(...symbolsInfo.inverse);
      return { success: true, data: Array.from(new Set(symbols)) };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  },
  
  // 新增：watch pair（對齊 pmC.md，轉發到現有監控接口）
  addWatchPair: (payload: any) => api.post('/api/monitoring/pairs', payload),

  // 交易所狀態管理（注意：部分端點後端未實現）
  // getExchangeStats: () => api.get('/api/exchanges/stats'),
  // getImplementedExchanges: () => api.get('/api/exchanges/implemented'),
  // getPlannedExchanges: () => api.get('/api/exchanges/planned'),
  // getConnectedExchanges: () => api.get('/api/exchanges/connected'),
  // getRecommendedPairs: () => api.get('/api/exchanges/recommended-pairs'),
  // getExchangeFeatures: () => api.get('/api/exchanges/features'),
  // checkFeatureSupport: (exchange: string, feature: string) => 
  //   api.get(`/api/exchanges/${exchange}/features/${feature}`),
  
  // 價格數據
  getPrice: (exchange: string, symbol: string) => 
    api.get(`/api/prices/${exchange}/${symbol}`),
  
  getBatchPrices: (symbols: string[]) => 
    api.post('/api/prices/batch', { symbols }),

  // 資金費率 / 借幣利率
  getFundingRates: (params?: { exchange?: string; symbols?: string[] | string }) => {
    const query: Record<string, string> = {};
    if (params?.exchange) {
      query.exchange = params.exchange;
    }
    if (params?.symbols) {
      query.symbols = Array.isArray(params.symbols) ? params.symbols.join(',') : params.symbols;
    }
    return api.get<ApiResponse<FundingRate[]>>('/api/funding-rates', {
      params: Object.keys(query).length ? query : undefined,
    });
  },

  getBorrowingRates: (params?: { exchange?: string; assets?: string[] | string }) => {
    const query: Record<string, string> = {};
    if (params?.exchange) {
      query.exchange = params.exchange;
    }
    if (params?.assets) {
      query.assets = Array.isArray(params.assets) ? params.assets.join(',') : params.assets;
    }
    return api.get<ApiResponse<any[]>>('/api/borrowing-rates', {
      params: Object.keys(query).length ? query : undefined,
    });
  },
  
  // 監控交易對管理 - 統一使用套利引擎API
  getMonitoringPairs: (): Promise<ApiResponse<PairConfig[]>> => 
    api.get('/api/arbitrage/pairs'),
  
  addMonitoringPair: (config: CreatePairRequest): Promise<ApiResponse<PairConfig>> => 
    api.post('/api/arbitrage/pairs', config),
  
  updateMonitoringPair: (id: string, updates: UpdatePairRequest): Promise<ApiResponse<void>> => 
    api.put(`/api/arbitrage/pairs/${id}`, updates),
  
  removeMonitoringPair: (id: string): Promise<ApiResponse<void>> => 
    api.delete(`/api/arbitrage/pairs/${id}`),

  // 獲取監控交易對的實時價格（注意：後端未實現此端點，請使用 websocket 或 batch）
  // getMonitoringPrices: () => api.get('/api/monitoring/prices'),
  
  // 套利引擎控制
  getArbitrageEngineStatus: (): Promise<ApiResponse<EngineStatus>> => 
    api.get('/api/arbitrage/engine/status'),
  
  controlArbitrageEngine: (payload: EngineControlRequest): Promise<ApiResponse<void>> => 
    api.post('/api/arbitrage/engine/control', payload),
  
  // 套利監控對管理（統一接口）
  upsertArbitragePair: (payload: CreatePairRequest): Promise<ApiResponse<PairConfig>> => 
    api.post('/api/arbitrage/pairs', payload),
  
  removeArbitragePair: (pairId: string): Promise<ApiResponse<void>> => 
    api.delete(`/api/arbitrage/pairs/${pairId}`),

  updateArbitragePair: (pairId: string, updates: UpdatePairRequest): Promise<ApiResponse<void>> =>
    api.put(`/api/arbitrage/pairs/${pairId}`, updates),
  
  // 套利執行（注意：後端暫未實現此端點，套利由引擎自動執行）
  // executeArbitrage: (pairId: string): Promise<ApiResponse<any>> => 
  //   api.post(`/api/arbitrage/execute/${pairId}`),

  // 取得套利執行歷史
  getArbitrageExecutions: (): Promise<ApiResponse<ExecutionHistoryResponse>> =>
    api.get('/api/arbitrage/executions'),
  
  // 取得成交均價統計
  getAveragePrices: () => api.get('/api/arbitrage/average-prices'),
  
  // TWAP策略管理
  getTwapStrategies: () => api.get('/api/twap/plans'),
  
  addTwapStrategy: (config: any) => 
    api.post('/api/twap/plans', config),
  
  updateTwapStrategy: (id: string, updates: any) => 
    api.put(`/api/twap/plans/${id}`, updates),
  
  removeTwapStrategy: (id: string) => 
    api.delete(`/api/twap/plans/${id}`),
  
  controlTwapStrategy: (id: string, action: string) =>
    api.post(`/api/twap/${id}/control`, { action }),
  
  emergencyRollbackTwap: (id: string) =>
    api.post(`/api/twap/${id}/emergency-rollback`),
  
  // 取得 TWAP 執行歷史
  getTwapExecutions: () => 
    api.get('/api/twap/executions'),

  getTradeRecords: (params?: TradeRecordQueryParams) =>
    api.get('/api/trade-records', { params }),

  exportTradeRecords: (params?: Omit<TradeRecordQueryParams, 'limit' | 'offset'>) =>
    api.get('/api/trade-records/export', {
      params,
      responseType: 'blob',
    }),
  
  // 賬戶信息（注意：後端端點為 /api/account/{exchange}，但實際實現可能不同）
  getAccount: (exchange: string) => 
    api.get(`/api/account/${exchange}`),
  
  // 設置（注意：後端未實現 /api/settings/risk 端點）
  // updateRiskSettings: (settings: any) => 
  //   api.put('/api/settings/risk', settings),

  // API設定
  getApiSettings: () =>
    api.get('/api/settings/api'),

  getApiSettingsForEdit: () =>
    api.get('/api/settings/api/edit'),

  updateApiSettings: (settings: any) =>
    api.put('/api/settings/api', settings),

  deleteApiSettings: (exchange: string) =>
    api.delete(`/api/settings/api/${exchange}`),

  testApiConnection: (exchange?: string) =>
    api.post('/api/settings/api/test', exchange ? { exchange } : {}),
  
  // 統計數據（注意：後端未實現 /stats 端點）
  // getStats: () => api.get('/stats'),

  // 報告相關 API
  /**
   * 獲取績效總覽
   * @param params - 查詢參數 { from_date?: string, to_date?: string, type?: 'all' | 'arbitrage' | 'twap' }
   */
  getReportSummary: (params?: { from_date?: string; to_date?: string; type?: 'all' | 'arbitrage' | 'twap' }) =>
    api.get('/api/report/summary', { params }),

  /**
   * 獲取套利報告（按策略ID聚合）
   * @param params - 查詢參數 { from_date?: string, to_date?: string, group_by?: 'strategy' | 'symbol' | 'exchange' }
   */
  getArbitrageReport: (params?: { from_date?: string; to_date?: string; group_by?: 'strategy' | 'symbol' | 'exchange' }) =>
    api.get('/api/report/arbitrage', { params }),

  /**
   * 獲取 TWAP 報告（按策略ID聚合）
   * @param params - 查詢參數 { from_date?: string, to_date?: string, group_by?: 'strategy' | 'symbol' | 'exchange' }
   */
  getTwapReport: (params?: { from_date?: string; to_date?: string; group_by?: 'strategy' | 'symbol' | 'exchange' }) =>
    api.get('/api/report/twap', { params }),

  /**
   * 獲取帳戶淨值統計
   * @param params - 查詢參數 { from_date?: string, to_date?: string }
   */
  getNetValueStats: (params?: { from_date?: string; to_date?: string }) =>
    api.get('/api/report/net-value/stats', { params }),

  /**
   * 獲取帳戶淨值歷史記錄
   * @param params - 查詢參數 { from_date?: string, to_date?: string }
   */
  getNetValueHistory: (params?: { from_date?: string; to_date?: string }) =>
    api.get('/api/report/net-value/history', { params }),

  /**
   * 手動記錄當前帳戶淨值
   * @param balances - 各交易所的餘額 { bybit: { USDT: 1000.0 }, ... }
   */
  recordNetValue: (balances: Record<string, Record<string, number>>) =>
    api.post('/api/report/net-value/record', balances),
};

// 保留的舊型別定義（向後兼容）
export interface ExchangeInfo {
  name: string;
  connected: boolean;
  status?: 'active' | 'ready' | 'planned' | 'unknown';
  implemented?: boolean;
  message?: string;
  features?: string[];
  priority?: number;
  symbols?: {
    spot: string[];
    linear: string[];    // 重命名：future -> linear
    inverse: string[];   // 新增
  };
  comingSoon?: boolean;
}

/** @deprecated 使用 types/arbitrage.ts 中的 CreatePairRequest 替代 */
export interface MonitoringPairConfig {
  id?: string;
  leg1: {
    exchange: string;
    symbol: string;
    type: 'future' | 'spot' | 'linear' | 'inverse';
    side?: 'buy' | 'sell';
  };
  leg2: {
    exchange: string;
    symbol: string;
    type: 'future' | 'spot' | 'linear' | 'inverse';
    side?: 'buy' | 'sell';
  };
  threshold: number;
  amount?: number;
  enabled?: boolean;
  executionMode?: 'market' | 'threshold';
  // 新增參數
  qty?: number;
  totalAmount?: number;
}

export interface TwapStrategyConfig {
  id?: string;
  leg1: {
    exchange: string;
    symbol: string;
    type: 'future' | 'spot';
    side: 'buy' | 'sell';
  };
  leg2: {
    exchange: string;
    symbol: string;
    type: 'future' | 'spot';
    side: 'buy' | 'sell';
  };
  totalAmount: number;
  timeInterval: number;
  orderCount: number;
  priceType?: 'market' | 'limit';
  enabled?: boolean;
}

export interface RiskSettings {
  maxPositionSize?: number;
  maxDailyLoss?: number;
  priceDeviationThreshold?: number;
}

export interface ApiSettings {
  bybitApiKey?: string;
  bybitSecret?: string;
  bybitTestnet?: boolean;
}

export interface AccountInfo {
  balance: any;
  positions: any[];
}

export interface SystemStats {
  totalTrades: number;
  successfulTrades: number;
  totalProfit: number;
  todayProfit: number;
}

// 導出默認實例
export default api;
