Add-Type -AssemblyName System.Drawing
$target = Join-Path $PSScriptRoot '../vercel-app/public/app-icon.png'
$bitmap = New-Object System.Drawing.Bitmap 1024, 1024
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#197563'))
$font = New-Object System.Drawing.Font 'Georgia', 760, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$graphics.DrawString('a', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, -80, 1024, 1024), $format)
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$format.Dispose()
$font.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
