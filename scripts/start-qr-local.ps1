$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $repoRoot 'data\qr-local-runtime'
$statePath = Join-Path $runtimeDirectory 'processes.json'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodeExecutable)) { throw 'Instale Node.js 24 para iniciar este ambiente.' }
& $nodeExecutable (Join-Path $repoRoot 'scripts\setup-qr-local.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível preparar o ambiente local.' }
$existing = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
$services = @(
  @{ Name='central'; Port=3187; Folder='vercel-app'; Script='scripts\local-server.mjs' },
  @{ Name='whatsapp'; Port=3100; Folder='whatsapp-qr-gateway'; Script='server.mjs' }
)
$processes = @()
foreach ($service in $services) {
  $workingDirectory = Join-Path $repoRoot $service.Folder
  $scriptPath = Join-Path $workingDirectory $service.Script
  $environmentPath = Join-Path $workingDirectory '.env.qr-local'
  $listener = Get-NetTCPConnection -State Listen -LocalPort $service.Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $record = $existing | Where-Object { $_.Name -eq $service.Name -and $_.Pid -eq $listener.OwningProcess } | Select-Object -First 1
    $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if (-not $record -or -not $running -or -not $running.CommandLine.Contains($scriptPath)) { throw "A porta $($service.Port) já está em uso por outro processo. Nada foi encerrado." }
    $processes += $record
    continue
  }
  $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $environmentPath /inheritance:r /grant:r "${owner}:(F)" 'SYSTEM:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Não foi possível restringir o arquivo de configuração local.' }
  $process = Start-Process -FilePath $nodeExecutable -ArgumentList @("`"--env-file=$environmentPath`"", "`"$scriptPath`"") -WorkingDirectory $workingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory ($service.Name+'.log')) -RedirectStandardError (Join-Path $runtimeDirectory ($service.Name+'-error.log')) -PassThru
  $processes += [pscustomobject]@{ Name=$service.Name; Pid=$process.Id; Port=$service.Port; Script=$scriptPath }
  $processes | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
}
$processes | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
foreach ($service in $services) {
  $healthy = $false
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    try { $result = Invoke-RestMethod -Uri "http://127.0.0.1:$($service.Port)/health" -TimeoutSec 2; if ($result.ok) { $healthy=$true; break } } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) { throw "O serviço $($service.Name) não respondeu. Confira os logs em data\qr-local-runtime." }
}
Write-Output 'Central local: http://127.0.0.1:3187'
Write-Output 'Serviço WhatsApp QR: http://127.0.0.1:3100/health'
Write-Output 'Ambiente de teste independente da produção. Os processos continuam ativos em segundo plano.'
