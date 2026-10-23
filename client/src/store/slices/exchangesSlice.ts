import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { apiService, ExchangeInfo } from '../../services/api';
import type { ApiResponse } from '../../types/arbitrage';
import logger from '../../utils/logger';

export interface ExchangesState {
  status: Record<string, { implemented: boolean; connected: boolean; status?: string } & Partial<ExchangeInfo>>;
  symbols: Record<string, string[]>;
  loading: boolean;
  error?: string;
}

const initialState: ExchangesState = {
  status: {},
  symbols: {},
  loading: false,
  error: undefined,
};

export const fetchExchangeStatus = createAsyncThunk('exchanges/fetchStatus', async () => {
  logger.info('開始獲取交易所狀態...', null, 'Redux');
  const res = await apiService.getExchangeStatus();
  logger.info('交易所狀態響應', res, 'Redux');
  if (!res.success) throw new Error(res.error || '獲取交易所狀態失敗');
  return res.data as Record<string, ExchangeInfo>;
});

export const fetchSymbols = createAsyncThunk('exchanges/fetchSymbols', async (exchange: string) => {
  logger.info(`開始獲取 ${exchange} 交易對...`, null, 'Redux');
  const res: ApiResponse<string[]> = await apiService.getSymbols(exchange);
  logger.info(`${exchange} 交易對響應`, res, 'Redux');
  if (!res.success) throw new Error(res.error || '獲取交易對失敗');
  return { exchange, symbols: res.data || [] };
});

const exchangesSlice = createSlice({
  name: 'exchanges',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchExchangeStatus.pending, (state) => {
        logger.info('交易所狀態請求中...', null, 'Redux');
        state.loading = true;
        state.error = undefined;
      })
      .addCase(fetchExchangeStatus.fulfilled, (state, action: PayloadAction<Record<string, ExchangeInfo>>) => {
        logger.info('交易所狀態獲取成功', action.payload, 'Redux');
        state.loading = false;
        const data = action.payload || {};
        const next: ExchangesState['status'] = {};
        Object.entries(data).forEach(([key, info]) => {
          // 避免重複鍵（TS2783）：先排除後再標準化
          const { implemented, connected, status, ...rest } = (info || {}) as ExchangeInfo & Record<string, any>;
          next[key] = {
            ...rest,
            implemented: !!implemented,
            connected: !!connected,
            status,
          };
        });
        state.status = next;
      })
      .addCase(fetchExchangeStatus.rejected, (state, action) => {
        logger.error('交易所狀態獲取失敗', action.error, 'Redux');
        state.loading = false;
        state.error = action.error.message;
      })
      .addCase(fetchSymbols.pending, (state) => {
        logger.info('交易對請求中...', null, 'Redux');
        state.loading = true;
        state.error = undefined;
      })
      .addCase(fetchSymbols.fulfilled, (state, action: PayloadAction<{ exchange: string; symbols: string[] }>) => {
        logger.info(`${action.payload.exchange} 交易對獲取成功`, action.payload.symbols, 'Redux');
        state.loading = false;
        const { exchange, symbols } = action.payload;
        state.symbols[exchange] = symbols;
      })
      .addCase(fetchSymbols.rejected, (state, action) => {
        logger.error('交易對獲取失敗', action.error, 'Redux');
        state.loading = false;
        state.error = action.error.message;
      });
  },
});

export default exchangesSlice.reducer;
