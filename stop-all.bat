@echo off
chcp 65001 >nul
title FatFish Bot 停止
echo 停止 qq-bridge ...
schtasks /end /tn "qq-bridge" >nul 2>&1
echo 停止 SnowLuma ...
schtasks /end /tn "SnowLuma" >nul 2>&1
echo.
echo 已请求停止。DSH 桌面版不会关闭（要关请手动退出）。
ping -n 4 127.0.0.1 >nul