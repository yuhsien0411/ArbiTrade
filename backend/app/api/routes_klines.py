"""
K線數據API路由
提供歷史K線數據查詢，支持多個交易所
"""

from fastapi import APIRouter, HTTPException, Query
from typing import Optional
import httpx
import time
from app.utils.logger import get_logger

router = APIRouter()
logger = get_logger()


def api_success(data: any, message: str = None):
    """統一成功響應格式"""
    return {
        "success": True,
        "data": data,
        "message": message,
        "timestamp": int(time.time() * 1000)
    }


def api_error(error: str, status_code: int = 400):
    """統一錯誤響應格式"""
    raise HTTPException(status_code=status_code, detail={
        "success": False,
        "error": error,
        "timestamp": int(time.time() * 1000)
    })


def convert_interval_to_bybit(interval: str) -> str:
    """
    轉換通用時間間隔為 Bybit 格式
    通用: 1m, 5m, 15m, 30m, 1h, 4h, 1d
    Bybit: 1, 5, 15, 30, 60, 240, D
    """
    interval_map = {
        "1m": "1",
        "3m": "3",
        "5m": "5",
        "15m": "15",
        "30m": "30",
        "1h": "60",
        "2h": "120",
        "4h": "240",
        "6h": "360",
        "12h": "720",
        "1d": "D",
        "1w": "W",
        "1M": "M"
    }
    return interval_map.get(interval, "1")


def convert_interval_to_binance(interval: str) -> str:
    """
    轉換通用時間間隔為 Binance 格式
    Binance 直接支持: 1m, 5m, 1h, 1d 等
    """
    return interval


def convert_interval_to_mexc(interval: str) -> str:
    interval_map = {
        "1m": "1m",
        "3m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "60m",
        "2h": "60m",
        "4h": "4h",
        "6h": "4h",
        "12h": "4h",
        "1d": "1d",
        "1w": "1W",
        "1M": "1M",
    }
    return interval_map.get(interval, "1m")


def get_interval_milliseconds(interval: str) -> int:
    interval_map = {
        "1s": 1000,
        "1m": 60_000,
        "3m": 3 * 60_000,
        "5m": 5 * 60_000,
        "15m": 15 * 60_000,
        "30m": 30 * 60_000,
        "1h": 60 * 60_000,
        "2h": 2 * 60 * 60_000,
        "4h": 4 * 60 * 60_000,
        "6h": 6 * 60 * 60_000,
        "12h": 12 * 60 * 60_000,
        "1d": 24 * 60 * 60_000,
        "1w": 7 * 24 * 60 * 60_000,
        "1M": 30 * 24 * 60 * 60_000,
    }
    return interval_map.get(interval, 60_000)


def convert_interval_to_aster(interval: str) -> str:
    """
    轉換通用時間間隔為 Aster 格式
    Aster 與 Binance 相容，直接使用原值
    """
    return interval


def convert_interval_to_bitget(interval: str) -> str:
    """
    轉換通用時間間隔為 Bitget 格式
    通用: 1m, 5m, 15m, 30m, 1h, 4h, 1d
    Bitget: 1m, 5m, 15m, 30m, 1H, 4H, 1D
    """
    interval_map = {
        "1m": "1m",
        "3m": "3m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1H",
        "2h": "2H",
        "4h": "4H",
        "6h": "6H",
        "12h": "12H",
        "1d": "1D",
        "1w": "1W",
        "1M": "1M"
    }
    return interval_map.get(interval, "1m")


def convert_interval_to_okx(interval: str) -> str:
    """
    轉換通用時間間隔為 OKX 格式
    通用: 1m, 5m, 15m, 30m, 1h, 4h, 1d
    OKX: 1m, 5m, 15m, 30m, 1H, 4H, 1D
    """
    interval_map = {
        "1m": "1m",
        "3m": "3m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "1H",
        "2h": "2H",
        "4h": "4H",
        "6h": "6H",
        "12h": "12H",
        "1d": "1D",
        "1w": "1W",
        "1M": "1M"
    }
    return interval_map.get(interval, "1m")


