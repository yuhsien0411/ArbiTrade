/**
 * 套利交易狀態管理
 *
 * 策略：只存記憶體。
 * - 監控對、即時機會、最近執行 = Redux 記憶體。
 * - 歷史成交的永久來源是後端 jsonl（透過 /api/arbitrage/executions 讀取）。
 * - 不再從 localStorage 讀取或寫入任何交易資料。
 */

import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { apiService } from '../../services/api';
import logger from '../../utils/logger';
import type {
  PairConfig,
  ArbitrageOpportunity,
  ArbitrageExecution
} from '../../types/arbitrage';

// 向後兼容的型別別名
/** @deprecated 使用 PairConfig 替代 */
interface ArbitragePair extends PairConfig {
  amount: number;  // 向後兼容，等同於 qty
  // 新增參數（向後兼容）
  totalAmount?: number;
  consumedAmount?: number;
}

interface ArbitrageState {
  monitoringPairs: ArbitragePair[];
  currentOpportunities: ArbitrageOpportunity[];
  recentExecutions: ArbitrageExecution[];
  isAutoExecuteEnabled: boolean;
  executionHistory: ArbitrageExecution[];
}

const MAX_RECENT_PAIR_IDS = 20;

function getExecutionPairId(exec: any): string | null {
  if (!exec || typeof exec !== 'object') return null;
  const rawId = exec.pairId || exec.opportunity?.id || exec.opportunity?.pairConfig?.id || exec.id;
  if (!rawId) return null;
  return String(rawId);
}

function keepRecentExecutionsByPairIds(executions: any[], maxPairIds: number = MAX_RECENT_PAIR_IDS): any[] {
  if (!Array.isArray(executions) || executions.length === 0) return [];

  const selectedPairIds = new Set<string>();
  const filtered: any[] = [];

  for (const exec of executions) {
    if (!exec || typeof exec !== 'object') continue;

    const pairId = getExecutionPairId(exec);
    if (!pairId) {
      if (selectedPairIds.size < maxPairIds) {
        filtered.push(exec);
      }
      continue;
    }

    if (selectedPairIds.has(pairId)) {
      filtered.push(exec);
      continue;
    }

    if (selectedPairIds.size < maxPairIds) {
      selectedPairIds.add(pairId);
      filtered.push(exec);
    }
  }

  return filtered;
}

const initialState: ArbitrageState = {
  monitoringPairs: [],
  currentOpportunities: [],
  recentExecutions: [],
  isAutoExecuteEnabled: false,
  executionHistory: [],
};

