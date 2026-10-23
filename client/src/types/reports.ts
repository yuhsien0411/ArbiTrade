export interface FundingIncomePoint {
  date: string;
  amount: number;
}

export interface FundingIncomeSeries {
  exchange: string;
  total: number;
  points: FundingIncomePoint[];
}

export interface FundingIncomeResponse {
  startDate: string;
  endDate: string;
  incomeType: string;
  totalAmount: number;
  exchanges: string[];
  series: FundingIncomeSeries[];
}

export type FundingIncomeApiResponse = {
  success: boolean;
  data: FundingIncomeResponse | null;
  error?: string;
};
