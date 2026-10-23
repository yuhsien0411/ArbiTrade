# Arbitrade 本機執行指南

以下指令從專案根目錄開始。先以不含交易所憑證的設定啟動，確認公開行情與介面正常，再決定是否設定私人帳戶。

**目前沒有使用者登入或 API 授權，僅適合本機或受控的私人環境。** 後端與前端依本指南只監聽 `127.0.0.1`；不要將 `3000` / `7001` 連接埠直接對外開放。CORS 不是身分驗證。

## 1. 環境需求

- Python 3.10 以上，並可使用 `venv`、`pip`。
- Node.js 與 npm；請使用仍受維護且與本專案依賴相容的版本。
- 可連線到 npm / Python 套件來源與交易所 API 的網路。

Windows 使用 PowerShell；macOS / Linux 使用一般 shell。以下直接指定虛擬環境中的 Python，不需要啟用環境腳本。

## 2. 建立環境設定

### Windows / PowerShell

```powershell
Copy-Item .env.example .env
Copy-Item client/.env.example client/.env.local
```

### macOS / Linux

```sh
cp .env.example .env
cp client/.env.example client/.env.local
```

如果檔案已存在，請直接編輯，不要覆蓋原本的憑證與設定。

### 後端：根目錄 `.env`

範本中的憑證預設留空，不填也可嘗試公開行情。依需要設定：

- Bybit：`BYBIT_API_KEY`、`BYBIT_SECRET`。
- Binance：`BINANCE_API_KEY`、`BINANCE_SECRET`、`BINANCE_USE_PORTFOLIO_MARGIN`。最後一項預設為 `true`，需與帳戶模式相符。
- OKX：`OKX_API_KEY`、`OKX_SECRET`、`OKX_PASSWORD`。
- Bitget：`BITGET_API_KEY`、`BITGET_SECRET`、`BITGET_PASSWORD`。
- MEXC 現貨：`MEXC_SPOT_API_KEY`、`MEXC_SPOT_SECRET`；程式也相容舊名稱 `MEXC_API_KEY`、`MEXC_SECRET`。
- Aster：`ASTER_USER` 為主帳戶地址、`ASTER_SIGNER` 為 API Wallet 地址、`ASTER_PRIVATE_KEY` 為 API Wallet 私鑰。
- `FRONTEND_URL`：CORS 允許的前端來源，逗號分隔；預設包含 `http://localhost:3000` 與 `http://127.0.0.1:3000`。

`OKX_PASSWORD` / `BITGET_PASSWORD` 指建立 API 時設定的 passphrase，不是登入密碼。憑證不要放進前端環境檔、截圖、Issue 或日誌。

本機網頁的「設定」頁也能更新交易所憑證。編輯時不會顯示原有內容；只填寫要更換的欄位，留空保留原值。要完整清除一組憑證，請使用刪除功能。網頁更新會寫入根目錄 `.env`，並可能建立含舊憑證的 `.env.backup`。

### 前端：`client/.env.local`

範本已設定：

```dotenv
HOST=127.0.0.1
PORT=3000
REACT_APP_API_URL=http://127.0.0.1:7001
REACT_APP_SERVER_URL=http://127.0.0.1:7001
REACT_APP_WS_URL=ws://127.0.0.1:7001/ws
```

前端由 `client` 目錄讀取環境檔，不會自動使用根目錄 `.env`。`REACT_APP_*` 會進入瀏覽器程式碼，只能放公開的連線設定。修改後須重啟開發伺服器；靜態 build 則須重新建置。

`BACKEND_HOST`、`BACKEND_PORT`、`FRONTEND_PORT` 不是目前啟動命令使用的設定；後端請用 Uvicorn 的 `--host` / `--port`，前端請用 `HOST` / `PORT`。

## 3. 安裝依賴

### Windows / PowerShell

在專案根目錄：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

如果沒有 `py` 啟動器，但有正確的 `python`，第一行可改為 `python -m venv .venv`。

### macOS / Linux

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

### 前端（所有平台）

另開終端，從根目錄執行：

```sh
cd client
npm ci
```

前端使用 `client/package-lock.json` 安裝。執行前端不需要先安裝根目錄的 Node.js 套件；後端為 Python，舊 Node.js 伺服器入口不適用。

