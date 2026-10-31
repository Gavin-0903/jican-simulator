// 图标注入器：给任意 exe 写入 Windows 资源节（RT_GROUP_ICON / RT_ICON / RT_VERSION）。
// 用 .NET Framework 自带的 Win32 UpdateResource / BeginUpdateResource 实现，
// 由 packaging/build.mjs 在构建时编译并调用。
// VS_VERSIONINFO 结构参考：https://learn.microsoft.com/windows/win32/menurc/vs-versioninfo
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

static class IconRes
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

    const ushort LANG = 1033;

    static int Main(string[] args)
    {
        // 用法：IconRes.exe <exe> <ico> [versionString]
        if (args.Length < 2) { Console.Error.WriteLine("usage: IconRes.exe <exe> <ico> [version]"); return 2; }
        string exePath = args[0], icoPath = args[1];
        string version = args.Length > 2 ? args[2] : null;

        byte[] ico = File.ReadAllBytes(icoPath);
        if (ico.Length < 6 || BitConverter.ToUInt16(ico, 2) != 1) { Console.Error.WriteLine("not an .ico"); return 3; }
        int count = BitConverter.ToUInt16(ico, 4);

        var images = new List<byte[]>();
        for (int i = 0; i < count; i++)
        {
            int off = 6 + i * 16;
            uint size = BitConverter.ToUInt32(ico, off + 8);
            uint dataOff = BitConverter.ToUInt32(ico, off + 12);
            var buf = new byte[size];
            Array.Copy(ico, (int)dataOff, buf, 0, (int)size);
            images.Add(buf);
        }

        byte[] group;
        using (var gm = new MemoryStream())
        using (var gw = new BinaryWriter(gm))
        {
            gw.Write((ushort)0); gw.Write((ushort)1); gw.Write((ushort)count);
            for (int i = 0; i < count; i++)
            {
                int off = 6 + i * 16;
                gw.Write(ico[off]);
                gw.Write(ico[off + 1]);
                gw.Write(ico[off + 2]);
                gw.Write(ico[off + 3]);
                gw.Write(BitConverter.ToUInt16(ico, off + 4));
                gw.Write(BitConverter.ToUInt16(ico, off + 6));
                gw.Write(BitConverter.ToUInt32(ico, off + 8));
                gw.Write((ushort)(i + 1));
            }
            group = gm.ToArray();
        }

        IntPtr h = BeginUpdateResource(exePath, false);
        if (h == IntPtr.Zero) { Console.Error.WriteLine("BeginUpdateResource failed " + Marshal.GetLastWin32Error()); return 4; }
        bool ok = true;
        for (int i = 0; i < images.Count; i++)
            ok &= UpdateResource(h, (IntPtr)3, (IntPtr)(i + 1), LANG, images[i], (uint)images[i].Length);   // RT_ICON
        ok &= UpdateResource(h, (IntPtr)14, (IntPtr)1, LANG, group, (uint)group.Length);                    // RT_GROUP_ICON
        if (version != null)
        {
            byte[] vi = BuildVersion(version);
            ok &= UpdateResource(h, (IntPtr)16, (IntPtr)1, LANG, vi, (uint)vi.Length);                      // RT_VERSION
        }
        if (!EndUpdateResource(h, false)) { Console.Error.WriteLine("EndUpdateResource failed " + Marshal.GetLastWin32Error()); return 5; }
        if (!ok) { Console.Error.WriteLine("UpdateResource failed"); return 6; }
        Console.WriteLine("icon resources written: " + exePath);
        return 0;
    }

    /// 最小 VS_VERSIONINFO 构建器。
    /// 每个节点 = wLength/wValueLength/wType + UTF-16 名 + "\0" + 4 字节对齐 + 值 + 4 字节对齐。
    static byte[] BuildVersion(string version)
    {
        string[][] kv = {
            new[] { "CompanyName", "机惨模拟器小组" },
            new[] { "FileDescription", "机惨模拟器" },
            new[] { "FileVersion", version },
            new[] { "InternalName", "jican-simulator" },
            new[] { "LegalCopyright", "机惨模拟器小组" },
            new[] { "OriginalFilename", "jican-simulator.exe" },
            new[] { "ProductName", "机惨模拟器" },
            new[] { "ProductVersion", version },
        };

        var ms = new MemoryStream();
        var bw = new BinaryWriter(ms);

        // 写节点头 + 名字，返回节点起始偏移；长度稍后回填
        Func<string, long> Begin = name =>
        {
            long start = ms.Length;
            bw.Write((ushort)0); bw.Write((ushort)0); bw.Write((ushort)0);
            foreach (char ch in name) bw.Write((ushort)ch);
            bw.Write((ushort)0);
            Pad(ms);
            return start;
        };
        Action<long, int, int> End = (start, valueLen, type) =>
        {
            long here = ms.Length;
            ms.Position = start;
            bw.Write((ushort)(here - start));
            bw.Write((ushort)valueLen);
            bw.Write((ushort)type);
            ms.Position = here;
        };

        // VS 版本号：0.3beta → 0.3.0.0，数值部分保持一致，字符串里写完整版本
        int[] parts = { 0, 0, 0, 0 };
        {
            string v = version;
            int cut = v.IndexOfAny(new[] { 'b', 'a', 'r', ' ', '-' });
            if (cut > 0) v = v.Substring(0, cut);
            string[] seg = v.Split('.');
            for (int i = 0; i < seg.Length && i < 4; i++) { int n; int.TryParse(seg[i], out n); parts[i] = n; }
        }

        long root = Begin("VS_VERSION_INFO");
        // VS_FIXEDFILEINFO (52 字节)
        byte[] ffi = new byte[52];
        Action<int, uint> put = (o, v) => { byte[] b = BitConverter.GetBytes(v); Array.Copy(b, 0, ffi, o, 4); };
        put(0, 0xFEEF04BDu);                       // dwSignature
        put(4, 0x00010000u);                       // dwStrucVersion
        put(8, ((uint)parts[0] << 16) | (uint)parts[1]);   // dwFileVersionMS
        put(12, ((uint)parts[2] << 16) | (uint)parts[3]);  // dwFileVersionLS
        put(16, ((uint)parts[0] << 16) | (uint)parts[1]);  // dwProductVersionMS
        put(20, ((uint)parts[2] << 16) | (uint)parts[3]);  // dwProductVersionLS
        put(24, 0x0000003Fu);                      // dwFileFlagsMask
        put(28, 0x00000000u);                      // dwFileFlags
        put(32, 0x00040004u);                      // dwFileOS = VOS_NT_WINDOWS32
        put(36, 0x00000001u);                      // dwFileType = VFT_APP
        put(40, 0x00000000u);                      // dwFileSubtype
        put(44, 0u);                               // dwFileDateMS
        put(48, 0u);                               // dwFileDateLS
        bw.Write(ffi);
        Pad(ms);

        long sfi = Begin("StringFileInfo");
        long table = Begin("040904B0");
        foreach (string[] pair in kv)
        {
            long node = Begin(pair[0]);
            int chars = pair[1].Length + 1;
            foreach (char ch in pair[1]) bw.Write((ushort)ch);
            bw.Write((ushort)0);
            Pad(ms);
            End(node, chars, 1);
        }
        End(table, 0, 1);
        End(sfi, 0, 1);
        End(root, 52, 0);

        bw.Flush();
        return ms.ToArray();
    }

    static void Pad(MemoryStream ms)
    {
        while ((ms.Length & 3) != 0) ms.WriteByte(0);
    }
}
