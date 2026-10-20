# dsh-screen-use — 屏幕操作

给 DeepSeek Harness 增加**读取屏幕**和**共享鼠标控制**的能力，并提供一个小悬浮窗：开关屏幕读取/鼠标操作、实时预览、直接给 DeepSeek 发消息、按需急停。

设计上刻意避开两件事：**不会悄悄花 token**，**不会抢走用户的鼠标**。

```
悬浮窗（shell.overlay）
  ├─ 读取屏幕开关   → 关：零截图、零预览、工具直接拒绝
  ├─ 允许操作开关   → 关：鼠标/键盘注入全部阻断
  ├─ 实时预览        → 开启读取后每 4 秒刷新（本地，不进模型）
  ├─ 聊天框          → 消息进入当前会话，由能操作桌面的 agent 处理
  └─ 停止 / 解除急停 → 只有用户能解除
```

## 快速开始

前提：Windows + DeepSeek Harness 桌面版，且当前 profile 已启用插件。

1. 安装 bundle 后重启 Harness（或在插件页确认已启用）。
2. 对话区左上角出现「屏幕操作」胶囊，点开悬浮窗。
3. 打开「读取屏幕」→ 出现预览；打开「允许操作」→ agent 才能移动鼠标、点击、输入。
4. 在聊天框里直接说：「打开设置，把字体调大」。

> 两个开关**默认都是关的**，并且只在本次进程内有效。重启后重新确认一次，这是故意的：忘记关掉的开关不该在下次开机后继续花 token。

## 拖动与位置

- **随便抓**：展开后的卡片，除了按钮、开关、输入框这些真正的控件，**任何位置按住都能拖**（标题栏、说明文字、预览图、聊天记录都行）；收起后的胶囊同样可以拖动——先拖到顺手的位置再点开。
- **不会丢**：位置写进页面存储（`localStorage`），刷新页面、插件重载后都待在原处。
- **不会拖丢**：始终保留至少 72px 在视口内；拖到窗口边缘会被拉回来，窗口缩小时也会重新夹紧。展开时如果卡片比剩余空间高，会自动往上收，保证整张卡片可见。
- **复位**：双击标题栏回到默认位置（左上角、侧边栏右侧）。
- 边界说明：它是 Web 界面里的悬浮层，只能在 **Harness 窗口内**移动，不能浮到其他应用窗口上面。

## 安全模型

### 1. Esc 随时强制停止

- 只要「允许操作」是开着的，宿主每 40ms 轮询一次物理 Esc 键（`GetAsyncKeyState`，不装键盘钩子、不吞键）。
- 同时读「当前按下」与「自上次轮询后被按过」两个位，所以快速点一下 Esc 也不会漏掉；授权开始时先消耗一次陈旧状态，避免误触发。
- 按下 Esc 立即：撤销授权 → 释放可能按下的鼠标键 → 本次及后续所有注入动作被拒绝。
- 急停状态**只能由悬浮窗的「解除急停并继续」清除**；工具面没有任何入口能清除它。工具被拒绝时会明确要求"请让用户在面板里解除"，而不是假装动作完成。
- 拖拽这类多步手势内部也会逐步检查 Esc，不会出现"按住鼠标时按 Esc 无效"。

### 2. 真·共享鼠标：你随时能用，Esc 才是停止键

- 自动化操作时**你仍然可以同时动鼠标、滚轮、打字**，不会因此被中断；手抖一下、顺手滑一下都没关系。
- 停止只有一个明确信号：**按 Esc**（或点面板的「立即停止操作」）。按下即撤销授权、释放可能按住的鼠标键，之后所有注入动作被拒。
- 之所以不再用"指针被动过就停"来判断：那会把每一次手抖都当成夺权，停下后还要重新授权，反而更难用。Esc 是唯一无歧义、不会误触的刹车。
- 使用 `SendInput`/`SetCursorPos` 注入真实事件（而不是只发窗口消息），所以目标程序看到的是正常输入；两人同时动鼠标时会互相"抢"指针，这是共享指针的物理现实，按 Esc 退出即可。

### 3. 两道用户开关

