# @marshal/pi-turn-stats

pi 扩展：对话统计（Turn Stats）。每次对话交换后，自动记录耗时、token 用量（input / output / cache read / cache write）和费用。

## 功能特性

- **对话流统计卡片** — 每次回复后，在对话流中追加统计卡片（不会进入 LLM 上下文）。
- **状态栏实时显示** — 底部状态栏显示上一轮对话的耗时 / 输出速度 / token 数 / 费用。
- **`/turnstats` 命令** — 追加会话累计统计卡片（总交换次数、总轮次、总 token、总费用）。

## 效果截图

![Turn Stats](https://github.com/MarshalW/pi-turn-stats/raw/v0.1.2/turn-stats.jpg)

## 安装

**推荐方式**：从 npm 安装，国内访问稳定，且可查看安装统计。

```bash
# pi 直接安装 npm 包
pi install -l npm:@marshal/pi-turn-stats
```

或使用标准 npm 安装：

```bash
npm install @marshal/pi-turn-stats
```

> 注意：`pi install -l npm:...` 是 pi 推荐的本地安装方式，会将扩展安装到当前项目；普通 `npm install` 仅下载包，不自动注册为 pi 扩展。

**备选方式**：从 GitHub 安装（适合需要源码或自定义修改的场景）。

```bash
# 从 GitHub 仓库安装，指定 tag（SSH）
pi install -l git:git@github.com:MarshalW/pi-turn-stats@v0.1.1
```

> 国内用户建议优先使用 npm 方式，GitHub 访问可能不稳定。

## 说明

生成的统计数据**仅本地存储**，不会上传到任何服务器。读取运行中 pi 进程内的 `turn_end` 事件数据和实际耗时。

## 开发

```bash
git clone git@github.com:MarshalW/pi-turn-stats.git
cd pi-turn-stats
pi install ./        # 本地安装，用于测试
```

## 发布流程

```bash
git tag vX.Y.Z && git push origin main --tags
# 发布到 npm：npm version patch && npm publish --access public
# 消费端安装：
#   npm 方式（推荐）：pi install -l npm:@marshal/pi-turn-stats
#   git 方式（备选）：pi install -l git:git@github.com:MarshalW/pi-turn-stats@vX.Y.Z
```
