import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const TIMEZONE = 'Asia/Shanghai'; // UTC+8

const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

export const formatTimeHMS = (timestamp: number): string => {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  return dayjs(timestamp).tz(TIMEZONE).format('HH:mm:ss');
};

export const formatTimeHM = (timestamp: number | string): string => {
  if (timestamp === undefined || timestamp === null || timestamp === '') return '';
  const ts = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (Number.isNaN(ts)) return '';
  const ms = ts < 10000000000 ? ts * 1000 : ts;
  return dayjs(ms).tz(TIMEZONE).format('HH:mm');
};

export const formatTimeMDHM = (timestamp: number): string => {
  if (!timestamp || Number.isNaN(timestamp)) return '';
  return dayjs(timestamp).tz(TIMEZONE).format('MM-DD HH:mm');
};

export const formatUnixTime = (unixTimestamp: number, format: string = 'HH:mm'): string => {
  if (!unixTimestamp || Number.isNaN(unixTimestamp)) return '';
  const ms = unixTimestamp * 1000;
  return dayjs(ms).tz(TIMEZONE).format(format);
};

export const formatUnixTimeFull = (unixTimestamp: number): string => {
  if (!unixTimestamp || Number.isNaN(unixTimestamp)) return '';
  const d = dayjs(unixTimestamp * 1000).tz(TIMEZONE);
  const weekdays = ['\u9031\u65e5', '\u9031\u4e00', '\u9031\u4e8c', '\u9031\u4e09', '\u9031\u56db', '\u9031\u4e94', '\u9031\u516d'];
  return `${weekdays[d.day()]} ${d.format('YYYY-MM-DD HH:mm')}`;
};

export const formatAmountWithCurrency = (amount: number, currency: string = 'USDT'): string => {
  if (typeof amount !== 'number' || Number.isNaN(amount)) {
    return '0';
  }

  const formattedAmount =
    Number(amount) % 1 === 0
      ? amount.toLocaleString()
      : amount.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 8,
        });

  return `${formattedAmount} ${currency}`;
};

export const getBaseCurrencyFromSymbol = (symbol: string): string => {
  if (!symbol || typeof symbol !== 'string') return '';
  const s = symbol.toUpperCase();
  const quotes = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'USD'];
  for (const q of quotes) {
    if (s.endsWith(q)) {
      const base = s.slice(0, s.length - q.length);
      return base || s;
    }
  }
  return s;
};

export const formatPercentage = (value: number, decimals: number = 2): string => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '0%';
  }

  return `${value.toFixed(decimals)}%`;
};

export const formatPrice = (price: number, decimals: number = 4): string => {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return '0';
  }

  return price.toFixed(decimals);
};

/**
 * 智能價格格式化函數
 * 根據價格範圍動態計算合適的小數位數，確保總數字數不超過8個（不包括小數點）
 * 適用於圖表 Y 軸標籤顯示，避免小數位數過多導致標籤重疊
 * 
 * @param price 要格式化的價格
 * @returns 格式化後的價格字符串
 * 
 * @example
 * formatPriceSmart(0.061234) // "0.061234" (6位小數，總共7個數字)
 * formatPriceSmart(1234.56) // "1234.56" (2位小數，總共7個數字)
 * formatPriceSmart(0.00000123) // "0.0000012" (7位小數，總共8個數字)
 */
export const formatPriceSmart = (price: number): string => {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return '0';
  }

  const absPrice = Math.abs(price);
  
  // 處理零值
  if (absPrice === 0) {
    return '0';
  }

  // 計算整數部分的位數
  const integerPart = Math.floor(absPrice);
  const integerDigits = integerPart === 0 ? 0 : integerPart.toString().length;
  
  // 根據整數部分位數動態調整小數位數
  // 確保總數字數（不包括小數點）不超過8個
  let precision: number;
  
  if (integerDigits >= 6) {
    precision = 1; // 6位整數：1位小數（總共7個數字）
  } else if (integerDigits >= 5) {
    precision = 2; // 5位整數：2位小數（總共7個數字）
  } else if (integerDigits >= 4) {
    precision = 3; // 4位整數：3位小數（總共7個數字）
  } else if (integerDigits >= 3) {
    precision = 4; // 3位整數：4位小數（總共7個數字）
  } else if (integerDigits >= 2) {
    precision = 5; // 2位整數：5位小數（總共7個數字）
  } else if (integerDigits >= 1) {
    precision = 6; // 1位整數：6位小數（總共7個數字）
  } else {
    // 純小數：計算第一個非零數字前有多少個零
    const str = absPrice.toString();
    if (str.includes('e')) {
      // 科學記數法處理
      const [, exp] = str.split('e');
      const exponent = parseInt(exp, 10);
      if (exponent < -6) {
        // 極小數值，使用科學記數法顯示
        return absPrice.toExponential(2);
      }
      precision = Math.min(7, Math.abs(exponent) + 2);
    } else {
      // 計算小數點後第一個非零數字的位置
      const decimalPart = str.split('.')[1] || '';
      let leadingZeros = 0;
      for (let i = 0; i < decimalPart.length; i++) {
        if (decimalPart[i] === '0') {
          leadingZeros++;
        } else {
          break;
        }
      }
      // 第一個非零數字後再顯示6位，但總共不超過8位
      // 對於像 0.06 這樣的數值，leadingZeros = 0，應該顯示至少6位小數
      precision = Math.max(6, Math.min(8, leadingZeros + 6));
    }
  }
  
  // 格式化價格，保留完整精度
  const formatted = price.toFixed(precision);
  // 不移除尾部零，確保顯示完整的精度（例如 0.060000 而不是 0.06）
  return formatted;
};

