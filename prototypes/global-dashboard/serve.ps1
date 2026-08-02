$ErrorActionPreference = 'Stop'

$prototypeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host 'Serving the throwaway Global Dashboard prototype at http://localhost:4173/?variant=A'
python -m http.server 4173 --directory $prototypeRoot
