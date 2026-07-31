# Chrome Web Store listing — 简体中文 (zh_CN)

The Chrome Web Store keeps a separate listing per locale. Adding this one is what makes the
extension findable to the users 2.2.0 was built for — localizing the product does nothing for
someone who never sees it in search.

Dashboard → Store listing → language selector → **中文 (简体)**. The English listing stays as
the default; this is additive and can be removed later without touching it.

## 商品名称 (Item name)

```
StampStack — 广告与跟踪器拦截
```

## 摘要 (Summary, ≤132 characters)

```
拦截广告、跟踪器和弹窗。看清每个页面在连接什么，一键隐藏任意元素，网站出问题时无需关闭拦截即可修复。
```

## 详细说明 (Detailed description)

```
StampStack 使用 Manifest V3 的 Declarative Net Request 拦截广告、跟踪器和弹窗，并用元素隐藏
和脚本片段处理网络层拦截不到的部分。

拦截什么
• 135,000 多条网络规则，来自 EasyList、EasyPrivacy、EasyList Cookie、EasyList China、
  CJX 规则列表以及 uBlock Origin 的广告、隐私和恶意软件列表
• 中文网站：安装时如果浏览器语言是中文，EasyList China 会自动启用。EasyList 和 EasyPrivacy
  对国内广告联盟覆盖很有限，这一条才是中文站点上真正管用的部分
• 弹窗和“新标签页打开”劫持
• 反广告拦截提示和付费墙检测
• Cookie 同意弹窗和互动提醒
• 恶意与钓鱼站点，包括你直接访问的页面，而不只是它加载的子资源

看清页面在做什么
• 在任意网站打开弹窗，StampStack 会列出该页面连接过的跟踪器 —— Google Analytics、Criteo、
  Taboola —— 并说明哪些有对应规则
• 同时统计在该页面隐藏了多少广告位
• 不需要账号，没有任何统计上报，这些都在你的浏览器里完成

网站出问题时，不必放弃拦截
• 大多数页面异常来自元素隐藏或脚本修补，而不是网络拦截
• 所以这里不是一个开关，而是分级修复：先停止隐藏元素 → 再停止运行脚本片段 →
  最后才关闭该站点的拦截
• 前两步都保留广告拦截
• 还是有问题？一次点击就能生成一封报告并在有邮件应用时打开。你自己过目再发送 ——
  StampStack 不会自行发送任何内容，报告里只有站点名称和你的 StampStack 设置，
  没有页面内容，也没有完整网址

隐藏任何你不想看的东西
• 点击“隐藏元素”（或按 Alt+Shift+X），指向碍眼的部分，它就消失了 —— 只在该站点，长期有效
• 选择器会尽量避开网站改版后失效
• 也可以在设置里手写自己的规则

YouTube
• 隐藏推广视频，清除播放器中的广告数据
• 拦截 Shorts 版块并离开 /shorts/ 页面
• 使用社区 SponsorBlock 数据库跳过赞助片段，并可按类别选择跳过哪些 ——
  赞助、自我推广、片头、片尾等
• 跳过了不想跳过的部分？提示条上有撤销

可选深色模式（一次性 $2）
• 为普通网页提供柔和的深色主题，支持按站点覆盖
• 本来就是深色的界面会保持原样，不会被反转成亮色
• 与广告拦截完全独立，拦截功能一直免费

界面语言
• 简体中文、繁体中文和英文，按浏览器语言自动选择，无需设置

对自己的能力保持诚实
• 规则数量显示的是 Chrome 实际加载的数量，而不是请求的数量 —— 如果浏览器的共享规则上限
  导致某个列表无法加载，StampStack 会明说，而不是继续宣称完整保护
• 在它无法运行的页面上，它也会直说，而不是显示一堆没有作用的控件

隐私
• 没有账号，没有分析统计，不向 StampStack 服务器发送任何遥测数据
• 设置和白名单保存在浏览器本地存储中
• 过滤规则列表随扩展一起打包，浏览时不会下载任何列表
• 赞助片段查询只发送视频 ID 的 SHA-256 哈希前 4 位，不发送视频 ID 或页面网址，
  可在设置中细化或完全关闭
• 可选的深色模式购买由 ExtensionPay / Stripe 处理（仅用于收据和恢复购买的邮箱），
  不会与支付方共享任何浏览数据
• 随时可以导出和重新导入你的设置

小提示
• 安装后直接浏览即可 —— 内置列表会立刻开始拦截
• 页面显示异常时，先用弹窗里的“网站出问题？”，不要急着整个关掉
• Alt+Shift+X 可以不打开弹窗直接启动元素选择器
• 重装了？用收据邮箱恢复深色模式购买
```

## 类别 (Category)

隐私与安全 / Privacy & Security — same as the English listing.

## Notes

- Screenshots are shared across locales in the dashboard. Worth re-capturing at least the popup
  and Options with a Chinese-locale profile so the listing images match the listing language:
  `chrome://settings/languages`, move 中文 to the top, restart Chrome, then
  `npm run store-screenshots`.
- Summary is 49 characters, well inside the 132 limit — Chinese is dense, so there is room to
  say more here than the English summary can.
- The `$2` price is written literally in listing copy. That is dashboard text, not a
  `chrome.i18n` message, so the `$$` escaping rule does not apply here.
