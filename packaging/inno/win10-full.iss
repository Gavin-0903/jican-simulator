; 机惨模拟器 — Windows 10/11 满血版安装包（Inno Setup 6）
; 用 ISCC.exe 编译：ISCC.exe win10-full.iss
;
; 关键点：
;  - Setup 自身带 PrivilegesRequired=admin，非管理员双击时 Windows 会要求提权（UAC），
;    这就是需求里「非管理员运行时自动提权」的落地方式。
;  - 主程序统一叫 jican-simulator.exe（用户要求），变体差异只体现在安装包名/安装目录/开始菜单项上。
;  - 2026-11-07 起本包内置 TailScale 官方安装器（packaging/vendor/*.msi）：
;    安装时先检测 {pf}\Tailscale\tailscale.exe，没有就用 msiexec /qn 静默装内置 MSI，
;    然后再以 --setup --server-source 静默调用主程序：
;      强制检测 TailScale → 建 data/ → 写 data/config.json 开启联机 → 把本机设成服务器源
;      （默认 Serve，可在软件设置页切换为 Funnel）。
;    若内置 MSI 装完仍检测不到 TailScale，[Code] 会弹出说明（含安装日志路径与手动下载入口），不静默失败。

#define MyAppName "机惨模拟器"
#define MyAppVariant "Win10满血"
#define MyAppExeName "jican-simulator.exe"
; 玩家双击的入口（无黑框）：launch.exe 外壳，内部再拉起 MyAppExeName。
#define MyLaunchExeName "jican-simulator-launcher.exe"
; 内置 TailScale 安装器：文件名必须与 packaging/vendor/ 下的实际文件一致；
; 升级时改这一行 + 重新下载 MSI（见 packaging/vendor/README.md）。
#define TailScaleMsi "tailscale-setup-1.104.5-amd64.msi"
#ifndef MyStamp
  #define MyStamp "1107"
#endif
#ifndef MyAppVersion
  #define MyAppVersion "1.5rc"
#endif

[Setup]
AppId={{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1010}
AppName={#MyAppName} {#MyAppVariant}版
AppVersion={#MyAppVersion}
AppComments=内置 TailScale，装好后可一键成为联机服务器源
AppPublisher=机惨模拟器小组
AppPublisherURL=https://github.com/Gavin-0903/jican-simulator
AppSupportURL=https://github.com/Gavin-0903/jican-simulator
DefaultDirName={autopf}\JicanSimulator
DefaultGroupName={#MyAppName} {#MyAppVariant}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\inno
OutputBaseFilename=jican-simulator-win10-v{#MyAppVersion}-{#MyStamp}-setup
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=..\icons\jican-simulator.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
; 静默安装也写日志：{localappdata} 是普通用户可写目录，避免 SetupLogging 因权限静默失败
SetupLogging=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
; 内置 TailScale 安装器先落到 {tmp}，[Run] 里用 msiexec 静默安装，装完即删（deleteafterinstall）。
Source: "..\vendor\{#TailScaleMsi}"; DestDir: "{tmp}"; Flags: deleteafterinstall ignoreversion
Source: "..\..\dist\win10-full\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win10-full\{#MyLaunchExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win10-full\assets.json"; DestDir: "{app}"; Flags: ignoreversion
; WebView2 托管程序集必须与启动器同目录（启动器是 .NET，CLR 按应用基目录找依赖）。
; 少了这两个 dll，双击会直接 FileNotFoundException: Microsoft.Web.WebView2.Core。
Source: "..\..\dist\win10-full\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win10-full\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
; 原生加载器：Launch.cs 先找 runtimes\win-x64\native\，找不到再找 {app} 同级，这里两处都装。
Source: "..\..\dist\win10-full\runtimes\*"; DestDir: "{app}\runtimes"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\dist\win10-full\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyLaunchExeName}"; IconFilename: "{app}\{#MyLaunchExeName}"
Name: "{group}\{#MyAppName} {#MyAppVariant}版（一键联机配置）"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --server-source"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{#MyAppName} {#MyAppVariant}版（调试窗口）"; Filename: "{app}\{#MyLaunchExeName}"; Parameters: "--debug"; IconFilename: "{app}\{#MyLaunchExeName}"
Name: "{group}\卸载 {#MyAppName} {#MyAppVariant}版"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyLaunchExeName}"; IconFilename: "{app}\{#MyLaunchExeName}"; Tasks: desktopicon

[Run]
; 1) 内置 TailScale：已安装就跳过（Check: NeedInstallTailScale），否则静默装 MSI。
;    /qn 无界面，/norestart 不重启系统；MSI 装完会带出 TailScale 系统服务与 tailscale.exe。
Filename: "{sys}\msiexec.exe"; Parameters: "/i ""{tmp}\{#TailScaleMsi}"" /qn /norestart"; StatusMsg: "正在安装内置 TailScale（约 1-2 分钟）…"; Flags: runhidden waituntilterminated; Check: NeedInstallTailScale; AfterInstall: MarkTailScaleInstalled
; 2) 首次配置：--setup 会强制检测 TailScale（tailscale -v）。
;   有 → 建 data/、写 data/config.json 开启联机、把本机设成服务器源（默认 Serve，可改 Funnel），
;        之后每次启动游戏都会自动确保 TailScale 服务在跑；
;   没有 → 返回 no-tailscale 结论，[Code] 的 HandleSetupResult 弹出安装失败说明（不静默失败）。
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --server-source"; WorkingDir: "{app}"; Description: "完成首次配置（检测 TailScale 并开启联机）"; Flags: runhidden waituntilterminated; AfterInstall: HandleSetupResult
; 3) 启动游戏。
Filename: "{app}\{#MyLaunchExeName}"; WorkingDir: "{app}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"

[Code]
const
  TailScaleDownloadUrl = 'https://tailscale.com/download/windows';

var
  TailScaleJustInstalled: Boolean;

{ TailScale 官方安装包固定装在 Program Files\Tailscale 下。 }
function TailScalePresent: Boolean;
begin
  Result := FileExists(ExpandConstant('{pf}\Tailscale\tailscale.exe'));
  if not Result then
    Result := FileExists(ExpandConstant('{pf32}\Tailscale\tailscale.exe'));
end;

{ [Run] 里内置 MSI 的 Check：系统里已有 TailScale 就不重复安装/覆盖。 }
function NeedInstallTailScale: Boolean;
begin
  Result := not TailScalePresent;
end;

{ 内置 MSI 跑过就置位，用来区分「刚装完（还没登录）」和「本来就有」。 }
procedure MarkTailScaleInstalled;
begin
  TailScaleJustInstalled := True;
end;

{ 内置 MSI 装完仍检测不到 TailScale：给出日志路径与手动安装入口，绝不静默失败。 }
procedure AskInstallTailScale;
var
  ErrCode: Integer;
  LogPath: String;
begin
  LogPath := ExpandConstant('{log}');
  if LogPath <> '' then
    LogPath := #13#10 + '安装日志：' + LogPath;
  if MsgBox('内置 TailScale 未能安装成功（可能被杀毒软件/系统策略拦截，或需要重启后再试）。' + #13#10 + #13#10 +
            'TailScale 用于把多台电脑连成一张虚拟内网，装好后本机可以一键成为联机服务器源；' + #13#10 +
            '没有它游戏仍可单机运行，但无法作为联机服务器。' + #13#10 +
            LogPath + #13#10 + #13#10 +
            '是否现在打开官方下载页手动安装？装好并登录 TailScale 后，' + #13#10 +
            '双击开始菜单里的「{#MyAppName} {#MyAppVariant}版（一键联机配置）」即可自动完成联机设置。',
            mbConfirmation, MB_YESNO) = IDYES then
  begin
    if not ShellExec('open', TailScaleDownloadUrl, '', '', SW_SHOWNORMAL, ewNoWait, ErrCode) then
      MsgBox('打开浏览器失败，请手动访问：' + TailScaleDownloadUrl, mbInformation, MB_OK);
  end;
end;

{ 首次配置的善后：
  - 仍没有 TailScale → 弹安装失败说明（含日志与下载页）；
  - 刚由本安装包装好 → 提醒去登录 TailScale（未登录时 --setup 会保留配置，登录后启动自动重试）。 }
procedure HandleSetupResult;
begin
  if not TailScalePresent then
  begin
    AskInstallTailScale;
    exit;
  end;
  if TailScaleJustInstalled and not WizardSilent then
    MsgBox('内置 TailScale 已安装。' + #13#10 + #13#10 +
           '请打开 TailScale 并用你的账号登录。登录后重新双击开始菜单里的' + #13#10 +
           '「{#MyAppName} {#MyAppVariant}版（一键联机配置）」即可完成服务器源配置' + #13#10 +
           '（若首次配置时 TailScale 还没登录，配置会保留，下次启动游戏时自动重试）。',
           mbInformation, MB_OK);
end;
