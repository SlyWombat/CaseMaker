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
; ON AN UPGRADE THE FILE IS LEFT ALONE unless /PORT or /HOST is passed (#403):
; every install runs this hook, and the file is the only copy of `host`, which
; no screen can restore. When /HOST is specified the installer also adds an
; inbound TCP firewall
; rule for the chosen port and records that port under the registry key
; "Software\Case Maker" (DWORD value "FirewallPort") so that uninstall can
; remove exactly that rule without parsing locale-sensitive netsh output.
; Adding a rule needs elevation; if netsh fails the hook logs it and
; continues (a per-machine Tauri install runs elevated, the default
; current-user install does not).

!include "FileFunc.nsh"

; ---------------------------------------------------------------------------------------------
; THE WELCOME PAGE'S WORDING (#403 gap 5).
;
; This file is included at installer.nsi:32 and Tauri's page list is not expanded until :165, so a
; define written here is already in place when `!insertmacro MUI_PAGE_WELCOME` runs. MUI takes it
; because every one of its own welcome strings arrives via `MUI_DEFAULT`, which only defines a
; symbol that is not defined yet — so these two override the stock "Welcome to the ... Setup
; Wizard" text without vendoring Tauri's template.
;
; THE PRODUCT AND VERSION CANNOT BE USED HERE. `${PRODUCTNAME}` and `${VERSION}` are defined at
; installer.nsi:36-41, four lines *after* this include, so interpolating them would put an empty
; string on the page. The name is spelled out instead; the version is left off, which also means
; this wording does not need editing at every release.
;
; The text says what the app actually does in a user's hands — it designs enclosures and it drives
; the Makera Z1 — rather than only the first half, which is what an "enclosure designer" line alone
; would have said (#403). Paragraph breaks are `$\r$\n`; the control wraps the rest itself, so
; there are no hand-placed line breaks to go ragged at another font size.
!ifndef MUI_WELCOMEPAGE_TITLE
  !define MUI_WELCOMEPAGE_TITLE "Welcome to the Case Maker Setup Wizard"
!endif
!ifndef MUI_WELCOMEPAGE_TEXT
  !define MUI_WELCOMEPAGE_TEXT "Case Maker designs 3D-printable enclosures for microcontrollers and single-board computers: pick a board, place its mounting points, and export STL or 3MF for your slicer. It also drives the Makera Z1 desktop CNC for engraving, so a project can be cut as well as printed.$\r$\n$\r$\nThis wizard will install Case Maker on your computer.$\r$\n$\r$\nClick Next to continue, or Cancel to exit Setup."
!endif

; Where the settings live, as a compile-time define so a harness can point the hook at a scratch
; directory (`nsis-harness.nsi` defines it before including this file; the real installer never
; defines it, so it gets the real location). The reason is the one `config::save_to` gives for
; taking its path as a parameter: this hook writes `host`, which nothing can restore, so a harness
; that ran against the user's own config.json would rewrite the settings of whichever machine built
; the installer.
!ifndef CM_CONFIG_DIR
  !define CM_CONFIG_DIR "$APPDATA\casemaker"
!endif

!macro NSIS_HOOK_POSTINSTALL
  ; Defaults
  StrCpy $0 "8000"     ; port
  StrCpy $2 ""         ; host (empty = loopback)
  StrCpy $5 "0"        ; was /PORT= given?
  StrCpy $6 "0"        ; was /HOST= given?

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
      StrCpy $5 "1"
    ${EndIf}
  ${EndIf}

  ; Parse /HOST=IP
  ${GetOptions} $R0 "/HOST=" $R3
  ${If} ${Errors}
    ClearErrors
  ${Else}
    StrCpy $2 $R3
    StrCpy $6 "1"
  ${EndIf}

  ; WRITE THE SETTINGS ONLY WHEN THERE IS NOTHING TO KEEP (#403 gap 1).
  ;
  ; This hook runs on EVERY install, upgrades included, and config.json is the only copy the app
  ; has of `port` and `host` — `host` in particular is on no screen, so a rewrite is
  ; unrecoverable. Until #403 the open was unconditional, so an upgrade put the defaults back and a
  ; machine set to a custom port silently returned to 8000 on the next release, while the uninstall
  ; hook's own comment claimed the settings were preserved across reinstalls.
  ;
  ; So: write when the file is ABSENT (a first install), and write when the operator PASSED /PORT
  ; or /HOST (an explicit instruction — that is what the switches are for). Otherwise leave the
  ; file exactly as it is. A switch rewrites the whole document rather than merging one field into
  ; it, so pass BOTH to pin both values.
  ;
  ; THE WRITE HAPPENS IN THE CURRENT-USER SHELL CONTEXT, whatever the install mode, because
  ; `${CM_CONFIG_DIR}` is `$APPDATA\casemaker` and `$APPDATA` follows `SetShellVarContext`
  ; (#403 gap 5). Tauri's own `SetContext` (utils.nsh) calls `SetShellVarContext all` for a
  ; perMachine install, and under `all` NSIS resolves `$APPDATA` to `C:\ProgramData` — a path this
  ; app never reads, because the Rust side asks `dirs::config_dir()` for the user's
  ; `%APPDATA%\casemaker\config.json`. Measured, not assumed: under `all`, `$APPDATA` and
  ; `$LOCALAPPDATA` both become `C:\ProgramData`, while `$PROFILE` is unchanged. Without the
  ; switch below, a perMachine install would configure a port that nothing reads and log it as if
  ; it had worked. `nsis-harness-ctx.nsi` is the case that fails when this line is removed.
  ;
  ; The context goes back to what the installer chose afterwards: code that follows in the section
  ; (start-menu and desktop shortcuts, and the uninstaller's shortcut removal) is context-dependent.
  ${If} ${FileExists} "${CM_CONFIG_DIR}\config.json"
  ${AndIf} $5 == "0"
  ${AndIf} $6 == "0"
    DetailPrint "Case Maker: keeping the existing settings in ${CM_CONFIG_DIR}\config.json (no /PORT or /HOST given)"
  ${Else}
    SetShellVarContext current
    CreateDirectory "${CM_CONFIG_DIR}"

    ; host is null when empty (loopback default).
    FileOpen $1 "${CM_CONFIG_DIR}\config.json" w
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

    DetailPrint "Case Maker: configured port $0 host=$2 in ${CM_CONFIG_DIR}\config.json"

    ; Put the context back. `INSTALLMODE` is defined by the generated installer script above this
    ; file's include, and read here at macro-insertion time — the same way Tauri's own `SetContext`
    ; macro reads it. The harness, which never defines it, takes the `current` branch.
    !if "${INSTALLMODE}" == "perMachine"
      SetShellVarContext all
    !else
      SetShellVarContext current
    !endif
  ${EndIf}

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

  ; DISCOVERY (#403 gap 3). The app BINDS UDP 3333 and waits for the machine's broadcast
  ; (`DISCOVERY_UDP_PORT`, src/platform/desktop/protocol.ts:19, bound by `machine_udp_listen` in
  ; src-tauri/src/machine.rs). That is inbound and is NOT a reply to anything the app sent, so
  ; Windows' stateful allowance does not cover it: without a rule the datagram is dropped before the
  ; app sees it — discovery looks like "no machine found" rather than like a blocked packet.
  ;
  ; Added on EVERY install, unlike the HTTP rule above: discovery is the machine panel's first act,
  ; and an operator cannot be made to answer a firewall prompt in the middle of setting a job up.
  ; The name carries no port, so a future port change replaces the rule rather than leaving the old
  ; one open beside it, and the delete-before-add makes a reinstall idempotent.
  ;
  ; Deleted by NAME only. The Lighting Arduino installer also clears `name=all program="<app>"` to
  ; sweep up rules Windows' own first-run prompt creates against the exe path; that would equally
  ; remove a rule the user added on purpose, and these named rules are all this app listens for, so
  ; it is not done here.
  ;
  ; An add needs elevation, and the default Tauri install mode is `currentUser` (see
  ; `bundle.windows.nsis.installMode`), so on a stock install netsh reports a failure and this
  ; continues — the same caveat the HTTP rule carries. The rule really lands only when the installer
  ; runs elevated (a per-machine install).
  DetailPrint "Case Maker: adding inbound firewall rule UDP 3333 (Case Maker Discovery)"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Case Maker Discovery"'
  Pop $4
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Case Maker Discovery" dir=in action=allow protocol=UDP localport=3333 description="Case Maker machine discovery (Z1 broadcast)"'
  Pop $4
  ${If} $4 != "0"
    DetailPrint "Case Maker: discovery firewall rule add returned exit code $4 (continuing; firewall rules need an elevated install)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Leave config.json in place — and since #403 the install that follows leaves it alone too, so
  ; the settings really do survive a reinstall: an upgrade passes no /PORT or /HOST, and
  ; POSTINSTALL writes only when the file is absent or a switch says otherwise.
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

    ; Discovery's rule carries no port, so it needs no record to find it again — delete it by name.
    ; Inside the same $UpdateMode guard: an update's uninstaller run is skipped, and the install
    ; that follows re-adds the rule, so deleting it here would only open a window with discovery
    ; blocked.
    DetailPrint "Case Maker: removing inbound firewall rule UDP 3333 (Case Maker Discovery)"
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Case Maker Discovery"'
    Pop $1
    ${If} $1 != "0"
      DetailPrint "Case Maker: discovery firewall rule delete returned exit code $1 (continuing)"
    ${EndIf}

    ; Forget the recorded port now that it has been used.
    DeleteRegValue SHCTX "Software\Case Maker" "FirewallPort"
    DeleteRegKey /ifempty SHCTX "Software\Case Maker"
  ${EndIf}
!macroend
