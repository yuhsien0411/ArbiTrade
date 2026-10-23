/**
 * 統一執行記錄型別定義 V2
 * 適用於 TWAP 和 Pairs 策略
 * 與後端 UnifiedExecutionRecord 模型保持一致
 */

// 基礎型別
export type ExecutionMode = "pair" | "twap";
export type ExecutionStatus = "success" | "failed" | "cancelled" | "rolled_back";
export type ExchangeName = "bybit" | "binance" | "okx" | "bitget" | "aster" | "mexc";
export type TradeType = "spot" | "linear" | "inverse";
export type TradeSide = "buy" | "sell";

/**
 * 執行腿的統一結構
 */
export interface ExecutionLeg {
  exchange: ExchangeName;
  symbol: string;
  type: TradeType;
  side: TradeSide;
  orderId: string | null;
  price: number | null;
  priceUpdated: boolean;
  originalOrderId?: string | null;  // 回滾時使用
}

/**
 * 統一的執行記錄格式（TWAP 和 Pairs 共用）
 */
export interface UnifiedExecutionRecord {
  // 基本資訊
  ts: number;                      // 時間戳（毫秒）
  mode: ExecutionMode;             // 策略類型
  strategyId: string;              // 策略ID（統一識別用）
  pairId: string | null;           // Pairs策略ID（mode=pair時使用）
  twapId: string | null;           // TWAP策略ID（mode=twap時使用）
  
  // 執行資訊
  totalTriggers: number;           // 第幾次執行（從1開始，pair和twap共用）
  
  // 狀態資訊
  status: ExecutionStatus;         // 執行狀態
  reason: string | null;           // 失敗或取消原因
  error: string | null;            // 錯誤訊息
  
  // 數量和價格資訊
  qty: number;                     // 本次執行數量
  spread: number | null;           // 價差
  spreadPercent: number | null;    // 價差百分比
  
  // 策略配置資訊
  totalAmount: number;             // 預期總數量
  orderCount: number;              // 總執行次數/最大執行次數
  threshold: number | null;        // 觸發閾值（pair用，twap為null）
  intervalMs: number | null;       // 執行間隔毫秒（twap用，pair為null）
  
  // 回滾資訊
  isRollback: boolean;             // 是否為回滾記錄
  
  // 執行腿資訊
  leg1: ExecutionLeg | null;       // 第一腿執行結果
  leg2: ExecutionLeg | null;       // 第二腿執行結果
}

/**
 * 型別守衛：檢查是否為統一執行記錄
 */
export function isUnifiedExecutionRecord(obj: any): obj is UnifiedExecutionRecord {
  return obj &&
         typeof obj === 'object' &&
         typeof obj.ts === 'number' &&
         typeof obj.mode === 'string' &&
         (obj.mode === 'pair' || obj.mode === 'twap') &&
         typeof obj.strategyId === 'string' &&
         typeof obj.totalTriggers === 'number' &&
         typeof obj.status === 'string' &&
         typeof obj.qty === 'number' &&
         typeof obj.totalAmount === 'number' &&
         typeof obj.orderCount === 'number' &&
         typeof obj.isRollback === 'boolean';
}

/**
 * 型別守衛：檢查是否為 Pairs 執行記錄
 */
export function isPairExecutionRecord(obj: UnifiedExecutionRecord): boolean {
  return obj.mode === 'pair' && obj.pairId !== null;
}

/**
 * 型別守衛：檢查是否為 TWAP 執行記錄
 */
export function isTwapExecutionRecord(obj: UnifiedExecutionRecord): boolean {
  return obj.mode === 'twap' && obj.twapId !== null;
}

/**
 * 工具函數：計算執行進度百分比
 */
export function getExecutionProgress(record: UnifiedExecutionRecord): number {
  return Math.min((record.totalTriggers / record.orderCount) * 100, 100);
}

/**
 * 工具函數：判斷是否已完成
 */
export function isExecutionCompleted(record: UnifiedExecutionRecord): boolean {
  return record.totalTriggers >= record.orderCount;
}

/**
 * 工具函數：取得策略顯示名稱
 */
export function getStrategyDisplayName(record: UnifiedExecutionRecord): string {
  if (record.mode === 'pair') {
    return `Pairs: ${record.pairId}`;
  } else {
    return `TWAP: ${record.twapId}`;
  }
}

/**
 * 工具函數：格式化執行狀態
 */
export function formatExecutionStatus(status: ExecutionStatus): string {
  const statusMap: Record<ExecutionStatus, string> = {
    'success': '成功',
    'failed': '失敗',
    'cancelled': '已取消',
    'rolled_back': '已回滾'
  };
  return statusMap[status] || status;
}

