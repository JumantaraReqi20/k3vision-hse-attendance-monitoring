#!/bin/bash
# K3Vision Quick Start Script - Windows PowerShell
# Save as: start.ps1

# Navigate to project directory
cd "e:\POLITEKNIK NEGERI BANDUNG\Pilmapres 2026\ProdukInovatif\K3Vision"

# Check if venv exists
if (-Not (Test-Path "venv311\Scripts\Activate.ps1")) {
    Write-Host "🔧 Creating virtual environment..." -ForegroundColor Yellow
    python -m venv venv311
}

# Activate virtual environment
Write-Host "✅ Activating virtual environment..." -ForegroundColor Green
& "venv311\Scripts\Activate.ps1"

# Install dependencies
Write-Host "📦 Installing dependencies..." -ForegroundColor Yellow
pip install -r requirements.txt

# Start application
Write-Host "🚀 Starting K3Vision Server..." -ForegroundColor Green
Write-Host "📍 Dashboard: http://127.0.0.1:8000/" -ForegroundColor Cyan
Write-Host "Press Ctrl+C to stop" -ForegroundColor Yellow

uvicorn main:app --reload --port 8000
