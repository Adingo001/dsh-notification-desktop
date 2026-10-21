# dsh-notification-desktop

给 **DeepSeek Harness 0.2.x** 用的「一轮跑完就弹系统通知」插件。上游 [`omdsh-dev/dsh-notification`](https://github.com/omdsh-dev/dsh-notification) 只覆盖 0.1.1 / 0.1.2 的客户端布局，这个包是它的 0.2.x 移植版。

## 它做什么

- Host 半边注册一个 `notification` 会话投影：折叠每个会话的最后一次 `turn/end`，得到 `{ turn, reason, body, tools }`；再提供一个 `POST /dsh-notification-desktop/notify` 路由，用 WinRT 真正把 toast 弹出来。
- Client 半边盯住 `ctx.sessions.list` 里这个投影的 `turn` 单调上升，决定这一轮要不要提醒（原因过滤、后台限制、总开关）；**桌面壳里把内容 POST 给宿主去弹，浏览器里才用页面自己的 `Notification`**。正文是该轮最后一段助手回复（Host 侧截到 400 字符，Client 侧再按设置截一次）。
- 设置页在 **设置 → 完成提醒**：总开关、按结束原因过滤、仅后台提醒、通知常驻、正文长度、权限状态、发测试通知。

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

**桌面端（DSH Desktop）**：`desktop` profile 由 Electron 应用独占，CLI 会拒绝写入（`profile "desktop" is managed exclusively by the Electron application`）。走应用自己的入口：

- 侧栏 **插件 → 添加插件**，粘贴仓库地址 `https://github.com/Adingo001/dsh-notification-desktop`；
- 或让 agent 用宿主内置的 plugin manager 装同一个地址（`plugin_manager` 的 `install_bundle`，`link:` 本地目录也行）。

**Web / CLI profile**（`dsh web`、headless 等）：

```bash
dsh plugin --profile web add https://github.com/Adingo001/dsh-notification-desktop/archive/refs/heads/main.tar.gz
```

装完刷新页面（桌面端要重启应用）：设置里应出现 **完成提醒** 一页。

> Windows 上还要跑一次 `scripts/fix-toast-aumid.ps1`，否则 toast 会被系统静默丢弃 —— 见下面「权限 ≠ 能够显示」。

## 插件市场（Discover）

`market/index.json` 是这个包的 **format 1 插件市场索引**，可以直接在 **插件 → Discover → 添加索引源** 里加：

```
https://raw.githubusercontent.com/Adingo001/dsh-notification-desktop/main/market/index.json
```

条目是 **commit 固定的 git 源**（`git+https://github.com/Adingo001/dsh-notification-desktop.git#<40 位 commit>`），不是移动分支——`marketInstallTarget()` 就是这么拼装的，版本号与 commit 一一对应。

发新版本时重新生成：

```powershell
$env:ELECTRON_RUN_AS_NODE = 1
& "D:\ai\DeepSeek Harness.exe" scripts\build-market-index.mjs
```

生成器保留索引里已有的历史版本，只把当前 `package.json` 的版本追加/替换进来，并把 `icon.svg` 复制到 `market/`（索引里的图标是相对引用，按索引 URL 解析）。

索引用 DSH 自带的校验器验过：`@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex()`，`format: 1`、`engines.dsh = >=0.2.0 <0.3.0`（`0.2.1-rc.2` 落在范围内）。要让别的市场收录，把这份 `index.json` 的条目提给对应索引维护者即可——格式统一，条目可原样搬运。

## 社区收录状态

DSH 的「市场」不是一个中心，而是几套索引 + 一个 GitHub topic 的生态。当前状态：

| 渠道 | 机制 | 状态 |
| --- | --- | --- |
| `bradeGithub/DSH-Plugins-Marketplace`（9500+ 插件，每 2 小时增量扫描） | 抓 GitHub topic `dsh-plugin` | ✅ 已打 topic，最迟 2 小时自动进索引，无需申请 |
| `awesome-dsh-plugin`（社区精选，也是下面几个索引的数据源） | PR 一个 `data/plugins/<owner>__<repo>.yml` | ⏳ 条目已备好（`market/awesome-dsh-plugin.yml`），等仓库创建满 1 天：本仓库 `2026-10-21 09:16 UTC` 建，**`2026-10-22 17:16` 之后**可提 |
| `dsh-market` / `dshmarket`（直接读 awesome 的 `plugins.json`） | 自动跟随 awesome | ⏳ 随上一条 |
| `dsh-plugin-catalog`（jsDelivr 上的 format 1 索引，DSH Discover 官方入口） | 由 awesome 生成 | ⏳ 随上一条 |
| 本仓库 `market/index.json` | 用户自己加索引源 | ✅ 已上线 |

`awesome-dsh-plugin` 的硬门槛（照它的 `contributing.md`）：仓库要有真实代码、`package.json` 必须声明 `dsh.bundle`（只写 `dsh.client` 不算，会被打回）、仓库创建满 1 天。前两条本仓库满足。

> 同分类里已有 `ztl0001/dsh-notify`（也是收尾提醒）。我们这条描述的差异化点写的是**实现事实**：0.2.x 的宿主投影 + 桌面端走宿主 WinRT 发（因为页面里的 `Notification` 在这套壳上会被系统静默丢弃），带按结束原因过滤的设置页。描述与代码对得上，这是那个列表审的核心。

## 桌面端：权限 ≠ 能够显示

两件事必须分开看，实测都踩过：

**1. 权限。** 桌面壳（`@deepseek-ai/dsh-desktop` 0.2.1-rc.2）给主窗口装的权限处理器，对**非 media** 权限是 `callback(true)` / `check → true`（见 `installMicrophonePermissions`）；被一律拒掉的是第三方登录窗口和 browser-use 的独立 partition。所以主窗口里 `Notification.permission` 实测就是 `granted`，不需要主进程加 IPC。

**2. Windows 的 toast 呈现。** 权限给了、`new Notification()` 也返回成功，**照样可能一个都不显示**，而且是两层原因叠在一起：

- **AUMID 没人注册。** Electron 在 Windows 上把 renderer 的通知按 AppUserModelID 归属；桌面壳的 `main.js` 里 `setAppUserModelId` 出现次数是 **0**，Chromium 退回默认值 `electron.app.DeepSeek Harness`，而开始菜单快捷方式的 `System.AppUserModelID` 是空串 —— 这个 AUMID 指向不到任何已注册应用。Windows 照样记账（`HKCU\...\Notifications\Settings\electron.app.DeepSeek Harness` 的 `LastNotificationAddedTime` 会更新）但**静默丢弃 toast**，通知中心里连留底都没有。
- **即使 AUMID 补齐了，Chromium 这条 presenter 仍然不放行。** 同一个 AUMID 下用 WinRT 直接发就能显示，页面里 `new Notification()` 发就还是不显示。所以桌面端不让页面发，改成页面 POST 给宿主、宿主用 WinRT 发（`POST /dsh-notification-desktop/notify`）。

两步都做上才算通：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\fix-toast-aumid.ps1
# 撤销：加 -Remove
```

它只写一个 `HKCU\Software\Classes\AppUserModelId\<AUMID>`（DisplayName + IconUri），不碰壳、不碰 asar、不碰快捷方式。

> **两个 PowerShell 坑（都实测踩过，都会静默失败）**
>
> 1. `[Type]::Static($x).Method()` 这种**在静态方法结果上继续调方法**的写法，Windows PowerShell 5.1 直接解析失败；配上 `stdio: 'ignore'` 就是"退出码 0、什么也没发生"。必须拆成 `$notifier = [Type]::Static($x)` 然后 `$notifier.Method()`。宿主侧现在会收集子进程 stdout/stderr 并写进 trace（`host-notify-result`），失败不再无声。
> 2. `powershell -File` 执行**无 BOM 的 UTF-8** 脚本会按 GBK 解析，中文字面量变成"锟斤拷"。所以 `scripts/toast.ps1` 是纯 ASCII，用户可见文本一律通过 UTF-8 JSON 文件传进去。

## 已知边界

- 不提醒「等你审批 / 等你回答」这类挂起交互（原因见上）。
- 页面必须在跑：判定发生在页面里，页面关了就没有；桌面端只是把"弹"这一步交给宿主。
- `turn/end` 的 `forked` / `interrupted` 也会推进投影的 `turn`（这样客户端去重不会漏轮），但默认只在 `completed` / `error` 上弹。
- 诊断用：Host 半边注册了 `GET/POST/DELETE /dsh-notification-desktop/trace`，客户端把每次闸门判断 POST 进去。排查"为什么不弹"直接 `Invoke-WebRequest http://127.0.0.1:<port>/dsh-notification-desktop/trace` 就能看到 `apply` / `seed` / `tick` / `skip` / `fire` / `deliver` / `host-notify` / `host-notify-result` 记录 —— 一次真实排查就是靠这条链定位到上面两个坑的。

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
