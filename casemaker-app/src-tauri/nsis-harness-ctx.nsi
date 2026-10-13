; The perMachine half of the hook's settings path (#403 gap 5).
;
; `installMode: perMachine` makes Tauri's own `SetContext` (utils.nsh) call
; `SetShellVarContext all` during `.onInit`, and under `all` NSIS resolves `$APPDATA` to
; `C:\ProgramData` rather than the user's roaming profile the app actually reads. So the question
; "where does the hook write config.json?" has a different answer per install mode, and only this
; compile asks the perMachine one.
;
; It includes the REAL hook and inserts the REAL macro, with `CM_CONFIG_DIR` left in its real shape
; (`$APPDATA\casemaker`) except for the last path segment — a scratch name, so the write cannot
; land on a real install's settings. `SetShellVarContext all` in the section below is what a
; perMachine install does before the hook runs; `INSTALLMODE` is defined so the hook's restore
; takes the same branch it would in the real script.
;
; `nsis-harness.sh` asserts three things about the run:
;   1. config.json appears under the USER's %APPDATA%, not under C:\ProgramData;
;   2. nothing appears under C:\ProgramData;
;   3. the context is put back (the file this section writes afterwards reads $APPDATA again and
;      must show C:\ProgramData again) — otherwise the shortcut code that follows the hook in a
;      real install would target the wrong profile.
; Remove the hook's `SetShellVarContext current` and (1) and (2) fail; remove its restore and (3)
; fails. Both were run.

!define CM_CONFIG_DIR "$APPDATA\casemaker-harness-ctx"
!define INSTALLMODE "perMachine"

Name "Case Maker installer-hook context harness"
OutFile "nsis-harness-ctx.exe"
InstallDir "$EXEDIR\harness-install"
RequestExecutionLevel user

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "installer-hooks.nsh"

Section
  ; What Tauri's SetContext does at .onInit for a perMachine install.
  SetShellVarContext all

  !insertmacro NSIS_HOOK_POSTINSTALL

  ; Read $APPDATA again, after the hook has run, to see which context it left behind.
  FileOpen $9 "$EXEDIR\ctx-after.txt" w
  FileWrite $9 "$APPDATA$\r$\n"
  FileClose $9
SectionEnd
