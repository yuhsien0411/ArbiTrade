/**
 * 套利交易統一型別定義
 * 與後端 Pydantic 模型保持一致
 */

// 基礎型別
export type ExchangeName = "bybit" | "binance" | "okx" | "bitget" | "aster" | "mexc";
export type TradeType = "spot" | "linear" | "inverse";
export type TradeSide = "buy" | "sell";
export type ExecutionStatus = "success" | "failed" | "cancelled" | "rolling_back" | "rolled_back";

// 交易腿
export interface Leg {
  exchange: ExchangeName;
  symbol: string;
  type: TradeType;
  side: TradeSide;
}

// 監控對配置
export interface PairConfig {
  id: string;
  leg1: Leg;
  leg2: Leg;
  threshold: number;          // 觸發閾值（%），可為負數
  qty: number;               // 每次下單數量
  maxExecs: number;          // 最大執行次數
  enabled: boolean;          // 是否啟用
  createdAt: number;         // 建立時間戳（毫秒）
  totalTriggers?: number;    // 已觸發次數
  lastTriggered?: number | null; // 最後觸發時間
}

// 執行腿結果
export interface ExecutionLeg {
  exchange: string;
  symbol: string;
  type: string;
  side: string;
  orderId: string | null;    // 訂單ID，失敗時為null
}

// 執行記錄
export interface ExecutionRecord {
  ts: number;                // 執行時間戳（毫秒）
  pairId: string;           // 對應的監控對ID
  qty: number;              // 執行數量
  status: ExecutionStatus;   // 執行狀態
  maxExecs: number;         // 該配置的最大執行次數
  totalTriggers: number;    // 執行後的總觸發次數
  leg1: ExecutionLeg;       // 第一腿執行結果
  leg2: ExecutionLeg;       // 第二腿執行結果
  
  // 向後兼容欄位
  success?: boolean;        // 執行是否成功
  reason?: string;          // 失敗原因
  error?: string;           // 錯誤訊息
}

// API 請求型別
export interface CreatePairRequest {
  pairId?: string;          // 可選的自定義ID
  leg1: Leg;
  leg2: Leg;
  threshold: number;
  qty: number;
  maxExecs?: number;        // 預設為1
  enabled?: boolean;        // 預設為true
}

export interface UpdatePairRequest {
  enabled?: boolean;
  threshold?: number;
  qty?: number;
  maxExecs?: number;
}

export interface EngineControlRequest {
  action: "start" | "stop";
}

// 價格資料
export interface PriceData {
  symbol: string;
  exchange: string;
  bid1: { price: number; amount?: number } | null;
  ask1: { price: number; amount?: number } | null;
}

// 價格更新訊息
export interface PriceUpdate {
  id: string;
  pairConfig: PairConfig;
  leg1Price: PriceData;
  leg2Price: PriceData;
  spread: number;
  spreadPercent: number;
  threshold: number;
  timestamp: number;
  refreshed?: boolean;      // 是否為手動刷新
}

// 套利機會
export interface ArbitrageOpportunity {
  id: string;
  pairConfig: PairConfig;
  leg1Price: PriceData;
  leg2Price: PriceData;
  spread: number;
  spreadPercent: number;
  threshold: number;
  shouldTrigger: boolean;
  timestamp: number;
  direction: 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy';
  status?: ExecutionStatus;
}

// 執行結果
export interface ArbitrageExecution {
  opportunity: ArbitrageOpportunity;
  amount?: number;
  result?: {
    leg1OrderId: string;
    leg2OrderId: string;
  };
  success: boolean;
  timestamp: number;
  maxExecs?: number;
  totalTriggers?: number;
  completed?: boolean;
}

// API 回應格式
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// WebSocket 訊息格式
export interface WebSocketMessage<T = any> {
  type: string;
  data: T;
  timestamp?: number;
}

// 執行歷史回應
export interface ExecutionHistoryResponse {
  data: Record<string, ExecutionRecord[]>;
  recent: ExecutionRecord[];
}

// 引擎狀態
export interface EngineStatus {
  running: boolean;
  pairs: string[];
  intervalSec: number;
}

// 統計資料
export interface PairStats {
  totalTriggers: number;
  lastTriggered: number | null;
}

// 向後兼容型別（逐步移除）
/** @deprecated 使用 PairConfig 替代 */
export interface ArbitragePair extends PairConfig {
  amount: number;           // 向後兼容，等同於 qty
}

/** @deprecated 使用 CreatePairRequest 替代 */
export interface MonitoringPairConfig extends CreatePairRequest {
  id?: string;
  amount?: number;          // 向後兼容
  executionMode?: 'market' | 'threshold'; // 向後兼容
  totalAmount?: number;     // 向後兼容
}

// 型別守衛
export function isPairConfig(obj: any): obj is PairConfig {
  return obj && 
         typeof obj === 'object' &&
         typeof obj.id === 'string' &&
         obj.leg1 && typeof obj.leg1 === 'object' &&
         obj.leg2 && typeof obj.leg2 === 'object' &&
         typeof obj.threshold === 'number' &&
         typeof obj.qty === 'number' &&
         typeof obj.maxExecs === 'number' &&
         typeof obj.enabled === 'boolean';
}

export function isExecutionRecord(obj: any): obj is ExecutionRecord {
  return obj &&
         typeof obj === 'object' &&
         typeof obj.ts === 'number' &&
         typeof obj.pairId === 'string' &&
         typeof obj.qty === 'number' &&
         typeof obj.status === 'string' &&
         obj.leg1 && typeof obj.leg1 === 'object' &&
         obj.leg2 && typeof obj.leg2 === 'object';
}

// 工具函數
export function calculateTotalAmount(qty: number, maxExecs: number): number {
  return qty * maxExecs;
}

export function isCompleted(totalTriggers: number, maxExecs: number): boolean {
  return totalTriggers >= maxExecs;
}

export function getProgressPercentage(totalTriggers: number, maxExecs: number): number {
  return Math.min((totalTriggers / maxExecs) * 100, 100);
}

// 常數
export const DEFAULT_THRESHOLD = 0.1;
export const DEFAULT_QTY = 0.001;
export const DEFAULT_MAX_EXECS = 1;

export const SUPPORTED_EXCHANGES: ExchangeName[] = ["bybit", "binance", "okx", "bitget", "aster", "mexc"];
export const SUPPORTED_TRADE_TYPES: TradeType[] = ["spot", "linear", "inverse"];
export const SUPPORTED_TRADE_SIDES: TradeSide[] = ["buy", "sell"];
