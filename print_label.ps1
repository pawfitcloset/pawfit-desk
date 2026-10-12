
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
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(5, 5, 5, 5)
$lines = Get-Content "C:/Users/Admin/tiktok-dashboard/temp_receipt.txt"
$pd.add_PrintPage({
  param($sender, $e)
  $font = New-Object System.Drawing.Font("Arial", 7, [System.Drawing.FontStyle]::Regular)
  $brush = [System.Drawing.Brushes]::Black
  $y = [float]2
  foreach ($line in $lines) {
    if ($line.Trim() -ne "") {
      $e.Graphics.DrawString($line, $font, $brush, [float]3, $y)
      $y += [float]10
    }
  }
  $e.HasMorePages = $false
})
$pd.Print()
Write-Host "Label printed successfully."
