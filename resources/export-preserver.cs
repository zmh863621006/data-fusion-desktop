using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

// Fixed, native .NET helper for NSIS. No PowerShell or machine policy changes.
// It copies/verifies exports and checks OS graphics availability; originals and backups are retained.
internal static class ExportPreserver {
    private const string ExportName = "\u5bfc\u51fa\u6587\u4ef6";
    private static readonly StringComparer Names = StringComparer.OrdinalIgnoreCase;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 67108864 };
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

    public sealed class Entry {
        public string path { get; set; }
        public string kind { get; set; }
        public long bytes { get; set; }
        public string sha256 { get; set; }
        public string modified { get; set; }
        public int attributes { get; set; }
    }
    public sealed class Manifest {
        public int schema { get; set; }
        public string installDirectory { get; set; }
        public bool hasExports { get; set; }
        public Entry[] entries { get; set; }
    }
    private sealed class Failure : Exception {
        public readonly string Code;
        public Failure(string code, string message) : base(message) { Code = code; }
    }
    private static void Fail(string code, string message) { throw new Failure(code, message); }
    private static string FullPath(string value) {
        if (String.IsNullOrEmpty(value) || value.Trim().Length == 0 || !Regex.IsMatch(value, @"^[A-Za-z]:\\") || value.IndexOf(':', 2) >= 0)
            Fail("invalid_path", "Expected a local absolute path.");
        string path = Path.GetFullPath(value).TrimEnd('\\');
        if (path.Length <= 2) Fail("invalid_path", "A drive root cannot be used for preservation.");
        return path;
    }
    private static void PlainPath(string path) {
        for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
            try {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    Fail("linked_path", "Linked paths are not supported.");
            } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
        }
    }
    private static bool Within(string child, string parent) {
        return child.StartsWith(parent + "\\", StringComparison.OrdinalIgnoreCase);
    }
    private static string Child(string root, string relative) {
        if (String.IsNullOrEmpty(relative) || Path.IsPathRooted(relative) || relative.Contains(":"))
            Fail("invalid_manifest", "Invalid relative export path.");
        string path = FullPath(Path.Combine(root, relative));
        if (!Within(path, root)) Fail("invalid_manifest", "Export path escapes its root.");
        PlainPath(path);
        return path;
    }
    private static string Hash(string path) {
        using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (SHA256 sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
    }
    private static List<Entry> Entries(string root) {
        PlainPath(root);
        if (File.Exists(root)) Fail("invalid_path", "Export root is not a directory.");
        List<Entry> entries = new List<Entry>();
        if (!Directory.Exists(root)) return entries;
        Stack<string> pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0) {
            string directory = pending.Pop();
            PlainPath(directory);
            foreach (string path in Directory.GetFileSystemEntries(directory)) {
                FileAttributes attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0) Fail("linked_path", "Linked exports are not supported.");
                Entry entry = new Entry { path = path.Substring(root.Length + 1) };
                if ((attributes & FileAttributes.Directory) != 0) {
                    entry.kind = "directory";
                    pending.Push(path);
                } else {
                    FileInfo info = new FileInfo(path);
                    entry.kind = "file";
                    entry.bytes = info.Length;
                    entry.modified = info.LastWriteTimeUtc.ToString("o", CultureInfo.InvariantCulture);
                    entry.attributes = (int)attributes;
                    entry.sha256 = Hash(path);
                }
                entries.Add(entry);
            }
        }
        return entries;
    }
    private static Dictionary<string, Entry> Index(string root, IEnumerable<Entry> entries) {
        Dictionary<string, Entry> result = new Dictionary<string, Entry>(Names);
        foreach (Entry entry in entries) {
            if (entry == null) Fail("invalid_manifest", "Null export entry.");
            Child(root, entry.path);
            if (entry.kind != "directory" && entry.kind != "file") Fail("invalid_manifest", "Unknown export entry kind.");
            if (entry.kind == "file" && (entry.bytes < 0 || entry.sha256 == null || !Regex.IsMatch(entry.sha256, "^[a-f0-9]{64}$")))
                Fail("invalid_manifest", "Invalid export hash or size.");
            if (result.ContainsKey(entry.path)) Fail("invalid_manifest", "Duplicate export path.");
            result.Add(entry.path, entry);
        }
        return result;
    }
    private static bool Same(Entry first, Entry second) {
        return first.kind == second.kind && (first.kind != "file" || (first.bytes == second.bytes && first.sha256 == second.sha256));
    }
    private static void Verify(string root, IEnumerable<Entry> expected, string code) {
        Dictionary<string, Entry> before = Index(root, expected), actual = Index(root, Entries(root));
        if (before.Count != actual.Count) Fail(code, "Export tree changed during preservation.");
        foreach (KeyValuePair<string, Entry> item in before) {
            Entry found;
            if (!actual.TryGetValue(item.Key, out found) || !Same(item.Value, found))
                Fail(code, "Export contents do not match their verified snapshot.");
        }
    }
    private static void Backup(string install, string backup, List<string> locations) {
        if (Directory.Exists(backup) || File.Exists(backup)) Fail("backup_exists", "Backup already exists; it will not be overwritten.");
        string contents = Path.Combine(backup, "files");
        Directory.CreateDirectory(contents);
        Dictionary<string, List<Entry>> sources = new Dictionary<string, List<Entry>>(Names);
        foreach (string location in locations) {
            string root = Path.Combine(location, ExportName);
            if (!sources.ContainsKey(root)) sources.Add(root, Entries(root));
        }
        Dictionary<string, Entry> merged = new Dictionary<string, Entry>(Names);
        bool hasExports = false;
        foreach (KeyValuePair<string, List<Entry>> source in sources) {
            if (Directory.Exists(source.Key)) hasExports = true;
            foreach (Entry entry in source.Value) {
                Entry previous;
                if (merged.TryGetValue(entry.path, out previous)) {
                    if (!Same(previous, entry)) Fail("exports_conflict", "Different installations contain conflicting exports.");
                    continue;
                }
                string target = Child(contents, entry.path);
                if (entry.kind == "directory") Directory.CreateDirectory(target);
                else {
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(Child(source.Key, entry.path), target, false);
                    if (Hash(target) != entry.sha256) Fail("backup_changed", "Backup hash does not match the original.");
                }
                merged.Add(entry.path, entry);
            }
        }
        foreach (KeyValuePair<string, List<Entry>> source in sources) Verify(source.Key, source.Value, "source_changed");
        Verify(contents, merged.Values, "backup_changed");
        Entry[] entries = new Entry[merged.Count];
        merged.Values.CopyTo(entries, 0);
        Manifest manifest = new Manifest { schema = 2, installDirectory = install, hasExports = hasExports, entries = entries };
        string temporary = Path.Combine(backup, "manifest.writing");
        File.WriteAllText(temporary, Json.Serialize(manifest), Utf8);
        File.Move(temporary, Path.Combine(backup, "manifest.json"));
    }
    private static void Restore(string install, string backup) {
        string manifestPath = Path.Combine(backup, "manifest.json"), contents = Path.Combine(backup, "files");
        PlainPath(manifestPath);
        if (new FileInfo(manifestPath).Length > Json.MaxJsonLength) Fail("invalid_manifest", "Backup manifest is too large.");
        Manifest manifest = Json.Deserialize<Manifest>(File.ReadAllText(manifestPath, Utf8));
        if (manifest == null || (manifest.schema != 1 && manifest.schema != 2) || manifest.entries == null ||
            !Names.Equals(install, manifest.installDirectory)) Fail("invalid_manifest", "Backup belongs to another installation or is invalid.");
        Verify(contents, manifest.entries, "backup_changed");
        if (!manifest.hasExports && manifest.entries.Length != 0) Fail("invalid_manifest", "Export directory metadata is inconsistent.");
        if (manifest.hasExports) {
            string root = Path.Combine(install, ExportName);
            PlainPath(root);
            Directory.CreateDirectory(root);
            foreach (Entry entry in manifest.entries) {
                string target = Child(root, entry.path);
                if (entry.kind == "directory") { Directory.CreateDirectory(target); continue; }
                if (File.Exists(target)) {
                    if (Hash(target) != entry.sha256) Fail("restore_conflict", "Refusing to overwrite an existing export.");
                } else {
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    File.Copy(Child(contents, entry.path), target, false);
                }
                if (Hash(target) != entry.sha256) Fail("restore_changed", "Restored export hash mismatch.");
                DateTime modified;
                if (!DateTime.TryParse(entry.modified, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out modified))
                    Fail("invalid_manifest", "Invalid export modification time.");
                // Normalize first so repeated recovery also supports read-only files.
                File.SetAttributes(target, FileAttributes.Normal);
                File.SetLastWriteTimeUtc(target, modified.ToUniversalTime());
                const FileAttributes allowed = FileAttributes.ReadOnly | FileAttributes.Hidden | FileAttributes.System |
                    FileAttributes.Archive | FileAttributes.NotContentIndexed | FileAttributes.Temporary | FileAttributes.Offline;
                FileAttributes attributes = ((FileAttributes)entry.attributes) & allowed;
                File.SetAttributes(target, attributes == 0 ? FileAttributes.Normal : attributes);
            }
            foreach (Entry entry in manifest.entries) {
                string path = Child(root, entry.path);
                if (entry.kind == "file" && Hash(path) != entry.sha256) Fail("restore_changed", "Final export verification failed.");
            }
        }
        File.WriteAllText(Path.Combine(backup, "restored.ok"), DateTime.UtcNow.ToString("o"), Utf8);
    }
    private static string ErrorCode(Exception error) {
        Failure known = error as Failure;
        if (known != null) return known.Code;
        if (error is UnauthorizedAccessException) return "access_denied";
        int native = System.Runtime.InteropServices.Marshal.GetHRForException(error) & 0xffff;
        if (error is IOException && (native == 32 || native == 33)) return "file_in_use";
        if (error is IOException && (native == 112 || native == 39)) return "disk_full";
        return "preservation_failed";
    }
    private static void Log(string backup, string phase, string status, string code, string message) {
        if (backup != null) {
            try {
                PlainPath(backup);
                Directory.CreateDirectory(backup);
                string path = Path.Combine(backup, "preservation.log");
                PlainPath(path);
                File.AppendAllText(path, Json.Serialize(new { phase = phase, status = status, code = code,
                    message = message, at = DateTime.UtcNow.ToString("o") }) + Environment.NewLine, Utf8);
            } catch { /* NSIS also retains the captured helper output if this location is unwritable. */ }
        }
    }
    private static int Main(string[] args) {
        string phase = args.Length == 1 ? args[0] : "", safeBackup = null;
        if (phase == "CheckGraphics") return SystemGraphics.Check();
        if (phase == "CheckBundledGraphics") return SystemGraphics.CheckBundled();
        if (phase == "CheckLegacyGraphics") return SystemGraphics.CheckLegacy();
        try {
            if (phase != "Backup" && phase != "Restore") Fail("invalid_phase", "Expected Backup or Restore.");
            string install = FullPath(Environment.GetEnvironmentVariable("DATA_FUSION_EXPORT_INSTALL"));
            string backup = FullPath(Environment.GetEnvironmentVariable("DATA_FUSION_EXPORT_BACKUP"));
            PlainPath(install);
            PlainPath(backup);
            List<string> locations = new List<string> { install };
            foreach (string name in new[] { "DATA_FUSION_EXPORT_PREVIOUS_USER", "DATA_FUSION_EXPORT_PREVIOUS_MACHINE" }) {
                string value = Environment.GetEnvironmentVariable(name);
                if (!String.IsNullOrEmpty(value) && value.Trim().Length != 0) locations.Add(FullPath(value));
            }
            foreach (string location in locations) {
                if (Names.Equals(backup, location) || Within(backup, location) || Within(location, backup))
                    Fail("backup_overlap", "Backup must be separate from every installation directory.");
            }
            safeBackup = backup;
            if (phase == "Backup") Backup(install, backup, locations);
            else Restore(install, backup);
            Log(safeBackup, phase, "verified", "ok", "Export hashes verified; recovery copy retained.");
            Console.WriteLine("export_preservation_verified: " + phase);
            return 0;
        } catch (Exception error) {
            string code = ErrorCode(error);
            Log(safeBackup, phase, "failed", code, error.Message);
            Console.WriteLine("export_preservation_failed: " + code + ": " + error.Message);
            return phase == "Restore" ? 22 : 21;
        }
    }
}
