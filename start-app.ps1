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

# Check if ChromaDB is already running on port 8000 (supports v2 and v1 heartbeat)
$chromaRunning = $false
foreach ($hbPath in @("/api/v2/heartbeat", "/api/v1/heartbeat")) {
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:8000$hbPath" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp) { $chromaRunning = $true; break }
    } catch {}
}

if ($chromaRunning) {
    $hostPort = 8000
    Write-Host "ChromaDB is already active on port $hostPort."
} else {
    $hostPort = Get-AvailablePort 8000
}

$appPort = Get-AvailablePort 3000

Write-Host "Service Ports: ChromaDB=$hostPort, Next.js=$appPort"
$env:CHROMA_URL = "http://localhost:$hostPort"

if (!$chromaRunning) {
    Write-Host "Starting ChromaDB..."
    $chromaProc = $null
    if (Get-Command uv -ErrorAction SilentlyContinue) {
        $chromaProc = Start-Process uv -ArgumentList "run --python 3.11 --with chromadb==0.6.3 chroma run --host localhost --port $hostPort --path ./chroma_data" -WindowStyle Hidden -PassThru
    } elseif (Get-Command chroma -ErrorAction SilentlyContinue) {
        $chromaProc = Start-Process chroma -ArgumentList "run --host localhost --port $hostPort --path ./chroma_data" -WindowStyle Hidden -PassThru
    } else {
        Write-Host "Error: Neither uv nor chroma command found"
        exit
    }

    Write-Host "Waiting for ChromaDB..."
    $maxRetries = 15
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
        Write-Host "Error: ChromaDB failed to start"
        if ($chromaProc) { Stop-Process -Id $chromaProc.Id -ErrorAction SilentlyContinue }
        exit
    }
}

Write-Host "Starting Next.js..."
Start-Process "http://localhost:$appPort"
npm run dev -- --port $appPort
