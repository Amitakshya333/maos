if (-not ('MaosPilotProcessTree' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MaosPilotProcessTree
{
    private const uint CreateSuspended = 0x00000004;
    private const uint JobObjectBasicAccountingInformation = 1;
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint KillOnJobClose = 0x00002000;
    private const uint WaitObject0 = 0;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint infoClass, ref JobExtendedLimitInformation info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, out JobBasicAccountingInformation info, uint length, out uint returnLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string applicationName, [In, Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    public static int Run(string executable, string[] arguments, string workingDirectory, CancellationToken cancellationToken)
    {
        IntPtr job = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        bool created = false;
        bool assigned = false;
        try
        {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the task-owned Windows Job Object.");
            var limits = new JobExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure the task-owned Windows Job Object.");

            var startup = new StartupInfo();
            startup.cb = Marshal.SizeOf(typeof(StartupInfo));
            var commandText = new StringBuilder(Quote(executable));
            foreach (var argument in arguments) commandText.Append(' ').Append(Quote(argument));
            var commandLine = new StringBuilder(commandText.ToString(), commandText.Length + 1);
            if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, CreateSuspended, IntPtr.Zero, workingDirectory, ref startup, out process))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not start the task-owned application process.");
            created = true;

            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not assign the application to its task-owned process tree.");
            assigned = true;

            if (ResumeThread(process.hThread) == uint.MaxValue)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not resume the task-owned application process.");

            while (true)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    TerminateJobObject(job, 130);
                    WaitForJobEmpty(job);
                    throw new OperationCanceledException(cancellationToken);
                }

                uint activeProcesses = GetActiveProcessCount(job);
                if (activeProcesses == 0)
                {
                    uint completedCode;
                    if (!GetExitCodeProcess(process.hProcess, out completedCode))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the task-owned application exit code.");
                    return unchecked((int)completedCode);
                }

                uint exitCode;
                if (WaitForSingleObject(process.hProcess, 0) == WaitObject0 && GetExitCodeProcess(process.hProcess, out exitCode) && exitCode != 0)
                {
                    TerminateJobObject(job, exitCode);
                    WaitForJobEmpty(job);
                    return unchecked((int)exitCode);
                }
                Thread.Sleep(25);
            }
        }
        catch
        {
            if (assigned)
            {
                TerminateJobObject(job, 1);
                WaitForJobEmpty(job);
            }
            else if (created)
            {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, uint.MaxValue);
            }
            throw;
        }
        finally
        {
            if (job != IntPtr.Zero)
            {
                if (GetActiveProcessCount(job) > 0)
                {
                    TerminateJobObject(job, 1);
                    WaitForJobEmpty(job);
                }
                CloseHandle(job);
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        }
    }

    private static uint GetActiveProcessCount(IntPtr job)
    {
        JobBasicAccountingInformation info;
        uint returnLength;
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info, (uint)Marshal.SizeOf(typeof(JobBasicAccountingInformation)), out returnLength))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect the task-owned process tree.");
        return info.ActiveProcesses;
    }

    private static void WaitForJobEmpty(IntPtr job)
    {
        while (GetActiveProcessCount(job) > 0) Thread.Sleep(25);
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '\"')
            {
                result.Append('\\', slashes * 2 + 1).Append('\"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('\"');
        return result.ToString();
    }
}
'@ -Language CSharp
}

function Invoke-MaosOwnedProcessTree {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][System.Threading.CancellationToken]$CancellationToken
  )

  if (-not $IsWindows -and $env:OS -ne 'Windows_NT') {
    throw 'The MAOS pilot process-tree launcher requires Windows Job Objects.'
  }
  return [MaosPilotProcessTree]::Run($FilePath, $ArgumentList, $WorkingDirectory, $CancellationToken)
}