/**
 * 工具函數：取得狀態顏色
 */
export function getStatusColor(status: ExecutionStatus): string {
  const colorMap: Record<ExecutionStatus, string> = {
    'success': 'green',
    'failed': 'red',
    'cancelled': 'orange',
    'rolled_back': 'purple'
  };
  return colorMap[status] || 'gray';
}

/**
 * 聚合函數：按 strategyId 分組執行記錄
 */
export function groupRecordsByStrategy(
  records: UnifiedExecutionRecord[]
): Record<string, UnifiedExecutionRecord[]> {
  return records.reduce((acc, record) => {
    const key = record.strategyId;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(record);
    return acc;
  }, {} as Record<string, UnifiedExecutionRecord[]>);
}

/**
 * 聚合函數：計算策略的總成交數量
 */
export function calculateTotalExecutedQty(
  records: UnifiedExecutionRecord[],
  strategyId: string
): { leg1TotalQty: number; leg2TotalQty: number } {
  const strategyRecords = records.filter(
    r => r.strategyId === strategyId && r.status === 'success'
  );
  
  return {
    leg1TotalQty: strategyRecords.reduce((sum, r) => sum + r.qty, 0),
    leg2TotalQty: strategyRecords.reduce((sum, r) => sum + r.qty, 0)
  };
}

/**
 * 過濾函數：取得成功的執行記錄
 */
export function getSuccessfulRecords(
  records: UnifiedExecutionRecord[]
): UnifiedExecutionRecord[] {
  return records.filter(r => r.status === 'success' && !r.isRollback);
}

/**
 * 過濾函數：取得失敗的執行記錄
 */
export function getFailedRecords(
  records: UnifiedExecutionRecord[]
): UnifiedExecutionRecord[] {
  return records.filter(r => r.status === 'failed');
}

/**
 * 過濾函數：取得回滾的執行記錄
 */
export function getRollbackRecords(
  records: UnifiedExecutionRecord[]
): UnifiedExecutionRecord[] {
  return records.filter(r => r.isRollback);
}

/**
 * 向後兼容：將舊格式轉換為統一格式（Pairs）
 */
export function convertLegacyPairRecord(legacy: any): UnifiedExecutionRecord {
  return {
    ts: legacy.ts || 0,
    mode: 'pair',
    strategyId: legacy.pairId || legacy.strategyId,
    pairId: legacy.pairId,
    twapId: null,
    totalTriggers: legacy.totalTriggers || legacy.executionIndex || 1,
    status: legacy.status || 'success',
    reason: legacy.reason || null,
    error: legacy.error || null,
    qty: legacy.qty || legacy.sliceQty || 0,
    spread: legacy.spread || null,
    spreadPercent: legacy.spreadPercent || null,
    totalAmount: legacy.totalAmount || (legacy.maxExecs || 1) * (legacy.qty || 0),
    orderCount: legacy.orderCount || legacy.maxExecs || 1,
    threshold: legacy.threshold || null,
    intervalMs: null,
    isRollback: legacy.isRollback || false,
    leg1: legacy.leg1 || null,
    leg2: legacy.leg2 || null
  };
}

/**
 * 向後兼容：將舊格式轉換為統一格式（TWAP）
 */
export function convertLegacyTwapRecord(legacy: any): UnifiedExecutionRecord {
  const sliceIndex = legacy.sliceIndex || 0;
  
  return {
    ts: legacy.ts || 0,
    mode: 'twap',
    strategyId: legacy.planId || legacy.twapId || legacy.strategyId,
    pairId: null,
    twapId: legacy.planId || legacy.twapId,
    totalTriggers: legacy.executionIndex || (sliceIndex + 1),
    status: legacy.status || 'success',
    reason: legacy.reason || null,
    error: legacy.error || null,
    qty: legacy.qty || legacy.sliceQty || 0,
    spread: legacy.spread || null,
    spreadPercent: legacy.spreadPercent || null,
    totalAmount: legacy.totalAmount || 0,
    orderCount: legacy.orderCount || 0,
    threshold: null,
    intervalMs: legacy.intervalMs || null,
    isRollback: legacy.isRollback || false,
    leg1: legacy.leg1 || null,
    leg2: legacy.leg2 || null
  };
}

/**
 * 常數定義
 */
export const SUPPORTED_EXECUTION_MODES: ExecutionMode[] = ['pair', 'twap'];
export const SUPPORTED_EXECUTION_STATUSES: ExecutionStatus[] = [
  'success',
  'failed',
  'cancelled',
  'rolled_back'
];
