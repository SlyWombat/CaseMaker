; The installer-hook harness (#403).
;
; `installer-hooks.nsh` is the only place Case Maker writes its own settings file, and nothing
; compiles or runs it outside a full `tauri build`. This does, for the part that can be wrong
; without a machine: it includes the REAL hook and inserts the REAL macro, so the logic under test
; is the shipped one, and makensis is the compiler the release uses.
;
; `nsis-harness.sh` builds this and runs the cases (a first install writes the defaults; an upgrade
; leaves a customised file alone — the #403 regression; a passed /PORT rewrites; a first install
; with /PORT uses it). It is not a substitute for the upgrade-in-place QA on a real install
; (#403 gap 6); it is what makes the fix checkable without cutting a release.
;
; CM_CONFIG_DIR is defined BEFORE the include so the hook writes to a scratch directory beside this
; file rather than to the builder's own %APPDATA%\casemaker. The `/HOST` flag is deliberately NOT
; exercised: the hook answers it by adding a firewall rule and recording the port under
; HKCU\Software\Case Maker, and a harness has no business touching the machine's firewall or a
; registry key a real install also uses. The /PORT flag shares the same guard.

!define CM_CONFIG_DIR "$EXEDIR\harness-config"
!define SHCTX HKCU

Name "Case Maker installer-hook harness"
OutFile "nsis-harness.exe"
InstallDir "$EXEDIR\harness-install"
RequestExecutionLevel user

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "installer-hooks.nsh"

Section
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
