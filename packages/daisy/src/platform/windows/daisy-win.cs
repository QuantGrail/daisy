// P5-05 (ADR-141): Daisy's Windows helper. Compiled on first use, on the
// owner's machine, by the C# compiler that ships with Windows
// (%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe, .NET Framework
// 4.x, C# 5 — no newer syntax here), as a GUI-subsystem program
// (/target:winexe): it never opens a console window of its own.
//
//   daisy-win job       --parent <pid> --app <exe> --cmdline <line> [--breakaway-ok]
//       Runs one program as the root of a process tree inside a fresh Job
//       Object with KILL_ON_JOB_CLOSE: created suspended, put in the job,
//       then resumed — so everything it ever starts is in the job too. The
//       job's only handle is this process's: when this process ends
//       (normally, killed by Daisy, or because Daisy itself died — this
//       process is Daisy's child in Node's own kill-on-close job, and it
//       also watches --parent), Windows ends the whole tree. Standard
//       handles are passed through, so the program talks to Daisy directly.
//       Exit code: the program's.
//   daisy-win pty       --parent <pid> --app <exe> --cmdline <line> [--cols N --rows N]
//       The same, attached to a pseudo console (ConPTY, Windows 10 1809+).
//       Speaks terminal-pty.py's protocol on stdin / stdout: JSON lines
//       {"text": "..."} and {"cols": N, "rows": N} in, {"data": "<base64>"}
//       out. Closed stdin ends the tree (exit 143).
//   daisy-win supervise --name <n> --log <file> --cwd <dir> --app <exe> --cmdline <line> [--set K=V]... [--once]
//       Runs Daisy at login (the HKCU Run entry) or for `daisy start`: no
//       console window, output appended to the log, inside a job. Started
//       again after exit 75 (a restart for an update or the owner's) and
//       after any other non-zero exit once it had run a minute (a crash);
//       a failure to start (non-zero within the first minute) and exit 0
//       (`daisy stop`) end this process with Daisy's code. --once: never
//       started again (`daisy start` without start at login).
//   daisy-win ps                        pid \t ppid \t creation time (FILETIME) \t exe name, one per line
//   daisy-win cmdlines <pid>...         pid \t command line, for each this account may read
//   daisy-win acl-set <path>            owner-only DACL: protected; full control for this user,
//                                       SYSTEM and Administrators only (inheritable on a folder)
//   daisy-win acl-get <path>            this user's SID, the owner, whether protected, then each ACE (full SIDs)
//   daisy-win whoami                    this user's SID
//   daisy-win profiles                  the SIDs of the user profiles on this machine
//   daisy-win run-get <name> | run-set <name> <command line> | run-delete <name>
//                                       the value <name> under HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//   daisy-win path                      this program's own path
//   daisy-win tcp-owner <client port> <server port>
//                                       whose is the 127.0.0.1 TCP client end: owner / other / unknown
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

static class DaisyWin
{
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) { Io.Err("usage: daisy-win <job|pty|supervise|ps|acl-set|acl-get|whoami|profiles|tcp-owner|version> ..."); return 64; }
            Opts o = new Opts(args, 1);
            switch (args[0])
            {
                case "version": Io.Out("daisy-win 1\n"); return 0;
                case "job": return Tree.Job(o);
                case "pty": return Pty.Run(o);
                case "supervise": return Supervise.Run(o);
                case "ps": return Ps.Run();
                case "cmdlines": return Ps.CmdLines(args);
                case "acl-set": return Acl.Set(o.Positional(0));
                case "acl-get": return Acl.Get(o.Positional(0));
                case "whoami": Io.Out(WindowsIdentity.GetCurrent().User.Value + "\n"); return 0;
                case "profiles": return Profiles.Run();
                case "path": Io.Out(System.Reflection.Assembly.GetExecutingAssembly().Location + "\n"); return 0;
                case "run-get": return RunKey.Get(o.Positional(0));
                case "run-set": return RunKey.Set(o.Positional(0), o.Positional(1));
                case "run-delete": return RunKey.Delete(o.Positional(0));
                case "tcp-owner": return Tcp.Owner(int.Parse(o.Positional(0)), int.Parse(o.Positional(1)));
            }
            Io.Err("daisy-win: unknown command " + args[0]);
            return 64;
        }
        catch (Exception e)
        {
            Io.Err("daisy-win: " + e.Message);
            return 70;
        }
    }
}

