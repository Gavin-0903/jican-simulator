; 机惨模拟器 — Windows 10/11 满血版安装包（Inno Setup 6）
; 用 ISCC.exe 编译：ISCC.exe win10-full.iss
;
; 关键点：
;  - Setup 自身带 PrivilegesRequired=admin，非管理员双击时 Windows 会要求提权（UAC），
;    这就是需求里「非管理员运行时自动提权」的落地方式。
;  - 主程序统一叫 jican-simulator.exe（用户要求），变体差异只体现在安装包名/安装目录/开始菜单项上。
;  - 装完后以 --setup --server-source 静默调用主程序：
;    强制检测 TailScale → 建 data/ → 写 data/config.json 开启联机 → 把本机设成服务器源
;    （默认 Serve，可在软件设置页切换为 Funnel）→ 退出码 3 表示「没装 TailScale」，[Code] 随即询问是否下载安装。

#define MyAppName "机惨模拟器"
#define MyAppVariant "Win10满血"
#define MyAppExeName "jican-simulator.exe"
#ifndef MyAppVersion
  #define MyAppVersion "0.2beta"
#endif

[Setup]
AppId={{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1010}
AppName={#MyAppName} {#MyAppVariant}版
AppVersion={#MyAppVersion}
AppPublisher=机惨模拟器小组
AppPublisherURL=https://github.com/Gavin-0903/jican-simulator
AppSupportURL=https://github.com/Gavin-0903/jican-simulator
DefaultDirName={autopf}\JicanSimulator
DefaultGroupName={#MyAppName} {#MyAppVariant}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\inno
OutputBaseFilename=机惨模拟器-Win10满血-v{#MyAppVersion}-setup-1031
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
Source: "..\..\dist\win10-full\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win10-full\assets.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\\..\\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\{#MyAppName} {#MyAppVariant}版（一键联机配置）"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --server-source"; IconFilename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName} {#MyAppVariant}版"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"; IconFilename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 首次配置：--setup 会强制检测 TailScale（tailscale -v）。
;   有 → 建 data/、写 data/config.json 开启联机、把本机设成服务器源（默认 Serve，可改 Funnel），
;        之后每次启动游戏都会自动确保 TailScale 服务在跑；
;   没有 → 退出码 3（SETUP_RESULT.tailscale=false），[Code] 的 HandleSetupResult 会询问是否下载安装。
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup --server-source"; WorkingDir: "{app}"; Description: "完成首次配置（检测 TailScale 并开启联机）"; Flags: runhidden waituntilterminated; AfterInstall: HandleSetupResult
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"

[Code]
const
  TailScaleDownloadUrl = 'https://tailscale.com/download/windows';

{ TailScale 官方安装包固定装在 Program Files\Tailscale 下。 }
function TailScalePresent: Boolean;
begin
  Result := FileExists(ExpandConstant('{pf}\Tailscale\tailscale.exe'));
  if not Result then
    Result := FileExists(ExpandConstant('{pf32}\Tailscale\tailscale.exe'));
end;

{ 没装 TailScale：询问是否打开官方下载页。 }
procedure AskInstallTailScale;
var
  ErrCode: Integer;
begin
  if MsgBox('未检测到 TailScale。' + #13#10 + #13#10 +
            'TailScale 用于把多台电脑连成一张虚拟内网。装好后本程序可以一键变身为联机服务器，' + #13#10 +
            '其他同学只要填服务器地址即可加入，不需要公网 IP、不用配路由器。' + #13#10 + #13#10 +
            '是否现在打开官方下载页？', mbConfirmation, MB_YESNO) = IDYES then
  begin
    if not ShellExec('open', TailScaleDownloadUrl, '', '', SW_SHOWNORMAL, ewNoWait, ErrCode) then
      MsgBox('打开浏览器失败，请手动访问：' + TailScaleDownloadUrl, mbInformation, MB_OK)
    else
      MsgBox('安装并登录 TailScale 后，双击开始菜单里的「{#MyAppName} {#MyAppVariant}版（一键联机配置）」' + #13#10 +
             '即可自动完成联机设置（等价于命令行 jican-simulator.exe --setup --server-source）。',
             mbInformation, MB_OK);
  end;
end;

{ 首次配置的善后：环境里没有 TailScale 时提示安装。
  上面的 [Run] 已经跑过一次 --setup，这里再探测一次安装路径，
  只做询问，不重复改配置（配置已由 --setup 按「无 TailScale」写好并关闭联机）。 }
procedure HandleSetupResult;
begin
  if not TailScalePresent then
    AskInstallTailScale;
end;