function getValidExecutionCount(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

export const addWatchPairThunk = createAsyncThunk(
  'arbitrage/addWatchPair',
  async (payload: any, { rejectWithValue }) => {
    try {
      logger.info('開始添加監控交易對', payload, 'Redux');
      const res = await apiService.addWatchPair(payload);
      logger.info('添加監控交易對響應', res, 'Redux');
      if ((res as any)?.success === false) {
        return rejectWithValue((res as any)?.error || '添加失敗');
      }
      return (res as any).data || res;
    } catch (e: any) {
      logger.error('添加監控交易對失敗', e, 'Redux');
      return rejectWithValue(e.message || '添加失敗');
    }
  }
);

const arbitrageSlice = createSlice({
  name: 'arbitrage',
  initialState,
  reducers: {
    addMonitoringPair: (state, action: PayloadAction<ArbitragePair>) => {
      const existingIndex = state.monitoringPairs.findIndex(p => p.id === action.payload.id);
      if (existingIndex >= 0) {
        state.monitoringPairs[existingIndex] = action.payload;
      } else {
        state.monitoringPairs.push(action.payload);
      }
    },

    updateMonitoringPair: (state, action: PayloadAction<{ id: string; updates: Partial<ArbitragePair> }>) => {
      const { id, updates } = action.payload;
      const index = state.monitoringPairs.findIndex(p => p.id === id);
      if (index >= 0) {
        state.monitoringPairs[index] = { ...state.monitoringPairs[index], ...updates };
      }
    },

    removeMonitoringPair: (state, action: PayloadAction<string>) => {
      state.monitoringPairs = state.monitoringPairs.filter(p => p.id !== action.payload);
      state.currentOpportunities = state.currentOpportunities.filter(o => o.id !== action.payload);
    },

    setMonitoringPairs: (state, action: PayloadAction<ArbitragePair[]>) => {
      state.monitoringPairs = Array.isArray(action.payload) ? action.payload : [];
    },

    updateOpportunity: (state, action: PayloadAction<ArbitrageOpportunity>) => {
      const existingIndex = state.currentOpportunities.findIndex(o => o.id === action.payload.id);
      if (existingIndex >= 0) {
        state.currentOpportunities[existingIndex] = action.payload;
      } else {
        state.currentOpportunities.push(action.payload);
      }
    },

    setOpportunities: (state, action: PayloadAction<ArbitrageOpportunity[]>) => {
      state.currentOpportunities = action.payload;
    },

    // 覆蓋最近執行記錄（用於手動刷新避免重複累加）
    setRecentExecutions: (state, action: PayloadAction<ArbitrageExecution[]>) => {
      const list = Array.isArray(action.payload) ? action.payload : [];
      state.recentExecutions = keepRecentExecutionsByPairIds(list as any[]) as ArbitrageExecution[];
    },

    addExecution: (state, action: PayloadAction<ArbitrageExecution>) => {
      state.recentExecutions.unshift(action.payload);
      state.recentExecutions = keepRecentExecutionsByPairIds(state.recentExecutions as any[]) as ArbitrageExecution[];

      // 更新對應交易對的觸發統計
      const pairId = action.payload.opportunity.id;
      const pairIndex = state.monitoringPairs.findIndex(p => p.id === pairId);
      if (pairIndex >= 0 && state.monitoringPairs[pairIndex]) {
        state.monitoringPairs[pairIndex].lastTriggered = action.payload.timestamp;
        if (action.payload.success) {
          const current = state.monitoringPairs[pairIndex].totalTriggers || 0;
          const pushedCount = getValidExecutionCount(action.payload.totalTriggers);
          state.monitoringPairs[pairIndex].totalTriggers = pushedCount !== null
            ? (pushedCount > current ? pushedCount : current + 1)
            : current + 1;
        }
      }
    },

    updatePairTriggerStats: (state, action: PayloadAction<{pairId: string, totalTriggers: number, lastTriggered: number | null}>) => {
      const pairIndex = state.monitoringPairs.findIndex(p => p.id === action.payload.pairId);
      if (pairIndex >= 0) {
        const current = state.monitoringPairs[pairIndex].totalTriggers || 0;
        const incoming = getValidExecutionCount(action.payload.totalTriggers);
        state.monitoringPairs[pairIndex].totalTriggers = incoming !== null
          ? Math.max(current, incoming)
          : current;
        state.monitoringPairs[pairIndex].lastTriggered = action.payload.lastTriggered;
      }
    },

    setAutoExecute: (state, action: PayloadAction<boolean>) => {
      state.isAutoExecuteEnabled = action.payload;
    },

    clearExecutionHistory: (state) => {
      state.executionHistory = [];
      state.recentExecutions = [];
    },

    clearAllArbitrageData: (state) => {
      state.monitoringPairs = [];
      state.currentOpportunities = [];
      state.recentExecutions = [];
      state.executionHistory = [];
      state.isAutoExecuteEnabled = false;
    },

    // 批量更新價格數據
    updatePricesForOpportunities: (state, action: PayloadAction<Array<{ id: string; leg1Price?: any; leg2Price?: any; spread: number; spreadPercent: number }>>) => {
      action.payload.forEach(update => {
        const index = state.currentOpportunities.findIndex(o => o.id === update.id);
        if (index >= 0) {
          if (update.leg1Price) {
            state.currentOpportunities[index].leg1Price = update.leg1Price;
          }
          if (update.leg2Price) {
            state.currentOpportunities[index].leg2Price = update.leg2Price;
          }
          state.currentOpportunities[index].spread = update.spread;
          state.currentOpportunities[index].spreadPercent = update.spreadPercent;
          state.currentOpportunities[index].timestamp = Date.now();
        }
      });
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(addWatchPairThunk.fulfilled, (state, action: PayloadAction<any>) => {
        logger.info('監控交易對添加成功', action.payload, 'Redux');
        if (action.payload) {
          const pair = action.payload;
          const existingIndex = state.monitoringPairs.findIndex(p => p.id === pair.id);
          if (existingIndex >= 0) {
            state.monitoringPairs[existingIndex] = pair;
            logger.info('更新現有監控交易對', pair.id, 'Redux');
          } else {
            state.monitoringPairs.push(pair);
            logger.info('新增監控交易對', pair.id, 'Redux');
          }
        }
      });
  }
});

export const {
  addMonitoringPair,
  updateMonitoringPair,
  removeMonitoringPair,
  setMonitoringPairs,
  updateOpportunity,
  setOpportunities,
  setRecentExecutions,
  addExecution,
  setAutoExecute,
  clearExecutionHistory,
  clearAllArbitrageData,
  updatePricesForOpportunities,
  updatePairTriggerStats,
} = arbitrageSlice.actions;

export default arbitrageSlice.reducer;
