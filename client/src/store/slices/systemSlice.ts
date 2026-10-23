/**
 * 系統狀態管理
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface SystemState {
  isConnected: boolean;
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'error';
  engineStatus: {
    isRunning: boolean;
    stats: {
      totalTrades: number;
      successfulTrades: number;
      totalProfit: number;
      todayProfit: number;
    };
    riskLimits: {
      maxPositionSize: number;
      maxDailyLoss: number;
      priceDeviationThreshold: number;
    };
  };
  exchanges: {
    [key: string]: {
      name: string;
      connected: boolean;
      status?: 'active' | 'ready' | 'planned' | 'unknown';
      implemented?: boolean;
      message?: string;
      features?: string[];
      priority?: number;
      symbols?: {
        spot: string[];
        linear: string[];
        inverse: string[];
      };
    };
  };
  notifications: Array<{
    id: string;
    type: 'success' | 'warning' | 'error' | 'info';
    message: string;
    timestamp: number;
  }>;
}

const initialState: SystemState = {
  isConnected: false,
  connectionStatus: 'disconnected',
  engineStatus: {
    isRunning: false,
    stats: {
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      todayProfit: 0,
    },
    riskLimits: {
      maxPositionSize: 10000,
      maxDailyLoss: 1000,
      priceDeviationThreshold: 0.05,
    },
  },
  exchanges: {},
  notifications: [],
};

const systemSlice = createSlice({
  name: 'system',
  initialState,
  reducers: {
    setConnectionStatus: (state, action: PayloadAction<SystemState['connectionStatus']>) => {
      state.connectionStatus = action.payload;
      state.isConnected = action.payload === 'connected';
    },
    
    updateEngineStatus: (state, action: PayloadAction<Partial<SystemState['engineStatus']>>) => {
      state.engineStatus = { ...state.engineStatus, ...action.payload };
    },
    
    updateExchanges: (state, action: PayloadAction<SystemState['exchanges']>) => {
      state.exchanges = action.payload;
    },
    
    addNotification: (state, action: PayloadAction<Omit<SystemState['notifications'][0], 'id' | 'timestamp'>>) => {
      const notification = {
        ...action.payload,
        id: `notification_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
      };
      state.notifications.unshift(notification);
      
      // 限制通知數量，保留最新的50條
      if (state.notifications.length > 50) {
        state.notifications = state.notifications.slice(0, 50);
      }
    },
    
    removeNotification: (state, action: PayloadAction<string>) => {
      state.notifications = state.notifications.filter(n => n.id !== action.payload);
    },
    
    clearNotifications: (state) => {
      state.notifications = [];
    },
    
    updateRiskLimits: (state, action: PayloadAction<Partial<SystemState['engineStatus']['riskLimits']>>) => {
      state.engineStatus.riskLimits = { ...state.engineStatus.riskLimits, ...action.payload };
    },
    
    // 清空所有系統資料
    clearAllSystemData: (state) => {
      state.isConnected = false;
      state.connectionStatus = 'disconnected';
      state.engineStatus = {
        isRunning: false,
        stats: {
          totalTrades: 0,
          successfulTrades: 0,
          totalProfit: 0,
          todayProfit: 0,
        },
        riskLimits: {
          maxPositionSize: 1000,
          maxDailyLoss: 100,
          priceDeviationThreshold: 0.01,
        },
      };
      state.exchanges = {};
      state.notifications = [];
    },
  },
});

export const {
  setConnectionStatus,
  updateEngineStatus,
  updateExchanges,
  addNotification,
  removeNotification,
  clearNotifications,
  updateRiskLimits,
  clearAllSystemData,
} = systemSlice.actions;

export default systemSlice.reducer;
