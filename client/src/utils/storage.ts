/**
 * 本地存儲工具
 *
 * 策略：執行中訂單與歷史成交資料不再存 localStorage，
 *       執行中資料只保存在 Redux 記憶體；歷史資料來源為後端 jsonl（透過 API 讀取）。
 *       此處僅保留「純 UI 偏好」資料，例如隱藏某些倉位 card。
 */

const STORAGE_KEYS = {
  UI_HIDDEN_POSITIONS: 'ui_hidden_positions',
} as const;

export const storage = {
  save: <T>(key: string, data: T): void => {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (error) {
      console.error('保存數據失敗:', error);
    }
  },

  load: <T>(key: string, defaultValue: T): T => {
    try {
      const item = localStorage.getItem(key);
      return item ? (JSON.parse(item) as T) : defaultValue;
    } catch (error) {
      console.error('讀取數據失敗:', error);
      return defaultValue;
    }
  },

  remove: (key: string): void => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('移除數據失敗:', error);
    }
  },

  /**
   * 清空本應用相關的 UI 偏好 key。
   * 不再提供 clearAll() 全域清 localStorage，避免波及其他應用。
   */
  clear: (): void => {
    Object.values(STORAGE_KEYS).forEach(key => {
      storage.remove(key);
    });
  },

  keys: STORAGE_KEYS,
};

export default storage;
