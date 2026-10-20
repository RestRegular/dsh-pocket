# dsh-pocket keep-awake helper (Windows).
#
# Holds an execution-state assertion on the main thread so the system (and,
# by default, the display) never idle-sleeps. The assertion belongs to this
# thread; the process simply stays alive until the parent DSH process exits
# or Node terminates it.
#
# stdout contract: exactly "awake" once the assertion is applied, or
# "error:<message>" when it cannot be applied. Anything else is diagnostic.

param(
  [int]$ParentPid = 0,
  [ValidateSet('all', 'system')][string]$Mode = 'all'
)

$ErrorActionPreference = 'Stop'

try {
  Add-Type -Namespace DSHPocket -Name ExecutionState -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
} catch {
  Write-Output ("error:Add-Type failed: " + $_.Exception.Message)
  exit 1
}

# ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2
$continuous = [uint32]2147483648
$flags = [uint32]2147483649
if ($Mode -eq 'all') { $flags = [uint32]2147483651 }

$applied = [DSHPocket.ExecutionState]::SetThreadExecutionState($flags)
if ($applied -eq 0) {
  $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output ("error:SetThreadExecutionState failed (Win32 " + $code + ")")
  exit 1
}

Write-Output 'awake'

while ($true) {
  Start-Sleep -Seconds 30
  if ($ParentPid -gt 0 -and $null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    break
  }
  # Re-assert after power events / resume; cheap and idempotent.
  [void][DSHPocket.ExecutionState]::SetThreadExecutionState($flags)
}

[void][DSHPocket.ExecutionState]::SetThreadExecutionState($continuous)
