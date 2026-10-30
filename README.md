# Medium2HackMD - Edge 瀏覽器擴充功能

協助將 **Medium**（包含 `medium.com` 與使用 Medium 架構的專欄網站）的文章與圖片擷取保存至本機 Library，透過 **ChatGPT** 結合自訂 Prompt 翻譯並修正為台灣繁體中文 Markdown，最後一鍵上傳圖片與內容至 **HackMD (`hackmd.io`)**。

---

## 📦 安裝方式 (Microsoft Edge)

1. 打開 Microsoft Edge 瀏覽器，在網址列輸入：
   ```text
   edge://extensions/
   ```
2. 開啟左下角（或左側選單）的 **「開發人員模式 (Developer mode)」**。
3. 點擊上方的 **「載入解壓縮的擴充功能 (Load unpacked)」**。
4. 選擇本專案資料夾：`C:\Workspace\Plugin`。
5. 點擊瀏覽器右上角工具列的 **Medium2HackMD** 圖示，即可開啟右側常駐的 **Side Panel (側邊欄)**。

---

## 🚀 三階段使用流程

### 步驟 1：在 Medium 網站擷取文章與圖片
1. 開啟欲翻譯的 Medium 專欄文章網頁。
2. 在右側 Side Panel 的 **「1 擷取文章」** 分頁中：
   - 點擊 **「📥 擷取整篇文章與圖片」**（或先反白部分段落後點擊 **「✂️ 擷取反白選取範圍」**）。
3. Plugin 會自動：
   - 將文章結構轉為包含圖片位置標記（如 `![說明]({{IMG_1}})`）的原文內容。
   - 透過背景 Service Worker 自動下載高解析度圖片，並將圖片二進位資料暫存於本機 IndexedDB 的 **Library** 中。

### 步驟 2：在 ChatGPT 網頁帶入 Prompt 產生繁體中文 Markdown
1. 切換至 Side Panel 的 **「2 ChatGPT」** 分頁。
2. 可檢視或修改預設的 **繁體中文翻譯與 Markdown 排版 Prompt**（預設會要求 ChatGPT 使用台灣在地慣用語，且嚴格保留 `{{IMG_1}}` 等圖片佔位符不變）。
3. 點擊 **「🚀 將『Prompt + 文章』送入 ChatGPT」**：
   - 若尚未開啟 ChatGPT，Plugin 會自動切換或開啟 `https://chatgpt.com/` 分頁，將 Prompt 與文章填入輸入框並自動發送。
4. 送出後 Plugin 會在 ChatGPT 分頁內**自動偵測翻譯完成**並由背景程式直接存入 Library（關閉側邊欄、切換視窗都不影響；最長等待 15 分鐘）：
   - 完成判斷：ChatGPT 停止輸出、內容連續約 9 秒不再變動，且通過長度與 `{{IMG_x}}` 圖片佔位符檢查；「思考中」提示文字不會被誤存。
   - 若 ChatGPT 以 Canvas 輸出，會自動改抓 Canvas 內容。
   - 逾時、分頁被關閉或內容未通過檢查時，側邊欄會顯示失敗原因，擴充功能圖示上也會出現「!」標記。
   - 您也可以隨時手動點擊 **「📥 立即從 ChatGPT 擷取回覆並存入 Library」**（強制存入目前回覆）或 **「📋 從剪貼簿載入翻譯結果」**。
   - 若自動偵測仍未如預期，點擊 **「🩺 複製診斷記錄」** 可取得背景程式的逐步記錄（注入方式、偵測階段、失敗原因），方便回報問題。
   - 送入既有的 ChatGPT 分頁時，Plugin 會先等待分頁喚醒與輸入框就緒，再以貼上事件填入內容並確認文字確實進入輸入框後才按下發送。

### 步驟 3：在 HackMD (`hackmd.io`) 上傳 Library 資料與圖片
1. 在瀏覽器開啟一篇 HackMD 筆記編輯頁（例如 `https://hackmd.io/new`），切換至 **「編輯模式」** 或 **「雙欄模式」**。
2. 切換至 Side Panel 的 **「3 HackMD」** 分頁，提供以下發佈方式：
   - **📤 自動上傳暫存圖片至 HackMD 並寫入 Markdown**：自動將 Library 暫存的圖片上傳至 HackMD（或模擬拖放上傳）、把 `{{IMG_x}}` 替換為上傳後的圖片網址，並直接寫入 HackMD 編輯器。
   - **⚡ 以原始圖片網址替換 `{{IMG_x}}` 並直接寫入 HackMD**：不經過圖片重新上傳，直接將 `{{IMG_x}}` 替換為原始高畫質圖片網址並寫入 HackMD 編輯器。
   - **📋 單張複製圖片檔 (`Ctrl+V` 手動貼入)**：在下方暫存圖片清單中，點擊任一張圖片的「📋 複製圖片檔」，即可直接將圖片本體複製到系統剪貼簿，在 HackMD 編輯器內按 `Ctrl+V` 即可由 HackMD 原生貼圖上傳。
