' ============================================================
'  run-panel-x410.vbs
'  Launches workspace-panel.py on the Linux host and forwards
'  the GTK window to X410, with NO visible cmd/console window.
'
'  Double-click to run. Close the panel (or kill ssh) to stop.
'  Uses $SSH_CLIENT on the Linux side to auto-detect the
'  Windows IP, so this works with a dynamic IP.
' ============================================================

Dim linuxUser, linuxHost, panelPath, remoteCmd, sshCmd, shell

linuxUser = "cslog"
linuxHost = "10.1.0.10"
panelPath = "/home/cslog/ai-workflow/workspace-switcher/workspace-panel.py"

remoteCmd = "export DISPLAY=$(echo $SSH_CLIENT | awk '{print $1}'):0.0; " & _
            "export GDK_BACKEND=x11; " & _
            "export NO_AT_BRIDGE=1; " & _
            "setxkbmap -layout br -variant abnt2; " & _
            "python3 " & panelPath

sshCmd = "ssh -o ServerAliveInterval=30 " & linuxUser & "@" & linuxHost & _
         " """ & remoteCmd & """"

Set shell = CreateObject("WScript.Shell")
' Run hidden (0), do not wait for it to finish (False)
shell.Run sshCmd, 0, False
