<#
.SYNOPSIS
  安装 Token 缓存系统 — 创建缓存目录 + 设置定时清理任务

.DESCRIPTION
  本脚本完成：
    1. 创建 data\cache\ 缓存目录（如不存在）
    2. 验证 token-cache.mjs 可用
    3. 注册 Windows 计划任务：每天凌晨 3:00 执行缓存清理（删除 7 天前过期数据）
    4. 记录安装日志

  使用方式：
    powershell -ExecutionPolicy Bypass -File install-token-cache.ps1

  注意：需以管理员身份运行以注册计划任务。
#>

$ErrorActionPreference = 'Stop'

# ---- 配置 ----
$Workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$CacheDir = Join-Path $Workspace "data\cache"
$ScriptPath = Join-Path $Workspace "token-cache.mjs"
$LogFile = Join-Path $Workspace "data\cache\install.log"

# ---- 日志函数 ----
function Write-Log {
  param([string]$Message, [string]$Level = "INFO")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$ts] [$Level] $Message"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line
}

Write-Log "=== Token 缓存系统 安装开始 ==="

# ---- 步骤 1: 创建缓存目录 ----
Write-Log "步骤 1/4: 创建缓存目录..."
if (-not (Test-Path $CacheDir)) {
  New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
  Write-Log "  已创建: $CacheDir" "OK"
} else {
  Write-Log "  已存在: $CacheDir" "OK"
}

# ---- 步骤 2: 验证脚本 ----
Write-Log "步骤 2/4: 验证 token-cache.mjs..."
if (-not (Test-Path $ScriptPath)) {
  Write-Log "  ❌ 未找到: $ScriptPath" "ERROR"
  exit 1
}
# 测试 --stats 命令（无缓存文件也不报错）
try {
  $testResult = node "$ScriptPath" --stats 2>&1
  Write-Log "  ✅ token-cache.mjs 验证通过" "OK"
} catch {
  Write-Log "  ❌ token-cache.mjs 运行失败: $_" "ERROR"
  exit 1
}

# ---- 步骤 3: 注册计划任务 ----
Write-Log "步骤 3/4: 注册计划任务（每天 03:00 清理缓存）..."

$TaskName = "OpenClaw-TokenCache-Cleanup"
$TaskDescription = "每天凌晨清理 OpenClaw Token 缓存（超过 7 天的记录）"

# 检查任务是否已存在
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask) {
  Write-Log "  计划任务已存在，正在更新..." "INFO"
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# 创建任务操作：node token-cache.mjs --clean 7
$Action = New-ScheduledTaskAction `
  -Execute "node.exe" `
  -Argument "`"$ScriptPath`" --clean 7" `
  -WorkingDirectory "$Workspace"

# 创建触发器：每天凌晨 3:00
$Trigger = New-ScheduledTaskTrigger -Daily -At "03:00"

# 设置任务用户（当前用户）
$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# 设置任务设置
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)

# 注册任务
try {
  Register-ScheduledTask -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description $TaskDescription `
    -Force | Out-Null
  Write-Log "  ✅ 计划任务已注册: $TaskName（每天 03:00）" "OK"
} catch {
  Write-Log "  ⚠️ 计划任务注册失败（可能需要管理员权限）: $_" "WARN"
  Write-Log "  ℹ️ 可以手动执行清理: node `"$ScriptPath`" --clean 7" "INFO"
}

# ---- 步骤 4: 写一条测试缓存 ----
Write-Log "步骤 4/4: 写入测试缓存..."
try {
  node "$ScriptPath" --save "_test_install" 100 50 "test" "安装验证"
  Write-Log "  ✅ 测试缓存写入成功" "OK"
  # 清除测试缓存
  node "$ScriptPath" --clean 0 2>$null
  Write-Log "  ✅ 测试缓存已清理" "OK"
} catch {
  Write-Log "  ⚠️ 测试缓存失败: $_" "WARN"
}

# ---- 汇总 ----
Write-Log "=== Token 缓存系统 安装完成 ==="
Write-Log "缓存目录: $CacheDir"
Write-Log "脚本路径: $ScriptPath"
Write-Log "日志文件: $LogFile"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗"
Write-Host "║     Token 缓存系统安装完成 ✅               ║"
Write-Host "╠══════════════════════════════════════════════╣"
Write-Host "║  缓存目录: data\cache\                      ║"
Write-Host "║  缓存脚本: token-cache.mjs                  ║"
Write-Host "║  清理计划: 每天 03:00（7 天过期）           ║"
Write-Host "╠══════════════════════════════════════════════╣"
Write-Host "║  手动清理:                                   ║"
Write-Host "║    node token-cache.mjs --clean 7            ║"
Write-Host "║  查看统计:                                   ║"
Write-Host "║    node token-cache.mjs --stats              ║"
Write-Host "║  加载缓存:                                   ║"
Write-Host "║    node token-cache.mjs --load <sessionKey>  ║"
Write-Host "╚══════════════════════════════════════════════╝"
