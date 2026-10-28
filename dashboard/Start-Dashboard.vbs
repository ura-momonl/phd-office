Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
directory = fso.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """ & directory & "\Start-Dashboard.ps1"""
If WScript.Arguments.Count > 0 Then
    If WScript.Arguments(0) = "open" Then command = command & " -OpenDashboard"
End If
shell.Run command, 0, False
