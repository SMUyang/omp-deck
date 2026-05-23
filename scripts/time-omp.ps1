$sw = [System.Diagnostics.Stopwatch]::StartNew()
$out = & omp -p "Say hi in one word."
$sw.Stop()
Write-Output ("elapsed: " + $sw.ElapsedMilliseconds + "ms")
Write-Output ("output length: " + ($out -join "`n").Length)
Write-Output ("output (first 200 chars):")
$joined = $out -join "`n"
$abbrev = if ($joined.Length -gt 200) { $joined.Substring(0,200) + "..." } else { $joined }
Write-Output $abbrev
