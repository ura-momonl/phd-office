$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = [Console]::In.ReadToEnd()
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$edits = @()
$reads = 0
$setupOffset = 0
if ($ast.ParamBlock) { $setupOffset = $ast.ParamBlock.Extent.EndOffset }
foreach ($statement in $ast.UsingStatements) { $setupOffset = [Math]::Max($setupOffset, $statement.Extent.EndOffset) }
foreach ($command in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    $name = $command.GetCommandName()
    if ($null -eq $name) { continue }
    $name = ($name -split '\\')[-1]
    if ($name -notin @('Get-Content', 'gc', 'cat', 'type')) { continue }
    $reads++
    $explicit = @($command.CommandElements | Where-Object {
        ($_ -is [System.Management.Automation.Language.CommandParameterAst] -and
         ('Encoding'.StartsWith($_.ParameterName, [System.StringComparison]::OrdinalIgnoreCase) -or $_.ParameterName -eq 'AsByteStream')) -or
        ($_ -is [System.Management.Automation.Language.VariableExpressionAst] -and $_.Splatted)
    })
    if ($explicit.Count -eq 0) { $edits += $command.CommandElements[0].Extent.EndOffset }
}
ConvertTo-Json -InputObject @{reads=$reads; edits=@($edits); setupOffset=$setupOffset} -Compress
