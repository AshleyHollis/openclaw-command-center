$ErrorActionPreference = 'Stop'

$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host 'Serving the throwaway Space lifecycle prototype at http://localhost:4175/?variant=A&scenario=create'
python -m http.server 4175 --directory $prototypeRoot
