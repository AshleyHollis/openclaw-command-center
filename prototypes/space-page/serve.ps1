param(
  [int]$Port = 4206
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $prototypeRoot

function Test-PrototypePort {
  param([int]$Candidate)

  $listener = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    $Candidate
  )

  try {
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    $listener.Stop()
  }
}

$selectedPort = $Port
while (-not (Test-PrototypePort -Candidate $selectedPort)) {
  $selectedPort += 1
}

Write-Host "Space Page prototype: http://localhost:$selectedPort/?variant=A"
python -m http.server $selectedPort --bind 127.0.0.1
