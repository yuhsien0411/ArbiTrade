/**
 * 環境變數工具
 * 統一處理前端在不同部署環境下的 API / WebSocket URL
 */

const DEFAULT_API_PORT = process.env.REACT_APP_API_PORT || '7001';

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function shouldUseSameOriginApi(): boolean {
  return process.env.REACT_APP_API_SAME_ORIGIN === 'true';
}

/**
 * 取得後端 API Base URL
 * - 優先使用 REACT_APP_API_URL
 * - 否則使用目前網站的 host，改成 7001 port
 */
export function getApiBaseUrl(): string {
  if (process.env.REACT_APP_API_URL) {
    return normalizeBaseUrl(process.env.REACT_APP_API_URL);
  }

  if (shouldUseSameOriginApi()) {
    return '';
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol || 'http:';
    const hostname = window.location.hostname || '127.0.0.1';
    return `${protocol}//${hostname}:${DEFAULT_API_PORT}`;
  }

  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

/**
 * 取得後端 HTTP 服務基礎 URL（供 WebSocket 轉換使用）
 */
export function getServerBaseUrl(): string {
  if (process.env.REACT_APP_SERVER_URL) {
    return process.env.REACT_APP_SERVER_URL;
  }

  return getApiBaseUrl();
}

/**
 * 取得 WebSocket URL
 * - 優先使用 REACT_APP_WS_URL
 * - 否則用 HTTP URL 替換協議並附上 /ws
 */
export function getWsUrl(): string {
  if (process.env.REACT_APP_WS_URL) {
    return process.env.REACT_APP_WS_URL;
  }

  if (shouldUseSameOriginApi() && typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
  }

  const base = getServerBaseUrl();
  try {
    const url = new URL(base);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}/ws`;
  } catch {
    return 'ws://127.0.0.1:7001/ws';
  }
}
