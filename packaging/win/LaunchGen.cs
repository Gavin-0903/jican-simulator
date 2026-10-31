// launch.exe 生成器（构建期工具，由 packaging/build.mjs 用 csc 编译并调用）。
//
// 产物 launch.exe = 本程序 exe 的副本 + 注入的资源（Windows GUI 子系统，无控制台）：
//   RCDATA/1 = node.exe 运行时本体
//   RCDATA/2 = launcher.cjs 的 ZIP 包
//   RT_ICON / RT_GROUP_ICON / RT_VERSION = 图标与版本信息
// 运行期由 packaging/win/Launch.cs 释放并按需启动。
//
// 用法：LaunchGen.exe <out.exe> <node.exe> <launcher.cjs> [icon.ico] [version]

using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;

internal static class LaunchGen
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: LaunchGen.exe <out.exe> <node.exe> <launcher.cjs> [icon.ico] [version]");
            return 2;
        }
        string outPath = Path.GetFullPath(args[0]);
        string nodePath = Path.GetFullPath(args[1]);
        string jsPath = Path.GetFullPath(args[2]);
        string icon = args.Length > 3 && File.Exists(args[3]) ? Path.GetFullPath(args[3]) : null;
        string version = args.Length > 4 ? args[4] : null;

        byte[] nodeBytes;
        using (var fs = File.OpenRead(nodePath))
        {
            nodeBytes = new byte[fs.Length];
            int read = 0;
            while (read < nodeBytes.Length) read += fs.Read(nodeBytes, read, nodeBytes.Length - read);
        }
        byte[] payload = ZipOne("launcher.cjs", File.ReadAllBytes(jsPath));

        // 模板必须是 winsubsystem=2 的 GUI 程序（Launch.exe，由 build.mjs 用 /target:winexe 编译），
        // 不能拿本生成器自己的 exe —— 那会把控制台子系统带到产物上，双击照样弹黑框。
        string self = Assembly.GetExecutingAssembly().Location;
        if (string.IsNullOrEmpty(self) || !File.Exists(self))
            self = new Uri(Assembly.GetExecutingAssembly().CodeBase).LocalPath;
        string stub = Path.Combine(Path.GetDirectoryName(self), "Launch.exe");
        if (!File.Exists(stub)) stub = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(self)), "Launch.exe");
        if (!File.Exists(stub))
        {
            Console.Error.WriteLine("[launch] 找不到 GUI 模板 Launch.exe（先编译 packaging/win/Launch.cs）");
            return 4;
        }
        File.Copy(stub, outPath, true);

        IntPtr h = BeginUpdateResource(outPath, false);
        if (h == IntPtr.Zero)
        {
            Console.Error.WriteLine("[launch] BeginUpdateResource 失败 " + Marshal.GetLastWin32Error());
            return 1;
        }
        bool ok = true;
        var rcdata = new IntPtr(10);
        ok &= UpdateResource(h, rcdata, new IntPtr(1), 0, nodeBytes, (uint)nodeBytes.Length);
        ok &= UpdateResource(h, rcdata, new IntPtr(2), 0, payload, (uint)payload.Length);
        // 图标/版本用「中性语言（0）」写入：exe 里原有的 .NET 清单也是中性语言，
        // 实测用 1033 写进去在部分环境取不到（VersionInfo 全空、图标提取失败）。
        if (icon != null) ok &= IconRes.WriteIcon(h, icon, 0);
        if (version != null) ok &= IconRes.WriteVersion(h, version, 0);
        if (!EndUpdateResource(h, false))
        {
            Console.Error.WriteLine("[launch] EndUpdateResource 失败 " + Marshal.GetLastWin32Error());
            return 2;
        }
        if (!ok)
        {
            Console.Error.WriteLine("[launch] UpdateResource 失败");
            return 3;
        }
        Console.WriteLine("[launch] 已生成 " + outPath + "（" + (new FileInfo(outPath).Length / 1048576.0).ToString("0.0") + " MB）");
        return 0;
    }

    /// <summary>把单个文件压成 zip（调用方运行期用 System.IO.Compression 解开，不需要外部工具）。</summary>
    private static byte[] ZipOne(string name, byte[] bytes)
    {
        using (var ms = new MemoryStream())
        {
            using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, true))
            {
                var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
                using (var s = entry.Open()) s.Write(bytes, 0, bytes.Length);
            }
            return ms.ToArray();
        }
    }
}
