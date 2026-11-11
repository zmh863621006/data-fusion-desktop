using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

// Diagnostic only. It neither changes Windows files nor injects code into a process.
internal static class D3DCompilerDiagnostic {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr library, string name);
    [DllImport("kernel32.dll")]
    private static extern bool FreeLibrary(IntPtr library);
    [UnmanagedFunctionPointer(CallingConvention.StdCall, CharSet = CharSet.Ansi)]
    private delegate int Compile(string source, UIntPtr length, string name, IntPtr defines, IntPtr include,
        string entry, string target, uint flags, uint effects, out IntPtr code, out IntPtr errors);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate UIntPtr BlobSize(IntPtr self);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string PathKey(string path) { return Path.GetFullPath(path).TrimEnd('\\').ToLowerInvariant(); }
    private static object Shader(string path) {
        IntPtr library = LoadLibraryEx(Path.GetFullPath(path), IntPtr.Zero, 0x00000100 | 0x00000800);
        if (library == IntPtr.Zero) throw new InvalidOperationException("compiler_load_failed_" + Marshal.GetLastWin32Error());
        try {
            IntPtr entry = GetProcAddress(library, "D3DCompile");
            var exports = new Dictionary<string, bool>();
            foreach (string name in new string[] { "D3DCompile", "D3DCompile2", "D3DDisassemble" }) exports.Add(name, GetProcAddress(library, name) != IntPtr.Zero);
            if (entry == IntPtr.Zero) throw new InvalidOperationException("compile_export_missing");
            Compile compile = (Compile)Marshal.GetDelegateForFunctionPointer(entry, typeof(Compile));
            var shaders = new List<object>();
            foreach (string target in new string[] { "vs_5_0", "ps_5_0" }) {
                string source = target == "vs_5_0" ? "float4 main(float4 p:POSITION):SV_POSITION{return p;}" : "float4 main():SV_Target{return float4(0.2,0.6,0.8,1.0);}";
                IntPtr code = IntPtr.Zero, errors = IntPtr.Zero;
                try {
                    int result = compile(source, new UIntPtr((uint)source.Length), "isolated-probe.hlsl", IntPtr.Zero, IntPtr.Zero, "main", target, 0, 0, out code, out errors);
                    ulong bytes = 0;
                    if (code != IntPtr.Zero) {
                        IntPtr vtable = Marshal.ReadIntPtr(code);
                        BlobSize size = (BlobSize)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtable, 4 * IntPtr.Size), typeof(BlobSize));
                        bytes = size(code).ToUInt64();
                    }
                    shaders.Add(new { target = target, success = result >= 0 && bytes > 0, hresult = result, bytes = bytes });
                    if (result < 0 || bytes == 0) throw new InvalidOperationException("shader_compile_failed");
                } finally {
                    if (code != IntPtr.Zero) Marshal.Release(code);
                    if (errors != IntPtr.Zero) Marshal.Release(errors);
                }
            }
            return new { status = "pass", path = Path.GetFullPath(path), version = FileVersionInfo.GetVersionInfo(path).ProductVersion, exports = exports, shaders = shaders };
        } finally { FreeLibrary(library); }
    }
    private static object Modules(string executable, int parentPid) {
        string expected = PathKey(executable);
        using (Process parent = Process.GetProcessById(parentPid)) {
            if (PathKey(parent.MainModule.FileName) != expected) throw new InvalidOperationException("parent_identity_mismatch");
        }
        var processes = new List<object>();
        foreach (Process process in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(executable))) {
            using (process) {
                try {
                    if (PathKey(process.MainModule.FileName) != expected) continue;
                    var modules = new List<object>();
                    foreach (ProcessModule module in process.Modules) {
                        if (module.ModuleName.StartsWith("d3dcompiler_", StringComparison.OrdinalIgnoreCase))
                            modules.Add(new { name = module.ModuleName, path = module.FileName, version = module.FileVersionInfo.ProductVersion });
                    }
                    processes.Add(new { pid = process.Id, compilers = modules });
                } catch (System.ComponentModel.Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        return new { status = "pass", processes = processes };
    }
    private static int Main(string[] args) {
        try {
            object result;
            if (args.Length == 2 && args[0] == "shader") result = Shader(args[1]);
            else if (args.Length == 3 && args[0] == "modules") result = Modules(args[1], Int32.Parse(args[2]));
            else throw new InvalidOperationException("diagnostic_arguments_invalid");
            Console.WriteLine(Json.Serialize(result));
            return 0;
        } catch (Exception error) {
            Console.WriteLine(Json.Serialize(new { status = "fail", code = error.Message }));
            return 1;
        }
    }
}
