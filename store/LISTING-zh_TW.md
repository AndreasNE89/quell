# Chrome Web Store listing — 繁體中文 (zh_TW)

Separate dashboard locale from Simplified. Not a character conversion of `LISTING-zh_CN.md` —
the vocabulary genuinely differs (軟體/網路/資訊/影片/預設/設定), and a mechanically converted
listing reads wrong to a Taiwanese reader immediately.

Dashboard → Store listing → language selector → **中文 (繁體)**.

Same structure and claims as `LISTING.md`; keep them in step. As in the Simplified listing,
EasyList China turning itself on is part of the opening.

## 商品名稱 (Item name)

"Title from package": the manifest `name`, the literal `StampStack`, in every language. The old
localized name here ("StampStack — 廣告與追蹤器攔截") could never reach the store.

```
StampStack
```

## 摘要 (Summary, ≤132 characters)

"Summary from package": `extDescription` in `src/_locales/zh_TW/messages.json`. Edit it there
and keep this copy identical. 50 characters.

```
攔截廣告與追蹤器。查看網頁連線到哪些已知追蹤器，一鍵隱藏任何礙眼的內容，網站出問題時也不必關閉攔截。
```

## 詳細說明 (Detailed description)

Not wrapped on purpose, as in the English listing.

```
StampStack 攔截廣告、追蹤器與背景彈出視窗（在你目前視窗後方開啟的視窗），並隱藏光靠攔截擋不住的廣告。
安裝後立即生效。不需帳號，沒有遙測，什麼都不用設定。瀏覽器語言為中文時，還會自動啟用專為中文網站設計的 EasyList China。
在任何網頁點一下工具列圖示，就能看到這個網頁連線到哪些已知追蹤器，以及其中哪些 StampStack 有對應規則。
網站出問題時，不必關閉攔截也能修復。其他礙眼的東西，指一下就能隱藏。
在 YouTube 上，它會略過贊助片段、隱藏推廣影片。廣告攔截免費。

攔截什麼
• 廣告與追蹤器：一安裝就啟用約 11.5 萬條規則，來自 EasyList、EasyPrivacy，以及 uBlock Origin 的廣告、隱私與惡意軟體過濾清單。加上 Cookie 橫幅與中文網站的選用清單，總數約 13 萬條
• 中文網站：安裝時若瀏覽器語言為中文，EasyList China（約 1.2 萬條規則）會自動啟用。EasyList 與 EasyPrivacy 對中文廣告聯播網的涵蓋相當有限，這份清單才是中文網站上真正有效的部分。CJX Annoyance 清單可在設定中開啟
• 背景彈出視窗，以及劫持你的點擊、在新分頁開啟廣告的網頁
• 許多「請關閉廣告攔截器」的提示
• Cookie 橫幅：在設定中開啟 EasyList Cookie 清單後生效（預設關閉）
• 惡意與釣魚網站：你直接前往這類網站時也會攔截，而不只是在網頁從那裡載入內容時

看清網頁在做什麼
• 在任何網站點擊工具列圖示，就能看到該網頁曾連線的已知追蹤器名稱（例如 Google Analytics、Criteo、Taboola），以及其中哪些 StampStack 有對應規則
• 若有針對該網站的規則隱藏了廣告版位，也會統計數量
• 這些都在你的瀏覽器裡完成，不會為此傳送任何資料

網站出問題時，不關閉攔截也能修復
• 大多數網頁異常來自元素隱藏（隱藏殘留的廣告框）或腳本修補（StampStack 加進網頁、用來關掉廣告或反廣告攔截偵測的小腳本），而不是攔截本身
• 所以彈出視窗中的修復功能會分步進行：先停止隱藏元素，再一併停用腳本修補，萬不得已才關閉該網站的攔截
• 前兩步都會保持廣告與追蹤器攔截開啟
• 還是有問題？一次點擊就能為開發者產生一封郵件草稿，能複製時會複製到剪貼簿，有郵件應用程式時還會開啟它。你自己看過再寄出，StampStack 不會自行寄送任何內容。草稿裡只有網站名稱、StampStack 版本與設定，以及瀏覽器版本。沒有網頁內容，也沒有完整網址

隱藏任何你不想看的東西
• 在彈出視窗中開始隱藏元素（或按 Alt+Shift+X），指向礙眼的部分，它就會在該網站上持續隱藏
• 許多網站每次更新都會換掉自動產生的名稱，StampStack 會避開這類名稱，所以網站改動後規則比較可能繼續有效
• 也可以在設定的「我的過濾規則」中自行撰寫規則

YouTube
• 隱藏推廣影片與「贊助」方塊，並清除播放器中的廣告資料
• 可以攔截 Shorts：隱藏 Shorts 區塊，開啟 Shorts 頁面時會回到首頁（預設關閉）
• 使用社群 SponsorBlock 資料庫略過贊助片段。預設只略過贊助內容；片頭、片尾、自我宣傳等可在設定中開啟
• 略過了想看的內容？提示列上可以復原
• YouTube 經常改版。這些功能可以減少廣告，但無法保證完全沒有廣告

選購的深色模式（一次性 $2）
• 為一般網頁提供深色主題，支援依網站個別設定
• 原本就是深色的網頁會保持原樣，不會被反轉成亮色
• 與廣告攔截完全獨立，廣告攔截一直免費

對自己的能力保持誠實
• 規則數量顯示的是 Chrome 實際載入的數量。若瀏覽器的共用規則上限導致某個清單無法載入，StampStack 會直說，而不是繼續宣稱完整保護
• 設定中會顯示過濾清單多久沒更新。清單隨每個版本一起封裝，StampStack 更新時清單也會更新
• 在它無法執行的網頁上，它也會直說，而不是顯示一堆沒有作用的控制項

隱私
• 沒有帳號，沒有分析統計，沒有遙測
• 設定和你對各網站的選擇都儲存在瀏覽器中
• 過濾清單隨擴充功能一起封裝，瀏覽時不會下載任何清單
• 贊助片段查詢只用影片 ID 雜湊值的前 4 個字元來識別影片，從不傳送影片 ID 或網頁網址，也不附帶 Cookie。可在設定中縮小範圍或完全關閉
• 選購的深色模式由 ExtensionPay / Stripe 處理。他們可能會請你提供電子郵件，用於收據和日後還原購買。不會與他們共用任何瀏覽資料
• 隨時可以把設定匯出為檔案，再重新匯入

小提示
• 安裝後直接瀏覽即可，攔截會立刻開始
• 網頁顯示異常時，先用彈出視窗中的修復功能，不要急著整個關掉
• 按 Alt+Shift+X 可以不開啟彈出視窗，直接開始隱藏元素
• 重新安裝了？用收據上的電子郵件還原深色模式購買
```

## 類別 (Category)

隱私權與安全性 / Privacy & Security — same as the English listing.

## Notes

Vocabulary deliberately Taiwan usage throughout, not converted from Simplified:
擴充功能 (not 扩展), 網路 (not 网络), 資料 (not 数据), 影片 (not 视频), 設定 (not 设置),
預設 (not 默认), 分頁 (not 标签页), 剪貼簿 (not 剪贴板), 工具列 (not 工具栏), 復原 (not 撤销),
略過 (not 跳过), 還原購買 (matches the zh_TW UI string, not 恢复购买).

Terms kept consistent with the zh_TW UI strings: 腳本修補 (script patches), 元素隱藏,
我的過濾規則, 彈出視窗. 背景彈出視窗 describes a pop-under in words a Taiwanese reader
recognizes; the gloss after it does the rest.

The popup's "Hide an element" and "Site broken?" buttons, its Alt+Shift+X tip, and the
sponsor-skip notice are still English-only in the UI, so the copy describes those actions rather
than quoting a label. Quote them once they are localized.

Same screenshot note as the Simplified listing — capture with a 繁體中文 profile if you want the
images to match.
