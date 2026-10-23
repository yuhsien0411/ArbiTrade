/**
 * 價格數據狀態管理
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface PriceData {
  symbol: string;
  exchange: string;
  timestamp: number;
  bid1: { price: number; amount: number } | null;
  ask1: { price: number; amount: number } | null;
  spread: number | null;
  spreadPercent: number | null;
}

interface PricesState {
  currentPrices: { [key: string]: PriceData }; // key: exchange_symbol
  priceHistory: { [key: string]: PriceData[] }; // key: exchange_symbol
  subscriptions: string[]; // 訂閱的交易對 (改為數組以支持序列化)
  lastUpdateTime: number;
}

const initialState: PricesState = {
  currentPrices: {},
  priceHistory: {},
  subscriptions: [],
  lastUpdateTime: 0,
};

const pricesSlice = createSlice({
  name: 'prices',
  initialState,
  reducers: {
    updatePrice: (state, action: PayloadAction<PriceData>) => {
      const key = `${action.payload.exchange}_${action.payload.symbol}`;
      state.currentPrices[key] = action.payload;
      
      // 添加到歷史記錄
      if (!state.priceHistory[key]) {
        state.priceHistory[key] = [];
      }
      state.priceHistory[key].push(action.payload);
      
      // 限制歷史記錄數量，保留最近100條
      if (state.priceHistory[key].length > 100) {
        state.priceHistory[key] = state.priceHistory[key].slice(-100);
      }
      
      state.lastUpdateTime = Date.now();
    },
    
    updateMultiplePrices: (state, action: PayloadAction<PriceData[]>) => {
      action.payload.forEach(priceData => {
        const key = `${priceData.exchange}_${priceData.symbol}`;
        state.currentPrices[key] = priceData;
        
        // 添加到歷史記錄
        if (!state.priceHistory[key]) {
          state.priceHistory[key] = [];
        }
        state.priceHistory[key].push(priceData);
        
        // 限制歷史記錄數量
        if (state.priceHistory[key].length > 100) {
          state.priceHistory[key] = state.priceHistory[key].slice(-100);
        }
      });
      
      state.lastUpdateTime = Date.now();
    },
    
    subscribe: (state, action: PayloadAction<string>) => {
      if (!state.subscriptions.includes(action.payload)) {
        state.subscriptions.push(action.payload);
      }
    },
    
    unsubscribe: (state, action: PayloadAction<string>) => {
      const index = state.subscriptions.indexOf(action.payload);
      if (index > -1) {
        state.subscriptions.splice(index, 1);
      }
      
      // 清理相關的價格數據
      const key = action.payload;
      delete state.currentPrices[key];
      delete state.priceHistory[key];
    },
    
    clearPriceHistory: (state, action: PayloadAction<string | undefined>) => {
      if (action.payload) {
        // 清理指定交易對的歷史
        delete state.priceHistory[action.payload];
      } else {
        // 清理所有歷史
        state.priceHistory = {};
      }
    },
    
    // 清空所有價格資料
    clearAllPricesData: (state) => {
      state.currentPrices = {};
      state.priceHistory = {};
      state.subscriptions = [];
      state.lastUpdateTime = 0;
    },
    
    clearAllPrices: (state) => {
      state.currentPrices = {};
      state.priceHistory = {};
      state.subscriptions = [];
    },
  },
});

// 選擇器
export const selectPriceByKey = (state: { prices: PricesState }, key: string) => 
  state.prices.currentPrices[key];

export const selectPriceByExchangeSymbol = (state: { prices: PricesState }, exchange: string, symbol: string) => 
  state.prices.currentPrices[`${exchange}_${symbol}`];

export const selectPriceHistory = (state: { prices: PricesState }, key: string) => 
  state.prices.priceHistory[key] || [];

export const selectAllCurrentPrices = (state: { prices: PricesState }) => 
  state.prices.currentPrices;

export const selectSubscriptions = (state: { prices: PricesState }) => 
  state.prices.subscriptions;

export const {
  updatePrice,
  updateMultiplePrices,
  subscribe,
  unsubscribe,
  clearPriceHistory,
  clearAllPrices,
  clearAllPricesData,
} = pricesSlice.actions;

export default pricesSlice.reducer;