async def fetch_bybit_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """
    從 Bybit 獲取 K 線數據
    
    Args:
        symbol: 交易對 (ETHUSDT)
        category: 類別 (spot/linear)
        interval: 時間間隔 (1m, 5m, 1h...)
        limit: 數據量 (最大 1000)
        start_time: 開始時間戳（毫秒），可選
        end_time: 結束時間戳（毫秒），可選
    
    Returns:
        統一格式的 K 線數據列表
    """
    try:
        url = "https://api.bybit.com/v5/market/kline"
        params = {
            "category": category,
            "symbol": symbol,
            "interval": convert_interval_to_bybit(interval),
            "limit": min(limit, 1000)  # Bybit 最大 1000
        }
        
        # 添加時間範圍參數（Bybit 使用 start 和 end，單位為毫秒）
        if start_time is not None:
            # 如果傳入的是秒，轉換為毫秒
            params["start"] = str(start_time if start_time > 1e12 else start_time * 1000)
        if end_time is not None:
            params["end"] = str(end_time if end_time > 1e12 else end_time * 1000)
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        
        if data.get("retCode") != 0:
            raise Exception(f"Bybit API 錯誤: {data.get('retMsg')}")
        
        # 解析 Bybit 數據格式
        # list[0]: startTime, list[1]: open, list[2]: high, 
        # list[3]: low, list[4]: close, list[5]: volume
        klines = []
        raw_list = data.get("result", {}).get("list", [])
        
        for item in raw_list:
            klines.append({
                "time": int(item[0]) // 1000,  # 毫秒 → 秒
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),  # closePrice
                "volume": float(item[5])
            })
        
        # Bybit 返回的是降序，強制按時間升序排序
        klines.sort(key=lambda x: x["time"])
        
        logger.info(f"Bybit K線數據獲取成功: {symbol} {category} {interval} {len(klines)}根")
        return klines
        
    except Exception as e:
        logger.error(f"Bybit K線獲取失敗: {str(e)}")
        raise Exception(f"Bybit K線獲取失敗: {str(e)}")


async def fetch_binance_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """
    從 Binance 獲取 K 線數據
    
    Args:
        symbol: 交易對 (ETHUSDT)
        category: 類別 (spot/linear)
        interval: 時間間隔 (1m, 5m, 1h...)
        limit: 數據量 (最大 1000)
        start_time: 開始時間戳（毫秒），可選
        end_time: 結束時間戳（毫秒），可選
    
    Returns:
        統一格式的 K 線數據列表
    """
    try:
        # 根據 category 選擇不同的 Base URL
        if category == "spot":
            base_url = "https://api.binance.com"
            endpoint = "/api/v3/klines"
        else:  # linear (合約)
            base_url = "https://fapi.binance.com"
            endpoint = "/fapi/v1/klines"
        
        url = f"{base_url}{endpoint}"
        params = {
            "symbol": symbol,
            "interval": convert_interval_to_binance(interval),
            "limit": min(limit, 1000)  # Binance 最大 1500，但我們限制 1000
        }
        
        # 添加時間範圍參數（Binance 使用 startTime 和 endTime，單位為毫秒）
        if start_time is not None:
            params["startTime"] = str(start_time if start_time > 1e12 else start_time * 1000)
        if end_time is not None:
            params["endTime"] = str(end_time if end_time > 1e12 else end_time * 1000)
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        
        # 解析 Binance 數據格式
        # [0]: 開盤時間, [1]: 開盤價, [2]: 最高價, 
        # [3]: 最低價, [4]: 收盤價, [5]: 成交量
        klines = []
        for item in data:
            klines.append({
                "time": int(item[0]) // 1000,  # 毫秒 → 秒
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),  # closePrice
                "volume": float(item[5])
            })
        
        # 確保數據按時間升序排序
        klines.sort(key=lambda x: x["time"])
        
        logger.info(f"Binance K線數據獲取成功: {symbol} {category} {interval} {len(klines)}根")
        return klines
        
    except Exception as e:
        logger.error(f"Binance K線獲取失敗: {str(e)}")
        raise Exception(f"Binance K線獲取失敗: {str(e)}")


