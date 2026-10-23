/**
 * 前端日誌工具
 * 將前端日誌同時發送到瀏覽器控制台和後端
 */

import { getWsUrl } from './env';

// 移除未使用的 LogLevel 接口

interface LogEntry {
  level: string;
  message: string;
  data?: any;
  timestamp: string;
  source: string;
  url?: string;
}

class FrontendLogger {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private logQueue: LogEntry[] = [];
  private maxQueueSize = 100;

  constructor() {
    this.initWebSocket();
  }

  private initWebSocket() {
    try {
      const wsUrl = getWsUrl();
      // 靜默連線，不在控制台輸出
      this.ws = new WebSocket(wsUrl);
      
      this.ws.onopen = () => {
        this.isConnected = true;
        // 靜默
        this.flushQueue();
      };
      
      this.ws.onclose = () => {
        this.isConnected = false;
        // 靜默
      };
      
      this.ws.onerror = (error) => {
        // 靜默
      };
    } catch (error) {
      // 靜默
    }
  }

  private createLogEntry(level: string, message: string, data?: any, source: string = 'Frontend'): LogEntry {
    return {
      level,
      message,
      data,
      timestamp: new Date().toISOString(),
      source,
      url: window.location.href
    };
  }

  private sendToBackend(entry: LogEntry) {
    if (this.isConnected && this.ws) {
      try {
        this.ws.send(JSON.stringify({
          type: 'log',
          data: entry
        }));
      } catch (error) {
        console.warn('🔌 [Logger] 發送日誌到後端失敗:', error);
      }
    } else {
      // 如果 WebSocket 未連接，將日誌加入隊列
      this.logQueue.push(entry);
      if (this.logQueue.length > this.maxQueueSize) {
        this.logQueue.shift(); // 移除最舊的日誌
      }
    }
  }

  private flushQueue() {
    while (this.logQueue.length > 0 && this.isConnected) {
      const entry = this.logQueue.shift();
      if (entry) {
        this.sendToBackend(entry);
      }
    }
  }

  private log(level: string, message: string, data?: any, source: string = 'Frontend') {
    const entry = this.createLogEntry(level, message, data, source);
    
    // 檢查是否應該隱藏此日誌
    const shouldHide = this.shouldHideLog(source, message, data);
    
    if (shouldHide) {
      // 檢查是否應該發送到後端
      const shouldSend = this.shouldSendToBackend(source, message, data);
      if (shouldSend) {
        this.sendToBackend(entry);
      }
      return;
    }
    
    // 其他日誌發送到瀏覽器控制台
    // 關閉瀏覽器控制台輸出，僅保留後端收集
    
    // 檢查是否應該發送到後端
    const shouldSend = this.shouldSendToBackend(source, message, data);
    if (shouldSend) {
      this.sendToBackend(entry);
    }
  }

  private shouldHideLog(source: string, message: string, data?: any): boolean {
    // 隱藏所有技術日誌源
    if (source === 'WebSocket' || source === 'API' || source === 'Bybit' || source === 'Binance' || source === 'Redux') {
      return true;
    }
    
    // 隱藏所有前端日誌（除了重要的業務日誌）
    if (source === 'Frontend') {
      // 只顯示重要的業務日誌
      const importantKeywords = [
        '套利機會',
        '交易成功',
        '操作完成',
        '錯誤',
        '失敗',
        '成功'
      ];
      
      const messageText = message.toLowerCase();
      const hasImportantKeyword = importantKeywords.some(keyword => 
        messageText.includes(keyword.toLowerCase())
      );
      
      // 如果沒有重要關鍵詞，就隱藏
      return !hasImportantKeyword;
    }
    
    return false;
  }

  private shouldSendToBackend(source: string, message: string, data?: any): boolean {
    // 完全阻止 API 相關日誌發送到後端
    if (source === 'API' || source === 'Bybit' || source === 'Binance') {
      return false;
    }
    
    // 只發送重要的業務日誌到後端
    if (source === 'Frontend') {
      const importantKeywords = [
        '套利機會',
        '交易成功',
        '操作完成',
        '錯誤',
        '失敗',
        '成功',
        '連接',
        '斷開'
      ];
      
      const messageText = message.toLowerCase();
      const hasImportantKeyword = importantKeywords.some(keyword => 
        messageText.includes(keyword.toLowerCase())
      );
      
      return hasImportantKeyword;
    }
    
    // WebSocket 和 Redux 日誌不發送到後端
    if (source === 'WebSocket' || source === 'Redux') {
      return false;
    }
    
    return true;
  }

  private getEmoji(level: string): string {
    const emojis = {
      debug: '🐛',
      info: 'ℹ️',
      warn: '⚠️',
      error: '❌'
    };
    return emojis[level as keyof typeof emojis] || '📝';
  }

  debug(message: string, data?: any, source?: string) {
    this.log('debug', message, data, source);
  }

  info(message: string, data?: any, source?: string) {
    this.log('info', message, data, source);
  }

  warn(message: string, data?: any, source?: string) {
    this.log('warn', message, data, source);
  }

  error(message: string, data?: any, source?: string) {
    this.log('error', message, data, source);
  }
}

// 創建全局實例
const logger = new FrontendLogger();

export default logger;
