; Case Maker NSIS installer hooks
;
; Adds support for /PORT=N and /HOST=IP command-line arguments so silent
; installs and unattended deployments can preconfigure the embedded HTTP
; server's listen socket without a GUI prompt, and opens the chosen port
; through Windows Firewall.
;
; Examples:
;     casemaker_setup.exe
;         -> port 8000, loopback only, no firewall rule
;     casemaker_setup.exe /PORT=9000
;         -> port 9000, loopback only, no firewall rule
;     casemaker_setup.exe /S /PORT=9000 /HOST=192.168.10.16
;         -> silent install, listen on 192.168.10.16:9000, firewall opened
;     casemaker_setup.exe /HOST=0.0.0.0
;         -> all interfaces, firewall opened
;
; The chosen port + host are written to %APPDATA%\casemaker\config.json
; before the first launch. The Rust HTTP server reads this file at startup.
; When /HOST is specified the installer also adds an inbound TCP firewall
; rule for the chosen port and records that port under the registry key
; "Software\Case Maker" (DWORD value "FirewallPort") so that uninstall can
; remove exactly that rule without parsing locale-sensitive netsh output.
; Adding a rule needs elevation; if netsh fails the hook logs it and
; continues (a per-machine Tauri install runs elevated, the default
; current-user install does not).

!include "FileFunc.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; Defaults
  StrCpy $0 "8000"     ; port
  StrCpy $2 ""         ; host (empty = loopback)

  ${GetParameters} $R0

  ; Parse /PORT=N
  ${GetOptions} $R0 "/PORT=" $R1
  ${If} ${Errors}
    ClearErrors
  ${Else}
    ${If} $R1 < 1024
      DetailPrint "Case Maker: invalid /PORT=$R1 (below 1024); falling back to 8000"
    ${ElseIf} $R1 > 65535
      DetailPrint "Case Maker: invalid /PORT=$R1 (above 65535); falling back to 8000"
    ${Else}
      StrCpy $0 $R1
    ${EndIf}
  ${EndIf}

  ; Parse /HOST=IP
  ${GetOptions} $R0 "/HOST=" $R3
  ${If} ${Errors}
    ClearErrors
  ${Else}
    StrCpy $2 $R3
  ${EndIf}

  ; Ensure %APPDATA%\casemaker exists
  CreateDirectory "$APPDATA\casemaker"

  ; Write config.json. host is null when empty (loopback default).
  FileOpen $1 "$APPDATA\casemaker\config.json" w
  FileWrite $1 "{$\r$\n"
  FileWrite $1 '  "port": $0,$\r$\n'
  ${If} $2 == ""
    FileWrite $1 '  "bind_to_all": false,$\r$\n'
    FileWrite $1 '  "host": null$\r$\n'
  ${Else}
    FileWrite $1 '  "bind_to_all": false,$\r$\n'
    FileWrite $1 '  "host": "$2"$\r$\n'
  ${EndIf}
  FileWrite $1 "}$\r$\n"
  FileClose $1

  DetailPrint "Case Maker: configured port $0 host=$2 in $APPDATA\casemaker\config.json"

  ; Open the firewall port iff the user asked for non-loopback access.
  ${If} $2 != ""
    ; Record the port so PREUNINSTALL can delete exactly this rule. Recorded
    ; only when we add a rule, so a plain loopback install records nothing and
    ; an update (which passes no /HOST) never overwrites a custom port with
    ; the default.
    WriteRegDWORD SHCTX "Software\Case Maker" "FirewallPort" $0
    DetailPrint "Case Maker: adding inbound firewall rule TCP $0 (Case Maker)"
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Case Maker (TCP $0)" dir=in action=allow protocol=TCP localport=$0'
    Pop $4
    ${If} $4 != "0"
      DetailPrint "Case Maker: firewall rule add returned exit code $4 (continuing)"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Leave config.json in place — preserves user settings across reinstalls.
  ;
  ; Best-effort firewall cleanup. The rule name encodes the port and netsh
  ; output is locale-sensitive, so rather than enumerating rules we read back
  ; the port recorded by POSTINSTALL ("Software\Case Maker" -> "FirewallPort")
  ; and delete exactly that rule. Older installs predate the record, and a
  ; default (loopback-only) install adds no rule and records nothing; in both
  ; cases the value is absent, so fall back to the default port's rule.
  ;
  ; Skipped during an update ($UpdateMode): the uninstaller also runs as part
  ; of every update, and the follow-up install only re-adds a rule when /HOST
  ; is passed, so deleting it here would silently drop firewall access.
  ${If} $UpdateMode <> 1
    ReadRegDWORD $0 SHCTX "Software\Case Maker" "FirewallPort"
    ${If} ${Errors}
      ClearErrors
      StrCpy $0 "8000"
    ${ElseIf} $0 < 1024
      StrCpy $0 "8000"
    ${ElseIf} $0 > 65535
      StrCpy $0 "8000"
    ${EndIf}

    DetailPrint "Case Maker: removing inbound firewall rule TCP $0 (Case Maker)"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Case Maker (TCP $0)"'
    Pop $1
    ${If} $1 != "0"
      DetailPrint "Case Maker: firewall rule delete returned exit code $1 (continuing)"
    ${EndIf}

    ; Forget the recorded port now that it has been used.
    DeleteRegValue SHCTX "Software\Case Maker" "FirewallPort"
    DeleteRegKey /ifempty SHCTX "Software\Case Maker"
  ${EndIf}
!macroend
