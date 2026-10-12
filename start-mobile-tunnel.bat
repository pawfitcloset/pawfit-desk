@echo off
title Pawfit Desk - Mobile Public Link
echo ====================================================
echo Starting Cloudflare Tunnel for Pawfit Desk...
echo This will generate a public link for your phone!
echo ====================================================
echo.
npx cloudflared tunnel --url https://localhost:5173 --no-tls-verify
pause
