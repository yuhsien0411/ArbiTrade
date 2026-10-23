/**
 * TWAP策略狀態管理
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface TwapStrategy {
  id: string;
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
  amountPerOrder: number;
  priceType: 'market' | 'limit';
  enabled: boolean;
  createdAt: number;
  executedOrders: number;
  remainingAmount: number;
  nextExecutionTime: number;
  status: 'pending' | 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
  progress?: {
    planId: string;
    executed: number;
    remaining: number;
    slicesDone: number;
    slicesTotal: number;
    state: string;
    lastExecutionTs?: number;
    nextExecutionTs?: number;
  } | null;
}

interface TwapExecution {
  strategyId: string;
  leg1OrderId?: string;
  leg2OrderId?: string;
  amount: number;
  leg1Price?: number;
  leg2Price?: number;
  timestamp: number;
  success: boolean;
  error?: string;
  // ✅ V3 新增欄位
  totalAmount?: number;
  orderCount?: number;
  sliceQty?: number;
  intervalMs?: number;
  status?: string;
  spread?: number;
  spreadPercent?: number;
  leg1?: any;
  leg2?: any;
  isRollback?: boolean;
  originalSliceIndex?: number;
}

interface TwapState {
  strategies: TwapStrategy[];
  executions: TwapExecution[];
  isAutoExecuteEnabled: boolean;
}

const initialState: TwapState = {
  strategies: [],
  executions: [],
  isAutoExecuteEnabled: true,
};

const twapSlice = createSlice({
  name: 'twap',
  initialState,
  reducers: {
    addStrategy: (state, action: PayloadAction<TwapStrategy>) => {
      const existingIndex = state.strategies.findIndex(s => s.id === action.payload.id);
      if (existingIndex >= 0) {
        state.strategies[existingIndex] = action.payload;
      } else {
        state.strategies.push(action.payload);
      }
    },
    
    updateStrategy: (state, action: PayloadAction<{ id: string; updates: Partial<TwapStrategy> }>) => {
      const { id, updates } = action.payload;
      const index = state.strategies.findIndex(s => s.id === id);
      if (index >= 0) {
        state.strategies[index] = { ...state.strategies[index], ...updates };
      }
    },
    
    removeStrategy: (state, action: PayloadAction<string>) => {
      state.strategies = state.strategies.filter(s => s.id !== action.payload);
      // 同時移除相關的執行記錄
      state.executions = state.executions.filter(e => e.strategyId !== action.payload);
    },
    
    setStrategies: (state, action: PayloadAction<TwapStrategy[]>) => {
      state.strategies = action.payload;
    },
    
    addExecution: (state, action: PayloadAction<TwapExecution>) => {
      state.executions.unshift(action.payload);
      
      // 限制執行記錄數量
      if (state.executions.length > 1000) {
        state.executions = state.executions.slice(0, 1000);
      }
      
      // 更新對應策略的執行狀態
      const strategyIndex = state.strategies.findIndex(s => s.id === action.payload.strategyId);
      if (strategyIndex >= 0 && action.payload.success) {
        const strategy = state.strategies[strategyIndex];
        strategy.executedOrders += 1;
        strategy.remainingAmount = Math.max(0, strategy.remainingAmount - action.payload.amount);
        strategy.nextExecutionTime = Date.now() + strategy.timeInterval;
        
        // 檢查是否完成（每次執行包含兩個腿）
        const completedExecutions = Math.floor(strategy.executedOrders / 2);
        if (completedExecutions >= strategy.orderCount) {
          strategy.status = 'completed';
          strategy.remainingAmount = 0; // 確保完成時剩餘數量為 0
        } else if (strategy.remainingAmount <= 0) {
          strategy.remainingAmount = 0; // 確保不會出現負數
        }
      }
    },
    
    pauseStrategy: (state, action: PayloadAction<string>) => {
      const index = state.strategies.findIndex(s => s.id === action.payload);
      if (index >= 0) {
        state.strategies[index].status = 'paused';
        state.strategies[index].enabled = false;
      }
    },
    
    resumeStrategy: (state, action: PayloadAction<string>) => {
      const index = state.strategies.findIndex(s => s.id === action.payload);
      if (index >= 0 && state.strategies[index].status === 'paused') {
        state.strategies[index].status = 'active';
        state.strategies[index].enabled = true;
        state.strategies[index].nextExecutionTime = Date.now() + state.strategies[index].timeInterval;
      }
    },
    
    cancelStrategy: (state, action: PayloadAction<string>) => {
      const index = state.strategies.findIndex(s => s.id === action.payload);
      if (index >= 0) {
        state.strategies[index].status = 'cancelled';
        state.strategies[index].enabled = false;
      }
    },
    
    setAutoExecute: (state, action: PayloadAction<boolean>) => {
      state.isAutoExecuteEnabled = action.payload;
    },
    
    clearExecutions: (state) => {
      state.executions = [];
    },
    
    // 設置執行記錄（用於批量更新）
    setExecutions: (state, action: PayloadAction<TwapExecution[]>) => {
      state.executions = Array.isArray(action.payload) ? action.payload : [];
    },
    
    // 清空所有 TWAP 資料
    clearAllTwapData: (state) => {
      state.strategies = [];
      state.executions = [];
      state.isAutoExecuteEnabled = false;
    },
    
    // 批量更新策略執行時間
    updateExecutionTimes: (state, action: PayloadAction<Array<{ id: string; nextExecutionTime: number }>>) => {
      action.payload.forEach(update => {
        const index = state.strategies.findIndex(s => s.id === update.id);
        if (index >= 0) {
          state.strategies[index].nextExecutionTime = update.nextExecutionTime;
        }
      });
    },
  },
});

export const {
  addStrategy,
  updateStrategy,
  removeStrategy,
  setStrategies,
  addExecution,
  setExecutions,
  pauseStrategy,
  resumeStrategy,
  cancelStrategy,
  setAutoExecute,
  clearExecutions,
  clearAllTwapData,
  updateExecutionTimes,
} = twapSlice.actions;

export default twapSlice.reducer;