/**
 * 固定寬度價格格式化函數
 * 非負數時數值部分固定為 9 個字符（含小數點），不足時前面補空格；負數會加上 '-' 前綴（總長 10）
 * 適用於圖表 Y 軸標籤顯示，確保標籤對齊
 * 
 * @param price 要格式化的價格
 * @returns 格式化後的價格字符串
 * 
 * @example
 * formatPriceFixedWidth(100000.12) // "100000.12" (9個字符，不需要補充)
 * formatPriceFixedWidth(2486) // "     2486" (5個空格 + 4個數字 = 9個字符)
 * formatPriceFixedWidth(12) // "       12" (7個空格 + 2個數字 = 9個字符)
 * formatPriceFixedWidth(12.123456) // "12.123456" (9個字符)
 * formatPriceFixedWidth(0.101) // "     .101" (5個空格 + 小數點 + 3個數字 = 9個字符)
 * formatPriceFixedWidth(34) // "       34" (7個空格 + 2個數字 = 9個字符)
 * formatPriceFixedWidth(-8.623245) // "-8.623245" 等（負數保留 '-' 前綴，總長可能為 10）
 */
export const formatPriceFixedWidth = (price: number): string => {
  if (typeof price !== 'number' || Number.isNaN(price)) {
    return '        0'; // 8個空格 + 1個數字 = 9個字符
  }

  const isNegative = price < 0;
  const absPrice = Math.abs(price);
  
  // 處理零值
  if (absPrice === 0) {
    return '        0'; // 8個空格 + 1個數字 = 9個字符
  }

  // 計算整數部分
  const integerPart = Math.floor(absPrice);
  
  // 根據整數部分位數決定小數位數，確保總共不超過9個字符
  const integerDigits = integerPart === 0 ? 0 : integerPart.toString().length;
  let precision: number;
  
  if (integerDigits >= 7) {
    precision = 1; // 7位整數：1位小數（總共9個字符）
  } else if (integerDigits >= 6) {
    precision = 2; // 6位整數：2位小數（總共9個字符）
  } else if (integerDigits >= 5) {
    precision = 3; // 5位整數：3位小數（總共9個字符）
  } else if (integerDigits >= 4) {
    precision = 4; // 4位整數：4位小數（總共9個字符）
  } else if (integerDigits >= 3) {
    precision = 5; // 3位整數：5位小數（總共9個字符）
  } else if (integerDigits >= 2) {
    precision = 6; // 2位整數：6位小數（總共9個字符）
  } else if (integerDigits >= 1) {
    precision = 7; // 1位整數：7位小數（總共9個字符）
  } else {
    // 純小數：7位小數（總共9個字符：小數點 + 7位數字）
    precision = 7;
  }
  
  // 格式化價格
  let formatted = absPrice.toFixed(precision);
  
  // 計算當前字符串的字符數（包括小數點）
  let currentLength = formatted.length;
  
  // 如果超過9個字符，需要截斷
  if (currentLength > 9) {
    if (formatted.includes('.')) {
      const parts = formatted.split('.');
      const intPart = parts[0] || '';
      const decPart = parts[1] || '';
      
      if (intPart.length >= 9) {
        formatted = intPart.substring(0, 9);
      } else {
        const availableForDecimal = 9 - intPart.length - 1; // -1 是小數點
        if (availableForDecimal > 0) {
          formatted = intPart + '.' + decPart.substring(0, availableForDecimal);
        } else {
          formatted = intPart;
        }
      }
    } else {
      formatted = formatted.substring(0, 9);
    }
  }
  
  // 重新計算長度
  currentLength = formatted.length;
  
  // 如果不足9個字符，在前面補充空格
  if (currentLength < 9) {
    formatted = formatted.padStart(9, ' ');
  }
  
  // 數值部分固定 9 字元；負數加上 '-'（價差 % 等需顯示負號，不可被 Math.abs 吃掉）
  return isNegative ? `-${formatted}` : formatted;
};
