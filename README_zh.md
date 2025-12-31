# Jellyfin MPV Desktop Bridge (Fork)

[English](./README.md)

这是一个基于 [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist) 进行深度重构的高级播放器桥接工具。

虽然本项目起源于 `mpv-handler`，但我们已经对其核心逻辑进行了彻底的改造。它不再局限于简单的打开 URL，而是引入了全新的 **Universal Jelly-Player Schema**，旨在为 Jellyfin/Emby Web 端提供**桌面级的多窗口并发播放体验**。

## 核心创新 (Key Innovations)

与原版相比，本项目引入了以下颠覆性功能：

1. **通用协议架构 (Universal Jelly-Player Schema)**
* 弃用了单一的 `mpv://` 协议，采用全新的 `jelly-player://` 通用协议。
* **JSON Payload**：通过 Base64 编码传输复杂的 JSON 数据，支持携带标题、窗口坐标、字幕流、Profile 配置等丰富元数据。


2. **批量并发播放 (Batch Processing)**
* **突破浏览器限制**：前端一次性发送包含多个视频信息的数组（Array Payload）。
* **零延迟启动**：后端 Go 程序接收指令后，瞬间并发启动 4 个（或更多）MPV 进程，完美规避现代浏览器的弹窗拦截和焦点抢占问题。


3. **智能视频墙 (Smart Video Wall)**
* **像素级精准排布**：配合配套的 UserScript，自动计算物理像素坐标。
* **全屏沉浸体验**：支持覆盖任务栏的沉浸式 2x2 视频墙，或自动避开任务栏的工作区模式。
* **字幕自动挂载**：自动通过 API 抓取 Jellyfin 的外挂字幕链接并传给 MPV。


4. **双向生态整合**
* 本项目由 **Go 后端 (Handler)** 和 **前端脚本 (UserScript)** 两部分组成，缺一不可，共同构成了一套完整的播放解决方案。



## 安装指南

### 第一步：部署 Go 后端

1. **下载**：前往 Releases 页面下载最新的 `mpv-handler.exe`。
2. **放置**：将其放入任意固定目录（推荐放在 MPV 安装目录）。
3. **注册协议**：以管理员身份运行 CMD/PowerShell，执行：
```shell
.\mpv-handler.exe --install "D:\Path\To\Your\mpv.exe"

```


*成功后，系统将注册 `jelly-player://` 协议。*

### 第二步：配置 MPV (关键)

为了实现无缝视频墙效果，您需要在 MPV 的 `portable_config/profiles.conf` 中添加专用配置（UserScript 会调用这个 `multi` profile）：

```ini
[multi]
profile-desc=Jellyfin Video Wall
# 禁用吸附和边框，实现无缝拼接
snap-window=no
border=no
ontop=yes
# 禁用自动适配，完全听从前端指令
autofit=no
keepaspect-window=no
# 性能优化
osc=no
osd-level=0
force-window=immediate

```

### 第三步：安装 UserScript

1. 在浏览器安装 Tampermonkey 插件。
2. 安装本仓库根目录下的 `script.js`。
3. 在脚本头部配置您的 **Windows 缩放比例** (例如 `osScale: 2.0`)。
4. 刷新 Jellyfin 网页，进入电影库，长按选中多个视频，点击出现的 **"Grid Play"** 按钮。

## 协议规范 (Protocol Spec)

如果您是开发者，您可以利用本项目的通用协议适配其他服务。
协议格式：`jelly-player://<Base64_Safe_URL_Encoded_JSON>`

JSON Payload 示例 (Batch Mode):

```json
[
  {
    "mode": "mpv",
    "url": "https://server/stream.mkv",
    "sub": "https://server/subtitle.srt",
    "profile": "multi",
    "geometry": "1920x1080+0+0",
    "title": "Video 1"
  },
  {
    "mode": "mpv",
    "url": "https://server/stream2.mkv",
    "geometry": "1920x1080+1920+0",
    "title": "Video 2"
  }
]

```

## 致谢

本项目 fork 自 [mpv-handler-openlist](https://github.com/outlook84/mpv-handler-openlist)。感谢原作者提供的基础架构，使我们能够在此基础上构建出如此强大的功能。
