# Dueba Firebase 프로젝트

Firebase Hosting, Auth, Firestore, Cloud Functions 기반으로 만든 서버리스 웹 프로젝트입니다.

## 포함된 기능

- 자체 ID/비밀번호 회원가입 및 로그인
- 회원가입 시 Firestore `users` 문서 생성
- 로그인 후 메인 대시보드 진입
- 상점, 인벤토리, 룰렛, 대국 정보, 특성치, 운영진 메뉴 기본 골격
- 룰렛 결과를 `roulette-logs` 컬렉션에 저장
- 최근 룰렛 결과 5개 표 출력
- 상점 데이터는 `shop` 컬렉션에서 조회
- 특성치 데이터는 `traits` 컬렉션에서 조회

## 폴더 구조

- `public/`
  Firebase Hosting으로 배포되는 프론트엔드 파일
- `public/src/firebase.js`
  Firebase 웹 앱 설정
- `public/src/auth.js`
  회원가입, 로그인, 프로필 생성/조회 로직
- `public/src/dashboard.js`
  로그인 후 대시보드 UI와 상점/룰렛/특성치 렌더링 로직
- `functions/`
  Firebase Cloud Functions 코드
- `firestore.rules`
  Firestore 보안 규칙

## Firebase 콘솔에서 먼저 할 일

1. Firebase 프로젝트 생성
2. `Authentication > Sign-in method > Email/Password` 활성화
3. Firestore Database 생성
4. `프로젝트 설정 > 일반 > 내 앱`에서 웹 앱 추가
5. 웹 앱 설정값을 `public/src/firebase.js`에 입력
6. Cloud Functions까지 배포하려면 Blaze 요금제 사용

## 로컬 설치

PowerShell 기준:

```powershell
cd C:\Users\user\Desktop\Project\functions
npm.cmd install
cd ..
```

Firebase CLI가 전역 설치되어 있지 않다면:

```powershell
npx.cmd firebase-tools login
npx.cmd firebase-tools use --add

## 깃허브 업로드 전 설정

이 프로젝트는 민감한 설정을 분리한 상태입니다.

- 실제 Firebase 웹 설정은 `public/src/firebase-config.js`에 둡니다.
- 깃허브에는 `public/src/firebase-config.example.js`만 올리고, 실제 설정 파일은 `.gitignore`로 제외합니다.
- 서비스 계정 키 JSON 파일도 `.gitignore`로 제외됩니다.

처음 세팅할 때는 아래처럼 복사해서 사용하면 됩니다.

```powershell
Copy-Item public\src\firebase-config.example.js public\src\firebase-config.js
```

그 다음 `public/src/firebase-config.js` 안에 실제 Firebase 설정값을 넣으면 됩니다.
```

## 배포 방법

전체 배포:

```powershell
cd C:\Users\user\Desktop\Project
npx.cmd firebase-tools deploy --project dueba-cbfd4
```

프론트와 Firestore 규칙만 배포:

```powershell
npx.cmd firebase-tools deploy --only hosting,firestore --project dueba-cbfd4
```

Functions만 배포:

```powershell
npx.cmd firebase-tools deploy --only functions --project dueba-cbfd4
```

## Firestore 컬렉션 구조

### `users`

- 문서 ID: 캐릭터 이름
- 주요 필드
  - `uid`
  - `loginId`
  - `nickname`
  - `characterName`
  - `role`
  - `selectedTraitIds`
  - `availableTraitPoints`
  - `inventory`
  - `currency`

### `shop`

- 문서 ID 예시
  - `special-table-ticket`
  - `duel-ticket`
  - `wrapping-paper`
- 주요 필드
  - `name`
  - `description`
  - `price`
  - `sortOrder`

### `traits`

- 문서 ID 예시
  - `pinfu-win`
  - `wait-36-win`
  - `kokushi-win`
  - `hidden-trait`
- 주요 필드
  - `name`
  - `successPoints`
  - `failPoints`
  - `requiredPoints`
  - `sortOrder`

### `roulette-items`

- 운영진이 직접 추가/삭제하는 룰렛 항목 컬렉션
- 주요 필드
  - `name`
  - `description`
  - `createdAt`

### `roulette-logs`

- 문서 ID: 시도 시각 기반 문자열
- 주요 필드
  - `uid`
  - `characterName`
  - `loginId`
  - `rewardName`
  - `rewardDescription`
  - `createdAt`
  - `createdAtText`
  - `attemptedAtId`

## 참고 사항

- `shop`, `traits` 기본 데이터는 Functions가 처음 실행될 때 자동으로 시드합니다.
- 예전에 만든 계정은 구 구조 데이터가 남아 있을 수 있습니다.
- 새로 가입한 계정은 캐릭터 이름을 문서 ID로 사용합니다.
- 현재 룰렛은 보상 지급 없이 결과 기록과 화면 표시만 구현되어 있습니다.
- 대국 정보는 이후 크롤링 데이터 연동을 위한 확장용 골격만 들어 있습니다.
