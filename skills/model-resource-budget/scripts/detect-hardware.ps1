# 宿主机硬件检测脚本 (Windows)
# 自动检测 GPU 显存、CPU 核心、可用内存
# 输出 JSON 格式供 AI Agent 做资源预算决策

param(
    [switch]$Json   # 输出 JSON 格式
)

$result = @{
    gpu = @{}
    cpu = @{}
    memory = @{}
    summary = @{}
}

# ======== GPU 检测 ========
$gpuInfo = Get-WmiObject Win32_VideoController | Where-Object { $_.Name -match "NVIDIA|AMD|Intel.*Graphics|Radeon|GeForce|RTX|GTX" }

if ($gpuInfo) {
    $gpu = $gpuInfo | Select-Object -First 1
    $result.gpu.name = $gpu.Name
    $result.gpu.driverVersion = $gpu.DriverVersion
    
    # 显存总量（字节转GB）
    if ($gpu.AdapterRAM) {
        $vramBytes = $gpu.AdapterRAM
        $vramGB = [math]::Round($vramBytes / 1GB, 1)
        $result.gpu.vramGB = $vramGB
    }
    
    # 尝试通过 nvidia-smi 获取更精确的显存使用情况
    $nvidiaSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $smiOutput = & nvidia-smi --query-gpu=memory.total,memory.used,memory.free,utilization.gpu,name --format=csv,noheader,nounits 2>$null
            if ($smiOutput) {
                $parts = $smiOutput -split ','
                $result.gpu.vramTotalMB = [int][math]::Round([double]$parts[0])
                $result.gpu.vramUsedMB = [int][math]::Round([double]$parts[1])
                $result.gpu.vramFreeMB = [int][math]::Round([double]$parts[2])
                $result.gpu.utilization = [double]$parts[3]
                $result.gpu.nameDetailed = $parts[4].Trim()
                
                # 推荐最大可本地加载的模型参数规模（B）
                $vramTotal = $result.gpu.vramTotalMB
                if ($vramTotal -ge 22000) { $result.gpu.recommendedModelSize = "≤70B" }
                elseif ($vramTotal -ge 10000) { $result.gpu.recommendedModelSize = "≤8B" }
                elseif ($vramTotal -ge 5000) { $result.gpu.recommendedModelSize = "≤3B" }
                elseif ($vramTotal -ge 3000) { $result.gpu.recommendedModelSize = "≤1.5B" }
                else { $result.gpu.recommendedModelSize = "≤0.5B 或纯 CPU" }
            }
        } catch {
            $result.gpu.nvidiaSmiError = $_.Exception.Message
        }
    }
}

# ======== CPU 检测 ========
$cpu = Get-WmiObject Win32_Processor | Select-Object -First 1
if ($cpu) {
    $result.cpu.name = $cpu.Name.Trim()
    $result.cpu.cores = $cpu.NumberOfCores
    $result.cpu.logicalProcessors = $cpu.NumberOfLogicalProcessors
    $result.cpu.maxClockGHz = [math]::Round($cpu.MaxClockSpeed / 1000, 2)
}

# ======== 内存检测 ========
$os = Get-WmiObject Win32_OperatingSystem
if ($os) {
    $totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $result.memory.totalGB = $totalGB
    $result.memory.freeGB = $freeGB
    $result.memory.usedPercent = [math]::Round(($totalGB - $freeGB) / $totalGB * 100, 1)
}

# ======== 综合评估 ========

# GPU 可用性评估
if ($result.gpu.vramTotalMB -and $result.gpu.vramTotalMB -gt 0) {
    $result.summary.hasGPU = $true
    $result.summary.gpuCapable = ($result.gpu.vramTotalMB -ge 3000)
    
    # 内存够不够
    if ($result.memory.freeGB -ge 4) {
        $result.summary.memorySufficient = $true
    } else {
        $result.summary.memorySufficient = $false
        $result.summary.warnings = @("可用内存仅 $($result.memory.freeGB)GB，建议关闭不必要的程序再跑本地模型")
    }
} else {
    $result.summary.hasGPU = $false
    $result.summary.gpuCapable = $false
    $result.summary.warnings = @("未检测到独立 GPU，只能 CPU 推理")
}

# 最终建议
if ($result.summary.gpuCapable -and $result.summary.memorySufficient) {
    $result.summary.recommendation = "可运行本地模型（建议 ≤ $($result.gpu.recommendedModelSize)）"
} else {
    $result.summary.recommendation = "建议全部走云端 API，本地模型体验极差"
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
} else {
    Write-Output "===== 宿主机硬件检测报告 ====="
    Write-Output ""
    Write-Output "--- GPU ---"
    Write-Output "型号: $($result.gpu.name)"
    if ($result.gpu.vramTotalMB) { Write-Output "显存: $($result.gpu.vramTotalMB) MB (已用 $($result.gpu.vramUsedMB) MB, 空闲 $($result.gpu.vramFreeMB) MB)" }
    if ($result.gpu.utilization) { Write-Output "占用率: $($result.gpu.utilization)%" }
    if ($result.gpu.recommendedModelSize) { Write-Output "推荐模型规模: $($result.gpu.recommendedModelSize)" }
    Write-Output ""
    Write-Output "--- CPU ---"
    Write-Output "型号: $($result.cpu.name)"
    Write-Output "核心数: $($result.cpu.cores) 物理 / $($result.cpu.logicalProcessors) 逻辑"
    Write-Output "主频: $($result.cpu.maxClockGHz) GHz"
    Write-Output ""
    Write-Output "--- 内存 ---"
    Write-Output "总量: $($result.memory.totalGB) GB"
    Write-Output "可用: $($result.memory.freeGB) GB"
    Write-Output ""
    Write-Output "--- 综合评估 ---"
    Write-Output "建议: $($result.summary.recommendation)"
    if ($result.summary.warnings) {
        Write-Output "⚠️ 警告:"
        $result.summary.warnings | ForEach-Object { Write-Output "   - $_" }
    }
}
