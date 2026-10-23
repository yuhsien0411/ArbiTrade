"""
Aster 交易所實作（合約 v3）
"""

import copy
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import aiohttp
from eth_account import Account
try:
    from eth_account.messages import encode_typed_data

    def _encode_aster_typed_data(typed_data: Dict[str, Any]):
        return encode_typed_data(full_message=typed_data)
except ImportError:
    from eth_account.messages import encode_structured_data

    def _encode_aster_typed_data(typed_data: Dict[str, Any]):
        return encode_structured_data(typed_data)

from .base import (
    AccountMode,
    AccountSummary,
    Balance,
    BaseExchange,
    FundingRate,
    OrderBookData,
    OrderResult,
    OrderSide,
    OrderType,
    Position,
    TickerData,
    TradeType,
)
from ..utils.logger import get_logger


ASTER_TYPED_DATA_TEMPLATE = {
    "types": {
        "EIP712Domain": [
            {"name": "name", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "chainId", "type": "uint256"},
            {"name": "verifyingContract", "type": "address"},
        ],
        "Message": [{"name": "msg", "type": "string"}],
    },
    "primaryType": "Message",
    "domain": {
        "name": "AsterSignTransaction",
        "version": "1",
        "chainId": 1666,
        "verifyingContract": "0x0000000000000000000000000000000000000000",
    },
    "message": {"msg": "$msg"},
}