async def fetch_mexc_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """Fetch MEXC spot klines."""
    try:
        if category != "spot":
            raise Exception("MEXC currently supports spot klines only")

        url = "https://api.mexc.com/api/v3/klines"
        mexc_interval = convert_interval_to_mexc(interval)
        interval_ms = get_interval_milliseconds(interval)
        requested_limit = min(limit, 1000)
        batch_limit = 500

        def to_milliseconds(value: Optional[int]) -> Optional[int]:
            if value is None:
                return None
            return int(value if value > 1e12 else value * 1000)

        async def fetch_batch(
            client: httpx.AsyncClient,
            current_limit: int,
            batch_start_ms: Optional[int] = None,
            batch_end_ms: Optional[int] = None,
        ) -> list:
            params = {
                "symbol": symbol.upper(),
                "interval": mexc_interval,
                "limit": min(current_limit, batch_limit),
            }
            if batch_start_ms is not None:
                params["startTime"] = str(batch_start_ms)
            if batch_end_ms is not None:
                params["endTime"] = str(batch_end_ms)

            response = await client.get(url, params=params)
            response.raise_for_status()
            raw_data = response.json()
            return raw_data if isinstance(raw_data, list) else []

        start_ms = to_milliseconds(start_time)
        end_ms = to_milliseconds(end_time)
        raw_rows = []

        async with httpx.AsyncClient(timeout=10.0) as client:
            if start_ms is not None:
                cursor_start = start_ms
                final_end = end_ms
                while len(raw_rows) < requested_limit:
                    remaining = requested_limit - len(raw_rows)
                    current_limit = min(remaining, batch_limit)
                    batch_end = final_end
                    if batch_end is None:
                        batch_end = cursor_start + interval_ms * (current_limit - 1)
                    else:
                        batch_end = min(batch_end, cursor_start + interval_ms * (current_limit - 1))

                    batch = await fetch_batch(client, current_limit, cursor_start, batch_end)
                    if not batch:
                        break

                    raw_rows.extend(batch)
                    newest_ms = int(batch[-1][0])
                    next_start = newest_ms + interval_ms
                    if next_start <= cursor_start or (final_end is not None and next_start > final_end):
                        break
                    if len(batch) < current_limit:
                        break
                    cursor_start = next_start
            else:
                first_batch_end = end_ms
                if first_batch_end is None:
                    first_batch = await fetch_batch(client, min(requested_limit, batch_limit))
                else:
                    first_limit = min(requested_limit, batch_limit)
                    first_batch_start = first_batch_end - interval_ms * (first_limit - 1)
                    first_batch = await fetch_batch(client, first_limit, first_batch_start, first_batch_end)

                raw_rows.extend(first_batch)

                while len(raw_rows) < requested_limit and raw_rows:
                    oldest_ms = int(raw_rows[0][0])
                    previous_end = oldest_ms - interval_ms
                    remaining = requested_limit - len(raw_rows)
                    current_limit = min(remaining, batch_limit)
                    previous_start = previous_end - interval_ms * (current_limit - 1)
                    batch = await fetch_batch(client, current_limit, previous_start, previous_end)
                    if not batch:
                        break
                    raw_rows = batch + raw_rows
                    if len(batch) < current_limit:
                        break

        klines = []
        seen_times = set()
        for item in raw_rows:
            open_time = int(item[0]) // 1000
            if open_time in seen_times:
                continue
            seen_times.add(open_time)
            klines.append({
                "time": open_time,
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
                "volume": float(item[5]),
            })
        klines.sort(key=lambda x: x["time"])
        klines = klines[-requested_limit:] if len(klines) > requested_limit else klines
        logger.info(f"MEXC Kline fetch success: {symbol} {category} {interval} {len(klines)} rows")
        return klines
    except Exception as e:
        logger.error(f"MEXC Kline fetch failed: {str(e)}")
        raise Exception(f"MEXC Kline fetch failed: {str(e)}")


