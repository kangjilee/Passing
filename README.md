# Passing 배치 문서 수집기

Windows 환경에서 **상세페이지 URL만 입력하면** 자동으로 사이드 영역의 참고자료를 수집하는 배치 모드 시스템입니다.

**핵심 특징**: 로그인 없이 내 세션으로 열고, 동시성 제한(동시 2개, QPS 2), 타임아웃 120초, 1회 재시도로 예의를 지키며 수집합니다.

## 📋 사용법 (간단 3단계)

### 1. URLs 입력
`urls.txt` 파일에 처리할 상세페이지 URL을 한 줄씩 입력하세요:

```txt
https://www.tankauction.com/pa/paView.php?cltrNo=1820103&chkNo=4&TotNo=20
https://www.tankauction.com/pa/paView.php?cltrNo=1820103&chkNo=5&TotNo=20
```

### 2. 인증 설정 (선택사항)
`.env` 파일을 생성하여 Chrome 프로필 또는 쿠키 설정:

```env
# Chrome 프로필 사용 (권장)
CHROME_PROFILE=C:\Users\사용자명\AppData\Local\Google\Chrome\User Data\Default

# 또는 쿠키 파일 사용
COOKIE_TANK=cookies.json

# 동시성 및 속도 제한
CONCURRENCY=2
QPS=2
TIMEOUT_MS=120000

# 수집 설정
MAX_ITEMS=16
CODES=AP,REG,BLD,ZON,RS,TEN,RTR,NT
```

### 3. 실행
```cmd
run.bat
```

끝! `out/` 폴더에 사건별로 정리된 문서들과 `MANIFEST.json`이 생성됩니다. 

**실패한 URL들은 `urls.failed.txt`에 별도 기록되며, 재실행 시 중복 저장 없이 안전하게 처리됩니다(idempotent).**

## 📁 출력 구조

```
out/
├── 2024타경12345_1차/
│   ├── AP_감정평가서.pdf
│   ├── RS_재산명세서.hwp
│   ├── REG_등기부등본.pdf
│   ├── BLD_건축물대장.pdf
│   ├── ZON_토지이용계획.pdf
│   └── MANIFEST.json
└── 2024타경12346_1차/
    ├── ...
```

## 📊 MANIFEST.json 예시

```json
{
  "casePrefix": "2024타경12345_1차",
  "totalCandidates": 8,
  "processedFiles": [
    {
      "code": "AP",
      "originalText": "감정평가서",
      "filename": "AP_감정평가서.pdf",
      "finalUrl": "https://...",
      "method": "GET",
      "size": 245760,
      "success": true
    }
  ],
  "missing": [],
  "summary": {
    "foundCodes": ["AP", "RS", "REG", "BLD", "ZON"],
    "totalSize": 1234567,
    "successCount": 5,
    "failCount": 0
  }
}
```

## 🔧 고급 옵션

### 명령행 옵션

```cmd
# 다운로드 없이 분석만 수행
run.bat --dry-run

# 브라우저 UI 표시
run.bat --headless false

# 사용자 정의 URLs 파일
run.bat --urls my-urls.txt

# 로그 레벨 조정
run.bat --log-level DEBUG
```

### 환경변수 설정

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `CHROME_PROFILE` | Chrome 프로필 디렉토리 경로 | 없음 |
| `COOKIE_TANK` | 쿠키 저장 파일 경로 | 없음 |
| `HEADLESS` | 헤드리스 모드 (true/false) | true |
| `HOOK_MS` | 클릭 후 대기시간 (ms) | 600 |
| `MAX_RETRIES` | 다운로드 재시도 횟수 | 3 |
| `LOG_LEVEL` | 로그 레벨 (DEBUG/INFO/WARN/ERROR) | INFO |

## 🚀 설치 및 초기 설정

### 1. 필수 소프트웨어
- **Node.js LTS** (https://nodejs.org)

### 2. 자동 설치
```cmd
# 의존성 설치 + Playwright 설치
npm run setup
```

### 3. 스모크 테스트 (권장)
```cmd
# 단위 테스트 및 기본 검증
npm test

# DRY RUN 테스트
npm run dev -- --urls ./urls.txt.example --dry-run
```

## 🧩 코드 분류 시스템

| 코드 | 설명 | 파일형식 |
|------|------|----------|
| **AP** | 감정평가서 | PDF |
| **RS** | 재산명세서 | HWP |
| **REG** | 등기부등본 | PDF |
| **BLD** | 건축물대장 | PDF |
| **ZON** | 토지이용계획 | PDF |
| **RTR** | 실거래가 | XLS |
| **TEN** | 임차/점유 | HWP |
| **NT** | 특약/유의사항 | HWP |

**필수 코드**: AP, RS, REG, BLD, ZON (이 중 누락된 것은 `missing` 배열에 표시됩니다)

## 🔍 문제해결

### 세션 만료 오류
```
[WARN] 세션 유효성 확인 실패
```
**해결**: `.env`에서 `CHROME_PROFILE` 경로를 확인하거나 브라우저에서 다시 로그인

### 필수 문서 누락
```json
"missing": ["AP", "REG"]
```
**해결**: 해당 문서가 실제로 있는지 확인하거나, 라벨 패턴이 달라서 인식되지 않을 수 있음

### 다운로드 실패 (403/429)
```
[ERROR] HTTP 403: Forbidden
```
**해결**: 요청 빈도를 줄이거나 `HOOK_MS` 값을 증가

### HWP 파일 인식 오류
**해결**: Content-Type 헤더가 없는 경우 URL 확장자나 코드별 기본값 사용

## 📝 로그 확인

실행 후 `logs/run-YYYYMMDD-HHMMSS.log` 파일에서 상세 로그를 확인할 수 있습니다:

```
[2024-01-15T10:30:00.000Z] INFO: 페이지 스캔 완료 | {"prefix":"2024타경12345_1차","candidates":8}
[2024-01-15T10:30:01.000Z] DEBUG: 후보 발견 | {"text":"감정평가서","code":"AP"}
[2024-01-15T10:30:02.000Z] INFO: 다운로드 성공 | {"filename":"AP_감정평가서.pdf","size":245760}
```

## ⚠️ 주의사항

- **배치 모드**이므로 Tampermonkey 스크립트는 사용하지 않습니다
- 브라우저 탭을 직접 열 필요가 없습니다 
- 세션 재사용으로 인증을 유지하므로 비밀번호 입력이 불필요합니다
- 사진·지도 링크는 URL만 기록하고 실제 이미지는 다운로드하지 않습니다

## 🎯 스모크 테스트

1. `urls.txt`에 테스트 URL 1-2개 입력
2. `.env`에 `CHROME_PROFILE` 설정
3. `run.bat --dry-run` 실행
4. `out/{prefix}/MANIFEST.json`에서 `missing` 배열이 비어있는지 확인

## 📞 지원

문제가 발생하면:
1. `logs/` 폴더의 최신 로그 확인
2. `--dry-run` 모드로 분석 결과 확인  
3. `--log-level DEBUG`로 상세 로그 활성화