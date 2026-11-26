# 툭 (Change-File)

파일을 툭 놓으면 PDF로 바꾸고, 그림 용량을 줄이고, ZIP으로 묶거나 풀어 주는 도구입니다.
파일은 내 컴퓨터 밖으로 나가지 않습니다.

- **웹 버전**: https://gmlduqzhd123-lab.github.io/Change-File/ — 설치 없이 브라우저에서 바로 씁니다.
- **윈도우 프로그램**: 같은 페이지에서 받습니다. 탐색기 보내기 메뉴로 쓰고, 한글·오피스 문서도 PDF로 바꿉니다.

| 할 일 | 웹 | 윈도우 |
|---|---|---|
| 그림 → PDF (하나로 묶기 포함) | ✓ | ✓ |
| 한글(HWP·HWPX)·워드·엑셀·PPT → PDF | | ✓ (한컴오피스·MS 오피스 필요) |
| 그림 용량 줄이기 (긴 쪽 1600px JPG) | ✓ | ✓ |
| ZIP 묶기·풀기 (CP949 한글 이름 포함) | ✓ | ✓ |

## 폴더
```
src/Tuk.cs        윈도우 프로그램 전체 코드 (C# 5, .NET Framework 4.x)
build.ps1         빌드·배포 스크립트
설치 안내.txt      ZIP에 함께 넣는 안내
docs/             GitHub Pages 사이트
  index.html      소개 + 웹 버전
  app.js          웹 버전 코드 (JSZip 3.10.1만 cdnjs에서 불러옴)
  version.json    윈도우 프로그램 새 버전 정보
  download/       Tuk.zip(받기 단추), Tuk.exe(앱 안 업데이트)
```

## 빌드
```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```
윈도우 10·11에 들어 있는 .NET Framework 4.8 컴파일러만 씁니다. 결과는 `build\Tuk.exe`.

## 새 버전 내기
1. `src\Tuk.cs`의 `Version`을 올립니다 (예: `0.1.0` → `0.2.0`).
2. 배포 파일을 만듭니다:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\build.ps1 -Release -Notes "고친 점"
   ```
   `docs\download\Tuk.zip`, `docs\download\Tuk.exe`, `docs\version.json`이 새로 만들어집니다.
3. 커밋하고 `main`에 푸시하면 GitHub Pages가 갱신되고, 설치된 툭은 다음 확인 때(하루 한 번 또는 [새 버전 확인]) 새 버전을 받습니다.

앱은 `version.json`의 `url`이 이 사이트 안일 때만 받고, 받은 파일의 SHA-256이 `version.json`과 같을 때만 바꿉니다.
코드 서명은 하지 않았기 때문에 처음 실행할 때 윈도우 'PC 보호' 창이 뜹니다.

## GitHub Pages 설정 (처음 한 번)
저장소 **Settings → Pages → Build and deployment**에서 Source를 **Deploy from a branch**, Branch를 **main / docs**로 정하고 저장합니다.

## 시험
- 창 없이 동작 시험: `Tuk.exe /run <pdf|pdfall|shrink|zip|unzip> 파일...` (종료 코드 = 문제 개수)
- 업데이트 시험: `TUK_UPDATE_BASE=http://127.0.0.1:포트/`를 정하고 `Tuk.exe /update-check` 또는 `/update-apply`
