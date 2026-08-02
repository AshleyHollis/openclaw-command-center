$ErrorActionPreference = 'Stop'
$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $prototypeRoot
python -m http.server 4174
