// The Windows entry point: an icon in the notification area, no console window,
// and a program that can be opened, closed and quit like any other.
//
// Compiled by tools/build-desktop.mjs with the C# compiler that ships inside
// Windows PowerShell (Add-Type), so the build needs no toolchain. That compiler
// is the .NET Framework one, which speaks C# 5 — no string interpolation, no
// null-conditional `?.`, no expression-bodied members. Lambdas and `var` are
// fine. Code here that uses a newer form fails the BUILD, not a test, and the
// build script only warns about it, so the package would quietly ship without
// its launcher.
//
// Why a tray icon at all. The server is a headless Node process and the window
// is a Chromium `--app` window that belongs to the browser, so neither half can
// own a taskbar presence that survives the window being closed. Without this
// program, "keep running in the background" means an invisible process: nothing
// to click to get the window back, nothing to say the app is up, and Task
// Manager as the only way to stop it. This program is the missing owner — it
// holds the process, shows that it is there, opens a window on demand, and
// quits the whole thing on request.
//
// It is also the SINGLE INSTANCE. A second double-click signals the running
// copy to show a window and exits, so an install can never end up with two
// servers on two ports and two views of one library. The signal is keyed on the
// install's own folder, so two portable copies on one machine stay two apps.
//
// The server is a CHILD process, held by a pipe on its standard input. That
// pipe is the shutdown channel: closing it asks the server to stop cleanly
// (WAL checkpointed, database closed), and it costs no HTTP endpoint and no
// exception for the password gate — which a quit over the tailnet must not have.
// It runs in both directions: if this program dies, the pipe closes and the
// server goes with it, so a killed tray icon cannot leave an orphan holding the
// port.
//
// A course file double-clicked in Explorer arrives as `--open "<path>"` (the
// file type desktop/installer/Terramentor.iss registers), and one dropped on the
// program as a bare path. The show signal carries no data, so a second copy
// that was handed a file starts the launcher script with it instead, and the
// script hands the file to the running server (desktop/launcher.js).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    public const string APP = "Terramentor";

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(root, "runtime", "node.exe");
        string script = Path.Combine(root, "desktop", "launcher.js");

        if (!File.Exists(node) || !File.Exists(script))
        {
            // Nothing to start: the folder was unpacked incompletely. A message
            // box is the only UI this program has before the tray icon exists.
            MessageBox.Show(
                "This copy of " + APP + " is incomplete: runtime\\node.exe or desktop\\launcher.js is missing."
                    + Environment.NewLine + Environment.NewLine
                    + "Unpack the whole zip into one folder and try again.",
                APP, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        // The file to open, if any, comes out of the arguments: they are passed
        // on to every later start, and the file is opened once.
        string opening;
        string[] rest = SplitOpenRequest(args, out opening);

        // Keyed on the install folder so two portable copies are two apps. A
        // hand-rolled FNV-1a rather than string.GetHashCode(), which is only
        // stable within one runtime's lifetime and is documented not to be a
        // durable key — this name has to match across separately started
        // processes.
        string key = Fingerprint(root);
        bool first;
        Mutex single = new Mutex(true, "Local\\" + APP + ".instance." + key, out first);
        if (!first)
        {
            if (opening != null)
            {
                StartHidden(node, script, root, rest, opening);
                return 0;
            }
            try
            {
                EventWaitHandle wake = EventWaitHandle.OpenExisting("Local\\" + APP + ".show." + key);
                wake.Set();
            }
            catch (Exception)
            {
                // The holder is starting up or going away. Either way this copy
                // has nothing useful left to do; the one that owns the mutex is
                // the app.
            }
            return 0;
        }

        // What the installer and its uninstaller look for (AppMutex in
        // desktop/installer/Terramentor.iss) before they replace or remove files
        // this program runs from. Not keyed on the folder: the installer cannot
        // compute the key, and any running copy holds the shared library open.
        Mutex running = new Mutex(false, "Local\\" + APP + ".running");

        Application.EnableVisualStyles();
        TrayApp app = new TrayApp(root, node, script, key, rest, opening);
        if (!app.Started)
        {
            app.Dispose();
            return 1;
        }
        Application.Run(app);
        GC.KeepAlive(single);   // the mutexes must outlive the message loop
        GC.KeepAlive(running);
        return 0;
    }

    /**
     * The arguments without the file this start was asked to open, which comes
     * back in `opening` as a full path (null when there is none). The same rule
     * as desktop/lib.js `openRequest`: `--open <path>` wins, else the first
     * argument that is neither a flag nor the value of one.
     */
    public static string[] SplitOpenRequest(string[] args, out string opening)
    {
        List<string> rest = new List<string>();
        string named = null, bare = null;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--open")
            {
                if (i + 1 >= args.Length || args[i + 1].StartsWith("--", StringComparison.Ordinal)) continue;
                if (named == null && args[i + 1].Length > 0) named = args[i + 1];
                i++;
                continue;
            }
            if (a == "--data-dir" || a == "--port")
            {
                rest.Add(a);
                if (i + 1 < args.Length) rest.Add(args[i + 1]);
                i++;
                continue;
            }
            if (a.StartsWith("--", StringComparison.Ordinal) || a.Length == 0) { rest.Add(a); continue; }
            // A file is opened once: one more (two files dropped on the program)
            // is not passed on, or every later "Open" would offer it again.
            if (bare == null) bare = a;
        }
        string asked = named != null ? named : bare;
        opening = null;
        if (asked != null)
        {
            try { opening = Path.GetFullPath(asked); }
            catch (Exception) { /* not a path this system can name: nothing to open */ }
        }
        return rest.ToArray();
    }

    /**
     * Run the launcher script hidden and detached with these arguments (and the
     * file to open, when there is one). It finds the server on this library by
     * itself, so this program never has to learn a port, and exits as soon as
     * the window is up.
     */
    public static void StartHidden(string node, string script, string root, string[] args, string opening)
    {
        string quoted = Launcher.QuoteArg(script);
        for (int i = 0; i < args.Length; i++)
        {
            // --autostart describes how the APP started, not this request. A
            // person clicking "Open" is asking for a window whatever the
            // sign-in preference says.
            if (args[i] == "--autostart") continue;
            quoted += " " + Launcher.QuoteArg(args[i]);
        }
        if (opening != null) quoted += " --open " + Launcher.QuoteArg(opening);
        ProcessStartInfo psi = new ProcessStartInfo(node, quoted);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try { Process.Start(psi); }
        catch (Exception) { /* the tray icon is still there to try again */ }
    }

    /** FNV-1a over the lower-cased path, as eight hex digits. */
    static string Fingerprint(string s)
    {
        uint h = 2166136261;
        string v = s.ToLowerInvariant();
        for (int i = 0; i < v.Length; i++)
        {
            h ^= v[i];
            h *= 16777619;
        }
        return h.ToString("X8");
    }

    /**
     * One argument of a command line, quoted so node.exe splits it back into
     * exactly this string. Windows' rule (CommandLineToArgvW, and the C
     * runtime node uses): inside quotes a backslash is an ordinary character
     * unless a run of them ends at a quote — 2n backslashes then mean n and
     * the quote is syntax, 2n+1 mean n and a literal quote. Escaping only the
     * quote left a path ending in a backslash (a library at a drive root,
     * `E:\`) to swallow its own closing quote and every argument after it.
     */
    public static string QuoteArg(string arg)
    {
        System.Text.StringBuilder sb = new System.Text.StringBuilder("\"");
        int slashes = 0;
        foreach (char c in arg)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') sb.Append('\\', slashes * 2 + 1);
            else sb.Append('\\', slashes);
            sb.Append(c);
            slashes = 0;
        }
        sb.Append('\\', slashes * 2);
        sb.Append('"');
        return sb.ToString();
    }
}

