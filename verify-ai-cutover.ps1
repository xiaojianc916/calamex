#requires -Version 5.1
<#
  verify-ai-cutover.ps1
  AI 编排切换后的本地验证脚本。
  做的事:
    1. git pull --ff-only(把 main 上的 sidecar-orchestrate.ts 等拉到本地)
    2. agent-sidecar: tsc 类型检查 + tsx 单测
    3. 根项目: pnpm tsc + pnpm test
  判定:每步打印 PASS/FAIL,末尾输出 JSON 汇总;任一步失败 exit 1。
  注意:既有的预存红(tavily 文案 / memory MCP / RequestInfo / eventSchemaVersion 等)
        属于历史问题,不是本次切换引入的,人工判读时请忽略。
#>

$ErrorActionPreference = 'Stop'

# 项目路径(按需修改)
$RepoRoot     = 'D:\com.xiaojianc\my_desktop_app'
$SidecarDir   = Join-Path $RepoRoot 'agent-sidecar'

# 收集每一步的结果
$results = New-Object System.Collections.Generic.List[object]

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$WorkDir,
        [Parameter(Mandatory = $true)][string]$Command
    )

    Write-Host ''
    Write-Host "=== [$Name] ===" -ForegroundColor Cyan
    Write-Host "    dir: $WorkDir"
    Write-Host "    cmd: $Command"

    $startedAt = Get-Date
    Push-Location $WorkDir
    try {
        # 用 cmd /c 跑,确保 pnpm / git 的退出码能拿到
        & cmd /c $Command
        $code = $LASTEXITCODE
    }
    catch {
        Write-Host "    异常: $($_.Exception.Message)" -ForegroundColor Yellow
        $code = 1
    }
    finally {
        Pop-Location
    }

    $durationSec = [math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
    $passed = ($code -eq 0)

    if ($passed) {
        Write-Host "    [$Name] PASS (${durationSec}s)" -ForegroundColor Green
    }
    else {
        Write-Host "    [$Name] FAIL (exit=$code, ${durationSec}s)" -ForegroundColor Red
    }

    $results.Add([pscustomobject]@{
        step        = $Name
        passed      = $passed
        exitCode    = $code
        durationSec = $durationSec
    })

    return $passed
}

Write-Host '开始验证 AI 编排切换...' -ForegroundColor White

# 1) 拉取 main(sidecar-orchestrate.ts 等)
Invoke-Step -Name 'git-pull' -WorkDir $RepoRoot `
    -Command 'git pull --ff-only' | Out-Null

# 2) sidecar 类型检查
Invoke-Step -Name 'sidecar-tsc' -WorkDir $SidecarDir `
    -Command 'pnpm exec tsc -p tsconfig.json --noEmit' | Out-Null

# 3) sidecar 单测
Invoke-Step -Name 'sidecar-test' -WorkDir $SidecarDir `
    -Command 'node --import tsx --test "src/**/*.spec.ts"' | Out-Null

# 4) 根项目类型检查
Invoke-Step -Name 'root-tsc' -WorkDir $RepoRoot `
    -Command 'pnpm tsc' | Out-Null

# 5) 根项目测试
Invoke-Step -Name 'root-test' -WorkDir $RepoRoot `
    -Command 'pnpm test' | Out-Null

# 汇总
Write-Host ''
Write-Host '=== 汇总 ===' -ForegroundColor Cyan
$summary = [pscustomobject]@{
    allPassed = -not ($results | Where-Object { -not $_.passed })
    steps     = $results
}
$summary | ConvertTo-Json -Depth 4 | Write-Host

if (-not $summary.allPassed) {
    Write-Host ''
    Write-Host '有步骤失败。请只关注 root-tsc 中【新增且指向 useAiAgentRun.ts / useAiAgentPlan.ts】的报错;' -ForegroundColor Yellow
    Write-Host '既有历史红与两个 .spec(待重写)的失败可忽略。' -ForegroundColor Yellow
    exit 1
}

Write-Host ''
Write-Host '全部通过。' -ForegroundColor Green
exit 0