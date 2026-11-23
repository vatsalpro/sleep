@echo off
REM Register Sleepwalker Native Host in Chrome Registry
set EXT_ID=%1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-native-host.ps1" -ExtensionId "%EXT_ID%"
