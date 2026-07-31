# Chrome Web Store listing — 繁體中文 (zh_TW)

Separate dashboard locale from Simplified. Not a character conversion of `LISTING-zh_CN.md` —
the vocabulary genuinely differs (軟體/網路/資訊/影片/預設/設定), and a mechanically converted
listing reads wrong to a Taiwanese reader immediately.

Dashboard → Store listing → language selector → **中文 (繁體)**.

## 商品名稱 (Item name)

```
StampStack — 廣告與追蹤器攔截
```

## 摘要 (Summary, ≤132 characters)

```
攔截廣告、追蹤器與彈出視窗。看清每個頁面連往哪裡，一鍵隱藏任何元素，網站出問題時不必關閉攔截也能修復。
```

## 詳細說明 (Detailed description)

```
StampStack 使用 Manifest V3 的 Declarative Net Request 攔截廣告、追蹤器與彈出視窗，並以元素
隱藏和腳本片段處理網路層攔截不到的部分。

攔截什麼
• 135,000 多條網路規則，來自 EasyList、EasyPrivacy、EasyList Cookie、EasyList China、
  CJX 規則清單，以及 uBlock Origin 的廣告、隱私與惡意軟體清單
• 中文網站：安裝時若瀏覽器語言為中文，EasyList China 會自動啟用。EasyList 與 EasyPrivacy
  對中文廣告聯播網的涵蓋相當有限，這一項才是中文網站上真正有效的部分
• 彈出視窗與「在新分頁開啟」的劫持
• 反廣告攔截提示與付費牆偵測
• Cookie 同意視窗與互動提醒
• 惡意與釣魚網站，包含你直接前往的頁面，而不只是它載入的子資源

看清頁面在做什麼
• 在任何網站開啟彈出視窗，StampStack 會列出該頁面曾連線的追蹤器 —— Google Analytics、
  Criteo、Taboola —— 並說明哪些有對應規則
• 同時統計在該頁面隱藏了多少廣告版位
• 不需要帳號，沒有任何統計回傳，這些都在你的瀏覽器裡完成

網站出問題時，不必放棄攔截
• 大多數頁面異常來自元素隱藏或腳本修補，而不是網路攔截
• 所以這裡不是一個開關，而是分級修復：先停止隱藏元素 → 再停止執行腳本片段 →
  最後才關閉該網站的攔截
• 前兩步都保留廣告攔截
• 還是有問題？一次點擊就能產生一封報告，並在有郵件應用程式時開啟。你自己看過再寄出 ——
  StampStack 不會自行寄送任何內容，報告中只有網站名稱與你的 StampStack 設定，
  沒有頁面內容，也沒有完整網址

隱藏任何你不想看的東西
• 點擊「隱藏元素」（或按 Alt+Shift+X），指向礙眼的部分，它就消失了 —— 只在該網站，長期有效
• 選擇器會盡量避免在網站改版後失效
• 也可以在設定中自行撰寫規則

YouTube
• 隱藏推廣影片，清除播放器中的廣告資料
• 攔截 Shorts 版位並離開 /shorts/ 頁面
• 使用社群 SponsorBlock 資料庫略過贊助片段，並可依類別選擇要略過哪些 ——
  贊助、自我宣傳、片頭、片尾等
• 略過了不想略過的部分？提示列上有復原

選購的深色模式（一次性 $2）
• 為一般網頁提供柔和的深色主題，支援依網站覆寫
• 原本就是深色的介面會保持原樣，不會被反轉成亮色
• 與廣告攔截完全獨立，攔截功能一直免費

介面語言
• 繁體中文、簡體中文與英文，依瀏覽器語言自動選擇，不需設定

對自己的能力保持誠實
• 規則數量顯示的是 Chrome 實際載入的數量，而不是要求的數量 —— 若瀏覽器的共用規則上限
  導致某個清單無法載入，StampStack 會直說，而不是繼續宣稱完整保護
• 在它無法執行的頁面上，它也會直說，而不是顯示一堆沒有作用的控制項

隱私
• 沒有帳號，沒有分析統計，不向 StampStack 伺服器傳送任何遙測資料
• 設定與白名單儲存在瀏覽器的本機儲存空間中
• 過濾規則清單隨擴充功能一起封裝，瀏覽時不會下載任何清單
• 贊助片段查詢只傳送影片 ID 的 SHA-256 雜湊前 4 碼，不傳送影片 ID 或頁面網址，
  可在設定中細分或完全關閉
• 選購的深色模式由 ExtensionPay / Stripe 處理（僅用於收據與恢復購買的電子郵件），
  不會與付款方共用任何瀏覽資料
• 隨時可以匯出與重新匯入你的設定

小提示
• 安裝後直接瀏覽即可 —— 內建清單會立刻開始攔截
• 頁面顯示異常時，先用彈出視窗中的「網站出問題？」，不要急著整個關掉
• Alt+Shift+X 可以不開啟彈出視窗直接啟動元素挑選器
• 重新安裝了？用收據電子郵件恢復深色模式購買
```

## 類別 (Category)

隱私權與安全性 / Privacy & Security — same as the English listing.

## Notes

Vocabulary deliberately Taiwan usage throughout, not converted from Simplified:
擴充功能 (not 扩展), 網路 (not 网络), 資料 (not 数据), 影片 (not 视频), 設定 (not 设置),
本機 (not 本地), 復原 (not 撤销), 挑選器 (not 选择器), 版位 (not 版块), 略過 (not 跳过).

Same screenshot note as the Simplified listing — capture with a 繁體中文 profile if you want the
images to match.
