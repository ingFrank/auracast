@echo off
title AuraCast - Subir a GitHub Pages
color 0B
echo ============================================================================
echo                     SUBIR AURACAST A GITHUB PAGES
echo ============================================================================
echo.
set /p REPO_URL="Pega aqui el enlace de tu repositorio de GitHub (ej: https://github.com/usuario/auracast.git): "

if "%REPO_URL%"=="" (
    echo No ingresaste ningun enlace. Operacion cancelada.
    pause
    exit /b
)

echo.
echo Conectando con tu repositorio...
"C:\Program Files\Git\bin\git.exe" remote remove origin 2>nul
"C:\Program Files\Git\bin\git.exe" remote add origin %REPO_URL%
"C:\Program Files\Git\bin\git.exe" branch -M main

echo Subiendo archivos a GitHub...
"C:\Program Files\Git\bin\git.exe" push -u origin main

echo.
echo ============================================================================
echo Si el push termino con exito:
echo 1. Ve a tu repositorio en GitHub
echo 2. Entra a Settings -> Pages (a la izquierda)
echo 3. En 'Source' elige 'Deploy from a branch' y en 'Branch' elige 'main' y Guarda
echo 4. Tu enlace sera: https://tu-usuario.github.io/tu-repositorio/
echo ============================================================================
pause
