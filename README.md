# 🎙️ TTS 스튜디오

쇼츠 대본을 넣으면 **한국어 음성(MP3)** 과 **자막(.srt)** 을 한 번에 뽑는 도구입니다.
음성 합성은 내 PC에서 돌아가고(무료 · 무제한), 웹 화면은 GitHub Pages에서 열립니다.

- 웹 UI: <https://anchirong9-arch.github.io/tts-studio/>
- 내려받기: [tts-studio.zip](https://github.com/anchirong9-arch/tts-studio/archive/refs/heads/main.zip)

## 쓰는 법 (처음 한 번만)

1. 위 ZIP을 받아 **압축을 풉니다.** (예: `C:\tts-studio`)
2. 폴더 안의 **`실행하기.bat`** 을 더블클릭합니다.
   (이름이 깨졌다면 `run.bat` 도 같은 기능입니다.)
3. 처음 한 번은 자동으로 필요한 패키지를 설치합니다. 1~2분 뒤 브라우저가 `http://127.0.0.1:8765` 로 열립니다.
4. 그 창에서 대본을 넣고 **음성 생성** → **MP3 저장 / .srt 자막** 을 누르면 끝.

> 검은 창(서버)은 쓰는 동안 **켜 두세요.** 닫으면 음성 생성이 멈춥니다.
> Python이 없다고 나오면 [python.org](https://www.python.org/downloads/windows/)에서 설치하고, 설치 첫 화면의 **“Add python.exe to PATH”** 를 꼭 체크하세요.

## 기능

| 기능 | 설명 |
| --- | --- |
| 목소리 3종 | **인준**(남·차분), **선희**(여·밝음), **현수**(남·부드러움) — 각 카드의 ▶ 로 미리듣기 |
| 속도 | `-30%` ~ `+50%` (5% 단위) |
| 피치 | `-20Hz` ~ `+20Hz` (5Hz 단위) |
| 예상 영상 길이 | 대본을 넣는 즉시 초 단위로 표시, **15·30·60초 쇼츠 길이 판정**까지 |
| 자막 .srt | 실제 음성의 **단어 타이밍**으로 자막 생성 · 미리보기 · 복사 · 다운로드 |
| 자막 분할 | 자동(문장 + 길면 나눔) / 줄바꿈 기준 / 마침표·쉼표 기준 |
| MP3 저장 | `tts-YYYYMMDD-HHMM.mp3` |
| 오프라인 보조 | 서버가 꺼져 있어도 예상 길이·예상 자막·브라우저 미리듣기 사용 가능 |

자막은 음성을 만들 때 edge-tts가 보내 주는 **단어별 타임코드**를 그대로 써서 맞춥니다. (서버 없이 만든 자막만 글자 수로 추정)

## 파일 구성

```
tts-studio/
├─ index.html          웹 UI
├─ style.css           다크 스튜디오 테마
├─ app.js              대본·설정·자막(SRT) 로직
├─ server.py           로컬 서버 (정적 파일 + /health + /tts)
├─ requirements.txt    edge-tts
├─ 실행하기.bat        1클릭 실행기 (Windows)
├─ run.bat             같은 실행기 (영문 파일명)
└─ README.md
```

## 로컬 서버 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/health` | 상태·버전·목소리 목록 JSON |
| POST | `/tts` | `{text, voice, rate, pitch}` → `audio/mpeg` |
| POST | `/tts?format=json` | 같은 요청 → `{audio_base64, duration_ms, words[]}` (자막 타이밍용) |

```bash
curl -X POST http://127.0.0.1:8765/tts \
  -H "Content-Type: application/json" \
  -d '{"text":"안녕하세요","voice":"ko-KR-SunHiNeural","rate":"+0%","pitch":"+0Hz"}' \
  -o test.mp3
```

옵션: `python server.py --port 9000 --no-open`

## 문제 해결

- **“서버 꺼짐”으로 보여요** → `실행하기.bat` 창이 켜져 있는지 확인하고 웹 화면의 **연결 확인**을 누르세요.
- **`pip install` 실패** → 인터넷 연결/방화벽 확인. 사내망이면 집 네트워크에서 시도해 보세요.
- **소리가 안 나요** → 브라우저 탭이 음소거되지 않았는지, 출력 장치를 확인하세요.
- **글자가 깨져 보여요** → Windows 10 이상 + 최신 브라우저(Chrome/Edge) 권장.

## 만든 방식

[edge-tts](https://github.com/rany2/edge-tts) (Microsoft Edge 읽기 음성) 를 파이썬 표준 `http.server` 로 감싼 구조입니다.
인터넷이 필요하고, 개인 사용 범위에서 쓰세요.