## 4. 啟動後端（終端 1）

### Windows / PowerShell

從根目錄執行：

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 7001 --reload
```

### macOS / Linux

```sh
cd backend
../.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 7001 --reload
```

`--reload` 僅用於開發，修改檔案會重啟服務；有執行中策略時請先處理好訂單與持倉。不要將它視為實盤服務的部署方式。

啟動後可檢查：

- 健康檢查：`http://127.0.0.1:7001/health`，預期包含 `data.status: "ok"`。
- API 文件：`http://127.0.0.1:7001/docs`。
- 設定狀態：`http://127.0.0.1:7001/api/config/status`，只應包含狀態，不應包含憑證原文。

健康檢查成功只表示 HTTP 服務可回應，不代表交易所連線、帳戶權限或下單功能均正常。

## 5. 啟動前端（終端 2）

從根目錄執行：

```sh
cd client
npm start
```

開啟 `http://127.0.0.1:3000`。後續日常開發只需重新執行第 4、5 節；變更依賴或新建環境時再安裝套件。

## 6. 驗證與建置

在 `client` 目錄執行：

```sh
npm run type-check
npm run build
```

產物位於 `client/build/`。建置前必須確認前端環境檔只含可公開設定。靜態前端建置成功不表示後端具備對外部署所需的認證與授權。

後端語法可在專案根目錄檢查：

```powershell
.\.venv\Scripts\python.exe -m compileall -q backend
```

macOS / Linux 將 Python 路徑改為 `.venv/bin/python`。語法檢查不會驗證交易邏輯或實際下單行為。

## 7. 本機資料與停止服務

- 根目錄 `data/` 存放淨值、執行紀錄、監控設定等資料；請勿發布。
- `.env`、`.env.backup`、`client/.env.local` 屬本機設定，請勿提交。
- 在終端按 `Ctrl+C` 停止服務。停止或重啟程式不保證取消交易所上的未成交訂單，也不會自動平倉。
- 手動修改後端憑證後，請重啟服務，避免既有交易所實例繼續持有舊設定。

## 8. 常見問題

### Python / npm 找不到

確認已安裝並加入 PATH，重新開啟終端。Windows 的 `python` 若只開啟 Microsoft Store，請使用實際安裝的 Python 或 `py` 啟動器。

### 前端顯示連線失敗

先開啟 `/health`；確認後端使用 `7001`，且 `client/.env.local` 中 HTTP / WebSocket 位址正確。更改前端設定後重啟 `npm start`。

### CORS 錯誤或前端連接埠變了

`FRONTEND_URL` 必須包含瀏覽器實際使用的來源，包含協定、主機名與連接埠。若前端改為 `3001`，請同步更新 CORS 設定並重啟後端；不要以開放所有來源代替排錯。

### 有行情但沒有資產或無法下單

公開行情不需要帳戶權限。請檢查後端憑證、API 權限、IP 限制與帳戶模式；API 設定狀態不等同交易所已驗證憑證。不要貼出完整錯誤請求或憑證求助。

## 9. 公開發布前檢查

- 只提交程式碼與空白設定範本；`git ls-files` 中不應出現真實 `.env`、`data/`、備份、日誌或私鑰檔。
- 使用 `git status --short --untracked-files=all` 檢查待提交檔案。`.gitignore` 不會移除已追蹤檔案或 Git 歷史。
- 發布既有儲存庫前，另外檢查所有分支、標籤、提交訊息與歷史檔案。已刪除的資產紀錄、舊部署位址、作者姓名與 email 仍可能存在。
- 若不想公開舊歷史，從已清理並複核的檔案建立新的公開儲存庫，不要複製舊 `.git` 或以舊 repo 的 fork / mirror 發布。保留原儲存庫作私人備份。
- 若需保留歷史，先安排敏感資料與作者資訊清理，再協調所有分支與遠端；不要只刪掉目前檔案就直接公開。
- 若曾洩漏真實憑證，先撤銷或輪替；刪檔或改寫歷史不能讓已流出的憑證恢復安全。
- 本專案採用 [MIT License](LICENSE)；發布時保留授權條款。
- 重新執行前端型別檢查、建置與後端檢查。敏感資料掃描只是檢查的一部分，不代表已完成完整安全稽核或依賴漏洞檢查。
