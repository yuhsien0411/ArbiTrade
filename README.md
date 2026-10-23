# Arbitrade

以 React / TypeScript 與 Python / FastAPI 開發的加密貨幣雙腿交易工具，提供跨交易所價差監控、PAIRS 條件執行、TWAP 分批下單、倉位監控與交易紀錄。

本專案是開發中的單使用者、自行架設工具，提供原始碼供研究與開發。不保證交易獲利、雙腿同時成交或故障時成功回滾。

> **使用範圍：本機或受控的私人環境。** 目前尚未實作使用者登入與 API 授權。交易、帳戶、設定與 WebSocket 端點不可直接暴露到網際網路。公開原始碼不代表服務已適合對外部署。

## 功能

- **PAIRS**：設定兩條交易腿、價差條件及執行次數，監控並觸發下單。
- **TWAP**：依設定的數量、次數與間隔分批執行交易。
- **即時行情**：透過 HTTP / WebSocket 顯示價格、訂單簿、價差與圖表。
- **倉位監控**：查詢持倉、損益與資金費率等資訊。
- **紀錄與報表**：查詢成交紀錄、匯出資料、記錄資產淨值。
- **交易所設定**：在本機設定頁新增、更新或移除憑證；不回傳已儲存的憑證原文。

未填入交易所憑證時，可先查看公開行情；帳戶查詢與下單需要相應憑證。是否有行情仍取決於網路與交易所 API 可用性。

## 交易所整合範圍

下列為目前程式註冊的能力，並非所有帳戶模式均已完成實盤驗證：

- **Binance**：現貨、USDT-M 合約；目前設定預設使用 Portfolio Margin。
- **Bybit**：現貨、USDT-M 合約；以統一帳戶整合為主。
- **OKX**：現貨、永續合約；實作以全倉跨幣種保證金模式為主。
- **Bitget**：USDT-M 永續合約。
- **Aster**：USDT-M 永續合約，使用 EIP-712 簽章。
- **MEXC**：現貨。

整合定義位於 [交易所能力註冊表](backend/app/exchanges/registry.py)。實際可用的功能仍受交易所權限、帳戶類型、交易對與實作限制影響。

## 快速開始

完整安裝、啟動、設定與排錯步驟請見 [run.md](run.md)。

1. 安裝 Python 3.10 以上、Node.js 與 npm。
2. 將根目錄的 [.env.example](.env.example) 複製為 `.env`，先保留憑證空白。
3. 將 [client/.env.example](client/.env.example) 複製為 `client/.env.local`。
4. 建立 Python 虛擬環境、安裝 `requirements.txt`，並在 `client` 執行 `npm ci`。
5. 在 `backend` 目錄啟動 FastAPI，在 `client` 目錄啟動前端。
6. 開啟 `http://127.0.0.1:3000`。

根目錄 `.env` 只供後端使用；前端設定放在 `client/.env.local`。**所有 `REACT_APP_*` 變數都可能被打包到瀏覽器 JavaScript，不可放入金鑰或私鑰。**

## 專案結構

```text
backend/app/
  api/            HTTP API 路由
  config/         後端環境變數與交易所設定
  exchanges/      交易所介面、實作與能力定義
  models/         請求與交易資料模型
  services/       套利、TWAP、行情、報表與紀錄服務
  utils/          日誌、HTTP、WebSocket、環境檔管理
client/
  public/         前端入口
  src/            React 頁面、元件、狀態與 API 服務
src/              其他靜態圖示
.env.example      後端設定範本，憑證留空
requirements.txt  後端依賴
run.md            本機執行與發布前檢查
```

執行後會產生 `data/` 等本機資料，包含淨值、成交紀錄與監控設定；請視為私人帳戶資料，不要上傳。依本文件的工作目錄啟動，避免依賴相對路徑的資料落在其他位置。

## 安全與限制

- 目前交易流程會使用真實交易所端點；沒有全系統一致的模擬交易或測試網切換。不要把局部的 `testnet` 參數視為整套系統的保護。
- API 憑證以明文儲存在本機 `.env`；更新時可能產生 `.env.backup`，備份也含憑證。請限制本機檔案存取權限。
- 不要配置提領權限。Aster 使用 API Wallet 的私鑰，切勿填入主錢包私鑰。
- 價差不是已實現利潤；手續費、滑價、資金費率、借貸成本與單腿成交都可能造成損失。
- 服務重啟不等同取消交易所訂單或平倉。停止程式前應自行核對交易所狀態。
- `.gitignore` 只能防止未追蹤檔案被一般方式加入 Git，不能移除既有提交或歷史資料。

## 開發與檢查

前端在 `client` 目錄提供下列指令：

```sh
npm run type-check
npm run build
```

Python 依賴使用版本下限，尚未提供完整鎖定檔；安裝成功不代表所有交易所整合均通過驗證。執行方式與發布前檢查請見 [run.md](run.md)。

## 授權

採用 [MIT License](LICENSE)。交易所名稱與標誌屬各自權利人所有。