/** --name value options (repeatable ones collected), then positionals. */
class Opts
{
    readonly Dictionary<string, List<string>> named = new Dictionary<string, List<string>>();
    readonly List<string> positional = new List<string>();
    public Opts(string[] a, int from)
    {
        for (int i = from; i < a.Length; i++)
        {
            if (a[i].StartsWith("--"))
            {
                string k = a[i].Substring(2);
                bool flag = i + 1 >= a.Length || a[i + 1].StartsWith("--");
                string v = flag ? "" : a[++i];
                List<string> l;
                if (!named.TryGetValue(k, out l)) { l = new List<string>(); named[k] = l; }
                l.Add(v);
            }
            else positional.Add(a[i]);
        }
    }
    public bool Has(string k) { return named.ContainsKey(k); }
    public string Get(string k) { List<string> l; return named.TryGetValue(k, out l) ? l[l.Count - 1] : null; }
    public string Require(string k) { string v = Get(k); if (v == null) throw new ArgumentException("missing --" + k); return v; }
    public List<string> All(string k) { List<string> l; return named.TryGetValue(k, out l) ? l : new List<string>(); }
    public int Int(string k, int dflt) { string v = Get(k); int n; return v != null && int.TryParse(v, out n) ? n : dflt; }
    public string Positional(int i) { if (i >= positional.Count) throw new ArgumentException("missing argument " + (i + 1)); return positional[i]; }
}

static class Io
{
    static readonly object gate = new object();
    static Stream stdout;
    public static void Out(string s)
    {
        byte[] b = new UTF8Encoding(false).GetBytes(s);
        lock (gate)
        {
            if (stdout == null) stdout = Console.OpenStandardOutput();
            stdout.Write(b, 0, b.Length);
            stdout.Flush();
        }
    }
    public static void Err(string s)
    {
        try
        {
            byte[] b = new UTF8Encoding(false).GetBytes(s + "\n");
            Stream e = Console.OpenStandardError();
            e.Write(b, 0, b.Length);
            e.Flush();
        }
        catch { }
    }
}

