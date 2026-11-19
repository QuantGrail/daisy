# 本地网页在不同来源下能用哪些浏览器功能

经组网地址用普通 HTTP 打开网页时，浏览器不把它当安全来源（secure context），一部分功能不可用。这里列出界面用到的、受这条规则影响的功能，逐个写明在三种打开方式下能不能用、不能用时界面怎么做。

验证：`npm run build:web && npm run test:e2e:web-origins [组网地址]`（`scripts/e2e-web-origins.cjs`）。它在本机的内网地址上开启对外面（一次明文、一次 TLS 自签名证书），用 Chrome 打开，读出下表的能力，再在这个来源上完成一轮完整对话、处理一张审批卡片、等第二轮的卡片经实时通道推到页面上、打开设置页。表中“实测”一列是这个脚本在 macOS 的 Chrome（Playwright 无头）上跑出的结果；换了浏览器或版本，以重新跑一遍的结果为准。

## 三种打开方式

| 打开方式 | 地址 | 是否安全来源 | 说明 |
| --- | --- | --- | --- |
| 本机面 | `http://127.0.0.1:<端口>`（`daisy open` 打印的链接） | 是 | 浏览器把回环地址当作可信来源，即使是 HTTP |
| 对外面，TLS（默认） | `https://<组网地址>:<端口>`，自签名证书 | 是（放行证书警告后） | 第一次打开有证书警告；放行后是安全来源，但证书错误的页面不能注册 Service Worker |
| 对外面，明文 | `http://<组网地址>:<端口>`，只允许组网 / 内网地址（对外面默认用 TLS，主人可以对组网地址选明文） | **否** | 下表标“否”的功能都没有 |

三者是三个不同的来源（源含协议、主机和端口）：本机面和对外面的登录（网页会话存在 `sessionStorage`）、本页的偏好（`localStorage`）各自独立，这是有意的（ADR-110：网页会话只在签发它的面有效）。

## 界面用到的功能

| 功能 | 界面里在哪用 | 本机面 | 对外 TLS | 对外明文（实测） | 结论与替代 |
| --- | --- | --- | --- | --- | --- |
| 异步剪贴板 `navigator.clipboard.writeText` | 设置 › 入口面与口令 › 复制“从别的机器打开的链接”（`ui/src/clipboard.ts`） | 能 | 能 | **没有** | 回退到隐藏文本框 + `document.execCommand("copy")`（明文下实测可用）；再不行提示“请手动选中复制”，链接文字本身可选中。宿主可以用 `copyText` 适配器接管 |
| 粘贴截图（`paste` 事件的 `clipboardData`） | 对话输入框（`ui/src/chat.tsx`、`paste-files.ts`） | 能 | 能 | 能 | 只有异步剪贴板 API 要求安全来源，粘贴事件不受限；明文下没有自动化验证粘贴本身 |
| `crypto.randomUUID` | 每条消息、新建会话的幂等键 `makeId()`（`client/src/index.ts`）；终端页的请求号（`terminal.tsx`、`terminal-page/terminal.js`） | 能 | 能 | **没有** | `makeId()` 改用 `crypto.getRandomValues` 生成 v4 UUID（各来源都有，`tests/web-page.test.ts` 覆盖）；终端页回退到时间加随机数（只作请求号，不作幂等键）。明文下实测：发送、审批、第二轮都正常 |
| `crypto.subtle` | 界面不用 | — | — | 没有 | 不需要替代。打包进来的 xterm 里有一处引用，只在 VS Code 的 webview iframe 场景走到，Daisy 不触发 |
| Service Worker | 不用（没有离线 / PWA） | — | 注册被拒（证书错误） | 没有 | 不依赖。将来要做离线或推送，对外面必须换成浏览器信任的证书（阶段 5 的 CA，ADR-100）或把 `keys/tls-cert.pem` 导入系统信任 |
| 浏览器通知 `Notification` | 不用 | — | — | 对象在，但非安全来源请求权限会被拒 | 会话通知（一轮结束、审批卡片、AI 出错）在页面里显示（侧栏“通知”面板和会话列表的标记，`ui/src/notifications.tsx`），不弹系统通知；手机推送不归 Daisy |
| `localStorage` / `sessionStorage` | 网页会话（`sessionStorage`）；侧栏折叠、输入框高度、新建会话的默认选择、通知已看到哪条（`localStorage`） | 能 | 能 | 能 | 无限制。隐私模式等取不到时各处都有 try/catch，只少了“记住”，功能不受影响 |
| `BroadcastChannel` | 退出时通知别的标签页清掉会话缓存（`session-cache.ts`） | 能 | 能 | 能 | 无限制 |
| WebSocket（`/api/live`） | 会话的实时推送 | `ws://` | `wss://` | `ws://` | 无限制；同源，CSP `connect-src 'self'` 覆盖。明文下实测第二轮的审批卡片实时到达 |
| 附件上传 / 下载（`<input type=file>`、`FileReader`、`Blob`、`URL.createObjectURL`、`a.download`） | 对话的附件 | 能 | 能 | 能 | 无安全来源要求 |
| 拖放文件（`DataTransfer`） | 对话区 | 能 | 能 | 能 | 无限制 |
| 终端（xterm，同源 iframe `/terminal-assets`） | 会话的终端面板 | 能 | 对外面默认关 | 对外面默认关 | 对外面上终端 / 执行命令 / 浏览目录默认关，要 PIN 才能开；开了以后不依赖受限功能（见上面 `randomUUID` 一行） |
| Cookie | 不用 | — | — | — | 网页会话用 Bearer（ADR-110），与安全来源无关 |

实测原始输出（`npm run test:e2e:web-origins 192.0.2.10`；地址换成了文档专用地址）：

```
feature | plain HTTP | TLS (self-signed, let through)
isSecureContext | false | true
navigator.clipboard | false | true
crypto.randomUUID | false | true
crypto.subtle | false | true
crypto.getRandomValues | true | true
serviceWorker | absent | refused (Failed to register a ServiceWorker …)
Notification | true | true
BroadcastChannel | true | true
localStorage | true | true
sessionStorage | true | true
WebSocket | true | true
execCommand('copy') | true | true
Web origins test passed: a full turn with an approval works over both.
```

## 对外面上要注意的另一件事：浏览目录默认关

对外面上“浏览目录”默认关（开启要 PIN），而新建会话原来总要经浏览接口登记目录，所以从别的机器打开时会建不了会话。现在的做法：新建会话默认选已经登记的工作目录（主目录登记过就选它），选中的目录已登记时直接用，不再调浏览接口；要用新目录，在本机面登记（设置 › 工作目录），或由主人在对外面上打开“浏览目录”（要 PIN）。

## 建议

- 对外面保持默认的 TLS。明文只在组网内用，代价是剪贴板走回退路径，其余功能不受影响。
- 自签名证书第一次打开会有警告。想去掉警告，把数据目录里的 `keys/tls-cert.pem` 导入访问方机器的系统信任；地址变了或证书快过期时 Daisy 会重新生成，要重新导入。
- 新加一个浏览器功能前，先查它是否要求安全来源（MDN 的 “Secure context” 标记），要求的话按本表补一行，并在 `scripts/e2e-web-origins.cjs` 里加上探测。
