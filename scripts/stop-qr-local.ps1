$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $repoRoot 'data\qr-local-runtime\processes.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Nenhum processo de teste registrado.'; exit 0 }
$records = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
foreach ($record in $records) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.Pid)" -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($record.Script) -or -not $record.Script.StartsWith($repoRoot,[System.StringComparison]::OrdinalIgnoreCase)) { throw "O processo $($record.Pid) não corresponde ao serviço registrado. Não foi encerrado." }
  Stop-Process -Id $record.Pid
  Write-Output "Serviço $($record.Name) encerrado."
}
Write-Output 'Chaves, sessões vinculadas e banco local foram preservados para a próxima inicialização.'
