# 机惨模拟器 · 下载站

纯静态下载页：版本号读取 `version.json`，下载列表读取 `download.json`（文字 + 下载链接）。

## 目录结构

```
jican-simulator-download/
├── index.html       # 下载页（无依赖，纯前端）
├── version.json     # 版本 / 渠道 / 更新日志
├── download.json    # 下载列表：名称 → 下载链接
├── icon.png         # 站点图标
└── README.md
```

## 本地预览

通过 HTTP 打开（`file://` 下浏览器禁止 fetch 本地 JSON）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/
```

## 网页版

不想下载安装包？点页面 Hero 区的「网页版试玩」按钮即可直接在浏览器里玩：

https://gavin-bitwing.pages.dev/JC%E6%A8%A1%E6%8B%9F%E5%99%A8/

（按钮在新标签页打开，不影响当前下载页。）

## download.json 格式

最简写法：键是显示名称，值是下载链接。

```json
{
  "机惨模拟器-Win10满血版-v1.2dev": "https://github.com/…/jican-simulator-win10-full-v1.2dev-setup-1106.exe",
  "机惨模拟器-Win7兼容版-v1.2dev": "https://github.com/…/jican-simulator-win7-compat-v1.2dev-setup-1106.exe"
}
```

需要更多文字时，值可以写成对象（键自动作为标题）：

```json
{
  "机惨模拟器-Win10满血版-v1.2dev": {
    "url": "https://github.com/…/file.exe",
    "note": "自带运行时，双击安装即可",
    "size": 48330097,
    "sha256": "121fd661…",
    "platform": "Windows 10 / 11"
  }
}
```

也支持直接写成数组，每项自带 `title`：

```json
[
  { "title": "机惨模拟器-Win10满血版-v1.2dev", "url": "https://…/file.exe", "note": "自带运行时" }
]
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| url / href / link | 是 | 下载直链，支持 http(s) 外链与镜像加速地址 |
| title / name | 数组形态必填 | 卡片标题；对象形态缺省用键名 |
| note / desc | 否 | 标题下方的一行补充文字 |
| size | 否 | 字节数，显示为 46.1 MB |
| sha256 | 否 | 显示前 12 位，点击可复制完整值 |
| platform | 否 | 缺省按标题/链接自动识别（Windows 10 / 11、Windows 7、macOS、Linux、Android） |
| version | 否 | 缺省从标题里提取；标题已含版本时不重复显示 |
| type | 否 | 缺省按扩展名识别（安装包 / 压缩包 等） |

卡片 meta 行会自动标注来源：ghproxy 类链接显示「加速镜像 · GitHub Release」，GitHub 直链显示「GitHub Release」。

## 日常更新

1. 新增或下架安装包：只改 `download.json`，刷新页面即可，无需动 HTML。
2. 发版：修改 `version.json` 的 `version` / `releasedAt` / `headline` / `notes`。
