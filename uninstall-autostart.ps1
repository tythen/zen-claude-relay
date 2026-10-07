# uninstall-autostart.ps1 — 移除 zen-claude-relay 的开机自启
#
#   powershell -ExecutionPolicy Bypass -File uninstall-autostart.ps1

$ErrorActionPreference = 'Stop'
$TaskName = 'zen-claude-relay'

Write-Host ""
Write-Host "  zen-claude-relay 开机自启卸载" -ForegroundColor Cyan
Write-Host "  ─────────────────────────────────────────"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Host "  [!] 没有找到名为 $TaskName 的计划任务，无需卸载。" -ForegroundColor Yellow
    Write-Host ""
    exit 0
}

try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  [OK] 计划任务已移除" -ForegroundColor Green
} catch {
    Write-Host "  [X] 移除失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "      试试用管理员身份运行。" -ForegroundColor Yellow
    exit 1
}

# 顺手把残留的代理进程也停掉
$conns = netstat -ano | Select-String ":8788\s+0\.0\.0\.0:0\s+LISTENING"
if ($conns) {
    $procId = ($conns -split '\s+')[-1]
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Host "  [OK] 已停掉占用 8788 端口的进程 (PID $procId)" -ForegroundColor Green
    } catch {
        Write-Host "  [!] 端口 8788 仍被 PID $procId 占用，可手动结束。" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "  注意：OpenCode 的 opencode.json 没有被改动，" -ForegroundColor Yellow
Write-Host "  exo-free 仍会尝试连 127.0.0.1:8788。如果你彻底不用了，" -ForegroundColor Yellow
Write-Host "  记得把那里的 baseURL 删掉，否则会报 ConnectionRefused。" -ForegroundColor Yellow
Write-Host ""
