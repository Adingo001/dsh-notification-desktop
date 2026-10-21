# dsh-notification-desktop

给 **DeepSeek Harness 0.2.x** 用的「一轮跑完就弹系统通知」插件。上游 [`omdsh-dev/dsh-notification`](https://github.com/omdsh-dev/dsh-notification) 只覆盖 0.1.1 / 0.1.2 的客户端布局，这个包是它的 0.2.x 移植版。

## 它做什么

- Host 半边注册一个 `notification` 会话投影：折叠每个会话的最后一次 `turn/end`，得到 `{ turn, reason, body, tools }`。
- Client 半边盯住 `ctx.sessions.list` 里这个投影的 `turn` 单调上升，弹一条浏览器系统通知；正文是该轮最后一段助手回复（Host 侧截到 400 字符，Client 侧再按设置截一次）。
- 设置页在 **设置 → 完成提醒**：总开关、按结束原因过滤、仅后台提醒、通知常驻、正文长度、权限状态 + 请求权限 + 发测试通知。

投影是纯函数，Host 侧只注册、不碰会话日志以外的任何东西；Client 侧只用公开的 `sessions.list` 快照和 `settings.section` 槽位。

## 相对上游 0.1.4 改了什么

| 上游 | 0.2.x 适配 |
| --- | --- |
| `dsh.client.inject` 列 `dsh-client-runtime` / `dsh-client-store` / `dsh-client-ui-slots` / `dsh-client-ui-settings` / `dsh-client-locale` | 改成 `inject: []`：`dsh-client-runtime` 在 0.2.x 里根本不存在，而顺序已经由服务 `inject: ['slots','locale']` 和 `ctx.slots.inject()` 表达；少列一个不存在的 id 就少一个模块永远等不到依赖的风险 |
| `ctx.get('sessions').list.getSnapshot()` 取 `{ ids, byId, current }` | 0.2.x 快照是 `{ ids, byId, phase, projectionsBySession }`，行内是 `projectionValues` / `displayTitle` / `retainedBy` |
| 用 `state.current` 判断「正在看的会话」 | 改读 `row.retainedBy.mainView > 0`（0.2.x 的 retention 才是权威） |
| `uiSession.pendingInteractions` 做「等你审批/回答」提醒 | **未移植**：0.2.x 的 `pendingInteraction` 只在 `ui-session` 的 Slot hook 里（`sessionStatus`），不是可订阅的根服务；只做完成边。 |
| `@deepseek-ai/dsh-client-store` 存设置 | 依赖不可解析，改成 localStorage + 一个自带的极简 observable |
| 设置页用自家 styles/组件 | 只用 React + 宿主主题 CSS 变量（`--dsw-alias-*`），不引外部组件包 |

Host 半边的投影契约（`key` / `stateSchema` / `init` / `apply` / `wire` / `stateVersion`）在 0.2.1-rc.2 里没变，所以 `index.js` 基本是原逻辑。

## 安装

```powershell
# 本地目录（开发中）
dsh plugin --profile desktop add C:\path\to\dsh-notification-desktop

# 或从 GitHub
dsh plugin --profile desktop add https://github.com/<owner>/dsh-notification-desktop/archive/refs/heads/main.tar.gz
```

装完刷新页面：设置左侧应出现 **完成提醒** 一页。

## 桌面端：权限 ≠ 能够显示

两件事必须分开看，实测都踩过：

**1. 权限。** 桌面壳（`@deepseek-ai/dsh-desktop` 0.2.1-rc.2）给主窗口装的权限处理器，对**非 media** 权限是 `callback(true)` / `check → true`（见 `installMicrophonePermissions`）；被一律拒掉的是第三方登录窗口和 browser-use 的独立 partition。所以主窗口里 `Notification.permission` 实测就是 `granted`，不需要主进程加 IPC。

**2. Windows 的 toast 呈现。** 权限给了、`new Notification()` 也成功了，**照样可能一个都不显示**。原因：Electron 在 Windows 上把 renderer 的通知交给 ToastNotificationManager，并按 AppUserModelID 归属；而桌面壳的 `main.js` 里 `setAppUserModelId` 出现次数是 **0**，Chromium 于是退回默认值 `electron.app.DeepSeek Harness`，同时开始菜单快捷方式的 `System.AppUserModelID` 是空串 —— 这个 AUMID 指向不到任何已注册应用，Windows 记账（`HKCU\...\Notifications\Settings\electron.app.DeepSeek Harness` 的 `LastNotificationAddedTime` 会更新）但**静默丢弃 toast**。

一次性修好：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\fix-toast-aumid.ps1
# 撤销：加 -Remove
```

它只写一个 `HKCU\Software\Classes\AppUserModelId\<AUMID>`（DisplayName + IconUri），不碰壳、不碰 asar、不碰快捷方式。实测注册后 toast 正常出现。

> 自己写 PowerShell 探针时注意：`powershell -File` 执行**无 BOM 的 UTF-8** 脚本会按 GBK 解析，中文字面量会变成"锟斤拷"。这与插件无关（插件的中文是 JS 字符串经 Chromium 传给 WinRT，全程 UTF-16），纯粹是探针脚本自身的编码坑；探针脚本要么带 BOM，要么只用 ASCII。

## 已知边界

- 不提醒「等你审批 / 等你回答」这类挂起交互（原因见上）。
- 需要页面在跑：通知由页面里的 `Notification` 发出，页面关了就没有。
- `turn/end` 的 `forked` / `interrupted` 也会推进投影的 `turn`（这样客户端去重不会漏轮），但默认只在 `completed` / `error` 上弹。
- 诊断用：Host 半边注册了 `GET/POST/DELETE /dsh-notification-desktop/trace`，客户端把每次闸门判断 POST 进去。排查"为什么不弹"直接 `Invoke-WebRequest http://127.0.0.1:<port>/dsh-notification-desktop/trace` 就能看到 `apply` / `seed` / `tick` / `skip` / `fire` / `deliver` 六类记录。

## 验证

`tests/client-harness.mjs` 用一个假模块加载器 + 假 React + 假 cordis ctx + 假 `Notification` 跑完整个客户端半边：模块 id、导出、locale 字典、`settings.section` 注册、设置页渲染（并检查没有漏翻的 key），以及通知闸门（首帧播种、后台限制、原因过滤、`forked` 跳过、总开关、权限拒绝）。

```powershell
# 没有 node 在 PATH 上时，用 Harness 自己的 Electron 当 node
$env:ELECTRON_RUN_AS_NODE = 1
& "D:\ai\DeepSeek Harness.exe" .\tests\client-harness.mjs
```

Host 侧的投影折叠（累积文本、工具去重、正文截断、turn 单调推进）另有同款 node 直跑测试覆盖。

## 许可

MIT。上游 0.1.4 也是 MIT，本包为其 0.2.x 移植。