static class N
{
    public const uint CREATE_SUSPENDED = 0x4;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    public const int STARTF_USESHOWWINDOW = 0x1;
    public const int STARTF_USESTDHANDLES = 0x100;
    public const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
    public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint SYNCHRONIZE = 0x00100000;
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint INFINITE = 0xFFFFFFFF;
    public const int PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCPROW_OWNER_PID { public uint state, localAddr, localPort, remoteAddr, remotePort, owningPid; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcessW(string app, StringBuilder cmdline, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attrs, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr hpc);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int ResizePseudoConsole(IntPtr hpc, COORD size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void ClosePseudoConsole(IntPtr hpc);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, uint reserved);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int cls, IntPtr buf, int len, out int retLen);
    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    public static Win32Exception Fail(string what)
    {
        int e = Marshal.GetLastWin32Error();
        return new Win32Exception(e, what + " failed (" + e + "): " + new Win32Exception(e).Message);
    }
    public static IntPtr NewJob(bool breakaway)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw Fail("CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        // No SILENT_BREAKAWAY_OK: whatever the program starts stays in the
        // job, even below a job of its own that allows silent breakaway
        // (Node's libuv makes one) — breakaway stops at a job that does not
        // permit it (Microsoft Learn, "Nested Jobs").
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
            | (breakaway ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            throw Fail("SetInformationJobObject");
        return job;
    }
    /** Started suspended → in the job → resumed: nothing it starts can escape the job first. */
    public static PROCESS_INFORMATION StartInJob(IntPtr job, string app, string cmdline, ref STARTUPINFOEX si, bool inherit, uint flags, string cwd)
    {
        PROCESS_INFORMATION pi;
        StringBuilder cl = new StringBuilder(cmdline, cmdline.Length + 1);
        if (!CreateProcessW(string.IsNullOrEmpty(app) ? null : app, cl, IntPtr.Zero, IntPtr.Zero, inherit, flags | CREATE_SUSPENDED, IntPtr.Zero, string.IsNullOrEmpty(cwd) ? null : cwd, ref si, out pi))
            throw Fail("CreateProcess");
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            Win32Exception e = Fail("AssignProcessToJobObject");
            TerminateProcess(pi.hProcess, 1);
            throw e;
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        return pi;
    }
    /** The program's exit code; when --parent goes first, the job is ended (exit 1). */
    public static int WaitChild(IntPtr process, IntPtr job, int parentPid)
    {
        IntPtr parent = parentPid > 0 ? OpenProcess(SYNCHRONIZE, false, parentPid) : IntPtr.Zero;
        IntPtr[] hs = parent != IntPtr.Zero ? new IntPtr[] { process, parent } : new IntPtr[] { process };
        uint r = WaitForMultipleObjects((uint)hs.Length, hs, false, INFINITE);
        if (r == 1)
        {
            TerminateJobObject(job, 1);
            return 1;
        }
        uint code;
        GetExitCodeProcess(process, out code);
        // What it left behind goes with it (also when this process exits).
        TerminateJobObject(job, code);
        return unchecked((int)code);
    }
    public static void Inheritable(IntPtr h)
    {
        if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 1);
    }
}

static class Tree
{
    public static int Job(Opts o)
    {
        IntPtr job = N.NewJob(o.Has("breakaway-ok"));
        N.STARTUPINFOEX si = new N.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(N.STARTUPINFO));
        si.StartupInfo.dwFlags = N.STARTF_USESTDHANDLES | N.STARTF_USESHOWWINDOW;
        si.StartupInfo.wShowWindow = 0; // SW_HIDE
        si.StartupInfo.hStdInput = N.GetStdHandle(-10);
        si.StartupInfo.hStdOutput = N.GetStdHandle(-11);
        si.StartupInfo.hStdError = N.GetStdHandle(-12);
        N.Inheritable(si.StartupInfo.hStdInput);
        N.Inheritable(si.StartupInfo.hStdOutput);
        N.Inheritable(si.StartupInfo.hStdError);
        // CREATE_NO_WINDOW: a console without a window, which everything
        // below it shares — no window flashes up for a harness's commands.
        N.PROCESS_INFORMATION pi = N.StartInJob(job, o.Get("app"), o.Require("cmdline"), ref si, true, N.CREATE_NO_WINDOW, null);
        return N.WaitChild(pi.hProcess, job, o.Int("parent", 0));
    }
}