async def fetch_bitget_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """
    從 Bitget 獲取 K 線數據
    
    API 文檔：https://www.bitget.com/api-doc/contract/market/Get-Candle-Data
    
    Args:
        symbol: 交易對 (ETHUSDT, BTCUSDT)
        category: 類別 (linear=USDT合約)
        interval: 時間間隔 (1m, 5m, 1h...)
        limit: 數據量 (默認100, 最大1000)
        start_time: 開始時間戳（毫秒），可選
        end_time: 結束時間戳（毫秒），可選
    
    Returns:
        統一格式的 K 線數據列表（升序）
    
    注意：
    - productType 必須小寫：usdt-futures, coin-futures, usdc-futures
    - granularity 格式：1m, 5m, 1H, 4H, 1D 等（注意大小寫）
    - 返回數據默認降序，需反轉
    """
    try:
        url = "https://api.bitget.com/api/v2/mix/market/candles"
        
        # Bitget productType 映射（必須小寫）
        if category == "linear":
            product_type = "usdt-futures"  # ⚠️ 必須小寫
        elif category == "inverse":
            product_type = "coin-futures"
        else:
            product_type = "usdt-futures"
        
        params = {
            "symbol": symbol,  # ETHUSDT, BTCUSDT
            "productType": product_type,  # usdt-futures (小寫)
            "granularity": convert_interval_to_bitget(interval),  # 1m, 1H, 1D
            "limit": str(min(limit, 1000)),  # 最大 1000
            "kLineType": "MARKET"  # MARKET=行情, MARK=標記, INDEX=指數
        }
        
        # 添加時間範圍參數（Bitget 使用 startTime 和 endTime，單位為毫秒）
        if start_time is not None:
            params["startTime"] = str(start_time if start_time > 1e12 else start_time * 1000)
        if end_time is not None:
            params["endTime"] = str(end_time if end_time > 1e12 else end_time * 1000)
        
        logger.info(f"Bitget K線請求: {url} params={params}")
        
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()
        
        # 檢查響應碼
        if data.get("code") != "00000":
            error_msg = data.get("msg", "Unknown error")
            logger.error(f"Bitget API 錯誤: code={data.get('code')}, msg={error_msg}")
            raise Exception(f"Bitget API 錯誤: {error_msg}")
        
        # 解析 Bitget 數據格式
        # 數據格式：[timestamp, open, high, low, close, baseVolume, quoteVolume]
        # index[0]: 時間戳（毫秒）
        # index[1]: 開盤價
        # index[2]: 最高價
        # index[3]: 最低價
        # index[4]: 收盤價
        # index[5]: 交易幣成交量（Base Volume）
        # index[6]: 計價幣成交量（Quote Volume）
        klines = []
        raw_list = data.get("data", [])
        
        if not raw_list:
            logger.warning(f"Bitget 返回空數據: {symbol} {interval}")
            return []
        
        for item in raw_list:
            try:
                klines.append({
                    "time": int(item[0]) // 1000,  # 毫秒 → 秒
                    "open": float(item[1]),
                    "high": float(item[2]),
                    "low": float(item[3]),
                    "close": float(item[4]),  # closePrice
                    "volume": float(item[5])  # baseVolume
                })
            except (IndexError, ValueError) as e:
                logger.error(f"Bitget 數據解析錯誤: {item}, error={str(e)}")
                continue
        
        # Bitget 返回的數據順序不確定，強制按時間升序排序
        klines.sort(key=lambda x: x["time"])
        
        logger.info(f"✅ Bitget K線數據獲取成功: {symbol} {product_type} {interval} {len(klines)}根")
        return klines
        
    except httpx.HTTPStatusError as e:
        logger.error(f"Bitget HTTP 錯誤: status={e.response.status_code}, body={e.response.text}")
        raise Exception(f"Bitget HTTP 錯誤: {e.response.status_code}")
    except Exception as e:
        logger.error(f"Bitget K線獲取失敗: {str(e)}")
        raise Exception(f"Bitget K線獲取失敗: {str(e)}")


