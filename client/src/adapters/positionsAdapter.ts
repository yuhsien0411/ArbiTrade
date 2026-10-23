/**
 * 倉位/資金費率/借幣率 相關 API 回傳的統一解析。
 */

/** 從各種形狀的回應中取出資料本體。 */
export function unwrapApiData<T = any>(res: any, fallback: T): T {
  if (res == null) return fallback;
  if (Array.isArray(res)) return res as unknown as T;
  if (res.success === false) return fallback;
  if (res.data !== undefined) return res.data as T;
  return res as T;
}

export interface FundingRateRow {
  exchange: string;
  symbol: string;
  category?: string;
  fundingRate: number;
  fundingRate8h?: number;
  fundingRateDaily?: number;
  nextFundingTime?: number | null;
  predictedFundingRate?: number | null;
  settlementIntervalHours?: number | null;
  timestamp?: number;
}

export function parseFundingRates(res: any): FundingRateRow[] {
  const data = unwrapApiData<any>(res, []);
  if (Array.isArray(data)) return data as FundingRateRow[];
  if (Array.isArray(data?.data)) return data.data as FundingRateRow[];
  return [];
}

export interface BorrowingRateRow {
  exchange: string;
  asset: string;
  interestRateHourly?: number;
  interestRateDaily: number;
  timestamp?: number;
}

export function parseBorrowingRates(res: any): BorrowingRateRow[] {
  const data = unwrapApiData<any>(res, []);
  if (Array.isArray(data)) return data as BorrowingRateRow[];
  if (Array.isArray(data?.data)) return data.data as BorrowingRateRow[];
  return [];
}