static class Pty
{
    static short Clamp(int v, int lo, int hi) { return (short)Math.Max(lo, Math.Min(hi, v)); }
    public static int Run(Opts o)
    {
        N.COORD size = new N.COORD();
        size.X = Clamp(o.Int("cols", 100), 20, 4096);
        size.Y = Clamp(o.Int("rows", 30), 5, 150);
        IntPtr inRead, inWrite, outRead, outWrite;
        if (!N.CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw N.Fail("CreatePipe");
        if (!N.CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw N.Fail("CreatePipe");
        IntPtr hpc;
        int hr = N.CreatePseudoConsole(size, inRead, outWrite, 0, out hpc);
        if (hr != 0) throw new Exception("CreatePseudoConsole failed (0x" + hr.ToString("X8") + "): needs Windows 10 1809 or later");
        N.CloseHandle(inRead);
        N.CloseHandle(outWrite);
        IntPtr bytes = IntPtr.Zero;
        N.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        IntPtr list = Marshal.AllocHGlobal(bytes);
        if (!N.InitializeProcThreadAttributeList(list, 1, 0, ref bytes)) throw N.Fail("InitializeProcThreadAttributeList");
        if (!N.UpdateProcThreadAttribute(list, 0, new IntPtr(N.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE), hpc, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
            throw N.Fail("UpdateProcThreadAttribute");
        N.STARTUPINFOEX si = new N.STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(N.STARTUPINFOEX));
        // Null standard handles: the program uses the pseudo console, not
        // this process's (redirected) ones — as node-pty does.
        si.StartupInfo.dwFlags = N.STARTF_USESTDHANDLES;
        si.lpAttributeList = list;
        IntPtr job = N.NewJob(o.Has("breakaway-ok"));
        N.PROCESS_INFORMATION pi = N.StartInJob(job, o.Get("app"), o.Require("cmdline"), ref si, false, N.EXTENDED_STARTUPINFO_PRESENT, null);
        FileStream output = new FileStream(new SafeFileHandle(outRead, true), FileAccess.Read, 1);
        FileStream input = new FileStream(new SafeFileHandle(inWrite, true), FileAccess.Write, 1);
        Thread reader = new Thread(delegate ()
        {
            byte[] buf = new byte[49152];
            try
            {
                int n;
                while ((n = output.Read(buf, 0, buf.Length)) > 0)
                    Io.Out("{\"data\":\"" + Convert.ToBase64String(buf, 0, n) + "\"}\n");
            }
            catch { }
        });
        reader.IsBackground = true;
        reader.Start();
        Thread writer = new Thread(delegate ()
        {
            try
            {
                StreamReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = stdin.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    Dictionary<string, object> m = Json.Object(line);
                    object v;
                    if (m.TryGetValue("text", out v) && v is string)
                    {
                        byte[] b = new UTF8Encoding(false).GetBytes((string)v);
                        input.Write(b, 0, b.Length);
                        input.Flush();
                    }
                    object c, r;
                    if (m.TryGetValue("cols", out c) && m.TryGetValue("rows", out r) && c is double && r is double)
                    {
                        N.COORD s = new N.COORD();
                        s.X = Clamp((int)(double)c, 20, 500);
                        s.Y = Clamp((int)(double)r, 5, 150);
                        N.ResizePseudoConsole(hpc, s);
                    }
                }
            }
            catch { }
            // Daisy closed our input (or it broke): end the whole tree.
            N.TerminateJobObject(job, 143);
            Environment.Exit(143);
        });
        writer.IsBackground = true;
        writer.Start();
        int code = N.WaitChild(pi.hProcess, job, o.Int("parent", 0));
        // Closing the pseudo console ends its output; the reader drains it.
        N.ClosePseudoConsole(hpc);
        reader.Join(5000);
        N.DeleteProcThreadAttributeList(list);
        return code;
    }
}

/** Just enough JSON for terminal-pty's input lines: one flat object of strings / numbers / booleans. */
static class Json
{
    public static Dictionary<string, object> Object(string s)
    {
        int i = 0;
        Dictionary<string, object> o = new Dictionary<string, object>();
        Ws(s, ref i);
        Expect(s, ref i, '{');
        Ws(s, ref i);
        if (Peek(s, i) == '}') return o;
        while (true)
        {
            Ws(s, ref i);
            string k = Str(s, ref i);
            Ws(s, ref i);
            Expect(s, ref i, ':');
            Ws(s, ref i);
            o[k] = Value(s, ref i);
            Ws(s, ref i);
            char c = Peek(s, i);
            i++;
            if (c == '}') return o;
            if (c != ',') throw new FormatException("bad JSON");
        }
    }
    static char Peek(string s, int i) { if (i >= s.Length) throw new FormatException("bad JSON"); return s[i]; }
    static void Ws(string s, ref int i) { while (i < s.Length && char.IsWhiteSpace(s[i])) i++; }
    static void Expect(string s, ref int i, char c) { if (Peek(s, i) != c) throw new FormatException("bad JSON"); i++; }
    static object Value(string s, ref int i)
    {
        char c = Peek(s, i);
        if (c == '"') return Str(s, ref i);
        if (s.Substring(i).StartsWith("true")) { i += 4; return true; }
        if (s.Substring(i).StartsWith("false")) { i += 5; return false; }
        if (s.Substring(i).StartsWith("null")) { i += 4; return null; }
        int start = i;
        while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
        return double.Parse(s.Substring(start, i - start), System.Globalization.CultureInfo.InvariantCulture);
    }
    static string Str(string s, ref int i)
    {
        Expect(s, ref i, '"');
        StringBuilder b = new StringBuilder();
        while (true)
        {
            char c = Peek(s, i++);
            if (c == '"') return b.ToString();
            if (c != '\\') { b.Append(c); continue; }
            char e = Peek(s, i++);
            switch (e)
            {
                case 'n': b.Append('\n'); break;
                case 'r': b.Append('\r'); break;
                case 't': b.Append('\t'); break;
                case 'b': b.Append('\b'); break;
                case 'f': b.Append('\f'); break;
                case 'u': b.Append((char)Convert.ToInt32(s.Substring(i, 4), 16)); i += 4; break;
                default: b.Append(e); break;
            }
        }
    }
}

static class Supervise
{
    public static int Run(Opts o)
    {
        string log = o.Require("log");
        foreach (string kv in o.All("set"))
        {
            int eq = kv.IndexOf('=');
            if (eq > 0) Environment.SetEnvironmentVariable(kv.Substring(0, eq), kv.Substring(eq + 1));
        }
        Environment.SetEnvironmentVariable("DAISY_WIN_SUPERVISOR", o.Require("name"));
        bool once = o.Has("once");
        while (true)
        {
            DateTime started = DateTime.UtcNow;
            int code = RunOnce(o, log);
            double ran = (DateTime.UtcNow - started).TotalSeconds;
            if (once || code == 0 || (code != 75 && ran < 60)) return code;
            int wait = code == 75 ? 1 : 3;
            Append(log, "[daisy-win] exited with code " + code + "; starting again in " + wait + " s\n");
            Thread.Sleep(wait * 1000);
        }
    }
    static void Append(string log, string line)
    {
        try { File.AppendAllText(log, line, new UTF8Encoding(false)); } catch { }
    }
    static int RunOnce(Opts o, string log)
    {
        using (FileStream f = new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
        {
            N.SECURITY_ATTRIBUTES sa = new N.SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(N.SECURITY_ATTRIBUTES));
            sa.bInheritHandle = true;
            // GENERIC_READ, share read|write, OPEN_EXISTING
            IntPtr nul = N.CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
            IntPtr h = f.SafeFileHandle.DangerousGetHandle();
            N.Inheritable(h);
            N.STARTUPINFOEX si = new N.STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(N.STARTUPINFO));
            si.StartupInfo.dwFlags = N.STARTF_USESTDHANDLES | N.STARTF_USESHOWWINDOW;
            si.StartupInfo.hStdInput = nul;
            si.StartupInfo.hStdOutput = h;
            si.StartupInfo.hStdError = h;
            IntPtr job = N.NewJob(false);
            N.PROCESS_INFORMATION pi = N.StartInJob(job, o.Get("app"), o.Require("cmdline"), ref si, true, N.CREATE_NO_WINDOW, o.Get("cwd"));
            if (nul != new IntPtr(-1)) N.CloseHandle(nul);
            int code = N.WaitChild(pi.hProcess, job, 0);
            N.CloseHandle(pi.hProcess);
            N.CloseHandle(job);
            return code;
        }
    }
}

static class RunKey
{
    const string KeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public static int Get(string name)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(KeyPath))
        {
            object v = k == null ? null : k.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
            if (v is string) Io.Out((string)v + "\n");
        }
        return 0;
    }
    public static int Set(string name, string value)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(KeyPath))
            k.SetValue(name, value, RegistryValueKind.String);
        return 0;
    }
    public static int Delete(string name)
    {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(KeyPath, true))
        {
            bool had = k != null && k.GetValue(name) != null;
            if (had) k.DeleteValue(name, false);
            Io.Out(had ? "deleted\n" : "absent\n");
        }
        return 0;
    }
}

