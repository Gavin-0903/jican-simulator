; 机惨模拟器 — Windows 7 联机客户端安装包（Inno Setup 6）
; 用 ISCC.exe 编译：ISCC.exe win7-compat.iss
;
; 定位（2026-11-07 起）：仅联机客户端。
;  - TailScale 官方不支持 Windows 7，所以本包不内置、不检测、也不提示下载 TailScale，
;    本机固定写成「仅联机客户端」（--setup --client --no-tailscale），不能作为服务器源。
;  - 联机方式：让一台 Win10/Win11 机器装满血版建房（自带 TailScale），
;    Win7 在 联机 → 高级 → 服务器源 里填 Win10 机器给出的 Funnel 公网 https 地址或局域网地址。
;  - 不要宣称 Win7 能跑内嵌的 Node 24 运行时：Win7 上主程序运行时存在兼容风险，
;    安装包只负责落盘与写客户端配置，具体见发布说明。
;
; Setup 自身带 PrivilegesRequired=admin，非管理员双击时 Windows 会要求提权（UAC）。

#define MyAppName "机惨模拟器"
#define MyAppVariant "Win7兼容"
#define MyAppExeName "jican-simulator.exe"
; 玩家双击的入口（无黑框）：launch.exe 外壳，内部再拉起 MyAppExeName。
#define MyLaunchExeName "jican-simulator-launcher.exe"
#ifndef MyStamp
  #define MyStamp "1107"
#endif
#ifndef MyAppVersion
  #define MyAppVersion "1.5rc"
#endif

[Setup]
AppId={{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1007}
AppName={#MyAppName} {#MyAppVariant}版
AppVersion={#MyAppVersion}
AppComments=仅联机客户端：Win7 不能作为服务器源，请加入 Win10 机器建的房间
AppPublisher=机惨模拟器小组
AppPublisherURL=https://github.com/Gavin-0903/jican-simulator
AppSupportURL=https://github.com/Gavin-0903/jican-simulator
DefaultDirName={sd}\JicanSimulator7
DefaultGroupName={#MyAppName} {#MyAppVariant}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\inno
OutputBaseFilename=jican-simulator-win7-v{#MyAppVersion}-{#MyStamp}-setup
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\icons\jican-simulator.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x86compatible x64compatible
ArchitecturesInstallIn64BitMode=
MinVersion=6.1sp1
CloseApplications=yes
; 静默安装也写日志：{localappdata} 是普通用户可写目录，避免 SetupLogging 因权限静默失败
SetupLogging=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
Source: "..\..\dist\win7-compat\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win7-compat\{#MyLaunchExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win7-compat\assets.json"; DestDir: "{app}"; Flags: ignoreversion
; WebView2 托管程序集必须与启动器同目录（启动器是 .NET，CLR 按应用基目录找依赖）。
; Win7 通常没有预装 WebView2，宿主会走三层兜底（见 Launch.cs FallbackToBrowser），
; 但 dll 仍要随包装，装了运行时的那部分 Win7/Win8 机器就能用内嵌窗口。
Source: "..\..\dist\win7-compat\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win7-compat\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win7-compat\runtimes\*"; DestDir: "{app}\runtimes"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\win7-compat\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyLaunchExeName}"; IconFilename: "{app}\{#MyLaunchExeName}"
Name: "{group}\{#MyAppName} {#MyAppVariant}版（联机客户端配置）"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --client --no-tailscale"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{#MyAppName} {#MyAppVariant}版（调试窗口）"; Filename: "{app}\{#MyLaunchExeName}"; Parameters: "--debug"; IconFilename: "{app}\{#MyLaunchExeName}"
Name: "{group}\卸载 {#MyAppName} {#MyAppVariant}版"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyLaunchExeName}"; IconFilename: "{app}\{#MyLaunchExeName}"; Tasks: desktopicon

[Run]
; Win7 只做客户端：--client 关掉服务器源，--no-tailscale 明确不碰 TailScale（Win7 上官方不支持）。
; 这里不装 TailScale、不弹下载询问，只把本机写成客户端配置。
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --client --no-tailscale"; WorkingDir: "{app}"; Description: "写入联机客户端配置"; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyLaunchExeName}"; WorkingDir: "{app}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"

[Code]
{ 安装完成后说明：Win7 不能当服务器源，联机要加入 Win10 机器建的房间。
  静默安装（/SILENT、/VERYSILENT）不弹窗，避免卡住自动化。 }
procedure ShowWin7ClientNote;
begin
  MsgBox('这个安装包用于 Windows 7 的「联机客户端」。' + #13#10 + #13#10 +
         '重要说明：TailScale 官方不支持 Windows 7，所以这台 Win7 机器不能作为联机服务器源（不能建房）。' + #13#10 + #13#10 +
         '联机步骤：' + #13#10 +
         '1. 让一台 Win10 / Win11 机器安装「满血版」并建房（它会自动装好 TailScale）；' + #13#10 +
         '2. 在 Win10 机器的游戏里打开「联机 → 高级」，复制「服务器源」地址' + #13#10 +
         '   （Funnel 公网 https 地址，或同一局域网内的 IP 地址）；' + #13#10 +
         '3. 在这台 Win7 机器上打开游戏 →「联机 → 高级 → 服务器源」，粘贴该地址即可加入。' + #13#10 + #13#10 +
         '本安装包已自动把本机写成「仅联机客户端」配置，单机玩不受影响。',
         mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssDone) and not WizardSilent then
    ShowWin7ClientNote;
end;
