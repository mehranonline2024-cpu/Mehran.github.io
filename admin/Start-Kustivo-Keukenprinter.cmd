@echo off
setlocal EnableExtensions DisableDelayedExpansion
title Kustivo - Keukenprintstation

rem Open only the Kustivo admin page in a separate Chrome print profile.
set "KUSTIVO_CHROME_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "KUSTIVO_CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined KUSTIVO_CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "KUSTIVO_CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined KUSTIVO_CHROME_EXE if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "KUSTIVO_CHROME_EXE=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not defined KUSTIVO_CHROME_EXE (
  echo Google Chrome is niet gevonden. Installeer Chrome op deze keuken-pc.
  pause
  exit /b 1
)
if not defined LOCALAPPDATA (
  echo De Windows-profielmap kan niet worden gevonden.
  pause
  exit /b 1
)

set "KUSTIVO_PRINT_PROFILE=%LOCALAPPDATA%\Kustivo\Keukenprintstation"
if not exist "%KUSTIVO_PRINT_PROFILE%\Default" mkdir "%KUSTIVO_PRINT_PROFILE%\Default"
if not exist "%KUSTIVO_PRINT_PROFILE%\Default" (
  echo De map voor het keukenprintstation kan niet worden gemaakt.
  pause
  exit /b 1
)
rem Seed only a new profile; never overwrite an existing browser profile.
rem This profile follows the default printer configured in Windows.
if not exist "%KUSTIVO_PRINT_PROFILE%\Default\Preferences" (
  > "%KUSTIVO_PRINT_PROFILE%\Default\Preferences" echo {"printing":{"use_system_default_printer":true}}
)

echo Kustivo wordt geopend voor automatisch keukenprinten.
echo Meld je aan en druk een testbon af. Bevestig dat die uit de keukenprinter kwam.
start "Kustivo Keukenprinter" "%KUSTIVO_CHROME_EXE%" --user-data-dir="%KUSTIVO_PRINT_PROFILE%" --kiosk-printing --no-first-run --no-default-browser-check --app="https://kustivo.be/admin/?printstation=1"
endlocal
