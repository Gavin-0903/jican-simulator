# 机惨模拟器 · 下载站

纯静态下载页：版本号读取 `version.json`，文件列表实时扫描 `download/` 目录。

## 目录结构

```
jican-simulator-download/
├── index.html            # 下载页（无依赖，纯前端）
├── version.json          # 版本 / 渠道 / 更新日志
├── files.json            # download/ 清单兜底（含 SHA-256）
├── scan-downloads.mjs    # 重新生成 files.json
├── icon.png              # 站点图标
├── preview.png           # 页面预览截图
└── download/             # 把发行包放这里，页面自动显示
```

## 本地预览

必须通过 HTTP 访问（`file://` 下浏览器禁止读取目录）：

```bash
python -m http.server 8000
# 打开 http://localhost:8000/
```

## 日常更新

1. 把新的安装包丢进 `download/`，刷新页面即可，无需改 HTML。
2. 站点部署在不支持目录浏览的服务器时，页面会自动回退到 `files.json`。
   新增文件后执行 `node scan-downloads.mjs` 重新生成清单（会计算 SHA-256）。
3. 发版时修改 `version.json` 的 `version` / `releasedAt` / `notes`。
