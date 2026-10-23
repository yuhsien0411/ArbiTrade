/**
 * 倉位監控 Redux Slice
 */

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type { 
  PositionsSummary, 
  AccountSummary, 
  ExposureSummary,
  FundingRate 
} from '../../types/positions';

interface PositionsState {
  summary: PositionsSummary | null;
  fundingRates: FundingRate[];
  loading: boolean;
  error: string | null;
  lastUpdate: number | null;
}

const initialState: PositionsState = {
  summary: null,
  fundingRates: [],
  loading: false,
  error: null,
  lastUpdate: null,
};

const positionsSlice = createSlice({
  name: 'positions',
  initialState,
  reducers: {
    setLoading: (state, action: PayloadAction<boolean>) => {
      state.loading = action.payload;
    },
    
    setSummary: (state, action: PayloadAction<PositionsSummary>) => {
      state.summary = action.payload;
      state.lastUpdate = Date.now();
      state.error = null;
    },
    
    updateAccount: (state, action: PayloadAction<AccountSummary>) => {
      if (state.summary) {
        const index = state.summary.accounts.findIndex(
          acc => acc.exchange === action.payload.exchange
        );
        if (index !== -1) {
          state.summary.accounts[index] = action.payload;
        } else {
          state.summary.accounts.push(action.payload);
        }
        state.lastUpdate = Date.now();
      }
    },
    
    updateExposures: (state, action: PayloadAction<ExposureSummary[]>) => {
      if (state.summary) {
        state.summary.exposures = action.payload;
        state.lastUpdate = Date.now();
      }
    },
    
    setFundingRates: (state, action: PayloadAction<FundingRate[]>) => {
      state.fundingRates = action.payload;
      state.lastUpdate = Date.now();
    },
    
    updateFundingRate: (state, action: PayloadAction<FundingRate>) => {
      const index = state.fundingRates.findIndex(
        fr => fr.exchange === action.payload.exchange && 
              fr.symbol === action.payload.symbol
      );
      if (index !== -1) {
        state.fundingRates[index] = action.payload;
      } else {
        state.fundingRates.push(action.payload);
      }
      state.lastUpdate = Date.now();
    },
    
    setError: (state, action: PayloadAction<string>) => {
      state.error = action.payload;
      state.loading = false;
    },
    
    clearError: (state) => {
      state.error = null;
    },
    
    reset: (state) => {
      state.summary = null;
      state.fundingRates = [];
      state.loading = false;
      state.error = null;
      state.lastUpdate = null;
    },
  },
});

export const {
  setLoading,
  setSummary,
  updateAccount,
  updateExposures,
  setFundingRates,
  updateFundingRate,
  setError,
  clearError,
  reset,
} = positionsSlice.actions;

export default positionsSlice.reducer;

// 確保此文件被視為模塊
export {};
