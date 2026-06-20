@echo off
chcp 65001 >nul
title 알리고 SMS Cloud Function 배포

echo.
echo ==========================================
echo   알리고 SMS Cloud Function 배포 도구
echo ==========================================
echo.

REM ── 1단계: Node.js 확인 / 설치 ──
node -v >nul 2>&1
IF ERRORLEVEL 1 (
  echo [1/4] Node.js가 없습니다. 자동 설치를 시작합니다...
  echo.
  winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  IF ERRORLEVEL 1 (
    echo.
    echo ❌ 설치 실패. https://nodejs.org 에서 직접 LTS 버전을 설치 후 다시 실행하세요.
    pause
    exit /b 1
  )
  echo.
  echo ✅ Node.js 설치 완료!
  echo.
  echo ⚠  중요: 이 창을 닫고 새 터미널에서 "함수배포.bat" 를 다시 실행하세요.
  echo    (PATH 환경변수 적용을 위해 재시작이 필요합니다)
  echo.
  pause
  exit /b 0
)

echo [1/4] Node.js 확인:
node -v
echo.

REM ── 2단계: Firebase CLI 확인 / 설치 ──
firebase --version >nul 2>&1
IF ERRORLEVEL 1 (
  echo [2/4] Firebase CLI 설치 중...
  npm install -g firebase-tools
  IF ERRORLEVEL 1 (
    echo ❌ Firebase CLI 설치 실패. 인터넷 연결을 확인하세요.
    pause
    exit /b 1
  )
  echo ✅ Firebase CLI 설치 완료
) ELSE (
  echo [2/4] Firebase CLI 확인:
  firebase --version
)
echo.

REM ── 3단계: functions 의존성 설치 ──
echo [3/4] Cloud Function 의존성 설치 중...
cd /d "%~dp0functions"
npm install
IF ERRORLEVEL 1 (
  echo ❌ npm install 실패
  cd /d "%~dp0"
  pause
  exit /b 1
)
cd /d "%~dp0"
echo ✅ 의존성 설치 완료
echo.

REM ── 4단계: Firebase 로그인 & 배포 ──
echo [4/4] Firebase 로그인 및 배포...
echo 브라우저가 열리면 Firebase 프로젝트 소유자의 Google 계정으로 로그인하세요.
echo.
firebase login
IF ERRORLEVEL 1 (
  echo ❌ 로그인 실패
  pause
  exit /b 1
)

firebase deploy --only functions
IF ERRORLEVEL 1 (
  echo.
  echo ❌ 배포 실패. 위 오류 메시지를 확인하세요.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo  ✅ 배포 완료!
echo  이제 admin 관리자 페이지 설정 탭에서
echo  알리고 API Key, 아이디, 발신번호를 입력하면
echo  문자 탭에서 실제 SMS 발송이 가능합니다.
echo ==========================================
echo.
pause
