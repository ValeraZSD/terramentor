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
using System;
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

        Application.EnableVisualStyles();
        TrayApp app = new TrayApp(root, node, script, key, args);
        if (!app.Started)
        {
            app.Dispose();
            return 1;
        }
        Application.Run(app);
        GC.KeepAlive(single);   // the mutex must outlive the message loop
        return 0;
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
    readonly NotifyIcon tray;
    readonly EventWaitHandle showSignal;
    readonly System.Windows.Forms.Timer pulse;
    const string FATAL = "TERRAMENTOR_FATAL ";
    Process server;
    volatile bool serverSaysBackground;
    volatile string fatalMessage;
    bool announced, quitting;

    /** Whether a server process was SPAWNED — not whether it is still alive. One
     *  that starts and then fails has a reason to report, and reporting it is the
     *  pulse's job; treating that as "never started" would exit before the
     *  message arrived down the pipe. */
    public bool Started { get { return server != null; } }

    public TrayApp(string root, string node, string script, string key, string[] passthrough)
    {
        this.root = root;
        this.node = node;
        this.script = script;
        this.key = key;
        this.passthrough = passthrough;

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
        // Left double-click is the Windows convention for "show me the window".
        tray.DoubleClick += delegate { OpenWindow(); };
        tray.BalloonTipClicked += delegate { OpenWindow(); };
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
        string quoted = "\"" + script + "\"";
        for (int i = 0; i < passthrough.Length; i++) quoted += " \"" + passthrough[i].Replace("\"", "\\\"") + "\"";

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
     * Show the window. The running server is found by the launcher script
     * itself, which knows the data directory, probes the ports it could be on
     * and opens a window at the one that answers — so this program never has to
     * learn a port. Hidden and detached: it exits as soon as the window is up.
     */
    void OpenWindow()
    {
        string quoted = "\"" + script + "\"";
        for (int i = 0; i < passthrough.Length; i++)
        {
            // --autostart describes how the APP started, not this request. A
            // person clicking "Open" is asking for a window whatever the
            // sign-in preference says.
            if (passthrough[i] == "--autostart") continue;
            quoted += " \"" + passthrough[i].Replace("\"", "\\\"") + "\"";
        }
        ProcessStartInfo psi = new ProcessStartInfo(node, quoted);
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        try { Process.Start(psi); }
        catch (Exception) { /* the tray icon is still there to try again */ }
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
