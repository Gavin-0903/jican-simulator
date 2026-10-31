// launch.exe：Windows GUI 子系统启动器（双击无黑框）。
//
// 为什么需要这一层：主程序 jican-simulator.exe 内嵌 SEA 的 Node 运行时，是控制台程序，
// 双击一定弹黑框，而且关掉黑框就停服务。Windows 不允许同一进程既是 GUI 又是控制台，
// 所以拆成两层：
//
//   launch.exe（本文件，/target:winexe，无控制台）
//     └─ CreateProcess(CREATE_NO_WINDOW) node-runtime.exe launcher.cjs …  ← 真正的服务端，无窗口
//
//   带 -debug / --debug / -d 时改用 CREATE_NEW_CONSOLE，并把 launcher.cjs 换成调试参数，
//   黑窗口保留，日志直接看得见（调试模式）。
//
// 内嵌资源（由构建期 packaging/win/LaunchGen.cs 注入）：
//   RCDATA/1 = node.exe 运行时本体
//   RCDATA/2 = launcher.cjs 的 ZIP 包
// 首次运行释放到 %LOCALAPPDATA%\JicanSimulator\runtime\，内容没变就直接复用。

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class Launch
{
    private const int RcData = 10;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_NEW_CONSOLE = 0x00000010;
    private const string ScriptName = "launcher.cjs";
    private const string NodeName = "node-runtime.exe";

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
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    private static void Main(string[] args)
    {
        try
        {
            Run(args);
        }
        catch (Exception e)
        {
            Fatal("启动器内部错误：" + e.Message);
        }
    }

    private static void Run(string[] argv)
    {
        string exeDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string mainExe = Path.Combine(exeDir, "jican-simulator.exe");

        bool debug = false;
        foreach (string a in argv)
            if (a == "-debug" || a == "--debug" || a == "-d") debug = true;

        // ---- 释放内嵌运行时（只做一次，内容指纹不变就复用）
        string runtimeDir = ExtractRuntime();

        if (!File.Exists(mainExe))
        {
            // 找不到主程序：如果是在源码目录里跑，就退回用 node 直接跑仓库里的 server/index.js
            Fatal("找不到主程序：" + mainExe + "\n\n请重新安装，或把 launch.exe 与 jican-simulator.exe 放在同一目录。");
            return;
        }

        string args = BuildArgs(argv, debug);
        string cmdline = "\"" + Path.Combine(runtimeDir, NodeName) + "\" \"" + Path.Combine(runtimeDir, ScriptName) + "\" " + args;

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;
        uint flags = debug ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW;
        // 不传自定义环境块：某些宿主（含 DSH 的作业沙箱）里给 CreateProcess 传非空 lpEnvironment
        // 会直接失败于 ERROR_INVALID_PARAMETER(87)，而子进程继承父环境完全够用 —— 主程序路径通过
        // 运行时目录里的 launcher.cfg 传下去（ExtractRuntime 里写）。
        bool ok = CreateProcess(null, new StringBuilder(cmdline, Math.Max(1024, cmdline.Length + 1)), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, exeDir, ref si, out pi);
        if (!ok)
        {
            Fatal("无法启动游戏服务（Win32 错误 " + Marshal.GetLastWin32Error() + "）\n\n" + cmdline);
            return;
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    /// <summary>
    /// 当前进程环境块的副本，尾部追加两项：JICAN_MAIN_EXE / JICAN_EXE_DIR。
    ///
    /// 不自己拼字符串：GetEnvironmentStringsW 返回的就是「\0 分隔、双 \0 结尾」的宽字符块，
    /// 只要跳过 JICAN_* 再原样拷贝、末尾补一个 \0 即可。手拼块在中文等非 ASCII 环境下很容易
    /// 把长度算错（CreateProcess 直接报 ERROR_INVALID_PARAMETER 87）。
    /// </summary>
    private static IntPtr BuildEnv(string mainExe)
    {
        IntPtr raw = GetEnvironmentStringsW();
        if (raw == IntPtr.Zero) return IntPtr.Zero;

        var parts = new System.Collections.Generic.List<byte[]>();
        int offset = 0;
        while (true)
        {
            string s = Marshal.PtrToStringUni(new IntPtr(raw.ToInt64() + offset));
            if (string.IsNullOrEmpty(s)) break;
            int bytes = (s.Length + 1) * 2;
            if (!s.StartsWith("JICAN_MAIN_EXE=", StringComparison.OrdinalIgnoreCase) &&
                !s.StartsWith("JICAN_EXE_DIR=", StringComparison.OrdinalIgnoreCase))
            {
                // 整段原始字节（含结尾的单个 \0），避免任何重新编码
                var seg = new byte[bytes];
                Marshal.Copy(new IntPtr(raw.ToInt64() + offset), seg, 0, bytes);
                parts.Add(seg);
            }
            offset += bytes;
        }
        FreeEnvironmentStringsW(raw);

        foreach (string extra in new string[]
                 {
                     "JICAN_MAIN_EXE=" + mainExe,
                     "JICAN_EXE_DIR=" + Path.GetDirectoryName(mainExe),
                 })
        {
            byte[] body = Encoding.Unicode.GetBytes(extra);
            var seg = new byte[body.Length + 2];
            Array.Copy(body, seg, body.Length);
            parts.Add(seg);
        }

        int total = 0;
        foreach (byte[] p in parts) total += p.Length;
        total += 2; // 收尾的双 \0
        IntPtr block = Marshal.AllocHGlobal(total);
        int at = 0;
        foreach (byte[] p in parts)
        {
            Marshal.Copy(p, 0, new IntPtr(block.ToInt64() + at), p.Length);
            at += p.Length;
        }
        Marshal.WriteInt16(new IntPtr(block.ToInt64() + at), 0);
        return block;
    }

    private static void FreeEnv(IntPtr block)
    {
        if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetEnvironmentStringsW();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool FreeEnvironmentStringsW(IntPtr block);

    private static string BuildArgs(string[] argv, bool debug)
    {
        var sb = new StringBuilder();
        if (debug) sb.Append("--debug ");
        foreach (string a in argv)
        {
            if (a == "-debug" || a == "--debug" || a == "-d") continue;
            sb.Append('"').Append(a.Replace("\"", "\\\"")).Append("\" ");
        }
        return sb.ToString().TrimEnd();
    }

    /// <summary>把 RCDATA/1（node.exe）与 RCDATA/2（launcher.cjs 的 zip）释放到用户目录。</summary>
    private static string ExtractRuntime()
    {
        byte[] nodeBytes = ReadResource(1);
        byte[] zipBytes = ReadResource(2);
        if (nodeBytes == null || zipBytes == null)
            throw new Exception("程序内的运行时资源缺失，请重新安装。");

        string baseDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "JicanSimulator", "runtime");
        Directory.CreateDirectory(baseDir);

        // 指纹必须同时覆盖 node 本体和 launcher.cjs 的 zip，否则升级后旧缓存目录会被直接复用，
        // 新版启动脚本永远不生效（踩过：改了 launcher.cjs 还是跑旧逻辑）。
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
        if (File.Exists(nodePath) && File.Exists(jsPath)) return dir;

        Directory.CreateDirectory(dir);
        // 写临时文件再改名，避免杀软/并发把半个文件留在那儿
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
        // 兜底：把主程序路径写成 launcher.cfg（launcher.cjs 读它），不依赖环境变量也能工作。
        // （某些受限宿主里给 CreateProcess 传自定义环境块会直接 ERROR_INVALID_PARAMETER 87）
        try
        {
            string exeDirOfMain = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            File.WriteAllText(Path.Combine(dir, "launcher.cfg"),
                "main=" + Path.Combine(exeDirOfMain, "jican-simulator.exe") + "\r\n", new UTF8Encoding(false));
        }
        catch { /* 忽略 */ }

        // 兜底：zip 里没有 launcher.cjs 就写一个最小版（正常构建不会走到）
        if (!File.Exists(jsPath))
            File.WriteAllText(jsPath, "require('node:child_process').spawn(require('node:path').join(process.env.JICAN_EXE_DIR||'.','jican-simulator.exe'), process.argv.slice(2), {stdio:'ignore', windowsHide:true});", new UTF8Encoding(false));
        return dir;
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

    private static void Fatal(string text)
    {
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "jican-launch-error.log"),
                DateTime.Now.ToString("s") + " " + text + Environment.NewLine, Encoding.UTF8);
        }
        catch { /* 忽略 */ }
        MessageBoxW(IntPtr.Zero, text, "机惨模拟器", 0x10);
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

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
