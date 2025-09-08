#!/bin/bash

# Passing 배치 수집기 스모크 테스트
# Windows에서는 Git Bash 또는 WSL에서 실행

set -e

echo "🔬 Passing 배치 수집기 스모크 테스트 시작"
echo "=============================================="

# 프로젝트 루트로 이동
cd "$(dirname "$0")/.."

# 테스트 환경 정리
echo "📁 테스트 환경 정리..."
rm -rf out/test-* test-temp/ || true

# 의존성 설치 확인
if [ ! -d "node_modules" ]; then
    echo "📦 의존성 설치..."
    npm run setup
fi

# TypeScript 빌드
echo "🔨 TypeScript 빌드..."
npm run build

# 단위 테스트 실행
echo "🧪 단위 테스트 실행..."
npm test

# 테스트용 URLs 파일 생성
echo "📄 테스트 URLs 파일 생성..."
cat > urls.test.txt << EOF
# 테스트용 URL (실제 URL로 교체 필요)
https://httpbin.org/html
https://httpbin.org/json
EOF

# 테스트용 환경변수 설정
export OUT_DIR="out"
export CONCURRENCY="1"
export QPS="1"
export MAX_ITEMS="5"
export CODES="AP,REG,BLD"
export HEADLESS="true"
export LOG_LEVEL="info"

# DRY RUN 테스트
echo "🔄 DRY RUN 테스트..."
npm run dev -- --urls ./urls.test.txt --dry-run --log-level debug

# 실제 실행 테스트 (주석 처리 - 실제 URL 필요)
# echo "🚀 실제 실행 테스트..."
# npm run dev -- --urls ./urls.test.txt --log-level info

# 결과 검증
echo "✅ 결과 검증..."

# dist 폴더 확인
if [ ! -f "dist/index.js" ]; then
    echo "❌ 빌드 실패: dist/index.js 없음"
    exit 1
fi

# package.json 스크립트 확인
if ! npm run --silent | grep -q "setup\|dev\|build\|start\|typecheck\|test"; then
    echo "❌ package.json 스크립트 누락"
    exit 1
fi

# .env.example 검증
if ! grep -q "CONCURRENCY\|QPS\|CODES" .env.example; then
    echo "❌ .env.example 키 누락"
    exit 1
fi

# 헬프 출력 테스트
echo "📖 헬프 출력 테스트..."
npm run dev -- --help | head -10

# 정리
echo "🧹 테스트 환경 정리..."
rm -f urls.test.txt
rm -rf out/test-* test-temp/ || true

echo ""
echo "=============================================="
echo "✅ 스모크 테스트 완료!"
echo ""
echo "다음 단계:"
echo "1. urls.txt에 실제 URL 입력"
echo "2. .env 파일에 CHROME_PROFILE 설정"  
echo "3. run.bat 실행"
echo ""
echo "전체 테스트 성공: 에러 없이 완료됨"