/**
 * 倉位監控相關型別定義
 */

export type PositionType = 
  | 'spot_cash'          // 現貨現金
  | 'spot_margin'        // 槓桿現貨
  | 'perp_linear'        // USDT 永續合約
  | 'perp_inverse'       // 幣本位永續合約
  | 'futures_linear'     // USDT 交割合約
  | 'futures_inverse';   // 幣本位交割合約

export type HedgeStatus = 
  | 'fully_hedged'       // 完全對沖（≥95%）
  | 'partially_hedged'   // 部分對沖（60%~95%）
  | 'unhedged'           // 未對沖（<60%）
  | 'over_hedged';       // 過度對沖（反向淨敞口）

export type RiskLevel = 'low' | 'medium' | 'high';

export interface Balance {
  asset: string;                     // 資產符號（如 BTC、USDT）
  total: number;                     // 總餘額（淨值）= 餘額 + 負債 + 鎖定（對於統一帳戶，total = free + borrowed + locked）
  free: number;                      // 可用餘額（對於統一帳戶，這是餘額，已減去借幣）
  locked: number;                    // 凍結餘額
  borrowed: number;                  // 借幣數量（槓桿現貨，負債）
  interest: number;                  // 累計利息
  interestRateDaily: number;         // 日化借幣利率（%）
  usdtValue: number;                 // USDT 計價價值
  netBalance: number;                // 持倉餘額；MEXC 現貨包含掛單鎖定量（free + locked）
}

export interface Position {
  symbol: string;                    // 交易對符號（如 BTCUSDT）
  baseAsset: string;                 // 基礎資產（如 BTC）
  quoteAsset: string;                // 計價資產（如 USDT）
  type: PositionType;                // 持倉類型
  side: 'long' | 'short';            // 方向
  sizeBase: number;                  // 持倉數量（基礎資產單位，正=多、負=空）
  entryPrice: number;                // 開倉均價
  markPrice: number;                 // 標記價格
  liquidationPrice?: number;         // 強平價格
  leverage: number;                  // 槓桿倍數
  marginMode: 'cross' | 'isolated';  // 保證金模式（統一帳戶固定 cross）
  marginUSDT: number;                // 佔用保證金
  notionalUSDT: number;              // 名義價值 = |sizeBase| × markPrice
  unrealizedPnlUSDT: number;         // 未實現盈虧
  realizedPnlUSDT: number;           // 已實現盈虧
  realizedPnlDetails?: Record<string, number>; // 已實現盈虧拆解
  fundingRate8h?: number;            // 8 小時資金費率（合約）
  nextFundingTime?: number;          // 下次結算時間（合約）
  estimatedCarry8h: number;          // 8 小時持有成本/收益（正=收入、負=支出）
}

export interface PositionExposure {
  exchange: string;
  type: PositionType;
  side: 'long' | 'short';
  sizeBase: number;
  notionalUSDT: number;
  carry8h: number;
  fundingRate8h?: number;
  interestRateDaily?: number;
}

export interface ExposureSummary {
  baseAsset: string;                 // 基礎資產（如 BTC）
  positions: PositionExposure[];     // 各交易所/類型的持倉
  longBase: number;                  // 多頭總敞口（base 單位）
  shortBase: number;                 // 空頭總敞口（base 單位，正數）
  netBase: number;                   // 淨敞口 = longBase - shortBase
  longNotionalUSDT: number;          // 多頭名義價值
  shortNotionalUSDT: number;         // 空頭名義價值
  netNotionalUSDT: number;           // 淨名義價值
  hedgeRatio: number;                // 對沖比率（0~1）
  hedgeStatus: HedgeStatus;          // 對沖狀態
  netCarry8h: number;                // 淨持有成本/收益（8h）
  netCarryDaily: number;             // 淨持有成本/收益（日）
  riskLevel: RiskLevel;              // 風險等級
  suggestions: string[];             // 對沖建議
}

export interface AccountSummary {
  exchange: 'bybit' | 'binance' | 'bitget' | 'okx' | 'aster' | 'mexc';
  accountMode: 'unified' | 'portfolio' | 'classic' | 'unsupported';
  timestamp: number;
  totalEquityUSDT: number;           // 總權益（USDT 計價）
  totalMarginUSDT: number;           // 已用保證金
  availableBalanceUSDT: number;      // 可用餘額
  marginRatio: number;               // 初始保證金率（0~1）
  maintenanceMarginRate: number;     // 維持保證金率（0~1）
  totalInitialMargin: number;        // 總初始保證金
  totalMaintenanceMargin: number;    // 總維持保證金
  balances: Balance[];
  positions: Position[];
  unsupportedReason?: string;        // 若 accountMode=unsupported，說明原因
}

export interface FundingRate {
  exchange: string;
  symbol: string;
  category: 'linear' | 'inverse';
  fundingRate: number;
  fundingRate8h: number;
  fundingRateDaily: number;
  nextFundingTime: number;
  predictedFundingRate?: number;
  settlementIntervalHours?: number; // 結算週期（小時），例如 8 表示每 8 小時結算一次
  timestamp: number;
}

export interface PositionsSummary {
  timestamp: number;
  accounts: AccountSummary[];
  exposures: ExposureSummary[];
  unsupportedExchanges: string[];
}

export interface HedgeAnalysis {
  timestamp: number;
  analyses: ExposureSummary[];
  summary: {
    totalExposuresUSDT: number;
    totalNetExposureUSDT: number;
    totalNetCarry8h: number;
    overallRiskLevel: RiskLevel;
    fullyHedgedAssets: number;
    partiallyHedgedAssets: number;
    unhedgedAssets: number;
  };
}

// 確保此文件被視為模塊
export {};
