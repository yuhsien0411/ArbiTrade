/**
 * 套利相關 API/WS 回傳的統一解析層
 *
 * 為了隔離後端欄位/外殼演進，各頁面/元件都應透過 adapter 讀取資料，
 * 不再直接 ?.data?.recent 之類多重 fallback。
 */

export interface ArbitrageExecutionsPayload {
  /** 最近的執行紀錄（已攤平為單一陣列） */
  recent: any[];
  /** 原始 history map（id → 紀錄陣列），如後端提供則回傳，否則為空物件 */
  history: Record<string, any[]>;
}

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function resolvePairExecutionCount(raw: any, fallback = 0): number {
  const candidates = [
    raw?.totalTriggers,
    raw?.executionsCount,
    raw?.executionCount,
    raw?.executedCount,
    fallback,
  ];

  return candidates.reduce((max, value) => {
    const numeric = toFiniteNumber(value, 0);
    return numeric >= 0 ? Math.max(max, numeric) : max;
  }, 0);
}

/**
 * 將 /api/arbitrage/executions 的多種回傳形狀統一成 { recent, history }。
 *
 * 目前支援的後端回傳形狀：
 * 1. api_success(data) 由 axios 攔截後 → { success, data: { recent, ...history } }
 * 2. 舊格式 { success, data, recent }
 * 3. { success, data: { recent } }
 * 4. 根層 { recent }
 * 5. data 直接為陣列
 * 6. 根本就是陣列
 */
export function parseArbitrageExecutionsResponse(res: any): ArbitrageExecutionsPayload {
  if (!res) return { recent: [], history: {} };

  // 根本是陣列
  if (Array.isArray(res)) {
    return { recent: res, history: {} };
  }

  // 形狀 1+3: data 裡有 recent
  if (res?.data && typeof res.data === 'object') {
    if (Array.isArray(res.data.recent)) {
      const { recent, ...rest } = res.data;
      return { recent, history: (rest as Record<string, any[]>) || {} };
    }
    // data 直接是陣列
    if (Array.isArray(res.data)) {
      return { recent: res.data, history: {} };
    }
  }

  // 形狀 2: 根層 recent + 旁邊 data 是 history map
  if (Array.isArray(res?.recent)) {
    return {
      recent: res.recent,
      history: (typeof res.data === 'object' && !Array.isArray(res.data) ? res.data : {}) as Record<string, any[]>,
    };
  }

  return { recent: [], history: {} };
}

/**
 * 將後端 monitoring pair 原始資料正規化為前端可用的 PairConfig（含預設值）。
 *
 * 之所以單獨抽出：`ArbitragePage` 舊版有一整段 normalize 邏輯，
 * 而 `Trading.tsx` 另一邊卻直接塞原始值，導致同一個 setMonitoringPairs 會被兩種
 * 形狀交替覆寫。統一走此 adapter 後 reducer 只會收到同一標準形狀。
 */
export function normalizeMonitoringPair(raw: any): any | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.id) return null;

  const leg1 = raw.leg1 || {};
  const leg2 = raw.leg2 || {};
  const qty = Number(raw.qty ?? raw.amount ?? 0);
  const totalTriggers = resolvePairExecutionCount(raw);

  return {
    id: String(raw.id),
    leg1: {
      exchange: String(leg1.exchange || ''),
      symbol: String(leg1.symbol || ''),
      type: (leg1.type || 'spot') as 'spot' | 'linear' | 'inverse',
      side: (leg1.side || 'buy') as 'buy' | 'sell',
    },
    leg2: {
      exchange: String(leg2.exchange || ''),
      symbol: String(leg2.symbol || ''),
      type: (leg2.type || 'spot') as 'spot' | 'linear' | 'inverse',
      side: (leg2.side || 'sell') as 'buy' | 'sell',
    },
    threshold: Number(raw.threshold ?? 0),
    qty,
    amount: qty, // 向後兼容
    maxExecs: Number(raw.maxExecs ?? 1),
    enabled: raw.enabled !== false,
    createdAt: Number(raw.createdAt ?? Date.now()),
    lastTriggered: raw.lastTriggered ?? null,
    totalTriggers,
    executionsCount: Number(raw.executionsCount ?? totalTriggers),
  };
}

export function normalizeMonitoringPairs(list: any): any[] {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeMonitoringPair).filter(Boolean);
}
