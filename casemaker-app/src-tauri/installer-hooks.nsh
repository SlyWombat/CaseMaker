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
; rule for the chosen port (requires elevation; the Tauri installer already
; runs elevated).

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
  ; Best-effort firewall cleanup: drop any rule we may have added. The rule
  ; name encodes the port; remove for the default and the most common
  ; user-chosen port. (Multi-port cleanup is a follow-up.)
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Case Maker (TCP 8000)"'
  Pop $0
!macroend
