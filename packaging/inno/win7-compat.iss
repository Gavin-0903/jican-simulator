; 机惨模拟器 — Windows 7 兼容版安装包（Inno Setup 6）
; 与满血版的差别：
;  - MinVersion=6.1（Win7 SP1）+ 仅 x86 安装模式，避免 64 位路径在老系统上的兼容问题；
;  - 不依赖任何 Win10 专属 API，程序本体用 --no-sandbox 友好参数启动。
;
; 注意：Node 20+ 官方二进制已不支持 Win7。本分支提供的是「源码 + 启动脚本」形态的兼容包
; （内嵌 node.exe 若在 Win7 上缺失，会退回用系统里的 node 运行 server/index.js 并给出提示）。

#define MyAppName "机惨模拟器"
#define MyAppVariant "Win7兼容"
#define MyAppExeName "机惨模拟器-Win7兼容-v0.1dev-setup-1031.exe"
#ifndef MyAppVersion
  #define MyAppVersion "0.1dev"
#endif

[Setup]
AppId={{7A5B2C10-3E44-4B7E-9F11-91C0DA7A1007}
AppName={#MyAppName} {#MyAppVariant}版
AppVersion={#MyAppVersion}
AppPublisher=机惨模拟器小组
DefaultDirName={sd}\JicanSimulator7
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist\inno
OutputBaseFilename=机惨模拟器-Win7兼容-v{#MyAppVersion}-setup-1031
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x86 x64
ArchitecturesInstallIn64BitMode=
MinVersion=6.1

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务:"

[Files]
Source: "..\..\dist\win7-compat\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\dist\win7-compat\assets.json"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName} {#MyAppVariant}版"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--setup"; Description: "完成首次配置（询问是否设为服务器源）"; Flags: runhidden waituntilterminated
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data"
