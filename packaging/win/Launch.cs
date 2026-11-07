// jican-simulator-launcher.exe —— 桌面宿主（Windows GUI 子系统，PE Subsystem=2，双击无黑框）。
//
// v0.4：从「只负责起服务的隐形外壳」升级为「带窗口的桌面应用」，模仿 DeepSeekHarness 那种
//       自带浏览器的打包形态：宿主内嵌 WebView2，双击直接弹出应用窗口，宿主机器上一个浏览器
//       都没有也能玩；同时常驻系统托盘，关窗口不杀服务。
//
// 结构：
//   jican-simulator-launcher.exe（本文件）
//     ├─ 内嵌资源：RCDATA/1 = node.exe，RCDATA/2 = launcher.cjs 的 ZIP（由 LaunchGen.exe 注入）
//     ├─ 释放到 %LOCALAPPDATA%\JicanSimulator\runtime\rt-<指纹>\
//     ├─ CreateProcess(CREATE_NO_WINDOW) → node-runtime.exe launcher.cjs --spawn-only
//     │     └─ spawn(jican-simulator.exe --serve)   ← 真正的服务端，无窗口常驻
//     ├─ 轮询 %LOCALAPPDATA%\JicanSimulator\server.port 取端口，再 GET /api/app/ping 确认是我们的服务
//     ├─ MainForm：内嵌 WebView2 占满客户区（关闭 = 收进托盘，服务继续跑）
//     ├─ RoomForm：页面 window.open 出来的每个本机地址 → 一个**独立房间窗口**（各自一个 WebView2），
//     │            递归：房间窗口里再 window.open 本机地址又开一个新的 RoomForm；关掉宿主时一并关掉。
//     └─ NotifyIcon：左键单击显示/隐藏；右键菜单 = 显示主界面 / 在浏览器打开 / 查看日志 / 重启服务 / 退出
//
// 为什么不用 Electron（DSH 的方案）：Electron 自带 Chromium 会让包体从 90 MB 涨到 340 MB；
// Windows 10/11 的 WebView2 Runtime 预装率极高，同样的「自带浏览器」效果只要宿主 app 几十 KB。
// 万一目标机器没有 WebView2，按三级兜底：WebView2 → 引导安装 Evergreen → 退回系统默认浏览器。
//
// 关键坑位（v0.3 踩出来的，别改回去）：
//   1) 编译必须 /target:winexe，否则子进程/自己会带控制台子系统，双击弹黑框；
//   2) 图标/版本资源语言必须写 0（中性），写 1033 会读不到；
//   3) CreateProcess 不能传自定义 lpEnvironment —— 某些宿主（DSH 作业沙箱）里直接
//      ERROR_INVALID_PARAMETER(87)。主程序路径改由运行时目录的 launcher.cfg 传下去；
//   4) lpCommandLine 必须 StringBuilder 且容量够，用 string 也是 87。
//
// 关于「加入 WebKit」（明确结论，别再来问一遍）：
//   本项目桌面宿主用的是 **WebView2 = Chromium/Edge**，**不是 WebKit**，也不需要 WebKit。
//   Windows 上现成可用的内嵌 WebKit 只有 QtWebKit（早已停更，拖进 100 MB+ Qt 运行时）或
//   wkwebview（macOS 专用），在 Windows 上都不现实；把 Chromium 内嵌进去要 340 MB（Electron 方案，
//   已在 v0.4 明确否掉）。WebView2 与现代 WebKit 的页面能力等价：window.open、WebSocket、
//   fetch、Promise、ES2020 全都原生支持，页面侧**不需要任何 polyfill**。
//   联机页面里 window.open(url) 出来的本机地址，由本文件的 RoomForm 变成独立窗口显示。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Windows DPI 感知：**不声明的话整窗被系统按位图拉伸，125%/150% 缩放下页面发糊**（用户反馈的原话：
// 「最后的 exe 打包完后页面过于模糊」）。根因不在页面/CSS，而在宿主 exe 没有 DPI 感知 →
// 系统把它当 96 DPI 位图放大到 150%，WebView2 里再清晰的 SVG 也全糊。
//
// 顺序：Per-Monitor v2（Win10 1703+）→ Per-Monitor（Win8.1+/1703 前）→ 系统 DPI（Win7 兜底）。
// 必须在任何窗口创建之前调用（Main 的第一句），否则进程 DPI 上下文已定，再调无效。
internal static class DpiAware
{
    private const int PerMonitorAwareV2 = -4;
    private const int PerMonitorAware = -3;

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int awareness);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    internal static void Enable()
    {
        try
        {
            if (Environment.OSVersion.Version.Major >= 10 && SetProcessDpiAwarenessContext(new IntPtr(PerMonitorAwareV2))) return;
        }
        catch { /* Win7/8 没有这个 API */ }
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(PerMonitorAware))) return;
        }
        catch { }
        try
        {
            if (SetProcessDpiAwareness(2) == 0) return;
        }
        catch { /* 只有 Win8.1+ 有 shcore */ }
        try
        {
            SetProcessDPIAware();
        }
        catch { }
    }
}

internal static class Program
{
    private const int RcData = 10;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const string ScriptName = "launcher.cjs";
    private const string NodeName = "node-runtime.exe";

    [STAThread]
    private static void Main(string[] argv)
    {
        try
        {
            // 第一句：DPI 感知必须在任何窗口（AppHost / RoomForm / NotifyIcon）创建之前定下来。
            DpiAware.Enable();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Run(argv);
        }
        catch (Exception e)
        {
            Fatal("启动器内部错误：" + e);
        }
    }

