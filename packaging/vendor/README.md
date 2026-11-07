# packaging/vendor —— 随安装包分发的第三方安装器

这个目录存放**不入库**的第三方安装包，由构建前手动下载（见下面步骤）。
仓库只保留本说明文件；`.gitignore` 里已屏蔽 `*.msi` 与 `*.msi.sha256`。

## TailScale（Win10 满血版内置）

安装包编译前需要把官方稳定版 MSI 放到这里：

```powershell
# 在仓库根目录执行
New-Item -ItemType Directory -Force packaging/vendor | Out-Null
Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi' `
  -OutFile 'packaging/vendor/tailscale-setup-1.104.5-amd64.msi'
Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.5-amd64.msi.sha256' `
  -OutFile 'packaging/vendor/tailscale-setup-1.104.5-amd64.msi.sha256'
Get-FileHash 'packaging/vendor/tailscale-setup-1.104.5-amd64.msi' -Algorithm SHA256
```

以当前 stable 页面（https://pkgs.tailscale.com/stable/）的版本为准；换版本时同步改：

- `packaging/inno/win10-full.iss` 里的 `#define TailScaleMsi "tailscale-setup-<版本>-amd64.msi"`
- `package.json` 的 `build:win10` 版本号（安装包文件名里的版本跟产品版本走，与 TailScale 版本无关）

校验：MSI 的 SHA256 必须与同名 `.sha256` 文件里第一段一致，否则不要打包。
