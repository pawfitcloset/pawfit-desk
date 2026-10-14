
Add-Type -AssemblyName System.Drawing
$printerName = "Xprinter XP-410B"
$pd = New-Object System.Drawing.Printing.PrintDocument
$installedPrinters = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
if ($installedPrinters -contains $printerName) {
  $pd.PrinterSettings.PrinterName = $printerName
} else {
  Write-Host "Xprinter XP-410B not found, using default printer."
}
$pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize("Label", 157, 79)
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(4, 4, 4, 4)
$lines = Get-Content "C:/Users/Admin/tiktok-dashboard/temp_receipt.txt"
$pd.add_PrintPage({
  param($sender, $e)
  $headerFont = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
  $buyerFont  = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
  $codeFont   = New-Object System.Drawing.Font("Arial", 11, [System.Drawing.FontStyle]::Bold)
  $brush      = [System.Drawing.Brushes]::Black
  $y          = [float]2
  foreach ($line in $lines) {
    if ($line.Trim() -ne "") {
      if ($line -like "*CODE*" -or $line -like "*PRICE*") {
        $e.Graphics.DrawString($line, $codeFont, $brush, [float]3, $y)
        $y += [float]13
      } elseif ($line -like "*BUYER*" -or $line -like "*USER*") {
        $e.Graphics.DrawString($line, $buyerFont, $brush, [float]3, $y)
        $y += [float]11
      } else {
        $e.Graphics.DrawString($line, $headerFont, $brush, [float]3, $y)
        $y += [float]10
      }
    }
  }
  $e.HasMorePages = $false
})
$pd.Print()
Write-Host "Label printed successfully."
