# 由计划任务调用的包装脚本：隐藏窗口启动代理，并保持前台等待
# 这样任务计划会认为它一直在跑，崩了还能按设置自动重启。
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    Write-EventLog -LogName Application -Source 'zen-claude-relay' -EventId 1 -EntryType Error `
        -Message 'zen-claude-relay: 找不到 node，无法启动代理。' -ErrorAction SilentlyContinue
    exit 1
}

Start-Process -FilePath $node `
    -ArgumentList "`"$dir\proxy.mjs`"" `
    -WorkingDirectory $dir `
    -WindowStyle Hidden `
    -Wait
