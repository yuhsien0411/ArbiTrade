/**
 * 報告頁面 Redux Slice
 * 管理績效報告數據和狀態
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// 報告總覽數據
export interface ReportSummary {
  totalPnl: number;           // 總盈虧 (USDT)
  winRate: number;            // 勝率 (%)
  totalVolume: number;        // 總成交量
  completedStrategies: number; // 完成策略數
  successCount: number;       // 成功次數
  failedCount: number;        // 失敗次數
}

// 套利報告記錄
export interface ArbitrageReportRecord {
  strategyId: string;
  lastTime: number;
  leg1Symbol: string;
  leg1Exchange: string;
  leg1Type: string;
  leg1Side: string;
  leg2Symbol: string;
  leg2Exchange: string;
  leg2Type: string;
  leg2Side: string;
  avgSpreadPercent: number;   // 平均價差%
  successCount: number;       // 成功次數
  maxExecs: number;           // 目標次數
  totalVolume: number;        // 總成交量
  estimatedPnl: number;       // 估算盈虧 (USDT)
  status: string;             // 完成/進行中/失敗
}

// TWAP 報告記錄
export interface TwapReportRecord {
  strategyId: string;
  lastTime: number;
  leg1Symbol: string;
  leg1Exchange: string;
  leg1Type: string;
  leg1Side: string;
  leg2Symbol: string;
  leg2Exchange: string;
  leg2Type: string;
  leg2Side: string;
  executedCount: number;      // 已執行次數
  targetCount: number;        // 目標次數
  sliceQty: number;           // 單次數量
  totalVolume: number;        // 總數量
  avgInterval: number;        // 平均間隔(秒)
  status: string;             // 完成/暫停/取消/失敗
  estimatedPnl: number;       // 估算盈虧
}

// 淨值統計數據
export interface NetValueStats {
  current: number;            // 當前淨值
  change24h: number;          // 24小時變化
  change24hPercent: number;   // 24小時變化百分比
  change7d: number;           // 7天變化
  change7dPercent: number;    // 7天變化百分比
  highest: number;            // 期間最高
  lowest: number;             // 期間最低
  records: Array<{
    ts: number;
    datetime: string;
    totalUSDT: number;
    balances: Record<string, Record<string, number>>;
  }>;
}

// 報告狀態
interface ReportState {
  summary: ReportSummary | null;
  arbitrageRecords: ArbitrageReportRecord[];
  twapRecords: TwapReportRecord[];
  netValueStats: NetValueStats | null;  // 淨值統計
  loading: boolean;
  error: string | null;
  
  // 篩選條件
  filters: {
    dateRange: [string, string] | null;  // [from, to]
    type: 'all' | 'arbitrage' | 'twap';
    symbol: string | null;
    exchange: string | null;
    status: string | null;
  };
}

const initialState: ReportState = {
  summary: null,
  arbitrageRecords: [],
  twapRecords: [],
  netValueStats: null,
  loading: false,
  error: null,
  filters: {
    dateRange: null,
    type: 'all',
    symbol: null,
    exchange: null,
    status: null
  }
};

const reportSlice = createSlice({
  name: 'report',
  initialState,
  reducers: {
    // 設置載入狀態
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
      if (action.payload) {
        state.error = null;
      }
    },
    
    // 設置錯誤
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      state.loading = false;
    },
    
    // 設置總覽數據
    setSummary: (state, action: PayloadAction<ReportSummary>) => {
      state.summary = action.payload;
    },
    
    // 設置套利報告記錄
    setArbitrageRecords: (state, action: PayloadAction<ArbitrageReportRecord[]>) => {
      state.arbitrageRecords = action.payload;
    },
    
    // 設置 TWAP 報告記錄
    setTwapRecords: (state, action: PayloadAction<TwapReportRecord[]>) => {
      state.twapRecords = action.payload;
    },
    
    // 設置淨值統計
    setNetValueStats: (state, action: PayloadAction<NetValueStats>) => {
      state.netValueStats = action.payload;
    },
    
    // 更新篩選條件
    updateFilters: (state, action: PayloadAction<Partial<ReportState['filters']>>) => {
      state.filters = {
        ...state.filters,
        ...action.payload
      };
    },
    
    // 重置篩選條件
    resetFilters: (state) => {
      state.filters = initialState.filters;
    },
    
    // 清空所有報告數據
    clearReports: (state) => {
      state.summary = null;
      state.arbitrageRecords = [];
      state.twapRecords = [];
      state.netValueStats = null;
      state.error = null;
    }
  }
});

export const {
  setLoading,
  setError,
  setSummary,
  setArbitrageRecords,
  setTwapRecords,
  setNetValueStats,
  updateFilters,
  resetFilters,
  clearReports
} = reportSlice.actions;

export default reportSlice.reducer;

