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
; file rather than to the builder's own %APPDATA%\casemaker.
;
; The `/HOST` flag is deliberately NOT exercised: the hook answers it by recording a port under
; HKCU\Software\Case Maker, a key a real install also uses, and a harness has no business writing
; it. The /PORT flag shares the same guard, so the branch that matters is still covered.
;
; The hook DOES call `netsh advfirewall` on every install — the discovery rule (#403 gap 3) — and
; the harness runs it too. That is safe here because the harness is not elevated, so netsh refuses
; and the hook continues as designed; `nsis-harness.sh` asserts the machine's rule list is
; byte-identical after the run rather than taking that on trust. If this harness is ever run from an
; elevated shell, stop: it would add a real firewall rule.

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
