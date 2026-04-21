# DUEBA 크롤러 서버

이 폴더는 별도 파이썬 프로세스로 실행하는 작혼 대회 크롤러입니다.

현재 목적:

- `users` 컬렉션을 스캔해서 친구 코드와 파벌 이름을 읽음
- 대국 결과 크롤링 전에 팀 매니저 페이지에서 미등록 유저를 자동 등록 시도
- 친구 코드가 잘못되어 등록 실패하면 해당 유저 문서에 상태를 남김
- 대국 결과를 `match-results` 컬렉션에 중복 없이 저장

## 준비

1. 가상환경 생성

```powershell
cd crawler
python -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
```

2. 설정 파일 생성

```powershell
Copy-Item .\\config.example.json .\\config.local.json
```

3. `config.local.json` 수정

- `yostar_login_id`
- `yostar_login_password`
- `yostar_mail_email`
- `yostar_mail_password`
- Gmail을 쓴다면 일반 비밀번호 대신 앱 비밀번호가 필요할 수 있습니다.
- `firestore_service_account_path`

서비스 계정 JSON은 Git에 올리지 말고 로컬에만 둡니다.

## 실행

한 번만 실행:

```powershell
python .\\main.py --once
```

주기적으로 반복 실행:

```powershell
python .\\main.py
```

## Firestore 사용 필드

`users/{characterName}`

- `friendCode`
- `factionName`
- `teamEnrollmentStatus`
- `teamEnrollmentMessage`
- `teamEnrollmentUpdatedAt`
- `teamEnrollmentByContest`

`match-results/{docId}`

- `mode`
- `contestName`
- `sourceUrl`
- `createdAt`
- `createdAtText`
- `ranks`
- `playerCount`

## 주의

- 팀 매니저 화면의 DOM 구조가 바뀌면 셀렉터 보정이 필요할 수 있습니다.
- 현재 팀 추가 로직은 여러 셀렉터 후보를 순차적으로 시도하도록 작성되어 있습니다.
- 실제 사이트에서 버튼/입력창 이름이 다르면 `main.py` 상단의 셀렉터 후보 목록을 조정하면 됩니다.