    private static void Run(string[] argv)
    {
        bool debug = false;
        var pass = new List<string>();
        foreach (string a in argv)
        {
            if (a == "-debug" || a == "--debug" || a == "-d") debug = true;
            else if (a == "--restart" || a == "--no-window") { /* 宿主自己处理，不下传 */ }
            else pass.Add(a);
        }

        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string mainExe = Path.Combine(exeDir, "jican-simulator.exe");
        if (!File.Exists(mainExe))
        {
            Fatal("找不到主程序：" + mainExe + "\n\n请重新安装，或把启动器与 jican-simulator.exe 放在同一目录。");
            return;
        }

        // ---- 已有实例在跑？已有实例就直接把窗口拉起来，不重复起服务（除非 --restart）
        int port = FindRunningPort();
        bool restart = Array.IndexOf(argv, "--restart") >= 0;
        if (port > 0 && restart)
        {
            QuitRunning(port);
            port = 0;
        }

        if (port <= 0)
        {
            // 拉起服务：直接跑主程序自己的 SEA 内核（--serve）。
            // 这里故意不再走 node-runtime.exe + launcher.cjs：
            //   node-runtime.exe 是 SEA 单文件，argv[1] 只会被当成业务参数，**脚本路径不会被当脚本执行**，
            //   所以「node-runtime.exe launcher.cjs」实际是把 launcher.cjs 当参数丢进内核 → 内核照常起服务
            //   却完全不写日志/不杀旧实例，排查时极具误导性（表现为 node-runtime 活着但什么都没有）。
            //   服务端内核自己就会写 <数据目录>/server.port、挂 /api/app/quit，宿主需要的它都有。
            // --data-dir 是宿主与服务内核之间唯一的「数据目录」通道：CreateProcess 不能传自定义环境块，
            // 不显式传的话两边会各算一份（内核落到 <exe目录>\data，宿主却去 %LOCALAPPDATA% 读 server.port），
            // 表现就是「服务启动超时」而后台其实好好地跑着。
            string cmdline = "\"" + mainExe + "\" --serve --data-dir \"" + DataDir() + "\"" + (debug ? " --debug" : "") + ArgsOf(pass);
            Program.HostLog("准备拉起服务：" + cmdline);
            if (!StartChild(cmdline, exeDir, debug))
            {
                Fatal("无法启动游戏服务（Win32 错误 " + Marshal.GetLastWin32Error() + "）\n\n" + cmdline);
                return;
            }
            port = WaitForPort(debug ? 45000 : 25000);
        }
        if (port <= 0)
        {
            Program.HostLog("等待端口超时");
            Fatal("服务启动超时。日志：" + LogPath() + "\n\n" + TailOfLog(15));
            return;
        }

        var ui = new AppHost(port, debug, exeDir, exeDir, mainExe);
        Application.Run(ui);
    }

    private static string ArgsOf(List<string> pass)
    {
        var sb = new StringBuilder();
        foreach (string a in pass)
        {
            if (a == "--restart" || a == "--no-window") continue;
            sb.Append('"').Append(a.Replace("\"", "\\\"")).Append("\" ");
        }
        return sb.ToString().TrimEnd();
    }

    // ------------------------------------------------------------------ 路径

