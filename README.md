# Arkpets-Card

一块 800×480 的桌面信息卡片：时钟 / 农历 / 天气 + 待办事项 + Claude Code 用量监控，以及一只会在界面横线之间跳来跳去的明日方舟桌宠「年」。
![demon](demon.png)

## 功能

**信息面板**

- 时钟与日期（含简化农历推算）
- 实时天气：基于浏览器定位 + [Open-Meteo](https://open-meteo.com/) 免费 API，显示温度、湿度、风速、当日最高/最低温
- 待办事项：勾选完成、hover 删除、点击时间内联编辑（自由文本）、底部快捷添加，数据存于 localStorage
- Claude Code 用量：5 小时 / 7 天双窗口用量条与重置倒计时，数据来自 claude.ai 服务端真实接口

**桌宠「年」**

- Spine WebGL 渲染（Spine 3.8 骨骼模型）
- Markov 状态机驱动行为：Relax / Move / Sit / Sleep / Interact
- 多楼层系统：自动扫描页面 DOM 的可见横向 border 作为「可站立的线」，年会跳上去坐着、再溜达下来
- 鼠标交互：像素级悬停检测（readPixels），点击播放互动动画，可拖拽抛起——释放后受重力下落，落在下落路径上第一条横线上

## 快速开始

```bash
# 1. 配置
cp .env.example .env   # 按需填写 ACCOUNT_LABEL 等

# 2. 启动本地服务
node server.js

# 3. 打开面板
# http://localhost:3000/claude-dashboard.html
```

无构建步骤，`server.js` 仅依赖 Node 内置模块。

## 用量数据更新（macOS）

`update-usage.js` 通过 AppleScript 向 Chrome 中已登录的 claude.ai 标签页注入 fetch，读取官方用量接口（`/api/organizations/{org}/usage`），写入 `usage-data.js`（已 gitignore）。

前置条件：

1. Chrome 中保持一个已登录的 claude.ai 标签页
2. Chrome 菜单开启 View → Developer → Allow JavaScript from Apple Events

手动刷新点面板右上角 ↻，或 cron 定时：

```
*/5 * * * * cd /path/to/card && node update-usage.js
```

## 主要常量（claude-dashboard.html）

| 常量 | 默认值 | 说明 |
|---|---|---|
| `CARD_W × CARD_H` | 800×480 | 卡片尺寸 |
| `SCALE` | 0.4 | 桌宠缩放 |
| `WALK_SPD` | 45 | 行走速度 px/s |
| `JUMP_RANGE` | 65 | 坐下时搜索上下横线的范围 px |
| `SIT_MIN_H` | 50 | 低于此高度的线不可坐（坐姿会穿模） |
| `MAX_FLOOR_Y` | CARD_H−50 | 可落/可坐线的最大高度 |
| `GRAVITY` | 1200 | 拖拽释放后的下落加速度 px/s² |

## 致谢与版权

- 行为设计与 Spine 加载方案参考 [ArkPets-Web](https://github.com/fuyufjh/ArkPets-Web) 与 [Ark-Pets](https://github.com/isHarryh/Ark-Pets)
- 模型素材（`2014_nian_nian#4/`）来自 [Ark-Models](https://github.com/isHarryh/Ark-Models)，**版权归属 [鹰角网络 Hypergryph](https://www.hypergryph.com/)**，仅供学习交流，请勿用于商业用途
- `libs/spine-webgl.js` 为 Esoteric Software 的 [Spine Runtime](http://esotericsoftware.com/spine-runtimes-license)，使用需遵守其许可条款
- 本项目与 Anthropic、鹰角网络均无官方关联

## License

代码部分 MIT；素材与第三方运行时遵循各自原始许可（见上）。

