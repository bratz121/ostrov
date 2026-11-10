# Reads Windows notifications (the ones in the notification centre) and prints
# JSON lines: {type:'add'} for each new one, {type:'gone'} when one is dismissed,
# {type:'status'} for the access state. ASCII only: PS 5.1 reads scripts as ANSI.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]

function Emit($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
    [Console]::Out.Flush()
}

$listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
$access = "$($listener.GetAccessStatus())"
Emit @{ type = 'status'; access = $access; toasts = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' -ErrorAction SilentlyContinue).ToastEnabled }
if ($access -ne 'Allowed') { exit 0 }

$seen = @{}
$first = $true
$parentPid = [int]$args[0]
while ($true) {
    # Exit with the island; nothing else would stop this loop.
    if ($parentPid -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
    try {
        $task =$asTask.MakeGenericMethod($listType).Invoke($null, @($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)))
        $null = $task.Wait(5000)
        $now = @{}
        foreach ($n in $task.Result) {
            $id = [string]$n.Id
            $now[$id] = $true
            if ($seen.ContainsKey($id)) { continue }
            $texts = @()
            try {
                $binding = $n.Notification.Visual.GetBinding('ToastGeneric')
                if ($binding) { $texts = @($binding.GetTextElements() | ForEach-Object { $_.Text } | Where-Object { $_ }) }
            } catch {}
            $app = ''; $aumid = ''
            try { $app = $n.AppInfo.DisplayInfo.DisplayName; $aumid = $n.AppInfo.AppUserModelId } catch {}
            Emit @{
                type    = 'add'
                id      = $id
                app     = $app
                aumid   = $aumid
                texts   = $texts
                at      = $n.CreationTime.ToUnixTimeMilliseconds()
                initial = $first
            }
        }
        foreach ($id in @($seen.Keys)) { if (-not $now.ContainsKey($id)) { Emit @{ type = 'gone'; id = $id } } }
        $seen = $now
        $first = $false
    } catch {}
    Start-Sleep -Milliseconds 1200
}