    internal static string DataDir()
    {
        string env = Environment.GetEnvironmentVariable("JICAN_DATA_DIR");
        if (!string.IsNullOrEmpty(env)) return env;
        string la = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!string.IsNullOrEmpty(la)) return Path.Combine(la, "JicanSimulator");
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "JicanSimulator");
    }

    internal static string LogPath() { return Path.Combine(DataDir(), "logs", "server.log"); }
    internal static string PortFile() { return Path.Combine(DataDir(), "server.port"); }

    internal static string TailOfLog(int lines)
    {
        try
        {
            string[] all = File.ReadAllLines(LogPath());
            int from = Math.Max(0, all.Length - lines);
            var sb = new StringBuilder();
            for (int i = from; i < all.Length; i++) sb.AppendLine(all[i]);
            return sb.ToString();
        }
        catch { return "（还没有日志）"; }
    }

    private static int ReadPort()
    {
        try
        {
            double age = (DateTime.UtcNow - File.GetLastWriteTimeUtc(PortFile())).TotalSeconds;
            if (age > 600) return 0;                     // 10 分钟没更新 = 陈旧文件
            int n = int.Parse(File.ReadAllText(PortFile()).Trim());
            return n > 0 && n < 65536 ? n : 0;
        }
        catch { return 0; }
    }

    /// <summary>确认这个端口上跑的真是本游戏（而不是别的软件占着同一端口）。</summary>
    private static bool ProbeApp(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/app/ping");
            req.Timeout = 1200;
            req.ReadWriteTimeout = 1200;
            req.Proxy = null;
            using (var res = (HttpWebResponse)req.GetResponse())
            {
                if ((int)res.StatusCode != 200) return false;
                using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd().IndexOf("\"app\":\"jican-simulator\"", StringComparison.Ordinal) >= 0;
            }
        }
        catch { return false; }
    }

    private static int FindRunningPort()
    {
        int p = ReadPort();
        if (p > 0 && ProbeApp(p)) return p;
        return 0;
    }

    private static void QuitRunning(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/app/quit");
            req.Method = "POST";
            req.ContentLength = 0;
            req.Timeout = 3000;
            req.ReadWriteTimeout = 3000;
            req.Proxy = null;
            req.Headers.Add("X-Jican-Client", "launcher");
            using ((HttpWebResponse)req.GetResponse()) { }
        }
        catch { /* 关不掉就等它自己退 */ }
        for (int i = 0; i < 40; i++)
        {
            if (FindRunningPortUnchecked(port) == false) return;
            Thread.Sleep(150);
        }
    }

    private static bool FindRunningPortUnchecked(int port)
    {
        int p = ReadPort();
        return p == port && ProbeApp(port);
    }

    private static int WaitForPort(int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            int p = ReadPort();
            if (p > 0 && ProbeApp(p)) return p;
            Application.DoEvents();
            Thread.Sleep(200);
        }
        return 0;
    }

    // --------------------------------------------------------- 子进程与资源

    /// <summary>
    /// 拉起运行时子进程（无黑框）。
    /// 关键点（v0.4 踩坑）：CreateProcess 的 bInheritHandles 必须为 true，并且显式给 STARTUPINFO 填
    /// 指向 NUL 的标准句柄。若传 false，子进程的 0/1/2 号句柄是无效的，node 运行时一启动就
    /// 在写日志/初始化 stdio 时死掉——现象是「进程列表里 node-runtime.exe 一闪就没」，
    /// launcher.cjs 一行都没执行，宿主只能等到超时，日志全空，极难定位。
    /// </summary>
    private static bool StartChild(string cmdline, string workDir, bool debug)
    {
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        uint flags = debug ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW;
        IntPtr nul = IntPtr.Zero;
        IntPtr hIn = IntPtr.Zero, hOut = IntPtr.Zero, hErr = IntPtr.Zero;
        uint access = 0x80000000u /* GENERIC_READ */ | 0x40000000u /* GENERIC_WRITE */;
        try
        {
            if (!debug)
            {
                // 打开 NUL 设备充当 stdio，避免子进程持有无效句柄。
                nul = CreateFileW(@"\\.\NUL", access, 0x00000003u /* FILE_SHARE_READ|WRITE */,
                    IntPtr.Zero, 3u /* OPEN_EXISTING */, 0u, IntPtr.Zero);
                if (nul != IntPtr.Zero && nul != new IntPtr(-1))
                {
                    bool okDup = DuplicateHandle(GetCurrentProcess(), nul, GetCurrentProcess(), out hOut,
                        0, true, 0x00000002u /* DUPLICATE_SAME_ACCESS */);
                    if (okDup) hIn = hOut;
                    // 三条都用同一个可继承句柄即可（读写都打开）。
                    hErr = hOut;
                    si.dwFlags = (int)STARTF_USESTDHANDLES;
                    si.hStdInput = hIn;
                    si.hStdOutput = hOut;
                    si.hStdError = hErr;
                }
            }
            bool ok = CreateProcess(null, new StringBuilder(cmdline, Math.Max(1024, cmdline.Length + 1)),
                IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, workDir, ref si, out pi);
            if (!ok) return false;
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            return true;
        }
        finally
        {
            if (hOut != IntPtr.Zero) CloseHandle(hOut);
            if (nul != IntPtr.Zero) CloseHandle(nul);
        }
    }

    /// <summary>
    /// 释放内嵌 node 运行时（v0.3 及以前宿主靠它跑 launcher.cjs）。
    /// v0.4 起宿主直接执行 jican-simulator.exe --serve，不再需要这层，本方法**仅在
    /// 「主程序缺失」的兜底路径上用不到**——保留代码是为了兼容老安装包与未来可能的形态，
    /// 新增调用前先想清楚是否又要重蹈「node-runtime 把脚本当参数」的坑。
    /// </summary>
    private static string ExtractRuntime(string exeDir)
    {
        byte[] nodeBytes = ReadResource(1);
        byte[] zipBytes = ReadResource(2);
        if (nodeBytes == null || zipBytes == null) throw new Exception("程序内的运行时资源缺失，请重新安装。");

        string baseDir = Path.Combine(DataDir(), "runtime");
        Directory.CreateDirectory(baseDir);

        // 指纹必须同时覆盖 node 本体与 launcher.cjs 的 zip，否则升级后旧缓存目录被复用，新脚本永不生效。
        string stamp;
        using (var sha = SHA256.Create())
        {
            byte[] hn = sha.ComputeHash(nodeBytes);
            byte[] hz;
            using (var sha2 = SHA256.Create()) hz = sha2.ComputeHash(zipBytes);
            var mix = new byte[16];
            Buffer.BlockCopy(hn, 0, mix, 0, 8);
            Buffer.BlockCopy(hz, 0, mix, 8, 8);
            stamp = BitConverter.ToString(mix).Replace("-", "").ToLowerInvariant();
        }
        string dir = Path.Combine(baseDir, "rt-" + stamp);
        string nodePath = Path.Combine(dir, NodeName);
        string jsPath = Path.Combine(dir, ScriptName);
        if (File.Exists(nodePath) && File.Exists(jsPath))
        {
            WriteCfg(dir, exeDir);
            return dir;
        }

        Directory.CreateDirectory(dir);
        string tmpNode = nodePath + ".tmp";
        File.WriteAllBytes(tmpNode, nodeBytes);
        if (File.Exists(nodePath)) File.Delete(nodePath);
        File.Move(tmpNode, nodePath);

        using (var ms = new MemoryStream(zipBytes))
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Read))
        {
            foreach (var entry in zip.Entries)
            {
                string outPath = Path.Combine(dir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(outPath));
                using (var s = entry.Open())
                using (var f = File.Create(outPath)) s.CopyTo(f);
            }
        }
        WriteCfg(dir, exeDir);
        return dir;
    }

    private static void WriteCfg(string dir, string exeDir)
    {
        try
        {
            // 每次启动都重写：升级后 exe 换了位置/数据目录变了，缓存目录里的旧 cfg 必须跟着更新。
            // data= 这一行是关键：CreateProcess 不能传自定义环境块（会 ERROR_INVALID_PARAMETER），
            // 所以宿主的 JICAN_DATA_DIR 只能通过这个文件交给 launcher.cjs，再由它写进子进程环境。
            // 不这么做两边数据目录就会分叉：服务端写 <exe目录>/data，宿主却去 %LOCALAPPDATA% 读 server.port，
            // 表现为「服务启动超时」而后台其实活得好好的。
            // 格式必须是「key=value」单行：launcher.cjs 用 /^key=(.+)$/m 解析，行尾不能有空格，
            // 路径里也不要有换行。写坏的 cfg 会让 launcher.cjs 算错数据目录/主程序，结果就是
            // node-runtime 起来了但服务从来没被拉起，宿主只能干等到超时。
            string mainPath = Path.Combine(exeDir, "jican-simulator.exe");
            string dataDir = DataDir();
            File.WriteAllText(Path.Combine(dir, "launcher.cfg"),
                "main=" + mainPath + "\r\n" + "data=" + dataDir + "\r\n", new UTF8Encoding(false));
            Program.HostLog("launcher.cfg 已写入：main=" + mainPath + " data=" + dataDir);
        }
        catch { /* 忽略 */ }
    }

    private static byte[] ReadResource(int id)
    {
        IntPtr h = LoadLibraryEx(Assembly.GetExecutingAssembly().Location, IntPtr.Zero, 0x00000002 /* LOAD_LIBRARY_AS_DATAFILE */);
        if (h == IntPtr.Zero) return null;
        IntPtr info = FindResource(h, new IntPtr(id), new IntPtr(RcData));
        if (info == IntPtr.Zero) return null;
        uint size = SizeofResource(h, info);
        IntPtr data = LoadResource(h, info);
        if (data == IntPtr.Zero || size == 0) return null;
        IntPtr ptr = LockResource(data);
        if (ptr == IntPtr.Zero) return null;
        var buf = new byte[size];
        Marshal.Copy(ptr, buf, 0, (int)size);
        return buf;
    }

    // --------------------------------------------------------------- 错误上报

    internal static string ErrorLogPath
    {
        get { return Path.Combine(Path.GetTempPath(), "jican-launch-error.log"); }
    }

    /// <summary>宿主诊断日志：写到 &lt;数据目录&gt;\logs\host.log，排障第一现场。</summary>
    internal static void HostLog(string text)
    {
        try
        {
            string dir = Path.Combine(DataDir(), "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "host.log"),
                DateTime.Now.ToString("HH:mm:ss.fff") + "  " + text + Environment.NewLine, Encoding.UTF8);
        }
        catch { /* 诊断不能反过来搞挂宿主 */ }
    }

    internal static void Fatal(string text)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath()));
            File.AppendAllText(ErrorLogPath,
                DateTime.Now.ToString("s") + " " + text + Environment.NewLine, Encoding.UTF8);
        }
        catch { /* 忽略 */ }
        MessageBox.Show(text, "机惨模拟器", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr hFile, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr FindResource(IntPtr hModule, IntPtr name, IntPtr type);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr hModule, IntPtr hResInfo);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr hResData);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr hModule, IntPtr hResInfo);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disposition, uint flags, IntPtr templ);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }
}

