@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

:: 배치 수집기 실행 스크립트
echo.
echo ==========================================
echo   Passing 배치 문서 수집기
echo ==========================================
echo.

:: Node.js 설치 확인
node --version >nul 2>&1
if errorlevel 1 (
    echo [오류] Node.js가 설치되지 않았습니다.
    echo        https://nodejs.org 에서 Node.js를 설치하세요.
    pause
    exit /b 1
)

:: 의존성 설치 확인
if not exist "node_modules" (
    echo [정보] 의존성을 설치합니다...
    call npm run setup
    if errorlevel 1 (
        echo [오류] 의존성 설치에 실패했습니다.
        pause
        exit /b 1
    )
)

:: TypeScript 빌드 (선택사항 - tsx로 직접 실행 가능)
if "%1"=="--build" (
    echo [정보] TypeScript를 빌드합니다...
    call npm run build
    if errorlevel 1 (
        echo [오류] 빌드에 실패했습니다.
        pause
        exit /b 1
    )
    shift
)

:: URLs 파일 확인
if not exist "urls.txt" (
    echo [오류] urls.txt 파일이 없습니다.
    echo        urls.txt 파일을 생성하고 처리할 URL을 한 줄씩 입력하세요.
    echo.
    echo 예시:
    echo https://www.tankauction.com/pa/paView.php?cltrNo=1820103^&chkNo=4^&TotNo=20
    echo https://www.tankauction.com/pa/paView.php?cltrNo=1820103^&chkNo=5^&TotNo=20
    pause
    exit /b 1
)

:: .env 파일 확인
if not exist ".env" (
    echo [경고] .env 파일이 없습니다.
    echo        Chrome 프로필이나 쿠키 설정을 위해 .env 파일을 생성하는 것을 권장합니다.
    echo.
    set /p continue="계속 진행하시겠습니까? (y/N): "
    if /i not "!continue!"=="y" (
        echo 실행을 취소합니다.
        pause
        exit /b 1
    )
)

:: 실행 옵션 확인
set "ARGS="
set "DRY_RUN="

:parse_args
if "%1"=="--dry-run" (
    set "DRY_RUN=--dry-run"
    set "ARGS=!ARGS! --dry-run"
    shift
    goto parse_args
)
if "%1"=="--help" (
    node dist\batch.js --help
    pause
    exit /b 0
)
if not "%1"=="" (
    set "ARGS=!ARGS! %1"
    shift
    goto parse_args
)

:: 실행 전 정보 출력
echo [정보] 설정 확인:
if exist ".env" (
    findstr /i "CHROME_PROFILE" .env >nul 2>&1
    if not errorlevel 1 (
        echo        - Chrome 프로필 사용
    )
    findstr /i "COOKIE_TANK" .env >nul 2>&1
    if not errorlevel 1 (
        echo        - 쿠키 파일 사용
    )
)

for /f "tokens=*" %%i in ('type urls.txt ^| find /c /v ""') do set URL_COUNT=%%i
echo        - 처리할 URL: !URL_COUNT!개

if not "!DRY_RUN!"=="" (
    echo        - 모드: DRY RUN (다운로드 생략)
) else (
    echo        - 모드: 실제 다운로드
)

echo.
set /p proceed="실행하시겠습니까? (Y/n): "
if /i "!proceed!"=="n" (
    echo 실행을 취소합니다.
    pause
    exit /b 0
)

:: 실행
echo.
echo [정보] 배치 수집기를 시작합니다...
echo ==========================================

if exist "dist\index.js" (
    node dist\index.js !ARGS!
) else (
    npm run dev -- !ARGS!
)

set EXIT_CODE=%errorlevel%

echo.
echo ==========================================
if %EXIT_CODE%==0 (
    echo [완료] 배치 수집기가 성공적으로 완료되었습니다.
    echo.
    if exist "out" (
        echo 결과물 확인:
        for /d %%d in (out\*) do (
            echo        - %%d
            if exist "%%d\MANIFEST.json" (
                echo          └─ MANIFEST.json (세부사항 확인)
            )
        )
    )
) else (
    echo [오류] 배치 수집기가 오류와 함께 종료되었습니다. (코드: %EXIT_CODE%)
    echo        logs 폴더의 로그 파일을 확인하세요.
)

echo.
echo 로그 파일:
if exist "logs" (
    for %%f in (logs\run-*.log) do (
        echo        - %%f
    )
)

echo.
pause