static class Ps
{
    /** ProcessCommandLineInformation (60, Windows 8.1+): a UNICODE_STRING and its text. */
    static string CmdLine(int pid)
    {
        IntPtr h = N.OpenProcess(N.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return null;
        IntPtr buf = IntPtr.Zero;
        try
        {
            int len;
            N.NtQueryInformationProcess(h, 60, IntPtr.Zero, 0, out len);
            if (len <= 0 || len > 1 << 20) len = 65536;
            buf = Marshal.AllocHGlobal(len);
            if (N.NtQueryInformationProcess(h, 60, buf, len, out len) != 0) return null;
            int chars = (ushort)Marshal.ReadInt16(buf) / 2;
            IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size == 8 ? 8 : 4);
            return text == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text, chars);
        }
        catch { return null; }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
            N.CloseHandle(h);
        }
    }
    public static int CmdLines(string[] args)
    {
        StringBuilder b = new StringBuilder();
        for (int i = 1; i < args.Length; i++)
        {
            int pid;
            if (!int.TryParse(args[i], out pid)) continue;
            string c = CmdLine(pid);
            if (c != null) b.Append(pid).Append('\t').Append(c.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ')).Append('\n');
        }
        Io.Out(b.ToString());
        return 0;
    }
    public static int Run()
    {
        IntPtr snap = N.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        if (snap == new IntPtr(-1)) throw N.Fail("CreateToolhelp32Snapshot");
        StringBuilder b = new StringBuilder();
        N.PROCESSENTRY32W e = new N.PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(N.PROCESSENTRY32W));
        bool ok = N.Process32FirstW(snap, ref e);
        while (ok)
        {
            long created = 0;
            IntPtr h = N.OpenProcess(N.PROCESS_QUERY_LIMITED_INFORMATION, false, (int)e.th32ProcessID);
            if (h != IntPtr.Zero)
            {
                long x, k, u;
                if (!N.GetProcessTimes(h, out created, out x, out k, out u)) created = 0;
                N.CloseHandle(h);
            }
            b.Append(e.th32ProcessID).Append('\t').Append(e.th32ParentProcessID).Append('\t')
             .Append(created).Append('\t').Append(e.szExeFile).Append('\n');
            ok = N.Process32NextW(snap, ref e);
        }
        N.CloseHandle(snap);
        Io.Out(b.ToString());
        return 0;
    }
}