// ======================================================================
// AppHost：主窗口（内嵌 WebView2）+ 系统托盘。
// ======================================================================
internal sealed class AppHost : Form
{
    private readonly int _port;
    private readonly bool _debug;
    private readonly string _exeDir;
    private readonly string _url;

    private WebView2 _web;
    private NotifyIcon _tray;
    private bool _reallyExit;
    private Label _splash;
    private System.Windows.Forms.Timer _updateTimer;

    internal AppHost(int port, bool debug, string exeDir, string runtimeDir, string mainExe)
    {
        _port = port;
        _debug = debug;
        _exeDir = exeDir;
        _url = "http://127.0.0.1:" + port + "/";

        Text = "机惨模拟器";
        ClientSize = new Size(1200, 760);
        MinimumSize = new Size(900, 600);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(18, 20, 24);
        Font = new Font("Microsoft YaHei UI", 9f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        BuildSplash();
        BuildTray();

        FormClosing += OnFormClosing;
        Shown += OnShown;
        // 窗口一旦能正常显示，就删掉启动超时留下的痕迹，免得下次排障被旧日志误导
        Activated += delegate { try { File.Delete(Program.ErrorLogPath); } catch { } };
    }

    // ------------------------------------------------------------- 启动画面
    private void BuildSplash()
    {
        _splash = new Label();
        _splash.Text = "机惨模拟器\n正在启动本地服务…";
        _splash.Dock = DockStyle.Fill;
        _splash.TextAlign = ContentAlignment.MiddleCenter;
        _splash.ForeColor = Color.FromArgb(200, 205, 215);
        _splash.Font = new Font("Microsoft YaHei UI", 12f);
        Controls.Add(_splash);
    }

    // --------------------------------------------------------------- 托盘
    private void BuildTray()
    {
        _tray = new NotifyIcon();
        try { _tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
        catch { _tray.Icon = SystemIcons.Application; }
        _tray.Text = "机惨模拟器（运行中）";
        _tray.Visible = true;
        _tray.DoubleClick += delegate { ShowApp(); };
        _tray.MouseClick += delegate(object s, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { if (Visible) Hide(); else ShowApp(); }
        };

        // 不设 Renderer 时，深色任务栏里的菜单可能白底白字；显式给一套浅色表。
        var menu = new ContextMenuStrip();
        menu.Renderer = new ToolStripProfessionalRenderer(new TrayColorTable());
        menu.ShowImageMargin = false;
        menu.Items.Add(MenuItem("显示主界面", delegate { ShowApp(); }));
        menu.Items.Add(MenuItem("在浏览器中打开", delegate { OpenInBrowser(); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(MenuItem("查看服务日志", delegate { ShowLog(); }));
        menu.Items.Add(MenuItem("重启服务", delegate { RestartService(); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(MenuItem("退出", delegate { ExitApp(false); }));
        _tray.ContextMenuStrip = menu;
    }

    private static ToolStripMenuItem MenuItem(string text, EventHandler onClick)
    {
        var it = new ToolStripMenuItem(text);
        it.Click += onClick;
        return it;
    }

    private sealed class TrayColorTable : ProfessionalColorTable
    {
        public override Color MenuItemSelected { get { return Color.FromArgb(0, 120, 215); } }
        public override Color MenuItemBorder { get { return Color.FromArgb(0, 120, 215); } }
        public override Color ToolStripDropDownBackground { get { return Color.White; } }
        public override Color ImageMarginGradientBegin { get { return Color.White; } }
        public override Color ImageMarginGradientMiddle { get { return Color.White; } }
        public override Color ImageMarginGradientEnd { get { return Color.White; } }
    }

    // ------------------------------------------------------------ 生命周期
    private void OnShown(object sender, EventArgs e)
    {
        StartUpdateWatcher();
        try
        {
            Program.HostLog("OnShown 开始，url=" + _url);
            InitWebView();
        }
        catch (Exception ex)
        {
            Program.HostLog("InitWebView 抛异常：" + ex);
            FallbackToBrowser(ex);
        }
    }

    /// <summary>
    /// 自动更新（v1.2）：服务端启动安装程序后会写 <数据目录>\update.quit 再退出。
    /// 宿主看到标记就把自己的窗口一起收掉——否则安装程序会一直撞上「文件被占用」。
    /// 用 WinForms Timer 而不是后台线程：检查就是读一个文件，放 UI 线程最省心（1 秒一次，开销可忽略）。
    /// </summary>
    private void StartUpdateWatcher()
    {
        try
        {
            _updateTimer = new System.Windows.Forms.Timer();
            _updateTimer.Interval = 1000;
            _updateTimer.Tick += delegate { CheckUpdateQuit(); };
            _updateTimer.Start();
        }
        catch { /* 计时器起不来不影响正常启动 */ }
    }

    private void CheckUpdateQuit()
    {
        try
        {
            string marker = Path.Combine(Program.DataDir(), "update.quit");
            if (!File.Exists(marker)) return;
            try { File.Delete(marker); } catch { }
            if (_updateTimer != null)
            {
                _updateTimer.Stop();
                _updateTimer.Dispose();
                _updateTimer = null;
            }
            Program.HostLog("检测到更新标记 update.quit，退出宿主交给安装程序");
            ExitApp(true); // 服务端已经在收尾，不需要再发 /api/app/quit
        }
        catch { /* 忽略 */ }
    }

    private void InitWebView()
    {
        CoreWebView2Environment env;
        try
        {
            env = WebView2Setup.Environment();
        }
        catch (Exception ex)
        {
            Program.HostLog("WebView2 环境创建失败：" + ex);
            FallbackToBrowser(ex);
            return;
        }
        _web = new WebView2();
        _web.Dock = DockStyle.Fill;
        _web.DefaultBackgroundColor = Color.FromArgb(18, 20, 24);
        Controls.Add(_web);
        // 让 WebView 显示在最上层，但焦点仍交给 WebView（_splash 是 Label，不会抢焦点）
        Controls.SetChildIndex(_web, 0);
        _splash.Visible = false;

        _web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs ev)
        {
            Program.HostLog("CoreWebView2 初始化完成，IsSuccess=" + ev.IsSuccess);
            if (!ev.IsSuccess)
            {
                FallbackToBrowser(ev.InitializationException ?? new Exception("WebView2 初始化失败"));
                return;
            }
            var core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = _debug;
            core.Settings.AreDefaultContextMenusEnabled = _debug;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            // 外链一律交给系统浏览器，绝不用内嵌窗口访问非本机地址
            core.NavigationStarting += delegate(object s2, CoreWebView2NavigationStartingEventArgs a2)
            {
                if (!IsLocal(a2.Uri))
                {
                    a2.Cancel = true;
                    OpenExternal(a2.Uri);
                }
            };
            // 页面 window.open(url)（「创建房间 / 进入房间成功」时就是它）→ 开独立的房间窗口。
            // v0.5 之前这里是 core.Navigate(uri)：本地地址被塞进同一个控件，主窗口页面直接被顶掉，
            // 玩家从房间里退不出来，只能重启宿主。现在本机地址一律给一个自己的 RoomForm。
            core.NewWindowRequested += delegate(object s2, CoreWebView2NewWindowRequestedEventArgs a2)
            {
                a2.Handled = true;
                if (IsLocal(a2.Uri)) OpenRoomWindow(a2.Uri); else OpenExternal(a2.Uri);
            };
            core.DocumentTitleChanged += delegate { SyncTitle(); };
            core.NavigationCompleted += delegate(object s3, CoreWebView2NavigationCompletedEventArgs a3)
            {
                Program.HostLog("导航完成 IsSuccess=" + a3.IsSuccess + " 状态=" + a3.WebErrorStatus);
            };
            Program.HostLog("即将导航到 " + _url);
            core.Navigate(_url);
        };
        _web.EnsureCoreWebView2Async(env);
    }

    /// <summary>
    /// 只有**本机自己那个服务**的地址才允许留在内嵌 WebView 里；跨机地址（含 ts.net 的 https://xxx.ts.net/…，
    /// 联机对端）一律交给系统浏览器，宿主不替第三方站点当浏览器。
    /// 刻意不认 https://——认了就等于把任意外站放进宿主进程。
    /// </summary>
    internal static bool IsLocal(string uri)
    {
        if (string.IsNullOrEmpty(uri)) return false;
        // about:blank 是 window.open() 不带参数时的「继承者」占位地址，必须留在内嵌侧，
        // 否则页面先 open 再写 document 的老写法会被拦。
        if (string.Equals(uri, "about:blank", StringComparison.OrdinalIgnoreCase)) return true;
        return uri.StartsWith("http://127.0.0.1:", StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("http://localhost:", StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("http://[::1]:", StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("data:", StringComparison.OrdinalIgnoreCase)
            || uri.StartsWith("ws://127.0.0.1:", StringComparison.OrdinalIgnoreCase);
    }

    private void SyncTitle()
    {
        string t = null;
        try { t = _web.CoreWebView2.DocumentTitle; } catch { }
        Text = string.IsNullOrEmpty(t) || t == _url ? "机惨模拟器" : "机惨模拟器 — " + t;
    }

    /// <summary>三级兜底：WebView2 用不了（老系统 / 没装运行时）退回系统默认浏览器，服务照常跑。</summary>
    private void FallbackToBrowser(Exception ex)
    {
        TryInstallWebView2Once();
        _splash.Text = "内嵌浏览器不可用（" + ex.Message + "）" + Environment.NewLine
            + "已用系统默认浏览器打开游戏。" + Environment.NewLine + Environment.NewLine
            + "本窗口与托盘图标常驻，服务仍在后台运行。";
        _splash.Visible = true;
        try { if (_web != null) { Controls.Remove(_web); _web.Dispose(); _web = null; } } catch { }
        OpenInBrowser();
    }

    private static void TryInstallWebView2Once()
    {
        try
        {
            string marker = Path.Combine(Program.DataDir(), "webview2-install-tried");
            if (File.Exists(marker)) return;
            File.WriteAllText(marker, DateTime.Now.ToString("s"));
            string have = null;
            try { have = CoreWebView2Environment.GetAvailableBrowserVersionString(); } catch { }
            if (!string.IsNullOrEmpty(have)) return;
            Process.Start(new ProcessStartInfo("https://go.microsoft.com/fwlink/p/?LinkId=2124703") { UseShellExecute = true });
        }
        catch { }
    }

    private void ShowApp()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        BringToFront();
    }

    /// <summary>
    /// 弹一个独立的房间窗口。页面 window.open 出来的本机地址都走这里（主窗口与房间窗口共用）。
    /// 同步 new + Show：不丢用户手势链，弹窗不被浏览器拦截，调用方也不用管 async。
    /// </summary>
    private void OpenRoomWindow(string uri)
    {
        if (!IsLocal(uri))
        {
            OpenExternal(uri);
            return;
        }
        try
        {
            RoomForm.Open(uri, _debug, false);
        }
        catch (Exception ex)
        {
            Program.HostLog("OpenRoomWindow 失败：" + ex);
            // 房间窗口自己起不来的兜底：至少让玩家用系统浏览器进去，别把人卡在大厅
            OpenExternal(uri);
        }
    }

    private void OpenInBrowser()
    {
        try { Process.Start(new ProcessStartInfo(_url) { UseShellExecute = true }); }
        catch (Exception ex) { MessageBox.Show(this, "无法打开浏览器：" + ex.Message, "机惨模拟器"); }
    }

    private static void OpenExternal(string uri)
    {
        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    private void ShowLog()
    {
        string path = Program.LogPath();
        try
        {
            if (!File.Exists(path)) File.WriteAllText(path, "（暂无日志）");
            Process.Start(new ProcessStartInfo("notepad.exe", "\"" + path + "\"") { UseShellExecute = true });
        }
        catch (Exception ex) { MessageBox.Show(this, "打不开日志：" + ex.Message, "机惨模拟器"); }
    }

    private void RestartService()
    {
        try
        {
            Process.Start(new ProcessStartInfo(Application.ExecutablePath, "--restart")
            { UseShellExecute = true, WorkingDirectory = _exeDir });
        }
        catch (Exception ex) { MessageBox.Show(this, "重启失败：" + ex.Message, "机惨模拟器"); }
        ExitApp(true);
    }

    private void ExitApp(bool skipQuit)
    {
        _reallyExit = true;
        // 退出前把房间窗口一起收掉，否则 Disposing 的 WebView2 会拖着进程不结束
        RoomForm.CloseAll();
        if (!skipQuit)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + _port + "/api/app/quit");
                req.Method = "POST";
                req.ContentLength = 0;
                req.Timeout = 4000;
                req.ReadWriteTimeout = 4000;
                req.Proxy = null;
                req.Headers.Add("X-Jican-Client", "launcher");
                using ((HttpWebResponse)req.GetResponse()) { }
            }
            catch { }
        }
        Close();
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (!_reallyExit && e.CloseReason == CloseReason.UserClosing)
        {
            // 点 X = 收进托盘（需求：后台继续跑），不是退出
            e.Cancel = true;
            Hide();
            if (_tray != null)
            {
                _tray.BalloonTipTitle = "机惨模拟器仍在后台运行";
                _tray.BalloonTipText = "双击托盘图标可重新打开窗口；右键菜单可退出。";
                _tray.ShowBalloonTip(2200);
            }
            return;
        }
        DestroyTray();
    }

    private void DestroyTray()
    {
        if (_tray != null)
        {
            _tray.Visible = false;
            try { _tray.Dispose(); } catch { }
            _tray = null;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DestroyTray();
        base.Dispose(disposing);
    }
}

// ======================================================================
// WebView2 运行时装配（主窗口与房间窗口共用同一份 Environment / user data folder）
// ======================================================================

/// <summary>
/// WebView2 的进程级装配集中在这里，原因（踩过的坑）：
///   1) 同一个进程里所有 WebView2 控件**必须**共用一个 user data folder（UDF），各开各的
///      会直接 0x8007139F「已经有一个同路径的 Environment 在用」之类的 HRESULT；
///   2) 托管层 Microsoft.Web.WebView2.Core.dll 是随 exe 平铺的，CLR 按「应用基目录 + PATH」找它，
///      WebView2Loader.dll（原生）还得靠 SetDllDirectory + PATH 兜；这套逻辑只写一遍；
///   3) CreateAsync 是 async，GetAwaiter().GetResult() 在 UI 线程上不能嵌套多次 —— 缓存在静态字段里
///      之后，房间窗口同步构造也能直接拿到，不会在 OnShown 里死等。
/// </summary>
internal static class WebView2Setup
{
    private static readonly object Gate = new object();
    private static CoreWebView2Environment _env;

    /// <summary>UDF：所有 WebView2 共用 &lt;数据目录&gt;webview2（Cookie / localStorage / 登录态也共用）。</summary>
    internal static string UserDataFolder()
    {
        string udf = Path.Combine(Program.DataDir(), "webview2");
        Directory.CreateDirectory(udf);
        return udf;
    }

    internal static CoreWebView2Environment Environment()
    {
        if (_env != null) return _env;
        lock (Gate)
        {
            if (_env != null) return _env;
            string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string loader = Path.Combine(exeDir, "runtimes", "win-x64", "native", "WebView2Loader.dll");
            if (!File.Exists(loader)) loader = Path.Combine(exeDir, "WebView2Loader.dll");
            if (File.Exists(loader)) Native.SetDllDirectory(Path.GetDirectoryName(loader));

            // 进程内可执行文件目录：WebView2Loader.dll 若与 exe 同目录，光 SetDllDirectory 不够可靠
            // （宿主可能从别的 cwd 启动），补一条 PATH。
            string path = System.Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            if (!path.Contains(exeDir)) System.Environment.SetEnvironmentVariable("PATH", exeDir + ";" + path);

            string udf = UserDataFolder();
            Program.HostLog("WebView2Setup: exeDir=" + exeDir + " loader=" + (File.Exists(loader) ? loader : "(未找到)") + " udf=" + udf);
            _env = CoreWebView2Environment.CreateAsync(null, udf, null).GetAwaiter().GetResult();
            return _env;
        }
    }
}

// ======================================================================
// RoomForm：房间窗口（页面 window.open 出来的本机地址 → 独立窗口，自己的 WebView2）
//
// 「加入 WebKit」的落地说明：没有 WebKit，也不需要。WebView2 = Chromium/Edge，
// 与 WebKit 在页面能力上等价（window.open / WebSocket / fetch 全支持），Windows 上
// 现成的 WebKit 要么停更（QtWebKit）要么平台不对（WKWebView 仅 macOS）。
// 所以「用 WebView 等方式把联机网页显示到窗口上」这件事，本类就是最终形态。
// ======================================================================
internal sealed class RoomForm : Form
{
    /// <summary>所有还活着的房间窗口。主窗口退出一并关掉；关掉宿主时靠它兜底。</summary>
    private static readonly List<RoomForm> _rooms = new List<RoomForm>();

    private readonly bool _debug;
    private readonly string _target;
    private WebView2 _web;
    private Label _splash;

    internal RoomForm(string url, bool debug, bool cascade)
    {
        _debug = debug;
        _target = url;

        // 级联偏移：同一位置叠 N 个窗口玩家会以为「没反应」，每个新窗口往右下错开 28px。
        Point spot = Screen.PrimaryScreen.WorkingArea.Location;
        if (cascade)
        {
            int n;
            lock (_rooms) n = _rooms.Count;
            spot = new Point(spot.X + 40 + (n % 8) * 28, spot.Y + 40 + (n % 8) * 28);
        }

        Text = "机惨模拟器 — 房间";
        ClientSize = new Size(1200, 760);
        MinimumSize = new Size(800, 560);
        StartPosition = cascade ? FormStartPosition.Manual : FormStartPosition.CenterScreen;
        if (cascade) Location = spot;
        BackColor = Color.FromArgb(18, 20, 24);
        Font = new Font("Microsoft YaHei UI", 9f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
    }

    /// <summary>打开一个房间窗口（主窗口 / 房间窗口都调这个）。</summary>
    internal static RoomForm Open(string url, bool debug, bool cascade)
    {
        var f = new RoomForm(url, debug, cascade);
        lock (_rooms) _rooms.Add(f);
        f.FormClosed += delegate { lock (_rooms) _rooms.Remove(f); };
        f.Show();
        f.Start();
        return f;
    }

    internal static int Count
    {
        get { lock (_rooms) return _rooms.Count; }
    }

    internal static void CloseAll()
    {
        RoomForm[] all;
        lock (_rooms) { all = _rooms.ToArray(); _rooms.Clear(); }
        foreach (RoomForm f in all)
        {
            try { f.Close(); } catch { }
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // Start 也可能被外部提前调（Open 里调用），这里只做一次初始化。
        Start();
    }

    private bool _started;
    private void Start()
    {
        if (_started) return;
        _started = true;
        Program.HostLog("RoomForm 打开：" + _target);

        _splash = new Label();
        _splash.Text = "正在打开房间…";
        _splash.Dock = DockStyle.Fill;
        _splash.TextAlign = ContentAlignment.MiddleCenter;
        _splash.ForeColor = Color.FromArgb(200, 205, 215);
        _splash.Font = new Font("Microsoft YaHei UI", 11f);
        Controls.Add(_splash);

        try
        {
            var env = WebView2Setup.Environment();
            _web = new WebView2();
            _web.Dock = DockStyle.Fill;
            _web.DefaultBackgroundColor = Color.FromArgb(18, 20, 24);
            _web.CoreWebView2InitializationCompleted += OnInitDone;
            _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Program.HostLog("RoomForm 初始化失败：" + ex);
            ShowFallback(ex);
        }
    }

    private void OnInitDone(object sender, CoreWebView2InitializationCompletedEventArgs ev)
    {
        Program.HostLog("RoomForm CoreWebView2 初始化完成，IsSuccess=" + ev.IsSuccess);
        if (!ev.IsSuccess)
        {
            ShowFallback(ev.InitializationException ?? new Exception("WebView2 初始化失败"));
            return;
        }

        Controls.Add(_web);
        Controls.SetChildIndex(_web, 0);
        if (_splash != null) _splash.Visible = false;

        var core = _web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = _debug;
        core.Settings.AreDefaultContextMenusEnabled = _debug;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = true;

        // 与主窗口一致：外链一律交给系统浏览器，绝不在房间窗口里访问非本机地址
        core.NavigationStarting += delegate(object s, CoreWebView2NavigationStartingEventArgs a)
        {
            if (!AppHost.IsLocal(a.Uri))
            {
                a.Cancel = true;
                OpenExternal(a.Uri);
            }
        };

        // 房间窗口里再次 window.open（比如房间内「再开一个房间」）：
        // **再开一个新的 RoomForm**，绝不把当前控件导航走 —— 这正是 v0.5 之前主窗口的 bug。
        core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs a)
        {
            a.Handled = true;
            if (AppHost.IsLocal(a.Uri)) OpenCascade(a.Uri); else OpenExternal(a.Uri);
        };

        core.DocumentTitleChanged += delegate { SyncTitle(); };
        core.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs a)
        {
            Program.HostLog("RoomForm 导航完成 IsSuccess=" + a.IsSuccess + " 状态=" + a.WebErrorStatus + " uri=" + _target);
        };

        core.Navigate(_target);
    }

    private void OpenCascade(string uri)
    {
        try { Open(uri, _debug, true); }
        catch (Exception ex) { Program.HostLog("RoomForm 级联开窗失败：" + ex); }
    }

    private void SyncTitle()
    {
        string t = null;
        try { t = _web.CoreWebView2.DocumentTitle; } catch { }
        if (string.IsNullOrEmpty(t)) return;
        Text = "机惨模拟器 — 房间：" + t;
    }

    private static void OpenExternal(string uri)
    {
        try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    private void ShowFallback(Exception ex)
    {
        if (_splash == null)
        {
            _splash = new Label();
            _splash.Dock = DockStyle.Fill;
            _splash.TextAlign = ContentAlignment.MiddleCenter;
            _splash.ForeColor = Color.FromArgb(200, 205, 215);
            Controls.Add(_splash);
        }
        _splash.Text = "内嵌浏览器不可用（" + ex.Message + "）" + Environment.NewLine
            + "已用系统默认浏览器打开这个房间。";
        _splash.Visible = true;
        try { Process.Start(new ProcessStartInfo(_target) { UseShellExecute = true }); } catch { }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            // WebView2 必须显式 Dispose，否则宿主进程会一直挂着浏览器子进程不退
            try { if (_web != null) { Controls.Remove(_web); _web.Dispose(); _web = null; } } catch { }
        }
        base.Dispose(disposing);
    }
}

internal static class Native
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern bool SetDllDirectory(string path);
}