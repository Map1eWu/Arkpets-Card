# Arkpets-Card

一块 800×480 的桌面信息卡片：时钟 / 天气 + 待办事项 + Claude Code 用量监控 + 网易云音乐 + GPU 监控，以及一只会在界面横线之间跳来跳去的明日方舟桌宠「年」。

![demon](demon_img/demon1.png)
<img src="demon_img/demon1.png" width="300" /> <img src="demon_img/demon7.png" width="300" />

## 功能

**信息面板**

- 时钟与日期
- 实时天气：基于浏览器定位 + [Open-Meteo](https://open-meteo.com/) 免费 API，显示温度、湿度、风速、当日最高/最低温，每 5 分钟自动刷新
- 待办事项：勾选完成、hover 删除、点击时间内联编辑（自由文本）、底部快捷添加，数据存于 localStorage
- Claude Code 用量：5 小时 / 7 天双窗口用量条与重置倒计时，数据来自 claude.ai 服务端真实接口
- 音乐：读取 macOS 系统「正在播放」（网易云 / Apple Music / Spotify 等），显示封面、歌名、歌手与**逐句滚动歌词**；歌词与高清封面来自网易云，进度在前端实时插值，歌词丝滑走字（详见下方「音乐」一节）
- 深浅色主题：右上角齿轮打开设置，可选浅色 / 深色 / 跟随时间（19:00–7:00 自动深色）
- 用量报警：5 小时额度 ≥80% 时，年会自己走到用量条上、坐在填充末端"值班"；≥95% 躺平，额度重置后庆祝离岗
- 开机自启：设置栏一键开关（macOS launchd）
- GPU 监控：中间栏实时显示远程服务器每张卡的利用率/显存/温度（ssh 免密 + nvidia-smi，连接复用，无人查看时自动停止轮询）；在 `.env` 配置 `GPU_HOST` 即可。每条 GPU 进度条同时是年的可站立横线——多卡服务器就是她的梯子
- 顶栏小组件：
  - **顶栏时间**——关闭「时间」栏时，顶栏 Claude 右侧自动显示当前时间（开着时不重复显示）
  - **顶栏歌曲**——设置栏开关；开启后在顶栏右侧（日期左边）显示小封面 + 歌名。**仅当「音乐」栏关闭时可用**，「音乐」栏打开时开关变灰

**桌宠「年」**

- Spine WebGL 渲染（Spine 3.8 骨骼模型）
- Markov 状态机驱动行为：Relax / Move / Sit / Sleep / Interact
- 多楼层系统：自动扫描页面 DOM 的可见横向 border 作为「可站立的线」，年会跳上去坐着、再溜达下来
- 鼠标交互：像素级悬停检测（readPixels），点击播放互动动画，可拖拽抛起——释放后受重力下落，落在下落路径上第一条横线上
- 位置持久化：F5 刷新不丢位置（sessionStorage），关闭标签页或点用量栏的 ↺ 按钮重置

## 快速开始

```bash
# 1. 配置
cp .env.example .env   # 按需填写 ACCOUNT_LABEL 等

# 2. 安装依赖
npm install                  # server.js 需要 @neteasecloudmusicapienhanced/api 与 jimp
brew install media-control   # 音乐功能依赖（见下）

# 3. 一键启动（拉起 server + Chrome 应用模式无边框窗口）
./start.sh

# 或手动：node server.js 后访问 http://localhost:3000
```

`server.js` 本体只用 Node 内置模块起 HTTP 服务，但音乐功能用到两个 npm 包（`@neteasecloudmusicapienhanced/api`、`jimp`）和一个外部命令（`media-control`）。其余功能（天气、用量、GPU、桌宠）无额外依赖。

**开机自启（macOS）**：设置栏（右上角齿轮）里打开"开机自启"开关即可——由本地 server 在 `~/Library/LaunchAgents/` 写入 launchd 配置，登录时自动执行 `start.sh`；关闭开关即移除，不留残留。

## 音乐

桌面端「正在播放」的来源是 macOS 系统级 Now Playing（锁屏/控制中心那套），所以**不限网易云**——放视频、直播也会显示对应标题（此时只显示标题、不搜歌词）。

**为什么用 `media-control` 而不是 `nowplaying-cli`**：macOS 15.4 起 Apple 给 `mediaremoted` 加了 entitlement 校验，普通二进制（含 `nowplaying-cli`、自己编译的 Swift）直连 `MediaRemote.framework` 会被拒返回空。[`media-control`](https://github.com/ungive/media-control) 借系统自带、带授权的 `/usr/bin/perl` 去访问，因此在 macOS 15.4 / 26 上仍可用，且**无需关闭 SIP**。`brew install media-control` 即可。

数据流：

1. 后端每 2 秒（无人查看时自动停）调 `media-control get`，拿到 `title / artist / album / duration / elapsedTime / timestamp / playbackRate / artworkData`（系统封面是 ~100px 小图）
2. 切歌时用「歌名 + 歌手」搜网易云，按 **专辑名 + 歌手 + 时长** 综合打分挑候选；不够确定时再用系统小图当指纹，对候选封面做**感知哈希 + 像素差**比对（`jimp`），锁定正在播放的那一版 → 歌词与高清封面都对得上
3. 封面策略：先显示系统小图保证立即有画面，匹配到高置信版本后**异步替换成网易云高清图**；不确定时保留系统图（虽糊但确为当前曲）
4. 进度由前端用 `elapsedTime + (now − timestamp) × playbackRate` 实时插值，250ms 刷新一次歌词高亮，暂停时自然冻结

**布局**：歌名/歌手与歌词之间有一条可调横线，在 `claude-dashboard.html` 的 `.music-pane` 里改 `--music-split`（上半区占比，调大→横线下移、封面更大；调小→歌词更多）。封面在「上边界↔歌名」之间居中。

## 用量数据更新（macOS）

`update-usage.js` 通过 AppleScript 向 Chrome 中已登录的 claude.ai 标签页注入 fetch，读取官方用量接口（`/api/account` 取 org → `/api/organizations/{org}/usage`），写入 `usage-data.js`（已 gitignore）。

前置条件：

1. Chrome 中保持一个已登录的 claude.ai 标签页
2. Chrome 菜单开启 View → Developer → Allow JavaScript from Apple Events

手动刷新点面板右上角 ↻，或 cron 定时：

```
*/5 * * * * cd /path/to/card && node update-usage.js
```

## 主要常量

**桌宠（`claude-dashboard.html`）**

| 常量 | 默认值 | 说明 |
|---|---|---|
| `CARD_W × CARD_H` | 800×480 | 卡片尺寸 |
| `SCALE` | 0.4 | 桌宠缩放 |
| `WALK_SPD` | 45 | 行走速度 px/s |
| `JUMP_RANGE` | 65 | 坐下时搜索上下横线的范围 px |
| `SIT_MIN_H` | 30 | 低于此高度的线不可坐（坐姿会穿模） |
| `MAX_FLOOR_Y` | CARD_H−50 | 可落/可坐线的最大高度 |
| `GRAVITY` | 1200 | 拖拽释放后的下落加速度 px/s² |

**音乐布局（`claude-dashboard.html`）**

| 位置 | 说明 |
|---|---|
| `--music-split`（`.music-pane`） | 歌名歌手与歌词之间横线的位置（上半区占比，默认 60%） |
| `.header` `height` | 顶栏固定高度（默认 42px，放大顶栏封面也不会撑高） |

**音乐匹配（`server.js`）**

| 位置 | 默认 | 说明 |
|---|---|---|
| `MUSIC_BUNDLES` | 网易云/Apple Music/Spotify/QQ 音乐 | 只有这些 App 在播时才搜歌词 |
| `MEDIA_CONTROL` | Homebrew 路径兜底 | `media-control` 可执行文件位置 |
| 图像比对阈值 | `0.20` | `searchSong` 内相似度阈值，越小越严 |
| 候选下载数 | `8` | 图像比对时下载比对的候选数 |

## 更换桌宠模型

模型与 [ArkPets-Web](https://github.com/fuyufjh/ArkPets-Web) 同源，来自 [Ark-Models](https://github.com/isHarryh/Ark-Models) 模型库。其 `models/` 目录下每个文件夹是一只干员基建小人，由 `.skel` + `.atlas` + `.png` 三件套组成（具体清单见仓库根目录的 `models_data.json`）。

1. 在 Ark-Models 的 `models/` 中找到想要的干员，下载整个文件夹，放到本项目根目录（与 `2014_nian_nian#4/` 同级）
2. 修改 `claude-dashboard.html` 桌宠模块顶部的四个常量，例如：
   
   ```js
   const MODEL_DIR  = '/xxxx_name/';            // 文件夹名；特殊字符需 URL 编码（如 # → %23）
   const SKEL_KEY   = 'build_char_xxxx_name.skel';
   const ATLAS_KEY  = 'build_char_xxxx_name.atlas';
   const PNG_KEY    = 'build_char_xxxx_name.png';
   ```
3. 刷新页面即可，体型不合适就调 `SCALE`

**注意事项**

- 必须是 Spine 3.8 的**基建小人**（`models/` 目录）；`models_enemies/`（敌人）与 `models_illust/`（动态立绘）动画名不同，不能直接用
- 模型需包含 `Relax` / `Move` / `Sit` / `Sleep` / `Interact` 动画，个别"载具型"模型缺 `Sit`/`Sleep`，暂不支持
- Ark-Models 自 2025 年 3 月起对所有纹理启用了 Premultiplied Alpha；如果新模型渲染出黑边/白边，把 `claude-dashboard.html` 中 WebGL 初始化处的 `premultipliedAlpha: false` 与 `renderer.premultipliedAlpha = false` 改为 `true`

## 致谢与版权

- 行为设计与 Spine 加载方案参考 [ArkPets-Web](https://github.com/fuyufjh/ArkPets-Web) 与 [Ark-Pets](https://github.com/isHarryh/Ark-Pets)
- 模型素材（`2014_nian_nian#4/`）来自 [Ark-Models](https://github.com/isHarryh/Ark-Models)，**版权归属 [鹰角网络 Hypergryph](https://www.hypergryph.com/)**，仅供学习交流，请勿用于商业用途
- 系统播放信息读取依赖 [media-control](https://github.com/ungive/media-control)（BSD-3-Clause）；歌词/封面来自网易云，版权归原权利人所有，仅供学习交流
- `libs/spine-webgl.js` 为 Esoteric Software 的 [Spine Runtime](http://esotericsoftware.com/spine-runtimes-license)，使用需遵守其许可条款
- 本项目与 Anthropic、鹰角网络、网易均无官方关联

## License

代码部分 MIT；素材与第三方运行时遵循各自原始许可（见上）。