async def fetch_okx_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """
    從 OKX 獲取 K 線歷史數據（使用 history-candles API）
    
    Args:
        symbol: 交易對 (ETHUSDT)
        category: 類別 (目前僅支援 linear/合約)
        interval: 時間間隔 (1m, 5m, 1h...)
        limit: 數據量 (OKX 單次最大 300，支持分批獲取）
        start_time: 開始時間戳（毫秒），可選。如果提供，會使用 before 參數
        end_time: 結束時間戳（毫秒），可選。如果提供，會使用 after 參數
    
    Returns:
        統一格式的 K 線數據列表
        
    注意：
    - 使用 /api/v5/market/history-candles API，支持查詢多年歷史數據
    - OKX API 單次最大返回 300 根 K 線
    - 如需更多數據，使用 after 參數進行分批獲取
    - 限速：20次/2s
    - OKX 使用 after（請求此時間之前的數據）和 before（請求此時間之後的數據）
    """
    try:
        # OKX symbol format: spot ETH-USDT, linear ETH-USDT-SWAP.
        suffix = "" if category == "spot" else "-SWAP"
        if symbol.endswith("USDT"):
            base = symbol[:-4]
            okx_symbol = f"{base}-USDT{suffix}"
        elif symbol.endswith("USD"):
            base = symbol[:-3]
            okx_symbol = f"{base}-USD{suffix}"
        else:
            okx_symbol = symbol
        
        url = "https://www.okx.com/api/v5/market/history-candles"
        all_klines = []
        
        # OKX 單次最大 300，如果需要更多，使用 after 參數分批獲取
        batch_size = 300
        batches_needed = (limit + batch_size - 1) // batch_size  # 計算需要的批數
        
        logger.info(f"OKX K線請求: {okx_symbol} {interval}, 需要 {limit} 根，分 {batches_needed} 批獲取")
        
        # 轉換時間戳為毫秒（如果傳入的是秒）
        after_timestamp = None
        before_timestamp = None
        
        if end_time is not None:
            # end_time 對應 OKX 的 after（請求此時間之前的數據）
            after_timestamp = end_time if end_time > 1e12 else end_time * 1000
        if start_time is not None:
            # start_time 對應 OKX 的 before（請求此時間之後的數據）
            before_timestamp = start_time if start_time > 1e12 else start_time * 1000
        
        for batch_num in range(batches_needed):
            params = {
                "instId": okx_symbol,
                "bar": convert_interval_to_okx(interval),
                "limit": str(batch_size)
            }
            
            # OKX 使用 after（請求此時間之前的數據）和 before（請求此時間之後的數據）
            if before_timestamp:
                params["before"] = str(before_timestamp)
            elif after_timestamp:
                params["after"] = str(after_timestamp)
            
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                data = response.json()
            
            if data.get("code") != "0":
                logger.error(f"OKX API 錯誤: code={data.get('code')}, msg={data.get('msg')}")
                break
            
            raw_list = data.get("data", [])
            if not raw_list:
                logger.warning(f"OKX 第 {batch_num + 1} 批返回空數據")
                break
            
            # 解析數據
            for item in raw_list:
                all_klines.append({
                    "time": int(item[0]) // 1000,  # 毫秒 → 秒
                    "open": float(item[1]),
                    "high": float(item[2]),
                    "low": float(item[3]),
                    "close": float(item[4]),
                    "volume": float(item[5])
                })
            
            # 更新 after 時間戳為最舊的那根 K 線（OKX 降序返回）
            # after 參數表示"請求此時間戳之前的數據"
            oldest_timestamp = int(raw_list[-1][0])  # 最後一個是最舊的
            # 如果沒有指定時間範圍，使用 after 進行分頁
            if before_timestamp is None:
                after_timestamp = oldest_timestamp
            
            logger.info(f"OKX 第 {batch_num + 1} 批: 獲取 {len(raw_list)} 根")
            
            # 如果已經獲取足夠數據，停止
            if len(all_klines) >= limit:
                break
        
        # 去重（可能有重複的時間戳）並排序
        unique_klines = {k["time"]: k for k in all_klines}.values()
        klines = sorted(unique_klines, key=lambda x: x["time"])
        
        # 限制到請求的數量
        klines = klines[-limit:] if len(klines) > limit else klines
        
        logger.info(f"✅ OKX K線數據獲取成功: {okx_symbol} {interval} {len(klines)}根（共 {batches_needed} 批）")
        return klines
        
    except Exception as e:
        logger.error(f"OKX K線獲取失敗: {str(e)}")
        raise Exception(f"OKX K線獲取失敗: {str(e)}")


