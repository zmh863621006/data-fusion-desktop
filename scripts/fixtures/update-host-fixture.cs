using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;
using Microsoft.Win32;

[assembly: AssemblyVersion("9.8.7.0")]
[assembly: AssemblyFileVersion("9.8.7.0")]

// Harmless native process/installer surrogate, compiled only into an isolated temp directory.
internal static class UpdateHostFixture {
    private static int Main(string[] args) {
        if (args.Length > 0 && (args[0] == "registry-set" || args[0] == "registry-remove")) {
            if (args.Length < 2 || !args[1].StartsWith(@"Software\DataFusionUpdateHostTest\", StringComparison.Ordinal)) return 70;
            using (RegistryKey registry = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64)) {
                if (args[0] == "registry-remove") registry.DeleteSubKeyTree(args[1], false);
                else using (RegistryKey key = registry.CreateSubKey(args[1])) key.SetValue("InstallLocation", args[2]);
            }
            return 0;
        }
        if (args.Length > 0 && args[0] == "parent") {
            Console.WriteLine("ready");
            Console.ReadLine(); // The test ends its own parent process normally via stdin.
            return 0;
        }
        if (args.Length > 0 && args[0] == "--updated") {
            string marker = Environment.GetEnvironmentVariable("DATA_FUSION_TEST_RESTART_MARKER");
            File.AppendAllText(marker, "restarted\n");
            Thread.Sleep(1500);
            File.WriteAllText(marker + ".done", "done");
            return 0;
        }
        if (args.Length > 0 && args[0] == "/S") {
            File.WriteAllText(Environment.GetEnvironmentVariable("DATA_FUSION_TEST_INSTALLER_MARKER"), Environment.CommandLine);
            string exitCode = Environment.GetEnvironmentVariable("DATA_FUSION_TEST_INSTALLER_EXIT");
            if (!String.IsNullOrEmpty(exitCode)) return Int32.Parse(exitCode);
            if (Environment.GetEnvironmentVariable("DATA_FUSION_TEST_FORCE_RUN") == "1") {
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = Environment.GetEnvironmentVariable("DATA_FUSION_TEST_APPLICATION");
                start.Arguments = "--updated";
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                using (Process process = Process.Start(start)) { }
            }
            return 0;
        }
        return 71;
    }
}
