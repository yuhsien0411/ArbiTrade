"""
MEXC spot exchange adapter.

Spot and futures on MEXC are separate API products/accounts. This adapter
intentionally supports spot only; futures should be added as a separate scope.
"""

import hashlib
import hmac
import asyncio
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode

import aiohttp

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


class MEXCExchange(BaseExchange):
    """MEXC spot implementation."""

    def __init__(
        self,
        api_key: str = "",
        api_secret: str = "",
        testnet: bool = False,
    ):
        super().__init__(api_key=api_key, api_secret=api_secret, testnet=testnet)
        self.base_url = "https://api.mexc.com"
        self.logger = get_logger()
        self.headers = {
            "Content-Type": "application/json",
            "User-Agent": "ArbiTrade/1.0",
        }

    @property
    def name(self) -> str:
        return "MEXC"

    def _ensure_spot(self, trade_type: TradeType) -> None:
        if trade_type != TradeType.SPOT:
            raise ValueError("MEXC is currently configured for spot only; futures will be added separately")

    def _safe_float(self, value: Any, default: float = 0.0) -> float:
        try:
            if value in (None, ""):
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    def _normalize_symbol(self, symbol: str) -> str:
        return symbol.upper().replace("/", "").replace("-", "").split(":")[0].strip()

    def _normalize_symbol_type(self, symbol: str) -> Tuple[str, str]:
        upper = self._normalize_symbol(symbol)
        for quote in ("USDT", "USDC", "BTC", "ETH", "MX"):
            if upper.endswith(quote) and len(upper) > len(quote):
                return upper[: -len(quote)], quote
        return upper, "USDT"

    async def _get_free_balance(self, asset: str) -> float:
        target = asset.upper()
        balances = await self.get_balances()
        for balance in balances:
            if balance.asset.upper() == target:
                return balance.free
        return 0.0

    async def validate_order_preconditions(
        self,
        symbol: str,
        side: OrderSide,
        quantity: float,
        order_type: OrderType = OrderType.MARKET,
        price: Optional[float] = None,
        trade_type: TradeType = TradeType.SPOT,
        **kwargs,
    ) -> Optional[str]:
        self._ensure_spot(trade_type)
        self._check_authentication()
        self._validate_quantity(quantity)

        base_asset, quote_asset = self._normalize_symbol_type(symbol)
        if side == OrderSide.SELL:
            try:
                available = await self._get_free_balance(base_asset)
            except Exception as exc:
                return f"MEXC spot sell precheck failed: unable to read {base_asset} balance ({exc})"

            if available + 1e-12 < quantity:
                return (
                    f"MEXC spot sell balance insufficient: available {available:.8f} {base_asset}, "
                    f"required {quantity:.8f} {base_asset}"
                )

        quote_order_qty = kwargs.get("quoteOrderQty") or kwargs.get("quote_order_qty")
        if side == OrderSide.BUY and quote_order_qty is not None:
            try:
                available_quote = await self._get_free_balance(quote_asset)
            except Exception as exc:
                return f"MEXC spot buy precheck failed: unable to read {quote_asset} balance ({exc})"

            required_quote = self._safe_float(quote_order_qty)
            if available_quote + 1e-12 < required_quote:
                return (
                    f"MEXC spot buy balance insufficient: available {available_quote:.8f} {quote_asset}, "
                    f"required {required_quote:.8f} {quote_asset}"
                )

        return None

    def _sign_query_string(self, query_string: str) -> str:
        return hmac.new(
            self.api_secret.encode("utf-8"),
            query_string.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _build_signed_params(self, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        signed_params = {k: v for k, v in (params or {}).items() if v is not None}
        signed_params.setdefault("recvWindow", 5000)
        signed_params["timestamp"] = int(time.time() * 1000)
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
            req_params = self._build_signed_params(params)
        else:
            req_params = {k: v for k, v in (params or {}).items() if v is not None}

        headers = dict(self.headers)
        if signed:
            headers["X-MEXC-APIKEY"] = self.api_key

        url = f"{self.base_url}{endpoint}"
        timeout = aiohttp.ClientTimeout(total=30, connect=10)

        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            method_upper = method.upper()
            if method_upper == "GET":
                async with session.get(url, params=req_params) as response:
                    data = await self._parse_response(response)
            elif method_upper == "POST":
                async with session.post(url, params=req_params) as response:
                    data = await self._parse_response(response)
            elif method_upper == "DELETE":
                async with session.delete(url, params=req_params) as response:
                    data = await self._parse_response(response)
            else:
                raise ValueError(f"Unsupported HTTP method: {method}")

        if isinstance(data, dict) and "code" in data:
            code = data.get("code")
            if code not in (0, 200, "0", "200", None):
                raise Exception(f"MEXC API error: code={code}, msg={data.get('msg', data)}")

        return data

    async def _parse_response(self, response: aiohttp.ClientResponse) -> Any:
        body = await response.text()
        if response.status != 200:
            raise Exception(f"MEXC HTTP error: {response.status}, body={body[:300]}")
        if not body:
            return {}
        try:
            return await response.json()
        except Exception:
            raise Exception(f"MEXC response is not JSON: {body[:300]}")

    async def get_ticker(self, symbol: str, trade_type: TradeType = TradeType.SPOT) -> TickerData:
        self._ensure_spot(trade_type)
        symbol = self._normalize_symbol(symbol)
        data = await self._make_request("GET", "/api/v3/ticker/24hr", {"symbol": symbol})
        return TickerData(
            symbol=data.get("symbol", symbol),
            bid_price=self._safe_float(data.get("bidPrice")),
            ask_price=self._safe_float(data.get("askPrice")),
            last_price=self._safe_float(data.get("lastPrice")),
            volume_24h=self._safe_float(data.get("volume")),
            timestamp=int(data.get("closeTime", int(time.time() * 1000))),
            high_24h=self._safe_float(data.get("highPrice")),
            low_24h=self._safe_float(data.get("lowPrice")),
            change_24h=self._safe_float(data.get("priceChange")),
            change_percent_24h=self._safe_float(data.get("priceChangePercent")),
        )

    async def get_orderbook(
        self,
        symbol: str,
        limit: int = 25,
        trade_type: TradeType = TradeType.SPOT,
    ) -> OrderBookData:
        self._ensure_spot(trade_type)
        symbol = self._normalize_symbol(symbol)
        data = await self._make_request("GET", "/api/v3/depth", {"symbol": symbol, "limit": limit})
        bids = [(self._safe_float(x[0]), self._safe_float(x[1])) for x in data.get("bids", [])]
        asks = [(self._safe_float(x[0]), self._safe_float(x[1])) for x in data.get("asks", [])]
        return OrderBookData(
            symbol=symbol,
            bids=bids,
            asks=asks,
            timestamp=int(time.time() * 1000),
        )

    async def get_symbols(self, trade_type: TradeType = TradeType.SPOT) -> List[str]:
        self._ensure_spot(trade_type)
        data = await self._make_request("GET", "/api/v3/exchangeInfo")
        symbols: List[str] = []
        for item in data.get("symbols", []) if isinstance(data, dict) else []:
            symbol = str(item.get("symbol", "")).upper()
            if not symbol:
                continue
            status = str(item.get("status", "")).upper()
            spot_allowed = item.get("isSpotTradingAllowed", True)
            if status and status not in {"1", "ENABLED", "TRADING"}:
                continue
            if spot_allowed is False:
                continue
            symbols.append(symbol)
        return symbols

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
        try:
            self._ensure_spot(trade_type)
            self._check_authentication()
            self._validate_quantity(quantity)
            if order_type == OrderType.LIMIT:
                self._validate_price(price)

            precheck_error = await self.validate_order_preconditions(
                symbol=symbol,
                side=side,
                quantity=quantity,
                order_type=order_type,
                price=price,
                trade_type=trade_type,
                **kwargs,
            )
            if precheck_error:
                return OrderResult(success=False, error_message=precheck_error)

            params: Dict[str, Any] = {
                "symbol": self._normalize_symbol(symbol),
                "side": "BUY" if side == OrderSide.BUY else "SELL",
                "type": "MARKET" if order_type == OrderType.MARKET else "LIMIT",
            }

            quote_order_qty = kwargs.get("quoteOrderQty") or kwargs.get("quote_order_qty")
            if quote_order_qty is not None:
                params["quoteOrderQty"] = str(quote_order_qty)
            else:
                params["quantity"] = str(quantity)

            if order_type == OrderType.LIMIT:
                params["price"] = str(price)
                params["timeInForce"] = kwargs.get("timeInForce", "GTC")

            for key in ("newClientOrderId", "selfTradePreventionMode"):
                if key in kwargs and kwargs[key] is not None:
                    params[key] = kwargs[key]

            data = await self._make_request("POST", "/api/v3/order", params=params, signed=True)
            order_id = str(data.get("orderId", ""))
            executed_qty = self._safe_float(data.get("executedQty"), 0.0)
            quote_qty = self._safe_float(
                data.get("cummulativeQuoteQty", data.get("cumulativeQuoteQty")),
                0.0,
            )
            avg_price = quote_qty / executed_qty if executed_qty > 0 and quote_qty > 0 else 0.0

            # MEXC's new-order response `price` is not a reliable filled average for market
            # orders. Query the order/trades and compute cummulativeQuoteQty / executedQty.
            if order_type == OrderType.MARKET and order_id:
                for _ in range(3):
                    try:
                        queried_avg = await self.get_fill_price(order_id=order_id, symbol=symbol, trade_type=trade_type)
                        if queried_avg and queried_avg > 0:
                            avg_price = queried_avg
                            break
                    except Exception as fill_error:
                        self.logger.debug("mexc_fill_price_query_failed", order_id=order_id, error=str(fill_error))
                    await asyncio.sleep(0.2)

            if avg_price <= 0 and order_type == OrderType.LIMIT:
                avg_price = self._safe_float(data.get("price"))

            return OrderResult(
                success=True,
                order_id=order_id,
                price=avg_price if avg_price > 0 else None,
                quantity=executed_qty if executed_qty > 0 else self._safe_float(data.get("origQty"), quantity),
                timestamp=int(data.get("transactTime", int(time.time() * 1000))),
            )
        except Exception as exc:
            error_message = str(exc)
            if "30005" in error_message or "Oversold" in error_message:
                base_asset, _ = self._normalize_symbol_type(symbol)
                error_message = (
                    f"MEXC spot sell balance insufficient for {symbol}: "
                    f"required {quantity:.8f} {base_asset}. Raw error: {exc}"
                )
            self.logger.error(
                "mexc_place_order_failed",
                symbol=symbol,
                side=side.value,
                quantity=quantity,
                error=error_message,
            )
            return OrderResult(success=False, error_message=error_message)

    async def cancel_order(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> bool:
        self._ensure_spot(trade_type)
        self._check_authentication()
        data = await self._make_request(
            "DELETE",
            "/api/v3/order",
            params={"symbol": self._normalize_symbol(symbol), "orderId": order_id},
            signed=True,
        )
        return str(data.get("orderId", "")) == str(order_id) or data.get("status") == "CANCELED"

    async def get_order_status(self, symbol: str, order_id: str, trade_type: TradeType = TradeType.SPOT) -> Dict[str, Any]:
        self._ensure_spot(trade_type)
        self._check_authentication()
        return await self._make_request(
            "GET",
            "/api/v3/order",
            params={"symbol": self._normalize_symbol(symbol), "orderId": order_id},
            signed=True,
        )

    async def get_fill_price(self, order_id: str, symbol: str, trade_type: TradeType = TradeType.SPOT) -> Optional[float]:
        self._ensure_spot(trade_type)
        order = await self.get_order_status(symbol=symbol, order_id=order_id, trade_type=trade_type)
        executed_qty = self._safe_float(order.get("executedQty"))
        quote_qty = self._safe_float(order.get("cummulativeQuoteQty", order.get("cumulativeQuoteQty")))
        if executed_qty > 0 and quote_qty > 0:
            return quote_qty / executed_qty

        try:
            trades = await self._make_request(
                "GET",
                "/api/v3/myTrades",
                params={"symbol": self._normalize_symbol(symbol), "orderId": order_id, "limit": 100},
                signed=True,
            )
            if not isinstance(trades, list) or not trades:
                return None
            total_qty = 0.0
            total_quote = 0.0
            for trade in trades:
                qty = self._safe_float(trade.get("qty"))
                price = self._safe_float(trade.get("price"))
                total_qty += qty
                total_quote += qty * price
            return total_quote / total_qty if total_qty > 0 else None
        except Exception:
            return None

    async def _get_usdt_price_map(self) -> Dict[str, float]:
        price_map: Dict[str, float] = {}
        try:
            data = await self._make_request("GET", "/api/v3/ticker/price")
            rows = data if isinstance(data, list) else []
            for row in rows:
                symbol = str(row.get("symbol", "")).upper()
                if not symbol.endswith("USDT"):
                    continue
                price = self._safe_float(row.get("price"))
                if price > 0:
                    price_map[symbol[:-4]] = price
        except Exception:
            return {}
        return price_map

    async def get_balances(self) -> List[Balance]:
        self._check_authentication()
        account = await self._make_request("GET", "/api/v3/account", signed=True)
        price_map = await self._get_usdt_price_map()
        stable_assets = {"USDT", "USDC", "USD", "FDUSD", "TUSD", "DAI"}

        balances: List[Balance] = []
        for item in account.get("balances", []) if isinstance(account, dict) else []:
            asset = str(item.get("asset", "")).upper()
            if not asset:
                continue
            free = self._safe_float(item.get("free"))
            locked = self._safe_float(item.get("locked"))
            total = free + locked
            if abs(total) <= 1e-12:
                continue

            if asset in stable_assets:
                usdt_value = total
            else:
                usdt_value = total * price_map.get(asset, 0.0)

            balances.append(
                Balance(
                    asset=asset,
                    free=free,
                    locked=locked,
                    borrowed=0.0,
                    usdt_value=usdt_value,
                    include_locked_in_net=True,
                )
            )
        return balances

    async def get_positions(self) -> List[Position]:
        return []

    async def get_account_summary(self) -> AccountSummary:
        balances = await self.get_balances()
        total_equity = sum(b.usdt_value for b in balances)

        price_map = await self._get_usdt_price_map()
        stable_assets = {"USDT", "USDC", "USD", "FDUSD", "TUSD", "DAI"}
        available_usdt = 0.0
        for balance in balances:
            if balance.asset.upper() in stable_assets:
                available_usdt += balance.free
            else:
                available_usdt += balance.free * price_map.get(balance.asset.upper(), 0.0)

        return AccountSummary(
            exchange=self.name.lower(),
            account_mode=AccountMode.CLASSIC.value,
            timestamp=int(time.time() * 1000),
            total_equity_usdt=total_equity,
            total_margin_usdt=0.0,
            available_balance_usdt=available_usdt,
            margin_ratio=0.0,
            maintenance_margin_rate=0.0,
            total_initial_margin=0.0,
            total_maintenance_margin=0.0,
            balances=balances,
            positions=[],
        )

    async def get_funding_rates(self, symbols: List[str] = None) -> List[FundingRate]:
        return []

    async def check_account_mode(self) -> Tuple[str, bool]:
        return AccountMode.CLASSIC.value, True

    async def ping(self) -> bool:
        try:
            await self._make_request("GET", "/api/v3/ping")
            return True
        except Exception:
            return False

    async def get_server_time(self) -> int:
        try:
            data = await self._make_request("GET", "/api/v3/time")
            return int(data.get("serverTime", int(time.time() * 1000)))
        except Exception:
            return int(time.time() * 1000)