async def fetch_aster_klines(
    symbol: str,
    category: str,
    interval: str,
    limit: int,
    start_time: Optional[int] = None,
    end_time: Optional[int] = None
) -> list:
    """
    從 Aster 獲取 K 線數據（合約 v3）
    
    注意：
    - 目前 Aster 僅支援 linear（USDT-M 永續）
    - 端點：GET /fapi/v3/klines
    """
    try:
        if category != "linear":
            raise Exception("Aster 目前僅支援 linear 類型 K 線")

        url = "https://fapi.asterdex.com/fapi/v3/klines"
        params = {
            "symbol": symbol,
            "interval": convert_interval_to_aster(interval),
            "limit": min(limit, 1000),
        }

        # 參數格式與 Binance 相容（毫秒）
        if start_time is not None:
            params["startTime"] = str(start_time if start_time > 1e12 else start_time * 1000)
        if end_time is not None:
            params["endTime"] = str(end_time if end_time > 1e12 else end_time * 1000)

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params=params)
            response.raise_for_status()
            data = response.json()

        # 預期格式同 Binance：
        # [0]: 開盤時間, [1]: open, [2]: high, [3]: low, [4]: close, [5]: volume
        klines = []
        for item in data:
            klines.append({
                "time": int(item[0]) // 1000,
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
                "volume": float(item[5]),
            })

        klines.sort(key=lambda x: x["time"])
        logger.info(f"Aster K線數據獲取成功: {symbol} {category} {interval} {len(klines)}根")
        return klines

    except Exception as e:
        logger.error(f"Aster K線獲取失敗: {str(e)}")
        raise Exception(f"Aster K線獲取失敗: {str(e)}")


