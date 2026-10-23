/**
 * WebSocket服務
 * 處理與後端的即時通訊
 */

import { AppDispatch } from '../store';
import { setConnectionStatus, addNotification, updateEngineStatus } from '../store/slices/systemSlice';
import { updateOpportunity, addExecution, removeMonitoringPair, updatePairTriggerStats } from '../store/slices/arbitrageSlice';
import { addExecution as addTwapExecution } from '../store/slices/twapSlice';
import logger from '../utils/logger';
import { getWsUrl } from '../utils/env';
import { resolvePairExecutionCount } from '../adapters/arbitrageAdapter';

let wsRef: WebSocket | null = null;
// let pollingTimers: Map<string, any> = new Map();
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 1500; // 1.5秒，加快重連

// 客戶端心跳：每 20 秒送 ping，保證後端連線不被判為閒置
const CLIENT_PING_INTERVAL_MS = 20000;
let pingTimer: ReturnType<typeof setInterval> | null = null;

function startPingLoop() {
  stopPingLoop();
  pingTimer = setInterval(() => {
    if (wsRef && wsRef.readyState === WebSocket.OPEN) {
      try {
        wsRef.send(JSON.stringify({ type: 'ping', data: { ts: Date.now() } }));
      } catch (e) {
        // 忽略送訊息錯誤，onclose 會處理重連
      }
    }
  }, CLIENT_PING_INTERVAL_MS);
}

function stopPingLoop() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

/**
 * 連接WebSocket
 */
