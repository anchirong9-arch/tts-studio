#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
TTS 스튜디오 로컬 서버
---------------------
- 웹 UI(index.html)와 정적 파일을 http://127.0.0.1:8765 에서 서빙
- POST /tts  : {text, voice, rate, pitch} -> audio/mpeg (edge-tts)
- POST /tts?format=json : 같은 요청을 JSON(audio base64 + 단어 타이밍)으로 반환
- GET  /health : 연결 확인용

실행:  python server.py            (브라우저 자동 열림)
       python server.py --no-open  (브라우저 안 열림)
       python server.py --port 9000
"""

import argparse
import asyncio
import base64
import json
import os
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_VERSION = "1.0.0"
DEFAULT_PORT = 8765
MAX_TEXT = 5000

VOICES = [
    {"id": "ko-KR-InJoonNeural", "name": "인준", "gender": "남성", "desc": "차분한 남성 · 뉴스/설명형"},
    {"id": "ko-KR-SunHiNeural", "name": "선희", "gender": "여성", "desc": "밝은 여성 · 쇼츠/친근한 톤"},
    {"id": "ko-KR-HyunsuMultilingualNeural", "name": "현수", "gender": "남성", "desc": "부드러운 남성 · 다국어 지원"},
]
VOICE_IDS = {v["id"] for v in VOICES}

try:
    import edge_tts
    EDGE_TTS_VERSION = getattr(edge_tts, "__version__", "unknown")
except Exception:  # noqa: BLE001
    edge_tts = None
    EDGE_TTS_VERSION = None


def log(msg):
    print("[tts-studio] " + str(msg), flush=True)


# ───────────────────────────── 음성 합성 ─────────────────────────────

async def _synth_once(text, voice, rate, pitch):
    """edge-tts 1회 호출. 오디오 바이트와 단어 타이밍(ms)을 돌려준다."""
    communicate = edge_tts.Communicate(
        text, voice, rate=rate, pitch=pitch, boundary="WordBoundary"
    )
    audio = bytearray()
    words = []
    async for chunk in communicate.stream():
        ctype = chunk.get("type")
        if ctype == "audio":
            audio.extend(chunk.get("data", b""))
        elif ctype == "WordBoundary":
            # offset/duration 단위: 100나노초 -> ms 로 변환
            words.append(
                {
                    "offset_ms": int(round(chunk.get("offset", 0) / 10000)),
                    "duration_ms": int(round(chunk.get("duration", 0) / 10000)),
                    "text": chunk.get("text", ""),
                }
            )
    if not audio:
        raise RuntimeError("empty audio")
    return bytes(audio), words


def synthesize(text, voice, rate, pitch, attempts=3):
    """일시적인 네트워크 실패에 대비해 몇 번 재시도한다."""
    last_error = None
    for i in range(1, attempts + 1):
        try:
            return asyncio.run(_synth_once(text, voice, rate, pitch))
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            log("합성 실패 %d/%d: %s: %s" % (i, attempts, type(exc).__name__, exc))
            if i < attempts:
                time.sleep(0.7 * i)
    raise RuntimeError(str(last_error) or "음성 합성에 실패했습니다")


# ───────────────────────────── 요청 처리 ─────────────────────────────

def clamp_number(value, default, low, high):
    try:
        num = int(round(float(str(value).replace("%", "").replace("Hz", "").strip())))
    except Exception:  # noqa: BLE001
        return default
    return max(low, min(high, num))


def normalize_sign(value):
    return ("+" if value >= 0 else "") + str(value)


class Handler(SimpleHTTPRequestHandler):
    server_version = "TTSStudio/" + SERVER_VERSION
    protocol_version = "HTTP/1.1"

    # ---------- 공통 ----------
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def log_message(self, fmt, *args):  # 콘솔 로그를 짧게
        log("%s - %s" % (self.address_string(), fmt % args))

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Accept, X-Requested-With",
        )
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "86400")

    def json_response(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return b""
        if length > 4 * 1024 * 1024:
            raise ValueError("요청이 너무 큽니다")
        return self.rfile.read(length)

    def parse_payload(self):
        raw = self.read_body()
        ctype = (self.headers.get("Content-Type") or "").lower()
        if not raw:
            return {}
        text = raw.decode("utf-8", errors="replace")
        if "application/json" in ctype:
            try:
                data = json.loads(text)
                return data if isinstance(data, dict) else {}
            except json.JSONDecodeError as exc:
                raise ValueError("JSON 형식이 올바르지 않습니다: %s" % exc)
        # form-urlencoded 도 허용
        parsed = parse_qs(text, keep_blank_values=True)
        return {k: v[0] for k, v in parsed.items()}

    # ---------- 라우팅 ----------
    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/healthz"):
            return self.json_response(self.health_payload())
        if path == "/voices":
            return self.json_response({"voices": VOICES})
        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/tts", "/api/tts"):
            query = parse_qs(parsed.query)
            as_json = (query.get("format", ["audio"])[0] or "").lower() == "json"
            if not as_json:
                as_json = "application/json" in (self.headers.get("Accept") or "")
            return self.handle_tts(as_json)
        # 알 수 없는 경로라도 본문을 읽어 두어야 keep-alive 연결이 꼬이지 않는다
        try:
            self.read_body()
        except Exception:  # noqa: BLE001
            pass
        self.json_response({"ok": False, "error": "알 수 없는 경로입니다: %s" % parsed.path}, 404)

    # ---------- 상태 ----------
    def health_payload(self):
        return {
            "ok": True,
            "service": "tts-studio",
            "version": SERVER_VERSION,
            "edge_tts": EDGE_TTS_VERSION,
            "python": sys.version.split()[0],
            "port": self.server.server_address[1],
            "voices": VOICES,
            "max_text": MAX_TEXT,
        }

    # ---------- TTS ----------
    def handle_tts(self, as_json):
        try:
            payload = self.parse_payload()
        except ValueError as exc:
            return self.json_response({"ok": False, "error": str(exc)}, 400)

        if edge_tts is None:
            return self.json_response(
                {
                    "ok": False,
                    "error": "edge-tts 패키지가 설치되어 있지 않습니다. 실행하기.bat 을 다시 실행해 주세요.",
                },
                500,
            )

        text = str(payload.get("text") or "").strip()
        if not text:
            return self.json_response({"ok": False, "error": "텍스트를 입력해 주세요."}, 400)
        if len(text) > MAX_TEXT:
            return self.json_response(
                {"ok": False, "error": "텍스트는 %d자까지 가능합니다." % MAX_TEXT}, 400
            )

        voice = str(payload.get("voice") or VOICES[0]["id"]).strip()
        if voice not in VOICE_IDS:
            voice = VOICES[0]["id"]

        rate_num = clamp_number(payload.get("rate", 0), 0, -50, 100)
        pitch_num = clamp_number(payload.get("pitch", 0), 0, -50, 50)
        rate = normalize_sign(rate_num) + "%"
        pitch = normalize_sign(pitch_num) + "Hz"

        started = time.time()
        try:
            audio, words = synthesize(text, voice, rate, pitch)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.json_response(
                {
                    "ok": False,
                    "error": "음성 합성에 실패했습니다: %s" % exc,
                    "hint": "인터넷 연결을 확인하고 다시 시도해 주세요.",
                },
                502,
            )

        duration_ms = 0
        if words:
            duration_ms = max(w["offset_ms"] + w["duration_ms"] for w in words)
        elapsed = round(time.time() - started, 2)
        log("합성 완료 %s %s %.2fs / %d bytes / %d words" % (voice, rate, elapsed, len(audio), len(words)))

        if as_json:
            return self.json_response(
                {
                    "ok": True,
                    "voice": voice,
                    "rate": rate,
                    "pitch": pitch,
                    "mime": "audio/mpeg",
                    "duration_ms": duration_ms,
                    "elapsed_sec": elapsed,
                    "words": words,
                    "audio_base64": base64.b64encode(audio).decode("ascii"),
                }
            )

        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Audio-Duration-Ms", str(duration_ms))
        self.send_header("Access-Control-Expose-Headers", "X-Audio-Duration-Ms")
        self.cors()
        self.end_headers()
        try:
            self.wfile.write(audio)
        except (BrokenPipeError, ConnectionResetError):
            pass


def find_free_port(host, port, tries=20):
    for offset in range(tries):
        candidate = port + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind((host, candidate))
                return candidate
            except OSError:
                continue
    return port


def open_browser_later(url, delay=0.9):
    def run():
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:  # noqa: BLE001
            log("브라우저 자동 열기에 실패했습니다. 직접 %s 를 열어 주세요." % url)

    threading.Thread(target=run, daemon=True).start()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    parser = argparse.ArgumentParser(description="TTS 스튜디오 로컬 서버")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--open", dest="open_browser", action="store_true", help="브라우저 자동 열기")
    parser.add_argument("--no-open", dest="open_browser", action="store_false", help="브라우저 열지 않기")
    parser.set_defaults(open_browser=True)
    args = parser.parse_args()

    port = find_free_port(args.host, args.port)
    if port != args.port:
        log("포트 %d 가 사용 중이라 %d 로 시작합니다." % (args.port, port))

    if edge_tts is None:
        log("경고: edge-tts 가 설치되어 있지 않습니다. 실행하기.bat 을 다시 실행해 주세요.")

    url = "http://%s:%d/" % (args.host, port)
    try:
        httpd = ThreadingHTTPServer((args.host, port), Handler)
    except OSError as exc:
        log("서버를 시작할 수 없습니다: %s" % exc)
        input("엔터를 누르면 종료합니다...")
        return 1

    httpd.daemon_threads = True
    log("TTS 스튜디오 서버 시작 → %s" % url)
    log("이 창을 닫으면 서버가 꺼집니다. (Ctrl+C 로도 종료)")
    if args.open_browser:
        open_browser_later(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("서버를 종료합니다.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
