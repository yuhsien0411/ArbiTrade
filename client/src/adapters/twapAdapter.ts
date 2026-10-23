/**
 * TWAP 相關 API/WS 回傳的統一解析層
 */

export interface TwapExecutionsPayload {
  recent: any[];
  executions: any[];
}

/**
 * 解析 /api/twap/executions 多種回傳形狀。
 */
export function parseTwapExecutionsResponse(res: any): TwapExecutionsPayload {
  if (!res) return { recent: [], executions: [] };

  if (Array.isArray(res)) {
    return { recent: res, executions: res };
  }

  const recent =
    (Array.isArray(res?.data?.recent) && res.data.recent) ||
    (Array.isArray(res?.recent) && res.recent) ||
    [];

  const executions =
    (Array.isArray(res?.data?.executions) && res.data.executions) ||
    (Array.isArray(res?.executions) && res.executions) ||
    (Array.isArray(res?.data) && res.data) ||
    recent;

  return { recent, executions };
}

/**
 * 解析 /api/twap/plans 多種回傳並正規化為共用 strategy shape。
 *
 * 以往 Trading.tsx 與 TwapPage.tsx 各自有 map，對 state/status 等欄位優先順序不一致。
 * 統一規則：優先讀 status，其次 state，其次 plan.progress.state。
 */
export function normalizeTwapStrategy(raw: any): any | null {
  if (!raw || typeof raw !== 'object') return null;

  const id = raw.planId || raw.id;
  if (!id) return null;

  const status = raw.status || raw.state || raw?.progress?.state || 'pending';

  return {
    id: String(id),
    planId: String(id),
    name: raw.name || String(id),
    status,
    state: status, // 雙欄位相容舊使用端
    totalQty: Number(raw.totalQty ?? raw.totalAmount ?? 0),
    sliceQty: Number(raw.sliceQty ?? 0),
    intervalMs: Number(raw.intervalMs ?? raw.timeInterval ?? 0),
    legs: Array.isArray(raw.legs) ? raw.legs : [],
    progress: raw.progress || {
      slicesDone: 0,
      executed: 0,
      remaining: Number(raw.totalQty ?? 0),
      state: status,
    },
    totalTriggers: Number(raw.totalTriggers ?? raw?.progress?.slicesDone ?? 0),
  };
}

export function normalizeTwapStrategies(list: any): any[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeTwapStrategy).filter(Boolean);
}