/**
 * The tray icon and the server process behind it.
 *
 * Everything runs on the UI thread, driven by one timer: the "show a window"
 * signal is POLLED rather than waited on in a background thread, because every
 * thing this program does in response touches either the tray icon or a
 * process handle, and a WinForms timer tick is already on the right thread.
 * The same tick notices the server exiting.
 */
class TrayApp : ApplicationContext
{
    readonly string root, node, script, key;
    readonly string[] passthrough;
    /** The file the first start shows, handed to the server's launcher only. */
    readonly string opening;
    readonly NotifyIcon tray;
    readonly EventWaitHandle showSignal;
    readonly System.Windows.Forms.Timer pulse;
    const string FATAL = "TERRAMENTOR_FATAL ";
    Process server;
    volatile bool serverSaysBackground;
    volatile string fatalMessage;
    bool announced, quitting;
    DateTime lastOpenClick;

    /** Whether a server process was SPAWNED — not whether it is still alive. One
     *  that starts and then fails has a reason to report, and reporting it is the
     *  pulse's job; treating that as "never started" would exit before the
     *  message arrived down the pipe. */
    public bool Started { get { return server != null; } }

    public TrayApp(string root, string node, string script, string key, string[] passthrough, string opening)
    {
        this.root = root;
        this.node = node;
        this.script = script;
        this.key = key;
        this.passthrough = passthrough;
        this.opening = opening;

        showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\" + Launcher.APP + ".show." + key);

        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("Open " + Launcher.APP, null, delegate { OpenWindow(); });
        menu.Items.Add(new ToolStripSeparator());
        ToolStripMenuItem quit = new ToolStripMenuItem("Quit " + Launcher.APP);
        quit.Click += delegate { Quit(); };
        menu.Items.Add(quit);

        tray = new NotifyIcon();
        tray.Icon = LoadIcon();
        tray.Text = Launcher.APP;               // capped at 63 chars by the shell
        tray.ContextMenuStrip = menu;
        // A left CLICK opens the window — what every modern tray app does, and
        // what the first half of a double-click is. Both events fire for a
        // double-click (Click, then DoubleClick), so the debounced entry below
        // turns the pair into ONE window. The button MUST be read: NotifyIcon
        // raises Click for every button, so the plain `Click`/`DoubleClick`
        // events opened a window on the RIGHT button too — on top of the menu
        // that button is for, which already offers Open and Quit.
        tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenWindowClick(); };
        tray.MouseDoubleClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) OpenWindowClick(); };
        tray.BalloonTipClicked += delegate { OpenWindowClick(); };
        tray.Visible = true;

        StartServer();

        pulse = new System.Windows.Forms.Timer();
        pulse.Interval = 400;
        pulse.Tick += OnPulse;
        pulse.Start();
    }

    Icon LoadIcon()
    {
        string ico = Path.Combine(root, Launcher.APP + ".ico");
        try
        {
            if (File.Exists(ico)) return new Icon(ico, SystemInformation.SmallIconSize);
        }
        catch (Exception)
        {
            // A corrupt or unreadable .ico must not cost the person their app.
        }
        return SystemIcons.Application;
    }

    void StartServer()
    {
        string quoted = Launcher.QuoteArg(script);
        for (int i = 0; i < passthrough.Length; i++) quoted += " " + Launcher.QuoteArg(passthrough[i]);
        if (opening != null) quoted += " --open " + Launcher.QuoteArg(opening);

        ProcessStartInfo psi = new ProcessStartInfo(node, quoted);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        // Standard input is the shutdown channel (see the file header). Output is
        // redirected only so the server can say it started without a window —
        // the pipe must then be DRAINED, or a chatty startup fills the buffer
        // and blocks the server's first console.log forever.
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.EnvironmentVariables["TERRAMENTOR_TRAY"] = "1";

        try
        {
            server = new Process();
            server.StartInfo = psi;
            server.OutputDataReceived += OnServerLine;
            server.ErrorDataReceived += delegate { };
            server.Start();
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();
        }
        catch (Exception e)
        {
            MessageBox.Show(
                Launcher.APP + " could not start." + Environment.NewLine + Environment.NewLine + e.Message,
                Launcher.APP, MessageBoxButtons.OK, MessageBoxIcon.Error);
            server = null;
        }
    }

    /** Runs on a pipe thread — set a flag, let the timer do the UI. */
    void OnServerLine(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null) return;
        if (e.Data.IndexOf("TERRAMENTOR_TRAY_HINT background", StringComparison.Ordinal) >= 0)
        {
            serverSaysBackground = true;
        }
        int marker = e.Data.IndexOf(FATAL, StringComparison.Ordinal);
        if (marker >= 0)
        {
            // The server is about to exit and this process has no console and
            // no window: without this the app would simply not appear, which is
            // the least useful thing a program can do. `\n` arrives escaped,
            // because a pipe is line-based.
            fatalMessage = e.Data.Substring(marker + FATAL.Length).Replace("\\n", Environment.NewLine);
        }
    }

    void OnPulse(object sender, EventArgs e)
    {
        if (quitting) return;

        // Another copy was double-clicked, or the Start Menu entry was used
        // while this one was already running.
        if (showSignal.WaitOne(0)) OpenWindow();

        // The server said it came up without opening a window (started at sign-in
        // with "stay in the background"). Say where it went, once — an app that
        // starts invisibly and says nothing is indistinguishable from one that
        // failed to start.
        if (serverSaysBackground && !announced)
        {
            announced = true;
            tray.BalloonTipTitle = Launcher.APP + " is running";
            tray.BalloonTipText = "It is in the background. Click here to open it.";
            tray.BalloonTipIcon = ToolTipIcon.None;
            try { tray.ShowBalloonTip(5000); } catch (Exception) { /* notifications off */ }
        }

        // The server is the app. When it stops — quit from inside the window,
        // a crash, a Task Manager kill — the icon must go too, or it is an icon
        // for something that is not there.
        if (server == null || server.HasExited)
        {
            // …and if it stopped because it could not start, say why before
            // going. An app that is double-clicked and simply never appears is
            // the one outcome worth any amount of code to avoid.
            string why = fatalMessage;
            if (why != null && !quitting)
            {
                quitting = true;
                try { tray.Visible = false; } catch (Exception) { }
                MessageBox.Show(why, Launcher.APP, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            ExitNow();
        }
    }

    /**
     * The tray's pointer events, debounced. A double-click raises Click AND
     * DoubleClick (the second press-up is suppressed), and the first click of a
     * double-click delivered while the overflow flyout is still settling can
     * arrive alone — so both gestures are answered, and the window here is
     * wide enough to span the system's double-click time, keeping the pair
     * from spawning two launcher processes and two windows.
     */
    void OpenWindowClick()
    {
        DateTime now = DateTime.UtcNow;
        if ((now - lastOpenClick).TotalMilliseconds < SystemInformation.DoubleClickTime + 300) return;
        lastOpenClick = now;
        OpenWindow();
    }

    /** Show the window, through the launcher script (Launcher.StartHidden). */
    void OpenWindow()
    {
        Launcher.StartHidden(node, script, root, passthrough, null);
    }

    /**
     * Stop the app. Closing the child's standard input is the ask; the server
     * checkpoints its WAL and exits, the next pulse sees that and ends this
     * program. The wait is bounded because a shutdown that hangs must not leave
     * a menu item that appears to do nothing — after it, the process tree goes
     * the hard way, which SQLite's write-ahead log is designed to survive.
     */
    void Quit()
    {
        if (quitting) return;
        quitting = true;
        try
        {
            if (server != null && !server.HasExited)
            {
                try { server.StandardInput.Close(); } catch (Exception) { }
                if (!server.WaitForExit(8000))
                {
                    try { server.Kill(); } catch (Exception) { }
                }
            }
        }
        catch (Exception) { }
        ExitNow();
    }

    void ExitNow()
    {
        if (pulse != null) pulse.Stop();
        // Hide before dispose: an icon whose owner has gone lingers in the
        // notification area until the pointer happens to pass over it.
        try { tray.Visible = false; } catch (Exception) { }
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (pulse != null) pulse.Dispose();
            if (tray != null) tray.Dispose();
            if (showSignal != null) showSignal.Close();
        }
        base.Dispose(disposing);
    }
}
