@echo off
rem 启动 zen-claude-relay
cd /d "%~dp0"
title zen-claude-relay (exo-free -> Claude only)
node proxy.mjs %*
echo.
echo 代理已退出。按任意键关闭窗口。
pause >nul