static class Acl
{
    static SecurityIdentifier[] Owners()
    {
        return new SecurityIdentifier[] {
            WindowsIdentity.GetCurrent().User,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        };
    }
    public static int Set(string path)
    {
        if (Directory.Exists(path))
        {
            DirectorySecurity s = new DirectorySecurity();
            s.SetAccessRuleProtection(true, false);
            foreach (SecurityIdentifier sid in Owners())
                s.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(path, s);
        }
        else if (File.Exists(path))
        {
            FileSecurity s = new FileSecurity();
            s.SetAccessRuleProtection(true, false);
            foreach (SecurityIdentifier sid in Owners())
                s.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(path, s);
        }
        else throw new FileNotFoundException("no such file or folder: " + path);
        return 0;
    }
    public static int Get(string path)
    {
        // One line per fact, every SID in full (SDDL would abbreviate some —
        // e.g. LA for an account with RID 500 — and the check must see the
        // same SID as whoami's):
        //   <this user's SID> / O <owner SID> / P <0|1 protected>
        //   A|D <inherited 0|1> <inheritance flags> <propagation flags> <rights> <SID>
        FileSystemSecurity sec;
        if (Directory.Exists(path)) sec = Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
        else if (File.Exists(path)) sec = File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
        else throw new FileNotFoundException("no such file or folder: " + path);
        StringBuilder b = new StringBuilder();
        b.Append(WindowsIdentity.GetCurrent().User.Value).Append('\n');
        IdentityReference owner = sec.GetOwner(typeof(SecurityIdentifier));
        b.Append("O ").Append(owner == null ? "-" : owner.Value).Append('\n');
        b.Append("P ").Append(sec.AreAccessRulesProtected ? 1 : 0).Append('\n');
        foreach (FileSystemAccessRule r in sec.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            b.Append(r.AccessControlType == AccessControlType.Allow ? "A" : "D").Append(' ')
             .Append(r.IsInherited ? 1 : 0).Append(' ')
             .Append((int)r.InheritanceFlags).Append(' ')
             .Append((int)r.PropagationFlags).Append(' ')
             .Append((int)r.FileSystemRights).Append(' ')
             .Append(r.IdentityReference.Value).Append('\n');
        Io.Out(b.ToString());
        return 0;
    }
}

static class Profiles
{
    public static int Run()
    {
        StringBuilder b = new StringBuilder();
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList"))
        {
            if (k == null) throw new Exception("ProfileList not readable");
            foreach (string sid in k.GetSubKeyNames()) b.Append(sid).Append('\n');
        }
        Io.Out(b.ToString());
        return 0;
    }
}

static class Tcp
{
    const uint LOOPBACK = 0x0100007F; // 127.0.0.1 as read from network byte order
    static int Port(uint p) { return (int)(((p & 0xFF) << 8) | ((p >> 8) & 0xFF)); }
    public static int Owner(int clientPort, int serverPort)
    {
        int size = 0;
        N.GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0); // AF_INET, TCP_TABLE_OWNER_PID_ALL
        IntPtr buf = Marshal.AllocHGlobal(size);
        try
        {
            if (N.GetExtendedTcpTable(buf, ref size, false, 2, 5, 0) != 0) { Io.Out("unknown\n"); return 0; }
            int count = Marshal.ReadInt32(buf);
            int rowSize = Marshal.SizeOf(typeof(N.MIB_TCPROW_OWNER_PID));
            for (int i = 0; i < count; i++)
            {
                N.MIB_TCPROW_OWNER_PID r = (N.MIB_TCPROW_OWNER_PID)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + 4 + i * rowSize), typeof(N.MIB_TCPROW_OWNER_PID));
                if (r.state != 5 || r.localAddr != LOOPBACK || r.remoteAddr != LOOPBACK) continue; // ESTABLISHED
                if (Port(r.localPort) != clientPort || Port(r.remotePort) != serverPort) continue;
                Io.Out(SameUser((int)r.owningPid) ? "owner\n" : "other\n");
                return 0;
            }
            Io.Out("unknown\n");
            return 0;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }
    static bool SameUser(int pid)
    {
        IntPtr h = N.OpenProcess(N.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return false;
        try
        {
            IntPtr token;
            if (!N.OpenProcessToken(h, 0x0008 /* TOKEN_QUERY */, out token)) return false;
            try
            {
                using (WindowsIdentity id = new WindowsIdentity(token))
                    return id.User != null && id.User.Equals(WindowsIdentity.GetCurrent().User);
            }
            catch { return false; }
            finally { N.CloseHandle(token); }
        }
        finally { N.CloseHandle(h); }
    }
}
