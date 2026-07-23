#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Compiles every TypeSpec example, then builds each generated client package to
    verify the emitter produces output that type-checks and compiles.

.DESCRIPTION
    Phase 0 — builds this emitter (dist/) so the file:-linked examples exercise the
              current source rather than a stale install.
    Phase 1 — for each directory under example/, runs `npm install` and compiles
              every tspconfig*.yaml it finds (e.g. tspconfig.yaml and
              tspconfig.all-versions.yaml) via `tsp compile`.
    Phase 2 — for every generated package (each package.json under an example's
              tsp-output/, excluding node_modules) runs `npm install` and
              `npm run build` (tsc) to confirm the generated client compiles.

    Examples, their config files, and their generated packages are all discovered
    dynamically — no example-specific logic lives here. Exits non-zero if any step
    fails, printing a summary of every step at the end.

.EXAMPLE
    ./build-examples.ps1
#>

$ErrorActionPreference = "Stop"
$repoRoot = $PSScriptRoot
$exampleRoot = Join-Path $repoRoot "example"

# Collected results: one row per step for the final summary.
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result {
    param([string]$Phase, [string]$Name, [string]$Status, [string]$Detail = "")
    $results.Add([pscustomobject]@{
            Phase  = $Phase
            Name   = $Name
            Status = $Status
            Detail = $Detail
        })
}

# Runs a native executable in $WorkingDir and throws if it exits non-zero
# (native commands set $LASTEXITCODE rather than throwing on their own).
function Invoke-Native {
    param(
        [Parameter(Mandatory)][string]$WorkingDir,
        [Parameter(Mandatory)][string]$Exe,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    Push-Location $WorkingDir
    try {
        & $Exe @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "'$Exe $($Arguments -join ' ')' exited with code $LASTEXITCODE (in $WorkingDir)"
        }
    }
    finally {
        Pop-Location
    }
}

# Runs one labeled step, recording pass/fail and continuing so the summary is complete.
function Invoke-Step {
    param(
        [string]$Phase,
        [string]$Name,
        [scriptblock]$Action
    )
    Write-Host ""
    Write-Host ">> [$Phase] $Name" -ForegroundColor Cyan
    try {
        & $Action
        Add-Result $Phase $Name "OK"
    }
    catch {
        Write-Host "   FAILED: $($_.Exception.Message)" -ForegroundColor Red
        Add-Result $Phase $Name "FAIL" $_.Exception.Message
    }
}

if (-not (Test-Path $exampleRoot)) {
    Write-Error "No example/ directory found at $exampleRoot"
    exit 1
}

Write-Host "TypeSpec example build harness" -ForegroundColor Green
Write-Host "Repo root: $repoRoot"

# ── Phase 0: build the emitter so examples link to current output ──────────────
Invoke-Step "emitter" "npm install && npm run build" {
    Invoke-Native $repoRoot "npm" @("install", "--no-audit", "--no-fund")
    Invoke-Native $repoRoot "npm" @("run", "build")
}

# ── Phase 1: compile each TypeSpec example ─────────────────────────────────────
$examples = Get-ChildItem -Path $exampleRoot -Directory | Sort-Object Name
foreach ($example in $examples) {
    $configs = Get-ChildItem -Path $example.FullName -Filter "tspconfig*.yaml" -File |
        Sort-Object Name
    if ($configs.Count -eq 0) {
        Write-Host "   (skipping $($example.Name): no tspconfig*.yaml)" -ForegroundColor DarkYellow
        continue
    }

    Invoke-Step "compile" "$($example.Name): npm install" {
        Invoke-Native $example.FullName "npm" @("install", "--no-audit", "--no-fund")
    }

    foreach ($config in $configs) {
        Invoke-Step "compile" "$($example.Name): tsp compile ($($config.Name))" {
            Invoke-Native $example.FullName "npx" @("tsp", "compile", ".", "--config", $config.Name)
        }
    }
}

# ── Phase 2: build each generated client package ───────────────────────────────
$generatedPackages = foreach ($example in $examples) {
    $outputDir = Join-Path $example.FullName "tsp-output"
    if (-not (Test-Path $outputDir)) { continue }
    Get-ChildItem -Path $outputDir -Recurse -Filter "package.json" -File |
        Where-Object { $_.FullName -notmatch "[\\/]node_modules[\\/]" } |
        Where-Object { $_.FullName -notmatch "[\\/]dist[\\/]" }
}

if (-not $generatedPackages) {
    Write-Host ""
    Write-Host "No generated client packages found under any example/tsp-output/." -ForegroundColor DarkYellow
}

foreach ($pkg in $generatedPackages) {
    $pkgDir = $pkg.Directory.FullName
    $label = [System.IO.Path]::GetRelativePath($repoRoot, $pkgDir)
    Invoke-Step "build" "$label`: npm install && npm run build" {
        Invoke-Native $pkgDir "npm" @("install", "--no-audit", "--no-fund")
        Invoke-Native $pkgDir "npm" @("run", "build")
    }
}

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "──────────────────────────── Summary ────────────────────────────" -ForegroundColor Green
$results | Format-Table -AutoSize Phase, Status, Name | Out-Host

$failures = @($results | Where-Object Status -eq "FAIL")
if ($failures.Count -gt 0) {
    Write-Host "$($failures.Count) step(s) failed." -ForegroundColor Red
    exit 1
}

Write-Host "All $($results.Count) step(s) succeeded." -ForegroundColor Green
exit 0
