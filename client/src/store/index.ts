/**
 * Redux Store 配置
 * 管理應用程式狀態
 */

import { configureStore } from '@reduxjs/toolkit';
import systemReducer from './slices/systemSlice';
import arbitrageReducer from './slices/arbitrageSlice';
import twapReducer from './slices/twapSlice';
import pricesReducer from './slices/pricesSlice';
import exchangesReducer from './slices/exchangesSlice';
import positionsReducer from './slices/positionsSlice';
import reportReducer from './slices/reportSlice';

export const store = configureStore({
  reducer: {
    system: systemReducer,
    arbitrage: arbitrageReducer,
    twap: twapReducer,
    prices: pricesReducer,
    exchanges: exchangesReducer,
    positions: positionsReducer,
    report: reportReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ['persist/PERSIST', 'persist/REHYDRATE'],
        // 忽略價格狀態中的訂閱列表
        ignoredPaths: ['prices.subscriptions'],
      },
    }),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
