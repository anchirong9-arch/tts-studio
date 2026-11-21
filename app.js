/* TTS 스튜디오 — 대본 → 음성(MP3) + 자막(.srt) */
(() => {
  'use strict';

  // ── 상수 ──────────────────────────────────────────────
  const LOCAL_BASE = 'http://127.0.0.1:8765';
  const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
  const IS_LOCAL = LOCAL_HOSTS.includes(location.hostname);
  const MAX_TEXT = 5000;

  // 목소리별 초당 글자 수(공백 제외, rate 0% 기준 — 실제 합성으로 측정)
  const VOICES = {
    'ko-KR-InJoonNeural': { name: '인준', cps: 4.45 },
    'ko-KR-SunHiNeural': { name: '선희', cps: 5.00 },
    'ko-KR-HyunsuMultilingualNeural': { name: '현수', cps: 4.72 },
  };
  const SAMPLE_TEXT = '안녕하세요. 이 목소리는 이렇게 들립니다. 쇼츠 대본을 넣고 생성해 보세요.';

  const EX = {
    hook: '이거 모르면 진짜 손해예요.\n지금부터 3가지만 알려드릴게요.',
    review: '한 달 써 본 솔직한 후기입니다.\n배송은 이틀 걸렸고, 소음은 생각보다 조용했어요.\n다만 가격이 조금 아쉽습니다.',
    news: '오늘 오후, 서울 전역에 첫눈이 내렸습니다.\n출근길 곳곳에서 미끄럼 사고가 잇따랐는데요.\n내일 아침까지 도로가 얼어붙을 전망입니다.',
    greet: '안녕하세요, 오늘도 영상 찾아주셔서 감사합니다.\n구독과 좋아요는 큰 힘이 됩니다.',
  };

  // ── 상태 ─────────────────────────────────────────────
  const state = {
    base: null,
    online: false,
    audioBlob: null,
    audioUrl: null,
    words: [],
    cues: [],
    exact: false,
    generating: false,
    busyVoice: null,
    lastStamp: null,
    generatedText: null,
  };

  // ── DOM ──────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), statusText: $('statusText'), btnRetry: $('btnRetry'),
    notice: $('notice'), noticeTitle: $('noticeTitle'), noticeText: $('noticeText'),
    btnNoticeRetry: $('btnNoticeRetry'), btnZip: $('btnZip'),
    text: $('text'), charCount: $('charCount'), charNoSpace: $('charNoSpace'), btnClear: $('btnClear'),
    durValue: $('durValue'), durClock: $('durClock'), durFill: $('durFill'),
    meter: document.querySelector('.meter'), durBadges: $('durBadges'), durNote: $('durNote'),
    voices: $('voices'), rate: $('rate'), rateValue: $('rateValue'),
    pitch: $('pitch'), pitchValue: $('pitchValue'), split: $('split'), splitHint: $('splitHint'),
    btnGenerate: $('btnGenerate'), btnGenerateText: $('btnGenerateText'),
    btnPreview: $('btnPreview'), btnStop: $('btnStop'),
    error: $('error'), empty: $('emptyState'),
    playerWrap: $('playerWrap'), audio: $('audio'), audioMeta: $('audioMeta'), audioWarn: $('audioWarn'),
    btnMp3: $('btnMp3'), btnSrt: $('btnSrt'), btnCopySrt: $('btnCopySrt'),
    dlWrap: $('dlWrap'), dlHint: $('dlHint'),
    subsWrap: $('subsWrap'), subsList: $('subsList'), subsCount: $('subsCount'),
    resultMeta: $('resultMeta'),
  };

  // ── 유틸 ─────────────────────────────────────────────
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const signed = (v) => (v >= 0 ? '+' : '') + v;

  function stamp(d = new Date()) {
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  function fmtClock(sec) {
    sec = Math.max(0, sec || 0);
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  function normalizeText(raw) {
    return String(raw || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function stripPunct(s) {
    return String(s || '').replace(/[^\p{L}\p{N}]/gu, '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg, ms = 2600) {
    let box = document.getElementById('toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastBox';
      box.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;' +
        'display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:max-content;max-width:92vw';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'background:#1b2130;border:1px solid #37415a;color:#eef1f7;padding:10px 16px;' +
      'border-radius:12px;font-size:13.5px;font-weight:600;box-shadow:0 16px 40px -16px #000;opacity:0;transition:opacity .18s';
    box.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 240); }, ms);
  }

  // ── 설정 저장/복원 ────────────────────────────────────
  const STORE_KEY = 'tts-studio:v1';

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { /* ignore */ }
    if (saved.voice && VOICES[saved.voice]) setVoice(saved.voice, false);
    if (typeof saved.rate === 'number') el.rate.value = String(Math.max(-30, Math.min(50, saved.rate)));
    if (typeof saved.pitch === 'number') el.pitch.value = String(Math.max(-20, Math.min(20, saved.pitch)));
    if (saved.split) el.split.value = saved.split;
    if (typeof saved.text === 'string' && saved.text.trim()) el.text.value = saved.text;
    syncSliders();
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          voice: currentVoice(), rate: Number(el.rate.value), pitch: Number(el.pitch.value),
          split: el.split.value, text: el.text.value.slice(0, 6000),
        }));
      } catch (_) { /* 저장 실패는 무시 */ }
    }, 350);
  }

  // ── 음성 설정 ────────────────────────────────────────
  function currentVoice() {
    const picked = document.querySelector('input[name="voice"]:checked');
    return picked ? picked.value : 'ko-KR-InJoonNeural';
  }

  function setVoice(id, persist = true) {
    document.querySelectorAll('input[name="voice"]').forEach((r) => { r.checked = r.value === id; });
    document.querySelectorAll('.voice').forEach((card) => {
      card.classList.toggle('on', card.dataset.voice === id);
    });
    if (persist) { updateEstimate(); saveSettings(); }
  }

  function syncSliders() {
    const rate = Number(el.rate.value);
    const pitch = Number(el.pitch.value);
    el.rateValue.textContent = signed(rate) + '%';
    el.pitchValue.textContent = signed(pitch) + 'Hz';
  }

  // ── 예상 길이 계산 ────────────────────────────────────
  function estimate(text, voice, ratePct) {
    const chars = text.replace(/\s/g, '').length;
    if (!chars) return 0;
    const cps = (VOICES[voice] || VOICES['ko-KR-InJoonNeural']).cps;
    const base = chars / cps / (1 + ratePct / 100);
    const linePauses = Math.max(0, (text.match(/\n/g) || []).length) * 0.18;
    return base + linePauses + 0.15;
  }

  function updateEstimate() {
    const text = normalizeText(el.text.value);
    const chars = text.replace(/\s/g, '').length;
    el.charCount.textContent = `${el.text.value.length.toLocaleString('ko-KR')}자`;
    el.charNoSpace.textContent = `공백 제외 ${chars.toLocaleString('ko-KR')}자`;

    const sec = estimate(text, currentVoice(), Number(el.rate.value));
    el.durValue.textContent = sec > 0 ? `${sec.toFixed(1)}초` : '0.0초';
    el.durClock.textContent = fmtClock(sec);

    // 게이지: 60초 기준, 60초 넘으면 넘침 표시
    const pct = Math.min(100, (sec / 60) * 100);
    el.durFill.style.width = pct + '%';
    el.meter.classList.toggle('over', sec > 60);

    el.durBadges.querySelectorAll('.badge').forEach((b) => {
      const limit = Number(b.dataset.limit);
      b.classList.toggle('fit', sec > 0 && sec <= limit);
      b.classList.toggle('over', sec > limit);
      b.textContent = sec > 0 ? `${limit}초 ${sec <= limit ? '✓' : '✕'}` : `${limit}초`;
    });

    if (!chars) {
      el.durNote.textContent = '대본을 입력하면 쇼츠 길이를 계산합니다';
    } else if (sec <= 15) {
      el.durNote.textContent = '15초 쇼츠에 딱 맞아요';
    } else if (sec <= 30) {
      el.durNote.textContent = '30초 쇼츠 OK';
    } else if (sec <= 60) {
      el.durNote.textContent = '60초 이내 — 릴스·쇼츠 한 편으로 좋아요';
    } else {
      el.durNote.textContent = `${Math.ceil(sec / 60)}분 — 나눠서 올리는 걸 추천`;
    }

    const over = el.text.value.length > MAX_TEXT;
    el.btnGenerate.disabled = state.generating || !chars || over;
    el.error.hidden = !over;
    if (over) el.error.innerHTML = `대본이 너무 깁니다. <b>${MAX_TEXT.toLocaleString('ko-KR')}자</b>까지 한 번에 만들 수 있어요.`;

    // 결과 메타
    const vName = (VOICES[currentVoice()] || {}).name || '인준';
    el.resultMeta.textContent = chars
      ? `${chars.toLocaleString('ko-KR')}자 · 예상 ${fmtClock(sec)} · ${vName} ${signed(Number(el.rate.value))}%`
      : '';

    // 대본만 있어도 자막(.srt)은 받을 수 있게 버튼을 열어 둔다
    if (chars) {
      el.dlWrap.hidden = false;
      el.btnMp3.disabled = !state.audioBlob;
      el.dlHint.hidden = !!state.audioBlob;
    } else if (!state.audioBlob) {
      el.dlWrap.hidden = true;
    }
  }

  // ── 서버 연결 ────────────────────────────────────────
  function setStatus(kind, msg) {
    el.status.dataset.state = kind;
    el.statusText.textContent = msg;
  }

  async function fetchTimeout(url, opts = {}, ms = 2500) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkHealth(quiet = true) {
    if (!quiet) setStatus('checking', '확인 중…');
    const candidates = IS_LOCAL ? [location.origin, LOCAL_BASE] : [LOCAL_BASE, 'http://localhost:8765'];
    const seen = new Set();

    for (const base of candidates) {
      if (seen.has(base)) continue;
      seen.add(base);
      try {
        const res = await fetchTimeout(base + '/health', { cache: 'no-store' }, 2500);
        if (!res.ok) continue;
        const data = await res.json();
        if (!data || !data.ok) continue;
        state.base = base;
        state.online = true;
        const port = base.replace(/^https?:\/\//, '');
        setStatus('ok', `서버 연결됨 · ${port}`);
        el.notice.hidden = true;
        el.btnGenerate.title = '';
        return true;
      } catch (_) { /* 다음 후보 시도 */ }
    }

    state.base = null;
    state.online = false;
    setStatus('off', '서버 꺼짐 · 설정 필요');
    el.notice.hidden = false;
    if (IS_LOCAL) {
      el.noticeTitle.textContent = '서버가 응답하지 않아요';
      el.noticeText.innerHTML = '이 창은 <b>http://127.0.0.1:8765</b> 에서 열렸지만 서버 응답이 없습니다. 검은 창(실행하기.bat)을 닫았다면 다시 켜 주세요.';
    }
    return false;
  }

  // ── 자막 분할 ────────────────────────────────────────
  function splitSegments(text, mode) {
    const segs = [];
    const push = (start, end, raw) => {
      const lead = raw.length - raw.replace(/^\s+/, '').length;
      const body = raw.trim();
      if (body) segs.push({ start: start + lead, end: start + lead + body.length, text: body });
    };

    if (mode === 'line') {
      let idx = 0;
      for (const line of text.split('\n')) {
        push(idx, idx + line.length, line);
        idx += line.length + 1;
      }
      return segs;
    }

    const re = mode === 'sentence'
      ? /[^.!?。！？…,、·\n]+(?:[.!?。！？…]+|[,、·]+|$)\s*/g
      : /[^.!?。！？…\n]+(?:[.!?。！？…]+|$)\s*/g;

    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0]) { re.lastIndex += 1; continue; }
      push(last, last + m[0].length, m[0]);
      last += m[0].length;
    }
    if (last < text.length) push(last, text.length, text.slice(last));
    return segs.length ? segs : [{ start: 0, end: text.length, text }];
  }

  const PUNCT_TAIL = /[.,!?。！？…~'"”’)\]】》]/;

  function makeCues(text, words, mode) {
    const segs = splitSegments(text, mode);
    const MAX_CHARS = 34;

    // 단어 위치 찾기(문장부호 제외하고 앞에서부터 순서대로 매칭)
    const located = [];
    let cursor = 0;
    for (const w of words) {
      const needle = stripPunct(w.text);
      if (!needle) continue;
      let pos = text.indexOf(needle, cursor);
      if (pos === -1) pos = text.indexOf(needle);
      if (pos === -1) pos = cursor;
      else cursor = pos + needle.length;
      located.push({ ...w, raw: w.text, pos });
    }

    // 세그먼트별 단어 배분
    const buckets = segs.map(() => []);
    let si = 0;
    for (const w of located) {
      while (si < segs.length - 1 && w.pos >= segs[si].end) si += 1;
      buckets[si].push(w);
    }

    const cues = [];
    segs.forEach((seg, i) => {
      const ws = buckets[i];
      if (!ws.length) {
        cues.push({ text: seg.text, words: [], start: null, end: null });
        return;
      }
      // 자막이 너무 길면 단어 경계에서 나누되, 조각 길이가 비슷해지게
      const plainTotal = ws.reduce((a, w) => a + stripPunct(w.raw).length, 0) + (ws.length - 1);
      const target = Math.ceil(plainTotal / Math.max(1, Math.ceil(plainTotal / MAX_CHARS)));

      const local = [];
      let chunk = [];
      let len = 0;
      const flush = () => {
        if (!chunk.length) return;
        const head = chunk[0];
        const tail = chunk[chunk.length - 1];
        let from = head.pos;
        let to = tail.pos + tail.raw.length;
        while (to < text.length && PUNCT_TAIL.test(text[to])) to += 1;
        let slice = text.slice(from, to).trim();
        const joined = chunk.map((w) => w.raw).join(' ');
        if (!slice || stripPunct(slice) !== stripPunct(joined)) slice = joined;
        local.push({
          text: slice,
          words: chunk.slice(),
          start: head.offset_ms / 1000,
          end: (tail.offset_ms + tail.duration_ms) / 1000,
        });
        chunk = [];
        len = 0;
      };
      for (const w of ws) {
        const add = (len ? 1 : 0) + stripPunct(w.raw).length;
        if (chunk.length && len + add > target) flush();
        chunk.push(w);
        len += add;
      }
      flush();

      // 마지막 조각이 한두 단어짜리로 남으면 앞 조각에 붙임
      while (local.length > 1) {
        const last = local[local.length - 1];
        const prev = local[local.length - 2];
        if (stripPunct(last.text).length < 12 && stripPunct(prev.text).length + stripPunct(last.text).length <= MAX_CHARS + 10) {
          prev.text = `${prev.text} ${last.text}`.trim();
          prev.words = prev.words.concat(last.words);
          prev.end = last.end;
          local.pop();
        } else break;
      }
      cues.push(...local);
    });

    // 단어가 없는 큐는 글자 수로 길이 추정
    const fallbackRate = (VOICES[currentVoice()] || {}).cps || 4.6;
    const speed = 1 + Number(el.rate.value) / 100;
    let prevEnd = 0;
    for (const c of cues) {
      if (c.start == null) {
        const chars = Math.max(1, stripPunct(c.text).length);
        const dur = Math.max(0.6, chars / fallbackRate / speed);
        c.start = prevEnd;
        c.end = prevEnd + dur;
      }
      if (c.end <= c.start) c.end = c.start + 0.5;
      prevEnd = c.end;
    }

    // 다음 자막 시작까지만 남기고, 너무 길게 끌지 않는다
    for (let i = 0; i < cues.length; i += 1) {
      const c = cues[i];
      const next = cues[i + 1];
      if (next) {
        c.end = Math.max(c.start + 0.4, Math.min(next.start, c.end + 0.9));
      } else {
        c.end = c.end + 0.35;
      }
    }

    // 자막끼리 겹치지 않게 정리
    for (let i = 1; i < cues.length; i += 1) {
      const prev = cues[i - 1];
      const cur = cues[i];
      if (cur.start < prev.start) cur.start = prev.start;
      if (cur.end <= cur.start) cur.end = cur.start + 0.4;
      if (prev.end > cur.start) prev.end = cur.start;
    }
    return cues;
  }

  // 긴 문장을 단어 경계에서 비슷한 길이로 나눈다
  function splitLong(text, maxChars) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= maxChars) return [t];
    const parts = Math.ceil(t.length / maxChars);
    const target = Math.ceil(t.length / parts);
    const out = [];
    let cur = '';
    for (const w of t.split(' ')) {
      if (!cur) { cur = w; continue; }
      if ((cur + ' ' + w).length <= target) cur += ' ' + w;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    while (out.length > 1) {
      const last = out[out.length - 1];
      const prev = out[out.length - 2];
      if (last.length < 12 && (prev + ' ' + last).length <= maxChars + 10) {
        out.splice(out.length - 2, 2, `${prev} ${last}`);
      } else break;
    }
    return out.length ? out : [t];
  }

  // 단어 타이밍 없이(서버 없이) 만드는 추정 자막
  function estimateCues(text, mode) {
    const segs = splitSegments(text, mode);
    const rate = Number(el.rate.value);
    const total = estimate(text, currentVoice(), rate);
    const MAX_CHARS = 34;

    const pieces = [];
    for (const s of segs) {
      for (const p of splitLong(s.text, MAX_CHARS)) pieces.push(p);
    }

    const weights = pieces.map((p) => Math.max(1, stripPunct(p).length));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let t = 0.1;
    return pieces.map((p, i) => {
      const dur = Math.max(0.6, (total - 0.1) * (weights[i] / sum));
      const cue = { text: p, words: [], start: t, end: t + dur };
      t += dur;
      return cue;
    });
  }

  // ── SRT ─────────────────────────────────────────────
  function wrapLine(text, max = 18, maxLines = 2) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length <= max) return [t];
    const words = t.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur) { cur = w; continue; }
      if ((cur + ' ' + w).length <= max) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines) return lines;
    // 너무 길면 앞에서 maxLines 줄로 합치고 남는 건 이어 붙임
    const kept = lines.slice(0, maxLines - 1);
    kept.push(lines.slice(maxLines - 1).join(' '));
    return kept;
  }

  function srtTime(sec) {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)},${pad(r, 3)}`;
  }

  function buildSrt(cues) {
    return cues.map((c, i) => (
      `${i + 1}\r\n${srtTime(c.start)} --> ${srtTime(c.end)}\r\n${wrapLine(c.text).join('\r\n')}\r\n`
    )).join('\r\n');
  }

  // ── 결과 렌더 ────────────────────────────────────────
  function renderCues(cues, exact) {
    state.cues = cues;
    state.exact = exact;
    el.subsList.innerHTML = '';
    if (!cues.length) {
      el.subsWrap.hidden = true;
      return;
    }
    const frag = document.createDocumentFragment();
    cues.forEach((c, i) => {
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.innerHTML = `<span class="t">${srtTime(c.start).slice(3, 12)}</span><span class="x">${escapeHtml(wrapLine(c.text).join('\n'))}</span>`;
      frag.appendChild(li);
    });
    el.subsList.appendChild(frag);
    el.subsWrap.hidden = false;
    el.dlWrap.hidden = false;
    el.btnMp3.disabled = !state.audioBlob;
    el.dlHint.hidden = !!state.audioBlob;
    el.subsCount.textContent = `${cues.length}개 자막 · ${exact ? '실제 음성 타이밍' : '예상 타이밍'}`;
    el.btnSrt.disabled = false;
  }

  function clearResult() {
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
    state.audioUrl = null;
    state.audioBlob = null;
    state.words = [];
    state.cues = [];
    state.generatedText = null;
    el.audio.removeAttribute('src');
    el.playerWrap.hidden = true;
    el.dlWrap.hidden = true;
    el.btnMp3.disabled = true;
    el.subsWrap.hidden = true;
    el.subsList.innerHTML = '';
    el.empty.hidden = false;
  }

  // 대본이 바뀌었을 때 결과만 걷어내고 새 대본으로 다시 시작
  function resetGenerated() {
    clearResult();
    el.error.hidden = true;
  }

  function showError(msg, hint) {
    el.error.hidden = false;
    el.error.innerHTML = `<b>${escapeHtml(msg)}</b>${hint ? `<br><span style="color:#e7b8bf">${escapeHtml(hint)}</span>` : ''}`;
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'audio/mpeg' });
  }

  // ── 생성 ────────────────────────────────────────────
  async function generate() {
    if (state.generating) return;
    const text = normalizeText(el.text.value);
    if (!text) { toast('대본을 먼저 입력해 주세요'); el.text.focus(); return; }

    if (!state.online) {
      const ok = await checkHealth(false);
      if (!ok) {
        showError('로컬 서버가 꺼져 있어 음성을 만들 수 없습니다.', 'ZIP을 받아 실행하기.bat 을 켠 뒤 다시 시도하거나, [브라우저 미리듣기]로 먼저 확인해 보세요.');
        el.notice.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('서버가 꺼져 있어요 · 아래 안내를 확인해 주세요');
        return;
      }
    }

    state.generating = true;
    el.error.hidden = true;
    el.btnGenerate.disabled = true;
    el.btnGenerateText.textContent = '음성 만드는 중…';
    el.btnGenerate.querySelector('.spin').hidden = false;
    el.empty.hidden = true;
    el.playerWrap.hidden = true;
    el.dlWrap.hidden = true;
    el.subsWrap.hidden = true;
    el.btnMp3.disabled = true;
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }

    const voice = currentVoice();
    const rate = Number(el.rate.value);
    const pitch = Number(el.pitch.value);
    const body = JSON.stringify({ text, voice, rate: signed(rate) + '%', pitch: signed(pitch) + 'Hz' });
    const started = Date.now();

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);
      const res = await fetch(state.base + '/tts?format=json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        let msg = `음성 생성 실패 (HTTP ${res.status})`;
        let hint = '';
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
          if (j && j.hint) hint = j.hint;
        } catch (_) { /* ignore */ }
        throw Object.assign(new Error(msg), { hint });
      }

      const data = await res.json();
      if (!data || !data.audio_base64) throw new Error('음성 데이터를 받지 못했습니다.');

      state.audioBlob = b64ToBlob(data.audio_base64, data.mime || 'audio/mpeg');
      state.audioUrl = URL.createObjectURL(state.audioBlob);
      state.words = Array.isArray(data.words) ? data.words : [];

      el.audio.src = state.audioUrl;
      el.playerWrap.hidden = false;

      const total = (data.duration_ms || 0) / 1000;
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      el.audioMeta.textContent = `${fmtClock(total)} · ${(state.audioBlob.size / 1024).toFixed(0)}KB · ${(VOICES[voice] || {}).name || ''} ${signed(rate)}% / ${signed(pitch)}Hz · ${elapsed}초 만에 생성`;
      el.audioWarn.hidden = true;

      const cues = makeCues(text, state.words, el.split.value);
      renderCues(cues, state.words.length > 0);
      state.lastStamp = stamp();
      state.generatedText = text;
      el.btnMp3.disabled = false;
      el.dlWrap.hidden = false;
      el.dlHint.hidden = true;
      el.empty.hidden = true;
      el.subsWrap.hidden = false;
      el.subsList.scrollTop = 0;

      toast(`완성 · 음성 ${fmtClock(total)} / 자막 ${cues.length}개`);
      el.audio.play().catch(() => { /* 자동 재생 차단은 무시 */ });
    } catch (err) {
      const isAbort = err && err.name === 'AbortError';
      showError(
        isAbort ? '시간이 너무 오래 걸려 중단했습니다.' : (err.message || '음성 생성 중 문제가 생겼습니다.'),
        err.hint || (isAbort ? '대본을 짧게 나눠서 다시 시도해 보세요.' : '잠시 뒤 다시 시도해 보세요. 계속 실패하면 실행하기.bat 창의 오류 메시지를 확인해 주세요.')
      );
      el.empty.hidden = false;
      if (!isAbort && /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')) {
        await checkHealth(true);
      }
    } finally {
      state.generating = false;
      el.btnGenerateText.textContent = '🎧 음성 생성';
      el.btnGenerate.querySelector('.spin').hidden = true;
      updateEstimate();
    }
  }

  // ── 브라우저 미리듣기 ─────────────────────────────────
  function pickBrowserVoice() {
    const list = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const ko = list.filter((v) => /ko/i.test(v.lang));
    if (!ko.length) return null;
    const want = currentVoice();
    if (want === 'ko-KR-SunHiNeural') return ko.find((v) => /female|여성/i.test(v.name)) || ko[0];
    return ko.find((v) => /male|남성/i.test(v.name)) || ko[0];
  }

  function browserSpeak(text = null, voiceId = null, opts = {}) {
    if (!('speechSynthesis' in window)) { toast('이 브라우저는 미리듣기를 지원하지 않아요'); return; }
    const content = normalizeText(text || el.text.value);
    if (!content) { toast('대본을 먼저 입력해 주세요'); return; }
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(content);
    u.lang = 'ko-KR';
    u.rate = Math.max(0.5, Math.min(2, 1 + Number(el.rate.value) / 100));
    u.pitch = Math.max(0.5, Math.min(1.8, 1 + Number(opts.pitch != null ? opts.pitch : el.pitch.value) / 200));
    const v = voiceId ? (speechSynthesis.getVoices().find((x) => /ko/i.test(x.lang) && (voiceId.includes('SunHi') ? /female|여성/i.test(x.name) : /male|남성/i.test(x.name))) || pickBrowserVoice()) : pickBrowserVoice();
    if (v) u.voice = v;
    u.onstart = () => { el.btnStop.hidden = false; };
    u.onend = () => { el.btnStop.hidden = true; };
    u.onerror = () => { el.btnStop.hidden = true; };
    speechSynthesis.speak(u);
    el.btnStop.hidden = false;
    toast('브라우저 미리듣기 · 실제 결과와 다를 수 있어요');
  }

  async function previewVoice(id) {
    const btn = document.querySelector(`.v-play[data-preview="${id}"]`);
    if (!state.online) { browserSpeak(SAMPLE_TEXT, id, { pitch: 0 }); return; }
    if (state.busyVoice) return;
    state.busyVoice = id;
    if (btn) { btn.classList.add('busy'); btn.textContent = '…'; }
    try {
      const res = await fetch(state.base + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: SAMPLE_TEXT, voice: id, rate: '+0%', pitch: '+0Hz' }),
      });
      if (!res.ok) throw new Error('미리듣기를 만들지 못했어요');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (err) {
      toast(err.message || '미리듣기 실패');
    } finally {
      state.busyVoice = null;
      if (btn) { btn.classList.remove('busy'); btn.textContent = '▶'; }
    }
  }

  // ── 다운로드 ─────────────────────────────────────────
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function ensureCues() {
    if (state.cues.length) return state.cues;
    const text = normalizeText(el.text.value);
    if (!text) { toast('대본을 먼저 입력해 주세요'); return null; }
    const cues = estimateCues(text, el.split.value);
    renderCues(cues, false);
    return cues;
  }

  function downloadSrt() {
    const cues = ensureCues();
    if (!cues) return;
    const srt = buildSrt(cues);
    const name = state.lastStamp ? `tts-${state.lastStamp}.srt` : `tts-${stamp()}.srt`;
    download(new Blob(['\ufeff' + srt], { type: 'text/plain;charset=utf-8' }), name);
    toast(`${name} 저장 · ${cues.length}개 자막`);
    if (!state.exact) el.audioWarn.hidden = false;
  }

  async function copySrt() {
    const cues = ensureCues();
    if (!cues) return;
    const srt = buildSrt(cues);
    try {
      await navigator.clipboard.writeText(srt);
      toast('자막(SRT)을 복사했어요');
    } catch (_) {
      toast('복사가 막혔어요 · .srt 저장을 이용해 주세요');
    }
  }

  function downloadMp3() {
    if (!state.audioBlob) {
      toast('먼저 음성을 생성해 주세요');
      return;
    }
    const name = `tts-${state.lastStamp || stamp()}.mp3`;
    download(state.audioBlob, name);
    toast(`${name} 저장`);
  }

  // ── 재생 하이라이트 ───────────────────────────────────
  function highlightCue() {
    if (!state.cues.length) return;
    const t = el.audio.currentTime;
    let active = -1;
    for (let i = 0; i < state.cues.length; i += 1) {
      if (t >= state.cues[i].start && t < state.cues[i].end) { active = i; break; }
    }
    el.subsList.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('active', Number(li.dataset.index) === active);
    });
    if (active >= 0) {
      const li = el.subsList.children[active];
      if (li && el.subsList.scrollHeight > el.subsList.clientHeight) {
        const top = li.offsetTop - el.subsList.clientHeight / 2;
        if (Math.abs(el.subsList.scrollTop - top) > 40) el.subsList.scrollTo({ top, behavior: 'smooth' });
      }
    }
  }

  // ── 이벤트 연결 ──────────────────────────────────────
  function bind() {
    el.text.addEventListener('input', () => {
      // 대본이 바뀌면 이전 음성·자막은 더 이상 이 대본의 결과가 아니다
      if (state.generatedText && normalizeText(el.text.value) !== state.generatedText) {
        resetGenerated();
      }
      updateEstimate();
      saveSettings();
    });
    el.rate.addEventListener('input', () => { syncSliders(); updateEstimate(); saveSettings(); });
    el.pitch.addEventListener('input', () => { syncSliders(); saveSettings(); });
    el.split.addEventListener('change', () => {
      const hint = {
        auto: '한 자막이 너무 길면 읽기 좋게 다시 나눕니다.',
        line: '줄바꿈한 단위로 자막을 만듭니다.',
        sentence: '마침표·쉼표마다 자막을 나눕니다.',
      };
      el.splitHint.textContent = hint[el.split.value] || hint.auto;
      state.cues = [];
      if (!el.subsWrap.hidden) {
        const text = normalizeText(el.text.value);
        if (state.words.length) renderCues(makeCues(text, state.words, el.split.value), true);
        else ensureCues();
      }
      saveSettings();
    });

    el.voices.addEventListener('change', (e) => {
      if (e.target && e.target.name === 'voice') { setVoice(e.target.value); }
    });
    el.voices.addEventListener('click', (e) => {
      const btn = e.target.closest('.v-play');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        previewVoice(btn.dataset.preview);
      }
    });

    document.querySelectorAll('.chip[data-ex]').forEach((chip) => {
      chip.addEventListener('click', () => {
        el.text.value = EX[chip.dataset.ex] || '';
        updateEstimate();
        saveSettings();
        el.text.focus();
      });
    });

    el.btnClear.addEventListener('click', () => {
      el.text.value = '';
      updateEstimate();
      saveSettings();
      clearResult();
      el.text.focus();
    });

    el.btnGenerate.addEventListener('click', generate);
    el.btnPreview.addEventListener('click', () => browserSpeak());
    el.btnStop.addEventListener('click', () => {
      if (window.speechSynthesis) speechSynthesis.cancel();
      el.btnStop.hidden = true;
      if (!el.audio.paused) el.audio.pause();
    });

    el.btnMp3.addEventListener('click', downloadMp3);
    el.btnSrt.addEventListener('click', downloadSrt);
    el.btnCopySrt.addEventListener('click', copySrt);

    el.btnRetry.addEventListener('click', () => checkHealth(false).then((ok) => toast(ok ? '서버에 연결됐어요' : '아직 서버가 안 보여요 · 실행하기.bat 을 확인해 주세요')));
    el.btnNoticeRetry.addEventListener('click', () => checkHealth(false).then((ok) => {
      toast(ok ? '연결 성공! 이제 음성을 만들 수 있어요' : '아직 연결이 안 됩니다');
      if (ok) el.notice.hidden = true;
    }));

    el.audio.addEventListener('timeupdate', highlightCue);
    el.audio.addEventListener('seeked', highlightCue);
    el.audio.addEventListener('error', () => {
      if (state.audioUrl) toast('음성 파일을 재생할 수 없어요');
    });

    el.subsList.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li || !state.audioUrl) return;
      const cue = state.cues[Number(li.dataset.index)];
      if (cue) {
        el.audio.currentTime = Math.max(0, cue.start);
        el.audio.play().catch(() => { /* ignore */ });
      }
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
    });

    window.addEventListener('online', () => checkHealth(true));
    window.addEventListener('offline', () => setStatus('off', '인터넷 끊김'));
    window.addEventListener('beforeunload', () => {
      if (window.speechSynthesis) speechSynthesis.cancel();
    });
  }

  // ── 시작 ────────────────────────────────────────────
  loadSettings();
  bind();
  updateEstimate();
  checkHealth(true);
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { /* 브라우저 음성 목록 로딩 트리거 */ };
    speechSynthesis.getVoices();
  }
  // 서버가 늦게 뜨는 경우를 위해 한 번 더 확인
  setTimeout(() => { if (!state.online) checkHealth(true); }, 2500);
})();