class AsterExchange(BaseExchange):
    """Aster 合約交易所實作（僅 linear）"""

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        testnet: bool = False,
        signer: str = "",
    ):
        # 沿用 BaseExchange 欄位：api_key -> user, api_secret -> private_key
        super().__init__(api_key=api_key, api_secret=api_secret, testnet=testnet)
        self.user = (api_key or "").strip()
        self.private_key = (api_secret or "").strip()
        self.signer = signer.strip()
        self.logger = get_logger()

        # 文件主網是 fapi.asterdex.com，若 testnet 未提供固定 domain，先回主網
        self.base_url = "https://fapi.asterdex.com"

        self._nonce_lock = threading.Lock()
        self._last_second = 0
        self._nonce_incr = 0

        self.headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Arbitrade/1.0",
        }
        self._authenticated = bool(self.user and self.private_key and self.signer)

    @property
    def name(self) -> str:
        return "Aster"

    def _ensure_linear(self, trade_type: TradeType):
        if trade_type != TradeType.LINEAR:
            raise ValueError("Aster 目前僅支援 linear 合約")

    def _get_nonce(self) -> int:
        """官方範例 nonce：seconds * 1_000_000 + counter"""
        with self._nonce_lock:
            now_second = int(time.time())
            if now_second == self._last_second:
                self._nonce_incr += 1
            else:
                self._last_second = now_second
                self._nonce_incr = 0
            return now_second * 1_000_000 + self._nonce_incr

    def _sign_query_string(self, query_string: str) -> str:
        typed_data = copy.deepcopy(ASTER_TYPED_DATA_TEMPLATE)
        typed_data["message"]["msg"] = query_string
        signable = _encode_aster_typed_data(typed_data)
        signed = Account.sign_message(signable, private_key=self.private_key)
        return signed.signature.hex()

    def _build_signed_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        signed_params = {k: v for k, v in (params or {}).items() if v is not None}
        signed_params["nonce"] = str(self._get_nonce())
        signed_params["user"] = self.user
        signed_params["signer"] = self.signer
        query_string = urlencode(signed_params)
        signed_params["signature"] = self._sign_query_string(query_string)
        return signed_params

    async def _make_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict[str, Any]] = None,
        signed: bool = False,
    ) -> Any:
        if signed:
            self._check_authentication()
            req_params = self._build_signed_params(params or {})
        else:
            req_params = {k: v for k, v in (params or {}).items() if v is not None}

        url = f"{self.base_url}{endpoint}"
        timeout = aiohttp.ClientTimeout(total=30, connect=10)

        async with aiohttp.ClientSession(timeout=timeout, headers=self.headers) as session:
            method_upper = method.upper()
            if method_upper == "GET":
                async with session.get(url, params=req_params) as response:
                    data = await self._parse_response(response)
            elif method_upper == "POST":
                async with session.post(url, data=req_params) as response:
                    data = await self._parse_response(response)
            elif method_upper == "DELETE":
                async with session.delete(url, params=req_params) as response:
                    data = await self._parse_response(response)
            else:
                raise ValueError(f"不支援的 HTTP 方法: {method}")

        if isinstance(data, dict) and "code" in data:
            code = data.get("code")
            if code not in (0, 200, "0", "200", None):
                raise Exception(f"Aster API 錯誤: code={code}, msg={data.get('msg', '')}")

        return data

    async def _parse_response(self, response: aiohttp.ClientResponse) -> Any:
        body = await response.text()
        if response.status != 200:
            raise Exception(f"Aster HTTP 錯誤: {response.status}, body={body[:300]}")

        content_type = response.headers.get("Content-Type", "")
        if "application/json" not in content_type:
            raise Exception(f"Aster 響應非 JSON: {content_type}, body={body[:300]}")
        return await response.json()

    def _normalize_symbol_type(self, symbol: str) -> Tuple[str, str]:
        upper = symbol.upper().replace("/", "").replace("-", "").split(":")[0].strip()
        for suffix in (".P", "PERP", "SWAP", "FUTURES"):
            if upper.endswith(suffix):
                upper = upper[: -len(suffix)]
        for quote in ("USDT", "USDC", "BUSD"):
            if upper.endswith(quote):
                return upper[: -len(quote)], quote
        return upper, "USDT"

    def _safe_float(self, value: Any, default: float = 0.0) -> float:
        try:
            if value in (None, ""):
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        self._ensure_linear(trade_type)
        symbol = self._normalize_symbol(symbol)
        data = await self._make_request("GET", "/fapi/v3/ticker/24hr", {"symbol": symbol})
        return TickerData(
            symbol=data.get("symbol", symbol),
            bid_price=float(data.get("bidPrice", 0.0)),
            ask_price=float(data.get("askPrice", 0.0)),
            last_price=float(data.get("lastPrice", 0.0)),
            volume_24h=float(data.get("volume", 0.0)),
            timestamp=int(data.get("closeTime", int(time.time() * 1000))),
            high_24h=float(data.get("highPrice", 0.0)),
            low_24h=float(data.get("lowPrice", 0.0)),
            change_24h=float(data.get("priceChange", 0.0)),
            change_percent_24h=float(data.get("priceChangePercent", 0.0)),
        )

    async def get_orderbook(
        self,
        symbol: str,
        limit: int = 25,
        trade_type: TradeType = TradeType.SPOT,
    ) -> OrderBookData:
        self._ensure_linear(trade_type)
        symbol = self._normalize_symbol(symbol)
        data = await self._make_request("GET", "/fapi/v3/depth", {"symbol": symbol, "limit": limit})
        bids = [(float(x[0]), float(x[1])) for x in data.get("bids", [])]
        asks = [(float(x[0]), float(x[1])) for x in data.get("asks", [])]
        return OrderBookData(
            symbol=data.get("symbol", symbol),
            bids=bids,
            asks=asks,
            timestamp=int(data.get("T", int(time.time() * 1000))),
        )

    async def get_symbols(self, trade_type: TradeType = TradeType.SPOT) -> List[str]:
        self._ensure_linear(trade_type)
        data = await self._make_request("GET", "/fapi/v3/exchangeInfo")
        symbols: List[str] = []
        for item in data.get("symbols", []):
            if item.get("status") == "TRADING":
                symbols.append(item.get("symbol", ""))
        return [s for s in symbols if s]

    async def place_order(
        self,
        symbol: str,
        side: OrderSide,
        quantity: float,
        order_type: OrderType = OrderType.MARKET,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.SPOT,
        **kwargs,
    ) -> OrderResult:
        self._ensure_linear(trade_type)
        self._check_authentication()
        self._validate_quantity(quantity)
        if order_type == OrderType.LIMIT:
            self._validate_price(price)

        symbol = self._normalize_symbol(symbol)
        params: Dict[str, Any] = {
            "symbol": symbol,
            "side": "BUY" if side == OrderSide.BUY else "SELL",
            "type": "MARKET" if order_type == OrderType.MARKET else "LIMIT",
            "quantity": str(quantity),
        }
        if order_type == OrderType.LIMIT:
            params["price"] = str(price)
            params["timeInForce"] = kwargs.get("timeInForce", "GTC")

        passthrough_keys = [
            "positionSide",
            "reduceOnly",
            "newClientOrderId",
            "stopPrice",
            "workingType",
            "priceProtect",
            "newOrderRespType",
        ]
        for key in passthrough_keys:
            if key in kwargs and kwargs[key] is not None:
                params[key] = kwargs[key]

        data = await self._make_request("POST", "/fapi/v3/order", params=params, signed=True)
        return OrderResult(
            success=True,
            order_id=str(data.get("orderId", "")),
            price=float(data.get("avgPrice") or data.get("price") or 0.0),
            quantity=float(data.get("executedQty") or data.get("origQty") or quantity),
            timestamp=int(data.get("updateTime", int(time.time() * 1000))),
        )

    async def cancel_order(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> bool:
        self._ensure_linear(trade_type)
        self._check_authentication()
        symbol = self._normalize_symbol(symbol)
        data = await self._make_request(
            "DELETE",
            "/fapi/v3/order",
            params={"symbol": symbol, "orderId": order_id},
            signed=True,
        )
        return str(data.get("orderId", "")) == str(order_id) or data.get("status") == "CANCELED"

    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> Dict[str, Any]:
        self._ensure_linear(trade_type)
        self._check_authentication()
        symbol = self._normalize_symbol(symbol)
        return await self._make_request(
            "GET",
            "/fapi/v3/order",
            params={"symbol": symbol, "orderId": order_id},
            signed=True,
        )

    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        self._ensure_linear(trade_type)
        order = await self.get_order_status(symbol=symbol, order_id=order_id, trade_type=trade_type)
        avg_price = float(order.get("avgPrice", 0.0))
        if avg_price > 0:
            return avg_price

        try:
            trades = await self._make_request(
                "GET",
                "/fapi/v3/userTrades",
                params={"symbol": self._normalize_symbol(symbol), "orderId": order_id, "limit": 100},
                signed=True,
            )
            if not isinstance(trades, list) or not trades:
                return None
            total_qty = 0.0
            total_quote = 0.0
            for trade in trades:
                qty = float(trade.get("qty", 0.0))
                price = float(trade.get("price", 0.0))
                total_qty += qty
                total_quote += qty * price
            if total_qty <= 0:
                return None
            return total_quote / total_qty
        except Exception:
            return None

    async def _get_usdt_price_map(self) -> Dict[str, float]:
        """
        獲取全量 ticker 價格，構建 baseAsset -> USDT 價格映射。
        """
        price_map: Dict[str, float] = {}
        try:
            data = await self._make_request("GET", "/fapi/v3/ticker/price")
            rows = data if isinstance(data, list) else []
            for row in rows:
                symbol = str(row.get("symbol", "")).upper()
                if not symbol.endswith("USDT"):
                    continue
                base = symbol[:-4]
                try:
                    price = float(row.get("price", 0.0))
                    if price > 0:
                        price_map[base] = price
                except (TypeError, ValueError):
                    continue
        except Exception:
            # 價格映射失敗時回退，保持可用
            return {}
        return price_map

    async def get_balances(self) -> List[Balance]:
        self._check_authentication()
        account_data = None
        try:
            # 優先使用帳戶信息 v3（欄位更完整）
            account_data = await self._make_request("GET", "/fapi/v3/accountWithJoinMargin", signed=True)
        except Exception:
            account_data = None

        # 回退到 balance v3
        data = None
        if not account_data:
            data = await self._make_request("GET", "/fapi/v3/balance", signed=True)

        price_map = await self._get_usdt_price_map()
        stable_assets = {"USDT", "USDC", "USDCE", "USDBC", "BONUSUSD"}

        balances: List[Balance] = []
        source_rows = []
        if isinstance(account_data, dict):
            source_rows = account_data.get("assets", []) or []
        elif isinstance(data, list):
            source_rows = data

        for item in source_rows:
            asset = str(item.get("asset", "")).upper()
            if not asset:
                continue

            # accountWithJoinMargin: walletBalance；balance: balance
            wallet = float(item.get("walletBalance", item.get("balance", 0.0)))
            # 合約帳戶視角：availableBalance 為現貨可購買額度，不作為 free 使用
            # 前端展示餘額時以 walletBalance 為準。
            if abs(wallet) <= 1e-12:
                continue
            free = wallet
            locked = 0.0

            if asset in stable_assets:
                usdt_value = wallet
            else:
                usdt_value = wallet * price_map.get(asset, 0.0)

            balances.append(
                Balance(
                    asset=asset,
                    free=free,
                    locked=locked,
                    borrowed=0.0,
                    usdt_value=usdt_value,
                )
            )
        return balances

    async def get_positions(self) -> List[Position]:
        self._check_authentication()
        data = await self._make_request("GET", "/fapi/v3/positionRisk", signed=True)
        positions: List[Position] = []

        for item in data if isinstance(data, list) else []:
            amt = float(item.get("positionAmt", 0.0))
            if abs(amt) <= 0:
                continue

            symbol = item.get("symbol", "")
            base_asset, quote_asset = self._normalize_symbol_type(symbol)
            mark_price = float(item.get("markPrice", 0.0))
            entry_price = float(item.get("entryPrice", 0.0))
            pnl = float(item.get("unRealizedProfit", 0.0))
            side = "long" if amt > 0 else "short"
            leverage = float(item.get("leverage", 1.0))
            margin_mode = str(item.get("marginType", "cross")).lower()
            liquidation = float(item.get("liquidationPrice", 0.0))

            positions.append(
                Position(
                    symbol=symbol,
                    base_asset=base_asset,
                    quote_asset=quote_asset,
                    position_type="perp_linear",
                    side=side,
                    size=abs(amt),
                    entry_price=entry_price,
                    mark_price=mark_price,
                    unrealized_pnl=pnl,
                    leverage=leverage,
                    margin_mode=margin_mode,
                    liquidation_price=liquidation if liquidation > 0 else None,
                )
            )
        return positions

    async def get_account_summary(self) -> AccountSummary:
        self._check_authentication()
        now_ts = int(time.time() * 1000)
        try:
            account = await self._make_request("GET", "/fapi/v3/accountWithJoinMargin", signed=True)
            balances = await self.get_balances()
            positions = await self.get_positions()
            total_wallet_balance = self._safe_float(account.get("totalWalletBalance"))
            total_margin_balance = self._safe_float(account.get("totalMarginBalance"))
            total_unrealized_pnl = self._safe_float(
                account.get("totalUnrealizedProfit", account.get("totalUnrealizedPnl"))
            )
            total_initial_margin = self._safe_float(account.get("totalInitialMargin"))
            total_maintenance_margin = self._safe_float(account.get("totalMaintMargin"))

            # Aster follows Binance futures naming: wallet balance excludes
            # unrealized PnL; margin balance is account equity/net value.
            total_equity = total_margin_balance
            if total_equity <= 0:
                total_equity = total_wallet_balance + total_unrealized_pnl
            if total_equity <= 0:
                total_equity = total_wallet_balance

            margin_ratio = (total_initial_margin / total_equity) if total_equity > 0 else 0.0
            maintenance_margin_rate = (
                total_maintenance_margin / total_equity
                if total_equity > 0 and total_maintenance_margin > 0
                else 0.0
            )
            return AccountSummary(
                exchange=self.name.lower(),
                account_mode=AccountMode.CLASSIC.value,
                timestamp=now_ts,
                total_equity_usdt=total_equity,
                total_margin_usdt=total_margin_balance,
                # availableBalance 在 Aster 文檔語意偏向現貨可購買量，優先用可提額度
                available_balance_usdt=self._safe_float(
                    account.get("maxWithdrawAmount", account.get("availableBalance", 0.0))
                ),
                margin_ratio=margin_ratio,
                maintenance_margin_rate=maintenance_margin_rate,
                total_initial_margin=total_initial_margin,
                total_maintenance_margin=total_maintenance_margin,
                balances=balances,
                positions=positions,
            )
        except Exception:
            balances = await self.get_balances()
            positions = await self.get_positions()
            total_usdt = 0.0
            for b in balances:
                if b.asset.upper() == "USDT":
                    total_usdt += b.total
            return AccountSummary(
                exchange=self.name.lower(),
                account_mode=AccountMode.CLASSIC.value,
                timestamp=now_ts,
                total_equity_usdt=total_usdt,
                total_margin_usdt=total_usdt,
                available_balance_usdt=total_usdt,
                balances=balances,
                positions=positions,
            )

    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        endpoint = "/fapi/v3/premiumIndex"
        params: Dict[str, Any] = {}
        if symbols and len(symbols) == 1:
            params["symbol"] = self._normalize_symbol(symbols[0])

        data = await self._make_request("GET", endpoint, params=params)
        rows = data if isinstance(data, list) else [data]
        wanted = set(self._normalize_symbol(s) for s in (symbols or []))
        settlement_interval_map: Dict[str, int] = {}

        # 嘗試獲取各交易對的實際資金費結算週期（小時）
        try:
            funding_info = await self._make_request("GET", "/fapi/v3/fundingInfo")
            if isinstance(funding_info, list):
                for item in funding_info:
                    symbol = str(item.get("symbol", "")).upper()
                    if not symbol:
                        continue
                    try:
                        interval = int(float(item.get("fundingIntervalHours", 8)))
                        if 0 < interval <= 24:
                            settlement_interval_map[symbol] = interval
                    except (TypeError, ValueError):
                        continue
        except Exception as info_error:
            self.logger.debug("aster_funding_info_failed", error=str(info_error))

        # 若 fundingInfo 無資料，回退從 exchangeInfo 讀取
        if not settlement_interval_map:
            try:
                exchange_info = await self._make_request("GET", "/fapi/v3/exchangeInfo")
                for item in exchange_info.get("symbols", []) if isinstance(exchange_info, dict) else []:
                    symbol = str(item.get("symbol", "")).upper()
                    if not symbol:
                        continue
                    try:
                        interval = int(float(item.get("fundingIntervalHours", 8)))
                        if 0 < interval <= 24:
                            settlement_interval_map[symbol] = interval
                    except (TypeError, ValueError):
                        continue
            except Exception as exchange_info_error:
                self.logger.debug("aster_exchange_info_failed", error=str(exchange_info_error))

        rates: List[FundingRate] = []
        for row in rows:
            symbol = row.get("symbol", "")
            if not symbol:
                continue
            if wanted and symbol not in wanted:
                continue

            fr = float(row.get("lastFundingRate", 0.0))
            next_ts = int(row.get("nextFundingTime", 0))
            ts = int(row.get("time", int(time.time() * 1000)))
            settlement_interval = settlement_interval_map.get(symbol.upper(), 8)
            funding_rate_8h = fr * (8 / settlement_interval) if settlement_interval > 0 else fr
            funding_rate_daily = fr * (24 / settlement_interval) if settlement_interval > 0 else fr * 3
            rates.append(
                FundingRate(
                    exchange=self.name.lower(),
                    symbol=symbol,
                    category=TradeType.LINEAR.value,
                    funding_rate=fr,
                    funding_rate_8h=funding_rate_8h,
                    funding_rate_daily=funding_rate_daily,
                    next_funding_time=next_ts,
                    settlement_interval_hours=settlement_interval,
                    timestamp=ts,
                )
            )
        return rates

    async def check_account_mode(self) -> Tuple[str, bool]:
        """Aster 視為 classic（僅合約）"""
        return AccountMode.CLASSIC.value, False

    async def ping(self) -> bool:
        try:
            await self._make_request("GET", "/fapi/v3/time")
            return True
        except Exception:
            return False

    async def get_server_time(self) -> int:
        try:
            data = await self._make_request("GET", "/fapi/v3/time")
            server_time = data.get("serverTime")
            if server_time is not None:
                return int(server_time)
        except Exception:
            pass
        return int(time.time() * 1000)