export function connectWebSocket(dispatch: AppDispatch) {
  const wsUrl = getWsUrl();
  
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    return;
  }

  try {
    wsRef = new WebSocket(wsUrl);
    
    wsRef.onopen = () => {
      console.log('🔗 WebSocket 連接成功');
      dispatch(setConnectionStatus('connected'));
      reconnectAttempts = 0;

      // 啟動心跳循環；引擎狀態改由後端 arbitrageEngineStatus 事件決定
      startPingLoop();
    };

    wsRef.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message, dispatch);
      } catch (error) {
        console.error('WebSocket 消息解析失敗:', error);
      }
    };

    wsRef.onclose = () => {
      console.log('🔌 WebSocket 連接關閉');
      dispatch(setConnectionStatus('disconnected'));
      stopPingLoop();

      // 自動重連
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        console.log(`🔄 嘗試重連 WebSocket (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        reconnectTimer = setTimeout(() => {
          connectWebSocket(dispatch);
        }, RECONNECT_DELAY);
      } else {
        console.error('❌ WebSocket 重連失敗，已達到最大重試次數');
      }
    };

    wsRef.onerror = (error) => {
      console.error('WebSocket 錯誤:', error);
    };

  } catch (error) {
    console.error('WebSocket 連接失敗:', error);
  }
}

/**
 * 斷開WebSocket連接
 */
export function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  stopPingLoop();

  if (wsRef) {
    wsRef.close();
    wsRef = null;
  }

  reconnectAttempts = 0;
}

/**
 * 處理WebSocket消息
 */
function handleWebSocketMessage(message: any, dispatch: AppDispatch) {
  const { type, data, timestamp } = message;

  switch (type) {
    case 'ping':
    case 'pong':
      // 心跳訊息：不做任何業務處理，onmessage 收到已足夠維持活躍
      break;

    case 'priceUpdate':
      // 套利雙腿價格更新（後端 arbitrage_engine 廣播）
      // payload: { id, pairConfig, leg1Price, leg2Price, spread, spreadPercent, threshold, timestamp }
      if (data && data.id && data.pairConfig) {
        const {
          id,
          leg1Price,
          leg2Price,
          spread,
          spreadPercent,
          threshold,
          pairConfig
        } = data;

        const leg1Side = pairConfig?.leg1?.side || 'buy';
        const leg2Side = pairConfig?.leg2?.side || 'sell';
        const direction = (leg1Side === 'sell' && leg2Side === 'buy')
          ? 'leg1_sell_leg2_buy'
          : 'leg1_buy_leg2_sell';

        const opportunity = {
          id,
          pairConfig: {
            id: pairConfig.id || id,
            leg1: pairConfig.leg1,
            leg2: pairConfig.leg2,
            threshold: pairConfig.threshold ?? threshold ?? 0,
            qty: pairConfig.qty ?? 0,
            maxExecs: pairConfig.maxExecs ?? 1,
            enabled: true,
            createdAt: Date.now(),
            lastTriggered: null,
            totalTriggers: pairConfig.totalTriggers ?? 0
          },
          leg1Price,
          leg2Price,
          spread: spread || 0,
          spreadPercent: spreadPercent || 0,
          threshold: threshold || 0,
          shouldTrigger: (spreadPercent || 0) >= (threshold || 0),
          timestamp: timestamp || data.timestamp || Date.now(),
          direction: direction as 'leg1_buy_leg2_sell' | 'leg1_sell_leg2_buy'
        };

        dispatch(updateOpportunity(opportunity));

        // 觸發自定義事件，讓頁面元件可以監聽雙腿即時價格
        window.dispatchEvent(new CustomEvent('priceUpdate', {
          detail: {
            type: 'priceUpdate',
            data: {
              id,
              leg1Price,
              leg2Price,
              spread,
              spreadPercent,
              threshold,
              pairConfig,
              timestamp: timestamp || data.timestamp || Date.now()
            }
          }
        }));
      }
      break;

    case 'priceUpdated':
      // 單一訂單成交價回填（_notify_price_update）
      // payload: { orderId, price, symbol, exchange, type, side, timestamp }
      if (data && data.orderId) {
        window.dispatchEvent(new CustomEvent('arbitragePriceUpdated', {
          detail: { type: 'priceUpdated', data }
        }));
        logger.info('arbitrage_fill_price_updated', data, 'WebSocket');
      }
      break;

    case 'chartTickerUpdate':
      if (data && data.exchange && data.symbol && data.price) {
        window.dispatchEvent(new CustomEvent('chartTickerUpdate', {
          detail: { type: 'chartTickerUpdate', data }
        }));
      }
      break;

    case 'pairDisabled':
      // 監控對被停用（失敗或完成 maxExecs）
      if (data?.id) {
        const reason = data.reason === 'completed' ? '已完成執行次數' : '執行失敗';
        dispatch(addNotification({ type: 'info', message: `監控對 ${data.id} 已停用：${reason}` }));
        window.dispatchEvent(new CustomEvent('pairDisabled', {
          detail: { type: 'pairDisabled', data }
        }));
      }
      break;

    case 'arbitrageExecuted':
      // 套利執行完成
      console.log('🔔 收到套利執行完成消息:', data);
      if (data) {
        const now = timestamp || Date.now();
        const leg1 = data.leg1 || {};
        const leg2 = data.leg2 || {};
        const pairId = data.pairId;
        const totalTriggers = resolvePairExecutionCount(data, 1);
        
        // 添加執行記錄到 Redux store（只調用一次，使用完整的數據結構）
        dispatch(addExecution({
          opportunity: {
            id: pairId,
            pairConfig: {
              id: pairId,
              leg1: {
                exchange: leg1.exchange || '',
                symbol: leg1.symbol || '',
                type: leg1.type || 'spot',
                side: leg1.side || 'buy'
              },
              leg2: {
                exchange: leg2.exchange || '',
                symbol: leg2.symbol || '',
                type: leg2.type || 'spot',
                side: leg2.side || 'sell'
              },
              threshold: data.threshold || 0,
              qty: data.qty || 0,
              maxExecs: data.maxExecs || 1,
              totalTriggers,
              enabled: true,
              createdAt: now,
              lastTriggered: now
            },
            leg1Price: { 
              symbol: leg1.symbol || '', 
              exchange: leg1.exchange || '', 
              bid1: null, 
              ask1: null 
            },
            leg2Price: { 
              symbol: leg2.symbol || '', 
              exchange: leg2.exchange || '', 
              bid1: null, 
              ask1: null 
            },
            spread: data.spread || 0,
            spreadPercent: data.spreadPercent || 0,
            threshold: data.threshold || 0,
            shouldTrigger: false,
            timestamp: now,
            direction: 'leg1_buy_leg2_sell'
          },
          amount: data.qty || 0,
          result: {
            leg1OrderId: data.leg1OrderId,
            leg2OrderId: data.leg2OrderId
          },
          success: true,
          timestamp: now,
          maxExecs: data.maxExecs || 1,
          totalTriggers,
          completed: true
        }));

        // 更新觸發統計
        dispatch(updatePairTriggerStats({
          pairId: pairId,
          totalTriggers,
          lastTriggered: now
        }));

        dispatch(addNotification({
          type: 'success',
          message: '套利執行成功'
        }));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('arbitrageExecuted', {
          detail: {
            type: 'arbitrageExecuted',
            data: data
          }
        }));
      }
      break;

    case 'pairRemoved':
      // 監控對被移除
      if (data?.id) {
        dispatch(addNotification({ type: 'info', message: `已完成並移除: ${data.id}` }));
        dispatch(removeMonitoringPair(data.id));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('pairRemoved', {
          detail: {
            type: 'pairRemoved',
            data: data
          }
        }));
      }
      break;

    case 'arbitrageFailed':
      // 套利執行失敗
      if (data) {
        dispatch(addNotification({
          type: 'error',
          message: `套利執行失敗: ${data.reason || '未知錯誤'}`
        }));

        // 觸發自定義事件，讓頁面可以監聽
        window.dispatchEvent(new CustomEvent('arbitrageFailed', {
          detail: {
            type: 'arbitrageFailed',
            data: data
          }
        }));
      }
      break;

    case 'twapExecuted':
      // TWAP 執行完成
      if (data) {
        dispatch(addTwapExecution({
          strategyId: data.planId,
          timestamp: data.timestamp || Date.now(),
          amount: data.qty || 0,
          leg1Price: data.price || undefined,
          leg2Price: data.price || undefined,
          success: data.success || false,
          error: data.error || undefined
        }));

        dispatch(addNotification({
          type: data.success ? 'success' : 'error',
          message: data.success ? 'TWAP 執行成功' : 'TWAP 執行失敗'
        }));
      }
      break;

    case 'twapPlanCompleted':
      // TWAP 策略完成
      if (data) {
        dispatch(addNotification({
          type: 'success',
          message: `TWAP 策略完成: ${data.planId}`
        }));
      }
      break;

    case 'twapPlanFailed':
      // TWAP 策略失敗
      if (data) {
        dispatch(addNotification({
          type: 'error',
          message: `TWAP 策略失敗: ${data.planId} - ${data.reason || '未知錯誤'}`
        }));
      }
      break;

    case 'arbitrageEngineStatus':
      // 🔧 套利引擎狀態變更
      if (data) {
        console.log('🔔 收到套利引擎狀態變更:', data);
        dispatch(updateEngineStatus({
          isRunning: data.running || false
        }));
        
        // 顯示通知
        dispatch(addNotification({
          type: 'info',
          message: data.running ? '套利引擎已啟動' : '套利引擎已停止'
        }));
        
        logger.info(`套利引擎狀態: ${data.running ? '運行中' : '已停止'}`, data, 'WebSocket');
      }
      break;

    case 'log':
      // 日誌消息
      if (data && data.message) {
        logger.info(data.message, data.data || {}, data.source || 'WebSocket');
      }
      break;

    default:
      console.log('未處理的 WebSocket 消息類型:', type, data);
      break;
  }
}

/**
 * 發送 WebSocket 消息
 */
export function sendWebSocketMessage(message: any) {
  if (wsRef && wsRef.readyState === WebSocket.OPEN) {
    wsRef.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/**
 * 獲取 WebSocket 連接狀態
 */
export function getWebSocketStatus(): boolean {
  return wsRef !== null && wsRef.readyState === WebSocket.OPEN;
}
