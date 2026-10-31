; 机惨模拟器 — Windows 10/11 满血版安装包（Inno Setup 6）
; 用 ISCC.exe 编译：ISCC.exe /DMyAppVersion=0.2beta win10-full.iss
;
; 关键点：
;  - Setup 自身带 PrivilegesRequired=admin，非管理员双击时 Windows 会要求提权（UAC），
;    这就是需求里「非管理员运行时自动提权」的落地方式。
;  - 装完后以 --setup 参数静默调用一次主程序做首次配置询问（是否设为服务器源），
;    问完即退出，不启动游戏主窗口。

#define MyAppName "机惨模拟器"
#define MyAppVariant "Win10满血"
#define MyAppExeName "机惨模拟器-Win10满血-v0.2beta-setup-1031.exe"
#ifndef MyAppVersion
  #define MyAppVersion "0.2beta"
#endif

[Setup]
AppId={{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1010}
AppName={#MyAppName} {#MyAppVariant}版
AppVersion={#MyAppVersion}
AppPublisher=机惨模拟器小组
DefaultDirName={autopf}\JicanSimulator
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\inno
OutputBaseFilename=机惨模拟器-Win10满血-v{#MyAppVersion}-setup-1031
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; 中文界面：Inno 6 自带 Languages\ChineseSimplified.isl 需另装；缺失时回退英文并正常提示。
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
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
Name: "{group}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 首次配置：以 --setup 启动一次，询问「是否设为服务器源」，问完自动退出
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup"; Description: "完成首次配置（询问是否设为服务器源）"; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