| 开关 | 关掉后的效果 |
|---|---|
| 读取屏幕 | `windows` / `capture` 被拒绝；预览不刷新；宿主完全不截屏。`info` 仍可读桌面尺寸/DPI/指针（只有数字，没有画面和窗口标题） |
| 允许操作 | 所有 move/click/drag/scroll/type/key/shortcut 被拒绝 |

拒绝时工具返回 `status: "blocked"` 和一句可直接转述给用户的话，不抛裸错误。

## 省 token 策略

屏幕类 agent 的账单几乎全在"重复发图"。这个插件把每一分钱都卡在寄出图片之前：

| 机制 | 行为 | 省什么 |
|---|---|---|
| 读取开关 | 关着就完全不截屏 | 整个能力在关时零成本 |
| 整屏缩略 | 整屏最长边默认 1024px（本机 2560×1600 会缩到 1024×640） | 单张图的像素量 |
| 区域原分辨率 | 明确要 `region` 时才按原生分辨率截（上限 1400px） | 需要细节时只截那一块 |
| 未变化不发图 | 同一区域指纹相同 → 只回文字"画面未变"，**不再附第二张图** | 轮询/验证循环里最大的一笔 |
| `changeOnly` | 只裁出真正变化的矩形再截，返回新原点 | 弹窗、行内提示这类小变化 |
| 冷却 + 频控 | 800ms 内连拍自动合并；每分钟超过 24 次只回文字 | 连点连拍 |
| 文字优先 | `windows` / `info` / `wait_change` / `wait_stable` 都零图片 | 大部分"东西在哪/变没变"的问题 |
| 批量动作 | `screen_batch` 一次调用跑「点击 → 输入 → 回车」，末尾才附一张验证图 | 往返轮次（每轮都要重发工具 schema 与历史） |

