using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using Microsoft.Win32;

// Independent GUI process. Only the fixed native update protocol below is executed;
// configuration contains data, never a script or command supplied by the server.
internal static class DataFusionUpdateHost {
    private const string ApplicationFileName = "DataFusion.exe";
    private const string ApplicationProcessName = "DataFusion";
    private const string InstallRegistryKey = @"Software\7030467a-ac8a-531f-b76e-ee2a205ae613";
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 16 };
    private static Configuration configuration;
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FlushFileBuffers(Microsoft.Win32.SafeHandles.SafeFileHandle file);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHGetFolderPath(IntPtr owner, int folder, IntPtr token, uint flags, StringBuilder path);

    public sealed class Configuration {
        public int schema { get; set; }
        public string token { get; set; }
        public string handoffId { get; set; }
        public string handoffDirectory { get; set; }
        public string updatesDirectory { get; set; }
        public string installerPath { get; set; }
        public string expectedSha256 { get; set; }
        public string installDirectory { get; set; }
        public string executablePath { get; set; }
        public int parentPid { get; set; }
        public int exitTimeoutMs { get; set; }
        public string version { get; set; }
    }
    public sealed class Marker {
        public string token { get; set; }
    }
    private sealed class Failure : Exception {
        public readonly string Code;
        public Failure(string code) : base(code) { Code = code; }
    }
    private static void Fail(string code) { throw new Failure(code); }
    private static bool Matches(string value, string pattern) { return value != null && Regex.IsMatch(value, pattern); }
    private static string PathKey(string value) {
        if (String.IsNullOrEmpty(value) || !Regex.IsMatch(value, @"^[A-Za-z]:[\\/]") || value.Length >= 1000
            || value.Substring(2).IndexOf(':') >= 0 || value.IndexOfAny(Path.GetInvalidPathChars()) >= 0
            || value.IndexOfAny(new char[] { '"', '<', '>', '|', '?', '*' }) >= 0) Fail("configuration_invalid");
        return Path.GetFullPath(value).TrimEnd('\\', '/').ToLowerInvariant();
    }
    private static bool SamePath(string left, string right) { return PathKey(left) == PathKey(right); }
    private static bool Inside(string path, string directory) { return PathKey(path).StartsWith(PathKey(directory) + "\\", StringComparison.Ordinal); }
    private static void PlainPath(string path) {
        for (string current = Path.GetFullPath(path); !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
            try {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) Fail("linked_path");
            } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
        }
    }
    private static string ReadSmall(string path, int maximum) {
        using (FileStream stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length > maximum) Fail("configuration_invalid");
            using (StreamReader reader = new StreamReader(stream, Utf8, true)) return reader.ReadToEnd();
        }
    }
    private static void WriteJson(string path, object value) {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".writing";
        try {
            using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (StreamWriter writer = new StreamWriter(stream, Utf8)) {
                writer.Write(Json.Serialize(value));
                writer.Flush();
                stream.Flush();
                // The native durable flush is available on Win7 7600. Unlike
                // FileStream.Flush(bool), it does not require CLR4.
                if (!FlushFileBuffers(stream.SafeFileHandle))
                    throw new IOException("Unable to flush update status", new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()));
            }
            if (File.Exists(path)) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        } finally {
            // A previous interrupted write must not permanently block later updates.
            // Only this invocation's unique temporary file may be removed.
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
    private static void Result(string status, string code) {
        if (configuration == null) return;
        var result = new System.Collections.Generic.Dictionary<string, object> {
            { "version", configuration.version }, { "status", status },
            { "at", (DateTime.UtcNow.Ticks - 621355968000000000L) / TimeSpan.TicksPerMillisecond }, { "handoffId", configuration.handoffId }
        };
        if (!String.IsNullOrEmpty(code)) result.Add("code", code);
        WriteJson(Path.Combine(configuration.handoffDirectory, "result.json"), result);
        WriteJson(Path.Combine(configuration.updatesDirectory, "update-install-result.json"), result);
    }
    private static bool HasMarker(string name) {
        string path = Path.Combine(configuration.handoffDirectory, name);
        try {
            PlainPath(path);
            Marker marker = Json.Deserialize<Marker>(ReadSmall(path, 1024));
            return marker != null && String.Equals(marker.token, configuration.token, StringComparison.Ordinal);
        } catch { return false; }
    }
    private static Configuration LoadConfiguration() {
        string path = Environment.GetEnvironmentVariable("DATA_FUSION_UPDATE_CONFIG");
        PathKey(path);
        PlainPath(path);
        Configuration value = Json.Deserialize<Configuration>(ReadSmall(path, 16384));
        if (value == null || value.schema != 1 || !Matches(value.token, @"\A[a-f0-9]{64}\z")
            || !Matches(value.expectedSha256, @"\A[a-f0-9]{64}\z")
            || !Matches(value.handoffId, @"\Ahandoff-[a-zA-Z0-9]+\z")
            || !Matches(value.version, @"\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z")
            || value.parentPid <= 0 || value.exitTimeoutMs < 1 || value.exitTimeoutMs > 600000) Fail("configuration_invalid");
        if (!SamePath(path, Path.Combine(value.handoffDirectory, "configuration.json"))
            || !SamePath(Path.GetDirectoryName(value.handoffDirectory), value.updatesDirectory)
            || !String.Equals(Path.GetFileName(value.handoffDirectory), value.handoffId, StringComparison.Ordinal)
            || !Inside(value.installerPath, value.updatesDirectory)
            || !String.Equals(Path.GetExtension(value.installerPath), ".exe", StringComparison.OrdinalIgnoreCase)) Fail("configuration_invalid");
        // Validate every path before accepting writable result locations from the file.
        PathKey(value.installDirectory); PathKey(value.executablePath);
        PlainPath(value.handoffDirectory); PlainPath(value.updatesDirectory);
        return value;
    }
    private static void ValidateInstallation() {
        string directory = configuration.installDirectory;
        if (!SamePath(Path.GetDirectoryName(configuration.executablePath), directory)
            || !String.Equals(Path.GetFileName(configuration.executablePath), ApplicationFileName, StringComparison.Ordinal)
            || SamePath(directory, Path.GetPathRoot(directory))
            || Inside(configuration.updatesDirectory, directory) || Inside(directory, configuration.updatesDirectory)
            || SamePath(directory, configuration.updatesDirectory)) Fail("installation_path_invalid");
        // Fixed CSIDLs preserve all of the original broad-directory exclusions
        // without relying on SpecialFolder enum values introduced in CLR4.
        foreach (int folder in new int[] { 0x24, 0x25, 0x28, 0x1a, 0x1c, 0x26, 0x2a, 0x23, 0x10, 0x05 }) {
            StringBuilder folderPath = new StringBuilder(260);
            if (SHGetFolderPath(IntPtr.Zero, folder, IntPtr.Zero, 0, folderPath) != 0) Fail("installation_path_invalid");
            string broad = folderPath.ToString();
            if (!String.IsNullOrEmpty(broad) && SamePath(directory, broad)) Fail("installation_path_invalid");
        }
        PlainPath(directory); PlainPath(configuration.executablePath);
        foreach (string name in new string[] { "package.json", ".git", "node_modules" }) {
            string path = Path.Combine(directory, name);
            if (File.Exists(path) || Directory.Exists(path)) Fail("development_directory");
        }
        if (!File.Exists(Path.Combine(directory, @"resources\app.asar"))) Fail("unregistered_installation");
        // Both shipped helpers are x64. Their default registry view is therefore
        // the same 64-bit view previously selected through CLR4 RegistryView.
        if (IntPtr.Size != 8) Fail("configuration_invalid");
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(InstallRegistryKey)) {
            string registered = key == null ? null : key.GetValue("InstallLocation", "") as string;
            if (String.IsNullOrEmpty(registered) || !SamePath(registered, directory)) Fail("unregistered_installation");
        }
    }
    private static string Digest(Stream stream) {
        using (SHA256 digest = SHA256.Create()) return BitConverter.ToString(digest.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    private static bool ApplicationsRunning(bool sameInstallationOnly) {
        bool found = false;
        foreach (Process process in Process.GetProcessesByName(ApplicationProcessName)) {
            using (process) {
                if (!sameInstallationOnly) found = true;
                else {
                    try { if (!process.HasExited && SamePath(process.MainModule.FileName, configuration.executablePath)) found = true; }
                    catch { /* A different inaccessible instance is never started or stopped. */ }
                }
            }
        }
        return found;
    }
    private static void Install() {
        if (!File.Exists(configuration.installerPath)) Fail("installer_missing");
        PlainPath(configuration.installerPath);
        // Keep the exact verified bytes read-locked until the native installer exits.
        using (FileStream installerStream = File.Open(configuration.installerPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (installerStream.Length < 128 || installerStream.Length > 524288000) Fail("installer_invalid");
            if (!String.Equals(Digest(installerStream), configuration.expectedSha256, StringComparison.Ordinal)) Fail("installer_hash_mismatch");
            installerStream.Position = 0;
            // BinaryReader borrows the outer using block's read-locked stream;
            // its CLR2 constructor has no leaveOpen argument. The stream owner
            // disposes it only after the installer has exited.
            {
                BinaryReader reader = new BinaryReader(installerStream, Utf8);
                if (reader.ReadUInt16() != 0x5a4d) Fail("installer_invalid");
                installerStream.Position = 60;
                int peOffset = reader.ReadInt32();
                if (peOffset < 64 || peOffset > installerStream.Length - 4) Fail("installer_invalid");
                installerStream.Position = peOffset;
                if (reader.ReadUInt32() != 0x00004550) Fail("installer_invalid");
            }
            if (HasMarker("cancel.json")) { Result("cancelled", null); return; }
            if (ApplicationsRunning(false)) Fail("another_application_running");
            Result("installing", null);
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = configuration.installerPath;
            // NSIS requires its final /D= argument to be unquoted, including spaces.
            // ProcessStartInfo invokes CreateProcess directly; there is no command shell.
            start.Arguments = "/S --updated --force-run /currentuser /D=" + configuration.installDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process installer = Process.Start(start)) {
                if (!installer.WaitForExit(600000)) Fail("installer_wait_timeout");
                if (installer.ExitCode == 21) Fail("export_backup_failed");
                if (installer.ExitCode == 22) Fail("export_restore_failed");
                if (installer.ExitCode == 23) Fail("graphics_runtime_unavailable");
                if (installer.ExitCode == 24) Fail("legacy_graphics_file_in_use");
                if (installer.ExitCode == 25) Fail("installer_check_failed");
                if (installer.ExitCode != 0) Fail("installer_failed");
            }
        }
        if (!File.Exists(configuration.executablePath)) Fail("installed_version_mismatch");
        FileVersionInfo version = FileVersionInfo.GetVersionInfo(configuration.executablePath);
        string actual = version.ProductMajorPart + "." + version.ProductMinorPart + "." + version.ProductBuildPart;
        if (!String.Equals(actual, configuration.version, StringComparison.Ordinal)) Fail("installed_version_mismatch");
        Result("installed", null);
        for (int attempt = 0; attempt < 20; attempt++) {
            if (ApplicationsRunning(true)) return;
            Thread.Sleep(250);
        }
        ProcessStartInfo restart = new ProcessStartInfo();
        restart.FileName = configuration.executablePath;
        restart.Arguments = "--updated";
        restart.WorkingDirectory = configuration.installDirectory;
        restart.UseShellExecute = false;
        restart.WindowStyle = ProcessWindowStyle.Normal;
        using (Process application = Process.Start(restart)) { }
    }
    [STAThread]
    private static int Main() {
        Mutex mutex = null;
        bool ownsMutex = false;
        Process parent = null;
        try {
            configuration = LoadConfiguration();
            ValidateInstallation();
            parent = Process.GetProcessById(configuration.parentPid);
            // Acquire and retain the original kernel handle, rather than trusting a reused PID.
            IntPtr originalHandle = parent.Handle;
            long parentStartedAt = parent.StartTime.ToUniversalTime().Ticks;
            if (parent.HasExited || !SamePath(parent.MainModule.FileName, configuration.executablePath)) Fail("parent_identity_invalid");
            string mutexKey;
            using (MemoryStream bytes = new MemoryStream(Utf8.GetBytes(PathKey(configuration.updatesDirectory)))) mutexKey = Digest(bytes);
            mutex = new Mutex(false, @"Local\DataFusionUpdateInstall-" + mutexKey);
            try { ownsMutex = mutex.WaitOne(0); } catch (AbandonedMutexException) { ownsMutex = true; }
            if (!ownsMutex) Fail("installation_already_prepared");
            Result("prepared", null);
            WriteJson(Path.Combine(configuration.handoffDirectory, "ready.json"), new { token = configuration.token, ready = true,
                parentStartedAt = parentStartedAt.ToString(), runtimeVersion = Environment.Version.ToString() });
            Stopwatch waiting = Stopwatch.StartNew();
            bool committed = false;
            while (waiting.ElapsedMilliseconds < configuration.exitTimeoutMs) {
                if (HasMarker("cancel.json")) { Result("cancelled", null); return 0; }
                if (!committed && HasMarker("commit.json")) { committed = true; Result("waiting", null); }
                if (parent.WaitForExit(100)) break;
            }
            if (!parent.HasExited) Fail("parent_exit_timeout");
            if (HasMarker("cancel.json")) { Result("cancelled", null); return 0; }
            if (!committed) committed = HasMarker("commit.json");
            if (!committed) { Result("cancelled", "parent_exited_without_commit"); return 0; }
            for (int closing = 0; closing < 10 && ApplicationsRunning(false); closing++) Thread.Sleep(200);
            if (ApplicationsRunning(false)) Fail("another_application_running");
            Install();
            return 0;
        } catch (Exception error) {
            try { Result("failed", error is Failure ? ((Failure)error).Code : "helper_failed"); } catch { }
            return 1;
        } finally {
            if (parent != null) parent.Dispose();
            if (mutex != null) { if (ownsMutex) mutex.ReleaseMutex(); mutex.Close(); }
        }
    }
}
