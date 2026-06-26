function Get-AvailablePort($startPort) {
    $port = $startPort
    while ($true) {
        $connection = Test-NetConnection -ComputerName localhost -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
        if (!$connection) {
            return $port
        }
        $port++
    }
}

$hostPort = Get-AvailablePort 8000
$appPort = Get-AvailablePort 3000

Write-Host "Service Ports: ChromaDB=$hostPort, Next.js=$appPort"
Write-Host "Starting services..."

if (!(Get-Command chroma -ErrorAction SilentlyContinue)) {
    Write-Host "Error: chroma not found"
    exit
}

$chromaProc = Start-Process chroma -ArgumentList "run --host localhost --port $hostPort --path ./chroma_data" -WindowStyle Hidden -PassThru

Write-Host "Waiting for ChromaDB..."
$maxRetries = 10
$retryCount = 0
while ($retryCount -lt $maxRetries) {
    try {
        $conn = Test-NetConnection -ComputerName localhost -Port $hostPort -InformationLevel Quiet -WarningAction SilentlyContinue
        if ($conn) { break }
    } catch {}
    Start-Sleep -Seconds 1
    $retryCount++
}

if ($retryCount -eq $maxRetries) {
    Write-Host "Error: ChromaDB failed"
    Stop-Process -Id $chromaProc.Id
    exit
}

Write-Host "Starting Next.js..."
Start-Process "http://localhost:$appPort"
npm run dev -- --port $appPort