@router.get("/klines/{exchange}/{symbol}")
async def get_klines(
    exchange: str,
    symbol: str,
    category: str = Query("linear", description="交易類型: spot/linear"),
    interval: str = Query("1m", description="時間間隔: 1m/5m/15m/1h/4h/1d"),
    limit: int = Query(300, description="數據量限制，最大 1000"),
    startTime: Optional[int] = Query(None, description="開始時間戳（毫秒或秒），可選"),
    endTime: Optional[int] = Query(None, description="結束時間戳（毫秒或秒），可選")
):
    """
    獲取 K 線歷史數據
    
    支持的交易所：
    - bybit: 現貨和合約
    - binance: 現貨和合約
    - bitget: 合約（USDT-M）
    - okx: 合約（USDT-M）
    - aster: 合約（USDT-M）
    
    參數說明：
    - exchange: 交易所名稱 (bybit/binance/bitget/okx)
    - symbol: 交易對 (ETHUSDT, BTCUSDT...)
    - category: 交易類型
        - spot: 現貨（bybit/binance）
        - linear: 永續合約/USDT合約（全交易所）
    - interval: K線時間間隔
        - 1m, 3m, 5m, 15m, 30m (分鐘)
        - 1h, 2h, 4h, 6h, 12h (小時)
        - 1d (天), 1w (週), 1M (月)
    - limit: 返回的K線數量，默認300
        - bybit/binance/bitget: 最大1000
        - okx: 最大300
    - startTime: 開始時間戳（毫秒或秒），可選。用於查詢指定時間範圍的歷史數據
    - endTime: 結束時間戳（毫秒或秒），可選。用於查詢指定時間範圍的歷史數據
    
    返回格式：
    {
        "success": true,
        "data": [
            {
                "time": 1730102400,      // Unix時間戳（秒）
                "open": 4120.5,          // 開盤價
                "high": 4125.0,          // 最高價
                "low": 4118.0,           // 最低價
                "close": 4122.5,         // 收盤價
                "volume": 1234.56        // 成交量
            },
            ...
        ],
        "timestamp": 1730102400000
    }
    """
    try:
        # 參數驗證
        if limit <= 0 or limit > 1000:
            return api_error("limit 必須在 1-1000 之間")
        
        if category not in ["spot", "linear"]:
            return api_error("category 必須是 spot 或 linear")
        
        # 根據交易所調用對應的函數
        exchange_lower = exchange.lower()
        if exchange_lower == "bybit":
            klines = await fetch_bybit_klines(symbol, category, interval, limit, startTime, endTime)
        elif exchange_lower == "binance":
            klines = await fetch_binance_klines(symbol, category, interval, limit, startTime, endTime)
        elif exchange_lower == "mexc":
            klines = await fetch_mexc_klines(symbol, category, interval, limit, startTime, endTime)
        elif exchange_lower == "bitget":
            klines = await fetch_bitget_klines(symbol, category, interval, limit, startTime, endTime)
        elif exchange_lower == "okx":
            klines = await fetch_okx_klines(symbol, category, interval, limit, startTime, endTime)
        elif exchange_lower == "aster":
            klines = await fetch_aster_klines(symbol, category, interval, limit, startTime, endTime)
        else:
            return api_error(f"不支持的交易所: {exchange}")
        
        return api_success(
            data=klines,
            message=f"成功獲取 {len(klines)} 根 K 線數據"
        )
        
    except Exception as e:
        logger.error(f"K線API錯誤: {str(e)}")
        return api_error(str(e), status_code=500)


@router.get("/klines/{exchange}/{symbol}/latest")
async def get_latest_kline(
    exchange: str,
    symbol: str,
    category: str = Query("linear", description="交易類型: spot/linear"),
    interval: str = Query("1m", description="時間間隔")
):
    """
    獲取最新一根 K 線數據
    
    用於實時更新圖表，比 WebSocket 更輕量
    支持的交易所：bybit, binance, bitget, okx, aster
    """
    try:
        # 只獲取最新 1 根
        exchange_lower = exchange.lower()
        if exchange_lower == "bybit":
            klines = await fetch_bybit_klines(symbol, category, interval, 1)
        elif exchange_lower == "binance":
            klines = await fetch_binance_klines(symbol, category, interval, 1)
        elif exchange_lower == "mexc":
            klines = await fetch_mexc_klines(symbol, category, interval, 1)
        elif exchange_lower == "bitget":
            klines = await fetch_bitget_klines(symbol, category, interval, 1)
        elif exchange_lower == "okx":
            klines = await fetch_okx_klines(symbol, category, interval, 1)
        elif exchange_lower == "aster":
            klines = await fetch_aster_klines(symbol, category, interval, 1)
        else:
            return api_error(f"不支持的交易所: {exchange}")
        
        if not klines:
            return api_error("未獲取到數據")
        
        return api_success(
            data=klines[-1],  # 返回最後一根（最新）
            message="成功獲取最新 K 線"
        )
        
    except Exception as e:
        logger.error(f"最新K線API錯誤: {str(e)}")
        return api_error(str(e), status_code=500)
