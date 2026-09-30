# Stop only THIS project's API server (pid recorded in data/server.json) and
# remove project-local runtime artifacts. Never touches unrelated processes.
$ErrorActionPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $root "data/server.json"

if (Test-Path $serverFile) {
  $info = Get-Content $serverFile -Raw | ConvertFrom-Json
  if ($info.pid) {
    $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -like "$root*") {
      Stop-Process -Id $info.pid -Force
      Write-Host "[clean] stopped project server pid $($info.pid)"
    }
  }
}

$artifacts = @(
  (Join-Path $root "data/app.sqlite"),
  (Join-Path $root "data/app.sqlite-wal"),
  (Join-Path $root "data/app.sqlite-shm"),
  (Join-Path $root "data/server.json"),
  (Join-Path $root "data/demo.sqlite"),
  (Join-Path $root "data/demo.sqlite-wal"),
  (Join-Path $root "data/demo.sqlite-shm"),
  (Join-Path $root "data/demo-distribution.csv")
)
foreach ($a in $artifacts) {
  if (Test-Path $a) { Remove-Item -LiteralPath $a -Force; Write-Host "[clean] removed $a" }
}
Write-Host "[clean] done"
