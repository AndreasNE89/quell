# Chrome Web Store listing — 简体中文 (zh_CN)

The Chrome Web Store keeps a separate listing per locale. Adding this one is what makes the
extension findable to the users 2.2.0 was built for — localizing the product does nothing for
someone who never sees it in search.

Dashboard → Store listing → language selector → **中文 (简体)**. The English listing stays as
the default; this is additive and can be removed later without touching it.

Same structure and claims as `LISTING.md`; keep them in step. For Chinese readers the lead is
different: EasyList China turning itself on is the reason to install, so it is in the opening.

## 商品名称 (Item name)

"Title from package": the manifest `name`, which resolves to `extName` in
`src/_locales/zh_CN/messages.json`. Edit it there and keep this copy identical. 22 characters.

```
StampStack — 广告与跟踪器拦截器
```

## 摘要 (Summary, ≤132 characters)

"Summary from package": `extDescription` in `src/_locales/zh_CN/messages.json`. Edit it there
and keep this copy identical. 50 characters.

```
拦截广告和跟踪器。查看页面连接了哪些已知跟踪器，一键隐藏任何碍眼的内容，网站出问题时也不必关闭拦截。
```

## 详细说明 (Detailed description)

Not wrapped on purpose, as in the English listing.

```
StampStack 拦截广告、跟踪器和背投广告（在你当前窗口后面打开的窗口），并隐藏单靠拦截挡不住的广告。
安装后立即生效。无需账号，没有遥测，什么都不用设置。浏览器语言是中文时，还会自动启用专门针对中文网站的 EasyList China。
在任意页面点一下工具栏图标，就能看到这个页面连接了哪些已知跟踪器，以及其中哪些 StampStack 有对应规则。
网站出问题时，不必关闭拦截也能修复。其他碍眼的东西，指一下就能隐藏。
在 YouTube 上，它会跳过赞助片段、隐藏推广视频。广告拦截免费。

拦截什么
• 广告和跟踪器：一安装就启用约 12 万条规则，来自 EasyList、EasyPrivacy 以及 uBlock Origin 的广告和恶意软件过滤列表，另有 uBlock Origin 的 Unbreak 列表防止它们弄坏网站。加上 Cookie 横幅和中文网站的可选列表，总数约 13.5 万条
• 中文网站：安装时如果浏览器语言是中文，EasyList China（约 1.2 万条规则）会自动启用。EasyList 和 EasyPrivacy 对国内广告联盟覆盖很有限，这份列表才是中文网站上真正管用的部分。CJX Annoyance 列表可在设置中开启
• 背投广告，以及劫持你的点击、在新标签页打开广告的页面
• 很多“请关闭广告拦截器”的提示
• Cookie 横幅：在设置中开启 EasyList Cookie 列表后生效（默认关闭）
• 恶意和钓鱼网站：你直接打开这类网站时也会拦截，而不只是在页面从那里加载内容时

看清页面在做什么
• 在任意网站点击工具栏图标，就能看到该页面连接过的已知跟踪器名称（如 Google Analytics、Criteo、Taboola），以及其中哪些 StampStack 有对应规则
• 如果有针对该网站的规则隐藏了广告位，也会统计数量
• 这些都在你的浏览器里完成，不会为此向任何地方发送数据

网站出问题时，不关闭拦截也能修复
• 大多数页面异常来自元素隐藏（隐藏残留的广告框）或脚本补丁（StampStack 加到页面里、用来关掉广告或反拦截检测的小脚本），而不是拦截本身
• 所以弹窗里的修复功能分步进行：先停止隐藏元素，再同时停用脚本补丁，万不得已才关闭该网站的拦截
• 前两步都会保持广告和跟踪器拦截开启
• 还是有问题？一次点击就能为开发者生成一封邮件草稿，能复制时会复制到剪贴板，有邮件应用时还会打开它。你自己过目再发送，StampStack 不会自行发送任何内容。草稿里只有网站名称、StampStack 版本和设置，以及浏览器版本。没有页面内容，也没有完整网址

隐藏任何你不想看的东西
• 在弹窗里开始隐藏元素（或按 Alt+Shift+X），指向碍眼的部分，它就会在该网站上一直隐藏
• 很多网站每次更新都会换掉自动生成的名称，StampStack 会避开这类名称，所以网站改动后规则更有可能继续有效
• 也可以在设置的“我的过滤规则”里手写规则

YouTube
• 隐藏推广视频和“赞助”卡片，并清除播放器里的广告数据
• 可以拦截 Shorts：隐藏 Shorts 版块，打开 Shorts 页面时会回到首页（默认关闭）
• 使用社区 SponsorBlock 数据库跳过赞助片段。默认只跳过赞助内容；片头、片尾、自我推广等可在设置中开启
• 跳过了想看的内容？提示条上可以撤销
• YouTube 经常改版。这些功能能减少广告，但无法保证完全没有广告

可选深色模式（一次性 $2）
• 为普通网页提供深色主题，支持按网站单独设置
• 本来就是深色的页面会保持原样，不会被反转成亮色
• 与广告拦截完全独立，广告拦截一直免费

对自己的能力保持诚实
• 规则数量显示的是 Chrome 实际加载的数量。如果浏览器的共享规则上限导致某个列表无法加载，StampStack 会直说，而不是继续宣称完整保护
• 设置里会显示过滤列表有多久没更新。列表随每个版本一起打包，StampStack 更新时列表也会更新
• 在它无法运行的页面上，它也会直说，而不是显示一堆没有作用的控件

隐私
• 没有账号，没有分析统计，没有遥测
• 设置和你对各网站的选择都保存在浏览器里
• 过滤列表随扩展一起打包，浏览时不会下载任何列表
• 赞助片段查询只用视频 ID 哈希值的前 4 个字符来标识视频，从不发送视频 ID 或页面网址，也不带 Cookie。可在设置中缩小范围或完全关闭
• 可选的深色模式购买由 ExtensionPay / Stripe 处理。他们可能会要你的邮箱，用于收据和日后恢复购买。不会与他们共享任何浏览数据
• 开始购买或恢复购买后，ExtensionPay 的程序库会把授权密钥（付款或登录后还包括购买邮箱）保存在 Chrome 的同步存储中，Chrome 会将其同步到你已登录并开启同步的其他浏览器
• 随时可以把设置导出为文件，再重新导入

小提示
• 安装后直接浏览即可，拦截会立刻开始
• 页面显示异常时，先用弹窗里的修复功能，不要急着整个关掉
• 按 Alt+Shift+X 可以不打开弹窗，直接开始隐藏元素
• 重新安装了？用收据邮箱恢复深色模式购买
```

## 类别 (Category)

隐私与安全 / Privacy & Security — same as the English listing.

## Notes

- Terms kept consistent with the zh_CN UI strings: 脚本补丁 (script patches), 元素隐藏,
  我的过滤规则, 设置, 恢复购买. 背投广告 is the established term for pop-unders.
- The popup's "Hide an element" and "Site broken?" buttons are localized since the release after
  2.3.0: 隐藏元素 and 网站出问题？. Its shortcut tip now names the key Chrome actually assigned
  (提示：按 … 可直接启动元素选择器). The sponsor-skip notice on YouTube is localized
  too (已跳过：… with 撤销 to undo).
- Rule counts come from `src/generated/meta.json` (see "Where the claims come from" in
  `LISTING.md`). For 2.4.0: 122,523 on by default, EasyList China 11,862, 137,221 in total.
- Screenshots are shared across locales in the dashboard. Worth re-capturing at least the popup
  and Options with a Chinese-locale profile so the listing images match the listing language:
  `chrome://settings/languages`, move 中文 to the top, restart Chrome, then
  `npm run store-screenshots`.
- The `$2` price is written literally in listing copy. That is dashboard text, not a
  `chrome.i18n` message, so the `$$` escaping rule does not apply here.
