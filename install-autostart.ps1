# install-autostart.ps1 — 把 zen-claude-relay 注册成开机自动启动（Windows 计划任务）
#
# 用法（普通用户权限即可，不需要管理员）：
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#
# 卸载：
#   powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$ErrorActionPreference = 'Stop'

$TaskName = 'zen-claude-relay'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Wrapper = Join-Path $Dir 'autostart-run.ps1'

function Info($m) { Write-Host "  $m" }
function Ok($m) { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [X] $m" -ForegroundColor Red }

Write-Host ""
Write-Host "  zen-claude-relay 开机自启安装" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────"
Write-Host ""

# 前置检查
if (-not (Test-Path (Join-Path $Dir 'proxy.mjs'))) {
    Fail "找不到 proxy.mjs，请在仓库目录里运行这个脚本。"
    exit 1
}
if (-not (Test-Path (Join-Path $Dir 'config.json'))) {
    Warn "还没生成 config.json，建议先跑：node setup.mjs"
    Warn "仍然继续安装，但代理启动后会立即报配置缺失。"
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Fail "找不到 node。请先安装 Node 18+：https://nodejs.org"
    exit 1
}
Ok "node: $node"
Ok "目录: $Dir"

# 已经有实例在跑吗？有的话不要再拉一个，否则新实例会因端口被占而反复重启
$Port = 8788
if (Test-Path (Join-Path $Dir 'config.json')) {
    try { $Port = (Get-Content (Join-Path $Dir 'config.json') -Raw | ConvertFrom-Json).listen.port } catch { }
}
$alreadyRunning = $false
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/__relay/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $alreadyRunning = $true }
} catch { }

if ($alreadyRunning) {
    Warn "端口 $Port 上已经有一个代理在运行"
    Info "计划任务只会在你下次登录时接管，这次不会重复启动它。"
}

# 已存在就先删掉，保证幂等
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Info "检测到已有同名任务，先移除旧的…"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "旧任务已移除"
}

# 组装任务
$pwsh = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
if (-not $pwsh) { $pwsh = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" }

$action = New-ScheduledTaskAction `
    -Execute $pwsh `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Wrapper`"" `
    -WorkingDirectory $Dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'zen-claude-relay：让 OpenCode 的 exo-free 只落在 Claude 后端' | Out-Null
    Ok "计划任务已注册：$TaskName"
} catch {
    Fail "注册失败：$($_.Exception.Message)"
    Warn "如果提示权限不足，改用管理员身份运行本脚本。"
    exit 1
}

# 立即试跑一次，确认能起来
if ($alreadyRunning) {
    Info "跳过试跑（已在运行中）"
} else {
    Info "正在试跑一次…"
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
}

$ok = $false
for ($i = 0; $i -lt 10; $i++) {
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:8788/__relay/health' -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}

Write-Host ""
if ($ok) {
    Ok "代理已通过计划任务启动，监听 127.0.0.1:8788"
    Write-Host ""
    Info "以后每次登录 Windows 都会自动拉起，不用再手动开窗口。"
} else {
    Warn "任务已注册，但暂时探测不到 8788 端口。"
    Info "可能原因：端口被占、config.json 有问题。跑一下：node doctor.mjs"
}

Write-Host ""
Info "查看任务：  Get-ScheduledTask -TaskName $TaskName"
Info "手动启动：  Start-ScheduledTask -TaskName $TaskName"
Info "手动停止：  Stop-ScheduledTask -TaskName $TaskName"
Info "卸载自启：  powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1"
Write-Host ""
