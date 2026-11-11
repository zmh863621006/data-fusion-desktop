using System;
using System.IO;
using System.Runtime.InteropServices;

// Called by the existing x64 installer helper before the old version is removed.
// All production DLL paths are fixed to this helper's directory or Windows.
internal static class SystemGraphics {
    private static string SystemDirectory() { return Environment.SystemDirectory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr library);
    internal static int Check() {
        IntPtr library = IntPtr.Zero;
        try {
            if (IntPtr.Size != 8) throw new InvalidOperationException("graphics_architecture_invalid");
            string path = Path.Combine(SystemDirectory(), "D3DCompiler_47.dll");
            if (!File.Exists(path)) throw new InvalidOperationException("graphics_component_missing");
            // Full OS path; search dependencies only beside the OS DLL and in System32.
            library = LoadLibraryEx(path, IntPtr.Zero, 0x00000100 | 0x00000800);
            if (library == IntPtr.Zero) throw new InvalidOperationException("graphics_component_load_failed");
            foreach (string name in new string[] { "D3DCompile", "D3DCompile2", "D3DDisassemble" }) {
                if (GetProcAddress(library, name) == IntPtr.Zero) throw new InvalidOperationException("graphics_component_exports_missing");
            }
            Console.WriteLine("system_graphics_verified");
            return 0;
        } catch (Exception error) {
            Console.WriteLine("system_graphics_unavailable: " + error.Message);
            return 23;
        } finally { if (library != IntPtr.Zero) FreeLibrary(library); }
    }

    internal static int CheckBundled() { return CheckApplication(false); }
    internal static int CheckLegacy() { return CheckApplication(true); }
    private static int CheckApplication(bool legacy) {
        IntPtr library = IntPtr.Zero;
        string prefix = legacy ? "legacy_" : "";
        try {
            Console.WriteLine("checker_runtime=" + Environment.Version);
            if (IntPtr.Size != 8) throw new InvalidOperationException("graphics_architecture_invalid");
            string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "d3dcompiler_47.dll");
            if (!File.Exists(path)) throw new InvalidOperationException(prefix + "graphics_component_missing");
            Console.WriteLine("graphics_provider=" + (legacy ? "electron22_bundled" : "electron_bundled") + "; file_version=" + System.Diagnostics.FileVersionInfo.GetVersionInfo(path).FileVersion);
            // Fixed official Electron resource extracted beside this helper.
            // Legacy flags also work on the user's Win7 7600 system.
            library = LoadLibraryEx(path, IntPtr.Zero, legacy ? 0x00000008u : 0x00000100u | 0x00000800u);
            if (library == IntPtr.Zero) {
                int nativeError = Marshal.GetLastWin32Error();
                throw new InvalidOperationException(prefix + "graphics_component_load_failed_win32=" + nativeError);
            }
            foreach (string name in new string[] { "D3DCompile", "D3DCompile2", "D3DDisassemble" })
                if (GetProcAddress(library, name) == IntPtr.Zero) throw new InvalidOperationException(prefix + "graphics_component_exports_missing=" + name);
            Console.WriteLine(prefix + "bundled_graphics_verified");
            return 0;
        } catch (Exception error) {
            Console.WriteLine(prefix + "graphics_unavailable: " + error.Message);
            return 23;
        } finally { if (library != IntPtr.Zero) FreeLibrary(library); }
    }
}