外部实践也是同一方向：项目 [tinyscreenshot](https://github.com/franzenzenhofer/tinyscreenshot) 把单张截图从约 2100 token 压到约 540 token；OpenClaw 的 [停止重发未变化截图](https://github.com/openclaw/openclaw/pull/129924) 与 Hermes agent 的 [同类改动](https://github.com/NousResearch/hermes-agent/commit/682b973b329754432a54520af94121c6ee9e646e) 都在修"画面没变还继续发图"；Vercel 的 [agent-browser](https://github.com/vercel-labs/agent-browser/blob/main/skill-data/core/SKILL.md) 直接把 `screenshot --if-changed` 标成推荐用法；[AQuAI](https://export.arxiv.org/pdf/2605.19260) 则用自适应四叉树只保留变化区域的视觉 token。DeepSeek 视觉侧也有按图封顶的计费口径（[一张图最多 384 token 的报道](https://ofox.ai/zh/blog/deepseek-v4-flash-vision-exp-image-tokens-2026/)），意味着"少而准的图"比"大而全的图"更划算。

> 上述数字来自检索结果的说明，未在本机重新计费；本插件实现的是机制，不依赖任何具体单价。

## 工具

| 工具 | 作用 |
|---|---|
| `screen` | 单步：`info` / `windows` / `focus` / `capture` / `move` / `click` / `double_click` / `right_click` / `middle_click` / `drag` / `scroll` / `type` / `shortcut` / `key` / `wait_change` / `wait_stable` / `sleep` / `status` |
| `screen_batch` | 一次调用执行多步；`captureAtEnd: true` 只在末尾附一张验证图 |

坐标规则只有一条：`native: true` 时，**图像像素 + region 原点 = 屏幕坐标**；被缩放过时结果里会明确给出 `scale`，公式同步写进文字。

`capture` 的关键参数：`region`、`window`、`maxDimension`、`grid`、`force`、`changeOnly`。

## 配置

`cordis.patch.yml` 的 `screen-use.config`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关掉则不注册任何工具 |
| `overviewMaxDimension` | `1024` | 整屏截图最长边 |
| `nativeMaxDimension` | `1400` | 区域/窗口截图最长边 |
| `pngLevel` | `6` | PNG 压缩级别 1–9 |
| `minCaptureIntervalMs` | `800` | 两次截图的最小间隔（不足则等待合并） |
| `maxCapturesPerMinute` | `24` | 每分钟最多附图的次数，超出只回文字 |
| `outputDirectory` | `''` | PNG 落盘目录；空则用系统临时目录 |

两个运行时开关不在配置里——它们只属于面板，且不持久化。

## 与 dsh-computer-use 的关系

`src/win32.cjs`、`src/capture.cjs`、`src/png.cjs`、`lib/loader.cjs` 改编自 MIT 许可的 [dsh-computer-use](https://github.com/EvangeliMo/dsh-computer-use)，保留了它实测过的坐标空间假设、DWM 边框、PNG zlib 流等关键约束；本插件新增了 `GetAsyncKeyState` 绑定与 Esc/鼠标接管探测。完整署名见 `NOTICE`。

与原项目的区别：

- 原项目是**第五种模式**（整份 preset），适合"这次任务全程操作电脑"；
- 本插件是**常驻能力 + 面板**，在任何会话里按需开关，重点在"用户可随时接管"和"不浪费 token"。

## 已知限制

1. UAC / 安全桌面截不到，也无法向提权窗口注入输入（UIPI）。
2. GPU 合成窗口（`WS_EX_NOREDIRECTIONBITMAP`）直接 `PrintWindow` 可能空白，插件会自动回退到屏幕区域截图。
3. 全局 Esc 轮询在"允许操作"开着时每 40ms 一次，成本可忽略；关掉开关后定时器立即停止。
4. 悬浮窗里的预览是本地刷新，不进模型上下文；但它确实在截屏，所以关掉「读取屏幕」后预览也会停。
5. 本插件只支持 Windows。
6. 插件重载/重启后两个开关都会复位为关，急停也会清空（新进程没有"上次授权"可继承）。
7. koffi 的类型名在进程内全局注册，所以每次加载都用带随机的类型前缀；这是本插件能在 HMR 重载和与 `dsh-computer-use-mode` 共存时继续工作的原因，不要改回固定名字。

## 验证状态

在本机（2560×1600，DPI 144，Harness 桌面版）实测：

- 宿主文件：`node --check` 全部通过；`Config` 校验通过，插件安装后 `application: applied`。
- 原生层：`koffi` 绑定、窗口枚举（7 个可用 / 376 个无标题辅助窗口被过滤）、整屏截图缩到 1024×640、区域原生 400×300 截图、PNG 编码与落盘均正常。
- 省 token：同一区域第二次截图**不附图**并明确回报"画面未变"；`force: true` 时重新附图；`region` 走原生分辨率。
- 门控：读取关闭时 `windows`/`capture` 返回 `blocked`；允许操作关闭时点击/按键被拒。
- 鼠标与面板：真实注入点击成功展开悬浮窗，悬浮窗渲染、两个开关的文案与状态、预览、停止按钮均按预期显示。
- 拖动：真实注入拖拽成功拖动收起胶囊（拖完不会误触展开）、也成功拖动展开卡片（从正文按住即可）；拖动结果在插件重载后仍保持（`localStorage`）；拖到底部再展开时卡片被自动上收、完整可见。
- 急停：注入 Esc 后工具立即返回 `stopped`，面板出现"你按下了 Esc，鼠标键盘注入已被阻断"横幅；急停期间注入点击被拒（连"解除急停"按钮也只能由真人点击）——见 `docs/panel-esc-stop.png`。
- 共享鼠标：控制已授权时手动移动鼠标/滚动，不会触发停止；随后注入的点击与拖动照常执行。只有注入 Esc（或点面板停止）才会 `stopped`。
- 解除急停：面板路由 `{resume:true}` 清空急停并重新授权，随后关闭两个开关，状态恢复干净。
- 聊天框：消息通过客户端 `sessions` 服务的 `prompt()` 进入当前会话（与自带输入框同一条路径）；"最近一条回复"从会话事件流读取。

## 文件结构

```
dsh-screen-use/
├── package.json        # CommonJS 宿主 + dsh.client 浏览器半
├── cordis.patch.yml    # 唯一一行：宿主平面挂载
├── icon.svg            # 原创图标（显示器 + 共享指针 + 急停）
├── locale/{zh,en}.json # 插件页标题/描述
├── lib/
│   ├── index.js        # 工具、提示词、面板路由
│   ├── screen.cjs      # 截图/输入/门控/Esc/省 token 运行时
│   └── loader.cjs      # 穿透 asar 的模块解析
├── src/                # 改编自 dsh-computer-use 的原生层
├── client.js           # 悬浮窗
├── README.md
└── NOTICE              # 署名与许可
```
