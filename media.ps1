# Bridge to Windows media sessions (SMTC). Prints JSON lines to stdout,
# reads commands (toggle / next / prev) from stdin. ASCII only: PS 5.1 reads
# scripts without BOM as ANSI.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [Type[]]@([Windows.Storage.Streams.IInputStream]))

# System volume through Core Audio.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float level, Guid context);
    int j();
    int GetMasterVolumeLevelScalar(out float level);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid context);
    int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
// Whether the foreground window covers its whole monitor (a game, a video, a
// slideshow). Coordinates are physical pixels; the island converts them.
public static class Fullscreen {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int max);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    static Fullscreen() { SetProcessDPIAware(); }
    public static RECT Monitor;
    public static bool Check() {
        IntPtr w = GetForegroundWindow();
        if (w == IntPtr.Zero) return false;
        var cls = new System.Text.StringBuilder(64);
        GetClassName(w, cls, 64);
        string c = cls.ToString();
        // the desktop and the taskbar also span the monitor
        if (c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd") return false;
        RECT r; if (!GetWindowRect(w, out r)) return false;
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfo(MonitorFromWindow(w, 2), ref mi)) return false;
        Monitor = mi.rcMonitor;
        // a maximized window's frame hangs 8px past the screen edge, so it would look full screen
        if (IsZoomed(w)) return false;
        return r.Left <= mi.rcMonitor.Left && r.Top <= mi.rcMonitor.Top && r.Right >= mi.rcMonitor.Right && r.Bottom >= mi.rcMonitor.Bottom;
    }
}
public static class Audio {
    static IAudioEndpointVolume Endpoint() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev; Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume epv; var id = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
        return epv;
    }
    public static float Volume {
        get { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
        set { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
    }
    public static bool Mute {
        get { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
        set { Marshal.ThrowExceptionForHR(Endpoint().SetMute(value, Guid.Empty)); }
    }
}
'@

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1

function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(5000)
    $task.Result
}

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

# What is audible wins: Yandex Music often plays in a browser tab, and Windows'
# "current" session can still point at a paused Telegram voice note or stream.
# Order: playing Yandex app, any playing session, the one played last, Yandex app, current.
$lastPlayingId = ''
function Get-Session($mgr) {
    $sessions = @($mgr.GetSessions())
    $playing = @($sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' })
    $yandex = @($sessions | Where-Object { $_.SourceAppUserModelId -match 'yandex|music' })
    $pick = @($playing | Where-Object { $_.SourceAppUserModelId -match 'yandex|music' })[0]
    if (-not $pick) { $pick = $playing[0] }
    if ($pick) { $script:lastPlayingId = $pick.SourceAppUserModelId; return $pick }
    $last = @($sessions | Where-Object { $_.SourceAppUserModelId -eq $script:lastPlayingId })[0]
    if ($last) { return $last }
    if ($yandex.Count) { return $yandex[0] }
    $mgr.GetCurrentSession()
}

function Get-Art($props) {
    try {
        if (-not $props.Thumbnail) { return $null }
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        # The stream comes back as a bare COM object; invoking through reflection does the interface cast.
        $net = $asStream.Invoke($null, @($stream))
        $ms = New-Object IO.MemoryStream
        $net.CopyTo($ms)
        if ($ms.Length -eq 0) { return $null }
        [Convert]::ToBase64String($ms.ToArray())
    } catch { $null }
}

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# Console.In.ReadLineAsync is synchronous in .NET Framework and froze the loop
# until the island sent a command; a StreamReader over the raw stdin stream
# reads on a pool thread instead.
$stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$stdin = $stdinReader.ReadLineAsync()
$lastState = ''
$lastVol = ''
$lastFs = ''
$artKey = ''
$artTries = 0

$parentPid = [int]$args[0]
$tick = 0
while ($true) {
    # Exit with the island even if it was killed without closing our stdin.
    if ($parentPid -and ($tick++ % 20 -eq 0) -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
    $session = $null
    try { $session = Get-Session $mgr } catch {}

    if ($stdin.Wait(300)) {
        $cmd = $stdin.Result
        if ($null -eq $cmd) { break }
        try {
            if ($cmd -match '^vol ([\d.]+)$') { [Audio]::Volume = [math]::Min(1, [math]::Max(0, [float]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture))); [Audio]::Mute = $false }
            elseif ($cmd.Trim() -eq 'mute') { [Audio]::Mute = -not [Audio]::Mute }
        } catch {}
        if ($session) {
            try {
                switch ($cmd.Trim()) {
                    'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
                    'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
                    'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
                }
            } catch {}
        }
        $stdin = $stdinReader.ReadLineAsync()
    }

    try {
        $full = [Fullscreen]::Check()
        $m = [Fullscreen]::Monitor
        $fs = "{0}|{1},{2},{3},{4}" -f $full, $m.Left, $m.Top, $m.Right, $m.Bottom
        if ($fs -ne $lastFs) { $lastFs = $fs; Emit @{ type = 'fs'; full = $full; x = $m.Left; y = $m.Top; w = $m.Right - $m.Left; h = $m.Bottom - $m.Top } }
    } catch {}

    try {
        $vol = "{0}|{1}" -f [math]::Round([Audio]::Volume * 100), [Audio]::Mute
        if ($vol -ne $lastVol) { $lastVol = $vol; Emit @{ type = 'vol'; level = [int][math]::Round([Audio]::Volume * 100); muted = [Audio]::Mute } }
    } catch {}

    try {
        if (-not $session) {
            $state = @{ type = 'state'; has = $false }
        } else {
            $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $tl = $session.GetTimelineProperties()
            $key = "$($props.Title)|$($props.Artist)"
            $state = @{
                type    = 'state'
                has     = $true
                key     = $key
                app     = $session.SourceAppUserModelId
                title   = $props.Title
                artist  = $props.Artist
                playing = ($session.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
                pos     = [math]::Round($tl.Position.TotalSeconds, 1)
                dur     = [math]::Round(($tl.EndTime - $tl.StartTime).TotalSeconds, 1)
                updated = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
            }
            # Covers often arrive a moment after the title, so retry a few times.
            if ($key -ne $artKey) { $artKey = $key; $artTries = 6 }
            if ($artTries -gt 0) {
                $art = Get-Art $props
                if ($art) { Emit @{ type = 'art'; key = $key; data = $art }; $artTries = 0 }
                else { $artTries--; if ($artTries -eq 0) { Emit @{ type = 'art'; key = $key; data = $null } } }
            }
        }
        $json = $state | ConvertTo-Json -Compress
        if ($json -ne $lastState) { $lastState = $json; [Console]::Out.WriteLine($json); [Console]::Out.Flush() }
    } catch {}
}
