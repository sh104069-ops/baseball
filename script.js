/* =========================================================
   やきゅうバッティングゲーム  script.js
   - 外部ファイル・画像・音源は使わない(すべてコードで描画・合成)
   - 2人対戦 / 3回制 / 野球盤ルール
   ========================================================= */
(() => {
'use strict';

/* =========================================================
   1. 設定
   ========================================================= */
const MAX_INNING   = 3;   // 規定回数
const EXTRA_INNING = 3;   // 同点時の延長(最大)

const TEAM = [
  { color: '#e5383b', dark: '#8f1519' },   // 先攻(赤)
  { color: '#2f6fe0', dark: '#17337a' }    // 後攻(青)
];

// 球速: T = ボールがホームベースに届くまでの時間(ms)
const SPEEDS = [
  { key: 'slow',  label: '低速',   kmh: 90,  T: 1650, w: 30 },
  { key: 'mid',   label: '中速',   kmh: 120, T: 1200, w: 30 },
  { key: 'fast',  label: '高速',   kmh: 145, T: 880,  w: 25 },
  { key: 'super', label: '超高速', kmh: 165, T: 640,  w: 15 }
];

// タイミングゲージ(左から右へ 0→1)。針の位置 p の中心 0.5 がボール到達の瞬間
const ZONES = [
  { kind: 'k',  w: .27 }, { kind: 'g',  w: .09 }, { kind: 'f',  w: .06 },
  { kind: 'h1', w: .04 }, { kind: 'h2', w: .03 }, { kind: 'h3', w: .02 },
  { kind: 'hr', w: .03 },
  { kind: 'h3', w: .02 }, { kind: 'h2', w: .03 }, { kind: 'h1', w: .04 },
  { kind: 'f',  w: .06 }, { kind: 'dp', w: .09 }, { kind: 'k',  w: .22 }
];
const ZINFO = {
  k:  { label: '三振',       vert: false },
  g:  { label: 'ゴロ',       vert: false },
  dp: { label: '併殺',       vert: false },
  f:  { label: '好守',       vert: true  },
  h1: { label: 'ヒット',     vert: true  },
  h2: { label: '二塁打',     vert: true  },
  h3: { label: '三塁打',     vert: true  },
  hr: { label: 'ホームラン', vert: true  }
};
const NEEDLE_END = 0.78;   // これ以降は「見逃し三振」

/* =========================================================
   2. ユーティリティ
   ========================================================= */
const $ = id => document.getElementById(id);
const rnd   = (a, b) => a + Math.random() * (b - a);
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const pick  = arr => arr[(Math.random() * arr.length) | 0];
const esc   = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ---- ゲーム内時計(タブが裏に回っても進みすぎない) ---- */
let vnow = 0, lastReal = performance.now();
const gnow = () => vnow + Math.min(performance.now() - lastReal, 50);

/* ---- タイマー ---- */
let timers = [];
function schedule(ms, fn) {
  const id = state.gameId;
  timers.push({ at: gnow() + ms, fn: () => { if (id === state.gameId) fn(); } });
}

/* =========================================================
   3. ゲーム状態
   ========================================================= */
const state = {
  names: ['プレイヤー1', 'プレイヤー2'],
  inning: 1,
  half: 0,                    // 0=オモテ(先攻) 1=ウラ(後攻)
  scores: [[0], []],          // [チーム][回] = 得点 or 'X'
  outs: 0,
  bases: [false, false, false],
  gameId: 0
};
let phase = 'title';          // title | idle | windup | pitch | swung | result | after | over

const pitch = { sp: SPEEDS[1], T: 1200, t0: 0, swung: false, swingAt: 0, mitt: false, released: false };
let windStart = 0, windDur = 0;
let curRes = null, resultSeq = 0;
let swingAtBat = null;        // バットを振り始めた時刻

const totalOf = t => state.scores[t].reduce((a, v) => a + (typeof v === 'number' ? v : 0), 0);

/* =========================================================
   4. DOM
   ========================================================= */
const cv = $('stage'), ctx = cv.getContext('2d');
const SC = cv.width / 960;                  // 論理座標 960x540
const gaugeEl = $('gauge'), needleEl = $('needle'), swingBtn = $('swingBtn');
const bannerEl = $('banner'), toastEl = $('toast'), cueEl = $('cue'), speedEl = $('speedLabel');
const titleScreen = $('titleScreen'), ov = $('overlay');
const ovTitle = $('ovTitle'), ovBody = $('ovBody'), ovBtn = $('ovBtn'), ovBtn2 = $('ovBtn2');

/* ---- ゲージ生成 ---- */
const segEls = ZONES.map(z => {
  const info = ZINFO[z.kind];
  const d = document.createElement('div');
  d.className = 'seg z-' + z.kind + (info.vert ? ' vert' : '');
  d.style.flexGrow = String(z.w * 100);
  const sp = document.createElement('span');
  sp.textContent = info.label;
  d.appendChild(sp);
  gaugeEl.appendChild(d);
  return d;
});

function zoneIndexAt(p) {
  let acc = 0;
  for (let i = 0; i < ZONES.length; i++) {
    acc += ZONES[i].w;
    if (p <= acc + 1e-9) return i;
  }
  return ZONES.length - 1;
}
function setNeedle(p) { needleEl.style.left = (clamp(p, 0, 1) * 100).toFixed(2) + '%'; }
function clearGaugeLock() { segEls.forEach(e => e.classList.remove('lock')); setNeedle(0); }

/* ---- スコアボード / ステータス ---- */
function renderHUD() {
  const n = Math.max(MAX_INNING, state.inning);
  let h = '<table><thead><tr><th class="team"></th>';
  for (let i = 1; i <= n; i++) h += `<th class="${i === state.inning ? 'cur' : ''}">${i}</th>`;
  h += '<th class="tot">計</th></tr></thead><tbody>';
  for (let t = 0; t < 2; t++) {
    const batting = phase !== 'title' && phase !== 'over' && state.half === t;
    h += `<tr><td class="team ${batting ? 'bat' : ''}"><span class="dot" style="background:${TEAM[t].color}"></span>${esc(state.names[t])}</td>`;
    for (let i = 1; i <= n; i++) {
      const v = state.scores[t][i - 1];
      const now = phase !== 'title' && phase !== 'over' && i === state.inning && state.half === t;
      h += `<td class="${now ? 'now' : ''}">${v === undefined ? '' : v}</td>`;
    }
    h += `<td class="tot">${totalOf(t)}</td></tr>`;
  }
  h += '</tbody></table>';
  $('scoreboard').innerHTML = h;

  $('inningLabel').textContent = (state.inning > MAX_INNING ? '延長' : '') + state.inning + '回' + (state.half ? 'ウラ' : 'オモテ');
  document.querySelectorAll('#outs i').forEach((e, i) => e.classList.toggle('on', state.outs > i));
  ['baseB1', 'baseB2', 'baseB3'].forEach((id, i) => $(id).classList.toggle('on', state.bases[i]));
}

/* ---- バナー / トースト / キュー ---- */
let bannerTimer = 0;
function showBanner(text, cls) {
  bannerEl.className = '';
  void bannerEl.offsetWidth;                 // アニメーション再始動
  bannerEl.textContent = text;
  bannerEl.className = 'show ' + (cls || '');
}
function hideBanner() { bannerEl.className = ''; bannerEl.textContent = ''; }
function showToast(text) {
  toastEl.className = '';
  void toastEl.offsetWidth;
  toastEl.textContent = text;
  toastEl.className = 'show';
}
function setCue(t) { cueEl.textContent = t || ''; }

/* ---- オーバーレイ ---- */
let ovAction = null, ovAction2 = null, lastAct = 0;
function guard(fn) {
  const n = performance.now();
  if (n - lastAct < 350) return;
  lastAct = n;
  fn();
}
function showOverlay(title, body, btnText, action, btn2Text, action2) {
  ovTitle.textContent = title;
  ovBody.textContent = body;
  ovBtn.textContent = btnText;
  ovAction = action;
  if (btn2Text) { ovBtn2.hidden = false; ovBtn2.textContent = btn2Text; ovAction2 = action2; }
  else ovBtn2.hidden = true;
  ov.hidden = false;
}
ovBtn.addEventListener('click', () => guard(() => { ov.hidden = true; if (ovAction) ovAction(); }));
ovBtn2.addEventListener('click', () => guard(() => { ov.hidden = true; if (ovAction2) ovAction2(); }));

/* =========================================================
   5. オーディオ(Web Audio API で合成 ─ 音源ファイル不要)
   ========================================================= */
const Aud = { ctx: null, bgm: null, se: null, noise: null, bgmOn: true, seOn: true, timer: null, next: 0, step: 0 };
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function initAudio() {
  if (Aud.ctx) { if (Aud.ctx.state === 'suspended') Aud.ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const c = new AC();
  Aud.ctx = c;
  const master = c.createGain(); master.gain.value = 0.9;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 6;
  master.connect(comp); comp.connect(c.destination);
  Aud.bgm = c.createGain(); Aud.bgm.gain.value = Aud.bgmOn ? 0.34 : 0; Aud.bgm.connect(master);
  Aud.se  = c.createGain(); Aud.se.gain.value  = Aud.seOn ? 0.9 : 0;  Aud.se.connect(master);
  const len = c.sampleRate * 2;
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  Aud.noise = buf;
  startBGM();
}

function noiseHit(dest, t, dur, o = {}) {
  const c = Aud.ctx; if (!c) return;
  const { type = 'highpass', freq = 1000, freqTo, q = 1, vol = .3, attack = .002 } = o;
  const s = c.createBufferSource(); s.buffer = Aud.noise; s.loop = true;
  const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
}
function oscHit(dest, t, freq, dur, o = {}) {
  const c = Aud.ctx; if (!c) return;
  const { type = 'sine', vol = .3, freqTo, attack = .004 } = o;
  const s = c.createOscillator(); s.type = type;
  s.frequency.setValueAtTime(freq, t);
  if (freqTo) s.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(g); g.connect(dest);
  s.start(t); s.stop(t + dur + 0.05);
}
// ブラス(トランペット風)
function brass(dest, t, freq, dur, vol) {
  const c = Aud.ctx; if (!c) return;
  dur = Math.max(dur, 0.09);
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  o1.type = o2.type = 'sawtooth';
  o1.frequency.value = freq; o2.frequency.value = freq * 1.005;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 1.5;
  f.frequency.setValueAtTime(freq * 1.4, t);
  f.frequency.linearRampToValueAtTime(Math.min(freq * 5, 6500), t + 0.03);
  f.frequency.exponentialRampToValueAtTime(freq * 2.6, t + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.015);
  g.gain.setValueAtTime(vol * 0.85, t + dur - 0.05);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(dest);
  o1.start(t); o2.start(t); o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
}
// チューバ(低音)
function tuba(t, freq, dur, vol) {
  const c = Aud.ctx; if (!c) return;
  const o1 = c.createOscillator(), o2 = c.createOscillator();
  o1.type = 'triangle'; o2.type = 'square';
  o1.frequency.value = freq; o2.frequency.value = freq;
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 520;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o1.connect(f); o2.connect(f); f.connect(g); g.connect(Aud.bgm);
  o1.start(t); o2.start(t); o1.stop(t + dur + 0.03); o2.stop(t + dur + 0.03);
}
function kick(t)  { oscHit(Aud.bgm, t, 150, 0.18, { freqTo: 45, vol: .85 }); }
function snare(t, v = .42) {
  noiseHit(Aud.bgm, t, 0.13, { type: 'highpass', freq: 1400, vol: v });
  oscHit(Aud.bgm, t, 190, 0.07, { type: 'triangle', vol: v * .5 });
}
function hat(t)   { noiseHit(Aud.bgm, t, 0.035, { type: 'highpass', freq: 7500, vol: .09 }); }
function crash(t) { noiseHit(Aud.bgm, t, 0.9, { type: 'highpass', freq: 4200, vol: .3, attack: .004 }); }

/* ---- BGM: 応援団ふうのオリジナル行進曲(8小節ループ) ---- */
const BPM = 138, STEP = 60 / BPM / 4;
const CH = {
  C:  { pcs: [0, 4, 7],  root: 48, fifth: 43, stab: [60, 64, 67] },
  F:  { pcs: [5, 9, 0],  root: 41, fifth: 48, stab: [60, 65, 69] },
  G:  { pcs: [7, 11, 2], root: 43, fifth: 50, stab: [59, 62, 67] },
  Am: { pcs: [9, 0, 4],  root: 45, fifth: 52, stab: [60, 64, 69] }
};
const BARS = ['C', 'C', 'F', 'G', 'C', 'Am', 'FG', 'C'];
const MEL = [   // [開始ステップ(16分), MIDIノート, 長さ]
  [[0,79,2],[2,79,2],[4,76,2],[6,79,2],[8,84,4],[12,79,2],[14,76,2]],
  [[0,79,2],[2,79,2],[4,76,2],[6,72,2],[8,76,4],[12,74,2],[14,76,2]],
  [[0,81,2],[2,81,2],[4,77,2],[6,81,2],[8,84,4],[12,81,2],[14,77,2]],
  [[0,83,2],[2,83,2],[4,79,2],[6,83,2],[8,86,4],[12,83,2],[14,79,2]],
  [[0,79,2],[2,79,2],[4,76,2],[6,79,2],[8,84,2],[10,86,2],[12,88,4]],
  [[0,84,2],[2,84,2],[4,81,2],[6,84,2],[8,88,4],[12,84,2],[14,81,2]],
  [[0,81,2],[2,84,2],[4,81,2],[6,77,2],[8,79,2],[10,83,2],[12,86,2],[14,83,2]],
  [[0,88,2],[2,84,2],[4,79,2],[6,76,2],[8,72,5]]
];
const MELMAP = new Array(128).fill(null);
MEL.forEach((bar, b) => bar.forEach(([s, m, d]) => { MELMAP[b * 16 + s] = { m, d }; }));

function chordAt(bar, sb) {
  const k = BARS[bar];
  if (k === 'FG') return sb < 8 ? CH.F : CH.G;
  return CH[k];
}
function harmonize(m, pcs) {
  for (let x = m - 3; x > m - 13; x--) if (pcs.includes(((x % 12) + 12) % 12)) return x;
  return m - 5;
}
function playStep(s, t) {
  const bar = s >> 4, sb = s & 15, ch = chordAt(bar, sb);
  // ベース(ズン・チャ)
  if (sb % 4 === 0) tuba(t, mtof(sb % 8 === 0 ? ch.root : ch.fifth), STEP * 2.6, 0.32);
  // 和音のスタブ(2・4拍)
  if (sb === 4 || sb === 12) ch.stab.forEach(m => brass(Aud.bgm, t, mtof(m), STEP * 2.2, 0.045));
  // ドラム
  if (sb === 0 || sb === 8) kick(t);
  if (sb === 4 || sb === 12) snare(t);
  if (sb % 2 === 0) hat(t);
  if (bar === 3 && sb >= 14) snare(t, 0.3);
  if (bar === 7 && sb >= 12) snare(t, 0.22 + (sb - 12) * 0.08);
  if ((bar === 0 || bar === 4) && sb === 0) crash(t);
  // メロディ + ハモリ
  const n = MELMAP[s];
  if (n) {
    const dur = n.d * STEP * 0.92;
    brass(Aud.bgm, t, mtof(n.m), dur, 0.12);
    brass(Aud.bgm, t, mtof(harmonize(n.m, ch.pcs)), dur, 0.07);
  }
}
function bgmSchedule() {
  const c = Aud.ctx; if (!c) return;
  if (Aud.next < c.currentTime - 0.5) Aud.next = c.currentTime + 0.05;
  while (Aud.next < c.currentTime + 0.18) {
    playStep(Aud.step % 128, Aud.next);
    Aud.next += STEP;
    Aud.step++;
  }
}
function startBGM() {
  if (Aud.timer || !Aud.ctx) return;
  Aud.next = Aud.ctx.currentTime + 0.1;
  Aud.step = 0;
  Aud.timer = setInterval(bgmSchedule, 30);
}

/* ---- 効果音 ---- */
const sfx = {
  ok() { return Aud.ctx && Aud.seOn; },
  pitch() { if (!this.ok()) return; const t = Aud.ctx.currentTime;
    noiseHit(Aud.se, t, 0.28, { type: 'bandpass', freq: 500, freqTo: 1800, q: 2, vol: .22, attack: .08 }); },
  swing() { if (!this.ok()) return; const t = Aud.ctx.currentTime;
    noiseHit(Aud.se, t, 0.16, { type: 'bandpass', freq: 2200, freqTo: 600, q: 1.5, vol: .3 }); },
  hit(power) { if (!this.ok()) return; const t = Aud.ctx.currentTime + 0.02;
    noiseHit(Aud.se, t, 0.07, { type: 'highpass', freq: 1800, vol: .9 * power + .1 });
    oscHit(Aud.se, t, 260, 0.14, { freqTo: 70, vol: .7 * power + .1 }); },
  mitt() { if (!this.ok()) return; const t = Aud.ctx.currentTime;
    noiseHit(Aud.se, t, 0.09, { type: 'lowpass', freq: 700, vol: .8 });
    oscHit(Aud.se, t, 140, 0.12, { freqTo: 60, vol: .6 }); },
  out() { if (!this.ok()) return; const t = Aud.ctx.currentTime + 0.05;
    oscHit(Aud.se, t, 330, 0.18, { type: 'sawtooth', vol: .16, freqTo: 300 });
    oscHit(Aud.se, t + 0.2, 247, 0.32, { type: 'sawtooth', vol: .16, freqTo: 200 }); },
  fine() { if (!this.ok()) return; const t = Aud.ctx.currentTime + 0.05;
    [523, 659, 784].forEach((f, i) => oscHit(Aud.se, t + i * 0.08, f, 0.16, { type: 'square', vol: .12 })); },
  cheer(sec) { if (!this.ok()) return; const t = Aud.ctx.currentTime + 0.1;
    noiseHit(Aud.se, t, sec, { type: 'bandpass', freq: 900, freqTo: 1400, q: .7, vol: .5, attack: .35 });
    noiseHit(Aud.se, t, sec, { type: 'bandpass', freq: 2400, q: .8, vol: .18, attack: .5 }); },
  fanfare(long) { if (!this.ok()) return; const t = Aud.ctx.currentTime + 0.05;
    const seq = long
      ? [[392,.14],[392,.14],[523,.14],[659,.14],[784,.34],[659,.14],[784,.6],[1047,.9]]
      : [[392,.12],[392,.12],[523,.12],[659,.5]];
    let at = t;
    seq.forEach(([f, d]) => { brass(Aud.se, at, f, d * 0.95, .16); brass(Aud.se, at, f / 2, d * 0.95, .1); at += d; }); }
};

/* ---- ミュートボタン ---- */
function refreshAudioBtns() {
  $('bgmBtn').textContent = '♪ BGM ' + (Aud.bgmOn ? 'ON' : 'OFF');
  $('seBtn').textContent  = '🔊 SE ' + (Aud.seOn ? 'ON' : 'OFF');
  $('bgmBtn').classList.toggle('off', !Aud.bgmOn);
  $('seBtn').classList.toggle('off', !Aud.seOn);
}
$('bgmBtn').addEventListener('click', e => {
  e.currentTarget.blur();
  Aud.bgmOn = !Aud.bgmOn;
  if (Aud.bgm) Aud.bgm.gain.setTargetAtTime(Aud.bgmOn ? 0.34 : 0, Aud.ctx.currentTime, 0.05);
  refreshAudioBtns();
});
$('seBtn').addEventListener('click', e => {
  e.currentTarget.blur();
  Aud.seOn = !Aud.seOn;
  if (Aud.se) Aud.se.gain.setTargetAtTime(Aud.seOn ? 0.9 : 0, Aud.ctx.currentTime, 0.05);
  refreshAudioBtns();
});
document.addEventListener('visibilitychange', () => {
  if (!Aud.ctx) return;
  if (document.hidden) Aud.ctx.suspend(); else Aud.ctx.resume();
});

/* =========================================================
   6. グラウンド描画(背景は最初に1回だけ描いて使い回す)
   ========================================================= */
const HOME = { x: 480, y: 470 }, B1 = { x: 670, y: 372 }, B2 = { x: 480, y: 275 }, B3 = { x: 290, y: 372 };
const scaleAt = y => 0.5 + (y - 200) / 270 * 0.65;          // 奥ほど小さく

function rrPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function cloud(g, x, y, r) {
  g.beginPath();
  g.arc(x, y, r, 0, 7); g.arc(x + r * 1.1, y + r * .15, r * .85, 0, 7);
  g.arc(x - r * 1.1, y + r * .25, r * .75, 0, 7); g.arc(x + r * .3, y - r * .5, r * .8, 0, 7);
  g.fill();
}

function buildBackground() {
  const c = document.createElement('canvas');
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d');
  g.scale(SC, SC);
  const R = mulberry32(11);
  const FONT = '"Hiragino Maru Gothic ProN","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo",sans-serif';

  // 空
  let gr = g.createLinearGradient(0, 0, 0, 190);
  gr.addColorStop(0, '#3d9be0'); gr.addColorStop(1, '#cdeeff');
  g.fillStyle = gr; g.fillRect(0, 0, 960, 200);
  g.fillStyle = 'rgba(255,255,255,.92)';
  [[90, 22, 16], [300, 14, 20], [560, 26, 15], [800, 16, 22]].forEach(a => cloud(g, a[0], a[1], a[2]));

  // 照明塔
  [130, 830].forEach(x => {
    g.fillStyle = '#9aa3b0'; g.fillRect(x - 2, 14, 4, 40);
    g.fillStyle = '#e8eef5'; g.fillRect(x - 24, 4, 48, 16);
    g.fillStyle = '#fff7c2';
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) g.fillRect(x - 21 + i * 11, 6 + j * 7, 8, 4);
  });

  // スタンド
  g.fillStyle = '#6f7684'; g.fillRect(0, 50, 960, 136);
  g.fillStyle = '#4d5462'; g.fillRect(0, 44, 960, 8);
  const pal = ['#e63946', '#f1c40f', '#2a9d8f', '#3a86ff', '#ff8fab', '#ffffff', '#ffffff', '#f4a261'];
  for (let r = 0; r < 13; r++) {
    const y = 62 + r * 9.4;
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, y + 5.6, 960, 1.6);
    for (let x = (r % 2) * 3.5 + 3; x < 960; x += 7) {
      const alps = (x < 270 || x > 690);                       // アルプススタンドは白いシャツ
      const col = alps ? (R() < .82 ? '#ffffff' : pal[(R() * pal.length) | 0]) : pal[(R() * pal.length) | 0];
      g.fillStyle = col; g.beginPath(); g.arc(x, y + 2, 3.3, 0, 7); g.fill();
      g.fillStyle = '#f2c9a5'; g.beginPath(); g.arc(x, y - 2.2, 2.3, 0, 7); g.fill();
      g.fillStyle = R() < .5 ? '#2b2b2b' : '#5a3a22'; g.beginPath(); g.arc(x, y - 3.1, 2.3, Math.PI, 0); g.fill();
    }
  }
  // 応援の横断幕
  [[60, 96, 120, 'ファイト!', '#c1121f'], [330, 120, 96, '必勝', '#1d4e89'],
   [560, 92, 116, '全力プレー', '#c1121f'], [790, 116, 120, 'がんばれ!', '#1d4e89']].forEach(a => {
    g.fillStyle = a[4]; g.fillRect(a[0], a[1], a[2], 22);
    g.fillStyle = '#fff'; g.font = 'bold 15px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(a[3], a[0] + a[2] / 2, a[1] + 12);
  });

  // 外野フェンス(ツタ)
  g.fillStyle = '#1f6b3a'; g.fillRect(0, 184, 960, 32);
  for (let x = 0; x < 960; x += 5) {
    g.fillStyle = R() < .5 ? '#2c8a4b' : '#165a2e';
    g.fillRect(x, 184 + R() * 8, 5, 20 + R() * 12);
  }
  g.fillStyle = '#f3d04a'; g.fillRect(0, 182, 960, 3);
  [['ヒット', 60, '#fff'], ['ファイト', 200, '#ffd23f'], ['ホームラン', 340, '#fff'],
   ['やきゅう', 600, '#ffd23f'], ['GO!', 760, '#fff'], ['甲子園', 870, '#fff']].forEach(a => {
    g.fillStyle = 'rgba(10,40,25,.85)'; g.fillRect(a[1] - 4, 192, 76, 16);
    g.fillStyle = a[2]; g.font = 'bold 12px ' + FONT; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(a[0], a[1], 200.5);
  });
  // ファウルポール
  [[24, 214], [936, 214]].forEach(a => { g.fillStyle = '#ffd23f'; g.fillRect(a[0] - 2, 150, 4, 66); });

  // ウォーニングトラック
  g.fillStyle = '#a9794a'; g.fillRect(0, 216, 960, 14);

  // 芝(縞模様)
  let y0 = 230, bh = 9, k = 0;
  while (y0 < 540) {
    g.fillStyle = (k++ % 2) ? '#2f8f3a' : '#3aa347';
    g.fillRect(0, y0, 960, bh + 1);
    y0 += bh; bh *= 1.11;
  }

  // 内野の土
  g.fillStyle = '#c98f55';
  g.beginPath(); g.ellipse(480, 372, 262, 122, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(120,70,20,.35)'; g.lineWidth = 3; g.stroke();
  // 内野の芝
  g.fillStyle = '#3aa347';
  g.beginPath(); g.moveTo(480, 314); g.lineTo(596, 372); g.lineTo(480, 428); g.lineTo(364, 372); g.closePath(); g.fill();
  // ホーム周りの土
  g.fillStyle = '#b97e46';
  g.beginPath(); g.ellipse(480, 470, 60, 26, 0, 0, Math.PI * 2); g.fill();

  // ファウルライン
  g.strokeStyle = '#fff'; g.lineWidth = 2.6;
  [-1, 1].forEach(s => {
    g.beginPath(); g.moveTo(480, 470); g.lineTo(480 + s * 190 * 2.95, 470 - 98 * 2.95); g.stroke();
  });
  // バッターボックス
  g.lineWidth = 2;
  g.strokeRect(418, 444, 40, 54); g.strokeRect(502, 444, 40, 54);

  // ピッチャーマウンド
  g.fillStyle = '#b57a42'; g.beginPath(); g.ellipse(480, 368, 27, 9.5, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.fillRect(473, 361, 14, 3);

  // ベース
  g.fillStyle = '#fff';
  [B1, B2, B3].forEach(b => {
    g.beginPath(); g.moveTo(b.x, b.y - 5); g.lineTo(b.x + 11, b.y); g.lineTo(b.x, b.y + 5); g.lineTo(b.x - 11, b.y); g.closePath(); g.fill();
  });
  g.beginPath();
  g.moveTo(466, 463); g.lineTo(494, 463); g.lineTo(494, 471); g.lineTo(480, 479); g.lineTo(466, 471); g.closePath(); g.fill();

  // 周辺減光
  const v = g.createRadialGradient(480, 320, 220, 480, 320, 640);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.38)');
  g.fillStyle = v; g.fillRect(0, 0, 960, 540);

  return c;
}
const bgCanvas = buildBackground();

/* ---- 選手 ---- */
function drawPerson(x, y, o) {
  const s = o.s || scaleAt(y);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.beginPath(); ctx.ellipse(0, s, 11 * s, 3.5 * s, 0, 0, 7); ctx.fill();
  if (o.rot) { ctx.translate(0, -10 * s); ctx.rotate(o.rot); ctx.translate(0, 10 * s); }
  if (o.sy) ctx.scale(1, o.sy);
  ctx.lineCap = 'round';
  ctx.strokeStyle = o.pants || '#f4f4f4'; ctx.lineWidth = 5 * s;
  ctx.beginPath(); ctx.moveTo(-4 * s, 0); ctx.lineTo(-3.5 * s, -16 * s); ctx.moveTo(4 * s, 0); ctx.lineTo(3.5 * s, -16 * s); ctx.stroke();
  ctx.fillStyle = o.shirt;
  rrPath(ctx, -8 * s, -35 * s, 16 * s, 21 * s, 5 * s); ctx.fill();
  ctx.fillStyle = '#f0c8a0'; ctx.beginPath(); ctx.arc(0, -41 * s, 6 * s, 0, 7); ctx.fill();
  ctx.fillStyle = o.cap; ctx.beginPath(); ctx.arc(0, -42 * s, 6.6 * s, Math.PI, 0); ctx.fill();
  if (!o.back) ctx.fillRect(-7.5 * s, -42.6 * s, 15 * s, 2.2 * s);
  if (o.glove) { ctx.fillStyle = '#8a5a2b'; ctx.beginPath(); ctx.arc(-10 * s, -22 * s, 3.6 * s, 0, 7); ctx.fill(); }
  ctx.restore();
}

/* 野手(動ける) */
const FIELDERS = [
  { id: '1B', hx: 648, hy: 368 }, { id: '2B', hx: 566, hy: 316 }, { id: 'SS', hx: 394, hy: 316 },
  { id: '3B', hx: 312, hy: 368 }, { id: 'LF', hx: 232, hy: 250 }, { id: 'CF', hx: 480, hy: 242 },
  { id: 'RF', hx: 728, hy: 250 }
].map(f => Object.assign(f, { x: f.hx, y: f.hy, tx: f.hx, ty: f.hy, dive: 0, diving: false, dir: 1 }));
const F = id => FIELDERS.find(f => f.id === id);
function moveF(id, x, y) { const f = F(id); f.tx = x; f.ty = y; }
function diveF(id, dir) { const f = F(id); f.diving = true; f.dir = dir; }
function resetFielders() { FIELDERS.forEach(f => { f.tx = f.hx; f.ty = f.hy; f.diving = false; }); }

/* ボール */
const ball = { mode: 'none', gx: 480, gy: 468, h: 14, r: 9, alpha: 1, segs: null, si: 0, st: 0, from: null, onDone: null };
const ballR = (gy) => 2.6 + 6.6 * clamp((gy - 150) / 320, 0, 1);

function startBallAnim(segs, now, onDone) {
  ball.mode = 'hit'; ball.segs = segs; ball.si = 0; ball.st = now;
  ball.from = { x: 480, y: 468, h: 14 }; ball.onDone = onDone; ball.alpha = 1;
}
function updateBall(now) {
  if (ball.mode === 'pitch') {
    const u = clamp((now - pitch.t0) / pitch.T, 0, 1);
    ball.gx = 480; ball.gy = lerp(372, 468, u);
    ball.h = lerp(38, 14, u) + Math.sin(u * Math.PI) * 4;
    ball.r = 3.2 + 6 * Math.pow(u, 1.5);
    ball.alpha = 1;
  } else if (ball.mode === 'mitt') {
    ball.gx = 482; ball.gy = 470; ball.h = 13; ball.r = 9; ball.alpha = 1;
  } else if (ball.mode === 'hit') {
    let seg = ball.segs[ball.si];
    let u = (now - ball.st) / seg.dur;
    if (seg.fx) seg.fx.forEach(o => { if (!o.done && u >= o.at) { o.done = true; o.fn(); } });
    if (u >= 1) {
      if (seg.fx) seg.fx.forEach(o => { if (!o.done) { o.done = true; o.fn(); } });
      ball.from = { x: seg.x, y: seg.y, h: seg.h1 || 0 };
      ball.st += seg.dur; ball.si++;
      if (ball.si >= ball.segs.length) {
        ball.mode = 'held';
        ball.gx = seg.x; ball.gy = seg.y; ball.h = seg.h1 || 0; ball.r = ballR(ball.gy);
        if (seg.fade) ball.alpha = 0;
        const cb = ball.onDone; ball.onDone = null;
        if (cb) cb();
        return;
      }
      seg = ball.segs[ball.si];
      u = (now - ball.st) / seg.dur;
      if (seg.fx) seg.fx.forEach(o => { if (!o.done && u >= o.at) { o.done = true; o.fn(); } });
    }
    const uu = clamp(u, 0, 1);
    ball.gx = lerp(ball.from.x, seg.x, uu);
    ball.gy = lerp(ball.from.y, seg.y, uu);
    ball.h = lerp(ball.from.h, seg.h1 || 0, uu) + (seg.peak || 0) * 4 * uu * (1 - uu);
    ball.r = ballR(ball.gy);
    ball.alpha = (seg.fade && uu > 0.88) ? 1 - (uu - 0.88) / 0.12 : 1;
  }
}
function drawBall() {
  if (ball.mode === 'none' || ball.alpha <= 0) return;
  const x = ball.gx, y = ball.gy - ball.h, r = ball.r;
  ctx.save();
  ctx.globalAlpha = ball.alpha;
  if (ball.h > 1.5) {
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath(); ctx.ellipse(ball.gx, ball.gy, r * .95, r * .34, 0, 0, 7); ctx.fill();
  }
  ctx.fillStyle = 'rgba(0,0,0,.4)';
  ctx.beginPath(); ctx.arc(x, y, r + 1.6, 0, 7); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.stroke();
  if (r > 4.5) {
    ctx.strokeStyle = '#d33'; ctx.lineWidth = Math.max(.7, r * .11);
    ctx.beginPath(); ctx.arc(x - r * .95, y, r * .75, -.9, .9); ctx.stroke();
    ctx.beginPath(); ctx.arc(x + r * .95, y, r * .75, Math.PI - .9, Math.PI + .9); ctx.stroke();
  }
  ctx.restore();
}

/* 紙ふぶき・フラッシュ */
let confetti = [], flashes = [], excite = 0;
function spawnConfetti(n) {
  const cols = ['#ffd23f', '#e5383b', '#2f6fe0', '#fff', '#3aa655', '#ff8fab'];
  for (let i = 0; i < n; i++) confetti.push({
    x: rnd(80, 880), y: rnd(-40, 60), vx: rnd(-40, 40), vy: rnd(40, 150),
    rot: rnd(0, 6), vr: rnd(-8, 8), c: pick(cols), life: rnd(2.5, 4.5)
  });
  excite = 3;
}

/* ピッチャーの腕 */
function pitcherArm(now) {
  if (phase === 'windup') return lerp(1.2, -1.9, easeOut((now - windStart) / windDur));
  if (pitch.released) return lerp(-1.9, 1.3, clamp((now - pitch.t0) / 140, 0, 1));
  return 1.3;
}

function drawScene(now, dt) {
  const half = state.half;
  const bat = TEAM[half], def = TEAM[1 - half];

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.setTransform(SC, 0, 0, SC, 0, 0);

  // スタンド: 旗ふり・カメラフラッシュ
  for (let i = 0; i < 14; i++) {
    const bx = 40 + i * 66, by = 168;
    const sw = Math.sin(now / 260 + i * 1.7) * (excite > 0 ? 9 : 5);
    ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + sw * .3, by - 20); ctx.stroke();
    ctx.fillStyle = i % 2 ? '#e5383b' : '#2f6fe0';
    ctx.beginPath(); ctx.moveTo(bx + sw * .3, by - 20); ctx.lineTo(bx + sw * .3 + 12 + sw, by - 16); ctx.lineTo(bx + sw * .3, by - 11); ctx.fill();
  }
  if (excite > 0) {
    excite = Math.max(0, excite - dt);
    if (Math.random() < 0.6) flashes.push({ x: rnd(10, 950), y: rnd(60, 175), life: .18 });
  }
  flashes = flashes.filter(f => (f.life -= dt) > 0);
  flashes.forEach(f => { ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fillRect(f.x - 3, f.y - .8, 6, 1.6); ctx.fillRect(f.x - .8, f.y - 3, 1.6, 6); });

  // 野手の移動
  FIELDERS.forEach(f => {
    const k = Math.min(1, dt * 5);
    f.x += (f.tx - f.x) * k; f.y += (f.ty - f.y) * k;
    f.dive = f.diving ? Math.min(1, f.dive + dt * 4.5) : Math.max(0, f.dive - dt * 3);
  });

  // 奥から手前へ
  FIELDERS.filter(f => f.y < 300).forEach(f => drawFielder(f, def));
  drawPitcher(now, def);
  FIELDERS.filter(f => f.y >= 300).sort((a, b) => a.y - b.y).forEach(f => drawFielder(f, def));

  // ランナー
  const rp = [[B1.x - 14, B1.y + 2], [B2.x, B2.y + 2], [B3.x + 14, B3.y + 2]];
  if (phase !== 'title') state.bases.forEach((on, i) => {
    if (on) drawPerson(rp[i][0], rp[i][1], { shirt: bat.color, cap: bat.dark, back: false });
  });

  drawBatter(now, bat);
  drawCatcher(def);
  drawBall();

  // 紙ふぶき
  confetti = confetti.filter(p => (p.life -= dt) > 0);
  confetti.forEach(p => {
    p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 60 * dt; p.rot += p.vr * dt;
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    ctx.fillStyle = p.c; ctx.fillRect(-4, -2, 8, 4); ctx.restore();
  });
}

function drawFielder(f, def) {
  const rot = f.dive * f.dir * 1.3;
  drawPerson(f.x + f.dive * f.dir * 6, f.y, { shirt: def.color, cap: def.dark, glove: true, rot });
}
function drawPitcher(now, def) {
  const x = 480, y = 366, s = scaleAt(y);
  drawPerson(x, y, { shirt: def.color, cap: def.dark, glove: true });
  const a = pitcherArm(now), sx = x + 8 * s, sy = y - 32 * s, L = 17 * s;
  const hx = sx + Math.cos(a) * L, hy = sy + Math.sin(a) * L;
  ctx.strokeStyle = '#f0c8a0'; ctx.lineWidth = 4 * s; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx, hy); ctx.stroke();
  if (phase === 'windup') { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 2.6, 0, 7); ctx.fill(); }
}
function drawBatter(now, bat) {
  const x = 436, y = 470, s = 1.15;
  drawPerson(x, y, { shirt: bat.color, cap: bat.dark, back: true, s });
  const sx = x + 5 * s, sy = y - 32 * s;
  const hx = x + 9, hy = y - 31 * s;
  const L = 52 * s * 0.95;
  let ang = -1.95, t = -1;
  if (swingAtBat !== null) {
    t = now - swingAtBat;
    ang = lerp(-1.95, 0.35, easeOut(t / 170));
  }
  // 腕
  ctx.strokeStyle = '#f0c8a0'; ctx.lineWidth = 4 * s; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx, hy); ctx.stroke();
  // スイングの軌跡
  if (t >= 0 && t < 230) {
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 8 * s;
    ctx.beginPath(); ctx.arc(hx, hy, L * .9, -1.95, ang); ctx.stroke();
  }
  // バット
  const bx = hx + Math.cos(ang) * L, by = hy + Math.sin(ang) * L;
  ctx.strokeStyle = '#3b2412'; ctx.lineWidth = 6.4 * s;
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + Math.cos(ang) * L * .35, hy + Math.sin(ang) * L * .35); ctx.stroke();
  ctx.strokeStyle = '#e0b26a'; ctx.lineWidth = 6.4 * s;
  ctx.beginPath(); ctx.moveTo(hx + Math.cos(ang) * L * .3, hy + Math.sin(ang) * L * .3); ctx.lineTo(bx, by); ctx.stroke();
  ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 2 * s; ctx.stroke();
}
function drawCatcher(def) {
  drawPerson(480, 514, { shirt: def.color, cap: '#1d1d1d', back: true, s: 1.05, sy: .7 });
  ctx.fillStyle = '#8a5a2b'; ctx.strokeStyle = '#5c3a18'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(481, 464, 8.5, 0, 7); ctx.fill(); ctx.stroke();
}

/* =========================================================
   7. 試合の流れ
   ========================================================= */
function chooseSpeed() {
  let r = Math.random() * SPEEDS.reduce((a, s) => a + s.w, 0);
  for (const s of SPEEDS) { if ((r -= s.w) <= 0) return s; }
  return SPEEDS[1];
}

function clearVisuals() {
  ball.mode = 'none'; ball.onDone = null;
  swingAtBat = null;
  pitch.released = false; pitch.swung = false; pitch.mitt = false; pitch.missPlanned = false;
  resetFielders();
  clearGaugeLock();
  hideBanner();
  speedEl.className = '';
  swingBtn.classList.remove('ready');
}

function newGame() {
  state.gameId++;
  timers = [];
  state.inning = 1; state.half = 0;
  state.scores = [[0], []];
  state.outs = 0; state.bases = [false, false, false];
  phase = 'idle';
  clearVisuals();
  setCue('');
  renderHUD();
  sfx.fanfare(false);
  showOverlay('プレイボール!', `1回オモテ\n${state.names[0]}のこうげきからスタート`, 'スタート', beginAtBat);
}

function beginAtBat() {
  clearVisuals();
  phase = 'idle';
  renderHUD();
  setCue(`${state.names[state.half]}の打席　ボールをよく見て…`);
  const wind = 650 + Math.random() * 450;
  schedule(900, () => {
    pitch.sp = chooseSpeed(); pitch.T = pitch.sp.T;
    windStart = gnow(); windDur = wind; phase = 'windup';
  });
  schedule(900 + wind, releasePitch);
}

function releasePitch() {
  const now = gnow();
  phase = 'pitch';
  pitch.t0 = now; pitch.swung = false; pitch.mitt = false; pitch.missPlanned = false; pitch.released = true;
  ball.mode = 'pitch';
  sfx.pitch();
  speedEl.textContent = `${pitch.sp.label}  ${pitch.sp.kmh}km/h`;
  speedEl.className = 'show s-' + pitch.sp.key;
  setCue(`${state.names[state.half]}　タイミングを合わせて「打つ！」`);
  swingBtn.classList.add('ready');
}

function swing() {
  if (Aud.ctx && Aud.ctx.state === 'suspended') Aud.ctx.resume();
  if (phase !== 'pitch' || pitch.swung) return;
  const now = gnow();
  pitch.swung = true; pitch.swingAt = now;
  swingAtBat = now;
  const p = clamp((now - pitch.t0) / (2 * pitch.T), 0, NEEDLE_END);
  setNeedle(p);
  const zi = zoneIndexAt(p);
  segEls[zi].classList.add('lock');
  swingBtn.classList.remove('ready');
  phase = 'swung';
  sfx.swing();
  const zone = ZONES[zi];
  if (zone.kind === 'k') {
    // 空振り: ボールがミットに収まってから判定
    pitch.missPlanned = true;
    const arrive = pitch.t0 + pitch.T;
    const wait = Math.max(now + 380, arrive + 120) - now;
    schedule(wait, () => startResult('k'));
  } else {
    schedule(90, () => startResult(zone.kind));
  }
}

/* ---- 走者の進塁 ---- */
function advanceRunners(b, n) {
  let runs = 0; const nb = [false, false, false];
  for (let i = 2; i >= 0; i--) {
    if (b[i]) { const t = i + 1 + n; if (t >= 4) runs++; else nb[t - 1] = true; }
  }
  return { runs, bases: nb };
}
function advanceHit(b, n) {
  const a = advanceRunners(b, n);
  if (n >= 4) a.runs++; else a.bases[n - 1] = true;
  return a;
}

/* ---- 結果の判定 ---- */
function evaluate(kind, swung) {
  const b = state.bases.slice();
  const outs = state.outs;
  const r = { kind, label: '', cls: 'out', runs: 0, outsAdd: 0, bases: b, swung };
  switch (kind) {
    case 'hr': case 'h3': case 'h2': case 'h1': {
      const n = { hr: 4, h3: 3, h2: 2, h1: 1 }[kind];
      const a = advanceHit(b, n);
      r.runs = a.runs; r.bases = a.bases;
      r.label = { hr: 'ホームラン!!', h3: 'スリーベース!', h2: 'ツーベース!', h1: 'ヒット!' }[kind];
      r.cls = kind === 'hr' ? 'hr' : 'hit';
      break;
    }
    case 'f':
      r.outsAdd = 1; r.label = 'ファインプレー!';
      break;
    case 'g':
      r.outsAdd = 1; r.label = 'ゴロアウト';
      if (outs + 1 < 3) { const a = advanceRunners(b, 1); r.runs = a.runs; r.bases = a.bases; }
      break;
    case 'dp':
      if (b[0]) {
        r.outsAdd = 2; r.label = 'ダブルプレー!';
        if (outs + 2 < 3) { const nb = b.slice(); nb[0] = false; const a = advanceRunners(nb, 1); r.runs = a.runs; r.bases = a.bases; }
      } else {
        r.kind = 'g'; r.outsAdd = 1; r.label = 'ゴロアウト';
        if (outs + 1 < 3) { const a = advanceRunners(b, 1); r.runs = a.runs; r.bases = a.bases; }
      }
      break;
    case 'k':
      r.outsAdd = 1; r.label = swung ? '空振り三振!' : '見逃し三振!';
      break;
  }
  return r;
}

/* ---- ボールの動き(結果ごと) ---- */
function planPlay(res) {
  const segs = [];
  const P = (x, y, peak, dur, h1, extra) => segs.push(Object.assign({ x, y, peak, dur, h1: h1 || 0 }, extra || {}));
  switch (res.kind) {
    case 'hr': {
      P(rnd(300, 660), 165, 190, 1750, 45, { fade: true });
      break;
    }
    case 'h3': {
      const right = Math.random() < .5, x = right ? rnd(650, 770) : rnd(190, 310), id = right ? 'RF' : 'LF';
      P(x, 218, 85, 1250, 18, { fx: [{ at: 0.05, fn: () => moveF(id, x, 232) }] });
      P(x + (right ? -24 : 24), 250, 20, 500, 0, { fx: [{ at: 0.1, fn: () => moveF(id, x + (right ? -24 : 24), 252) }] });
      P(x + (right ? -34 : 34), 262, 0, 350, 0);
      break;
    }
    case 'h2': {
      const right = Math.random() < .5, x = right ? rnd(640, 740) : rnd(200, 320), id = right ? 'RF' : 'LF';
      P(x, 236, 75, 1150, 0, { fx: [{ at: 0.1, fn: () => moveF(id, x, 240) }] });
      P(x + (right ? 18 : -18), 228, 18, 320, 0);
      P(x + (right ? 30 : -30), 224, 0, 380, 0, { fx: [{ at: 0.2, fn: () => moveF(id, x + (right ? 30 : -30), 226) }] });
      break;
    }
    case 'h1': {
      const lx = rnd(330, 650), ly = rnd(288, 320), dx = lx < 480 ? -14 : 14;
      const cand = ['2B', 'SS', 'CF', 'RF', 'LF', '1B', '3B'];
      let best = cand[0], bd = 1e9;
      cand.forEach(id => { const f = F(id); const d = Math.hypot(f.hx - lx, f.hy - ly); if (d < bd) { bd = d; best = id; } });
      const ex = lx + dx * 1.6, ey = ly - 26;
      P(lx, ly, 55, 850, 0, { fx: [{ at: 0.3, fn: () => moveF(best, ex, ey + 6) }] });
      P(lx + dx, ly - 16, 14, 320, 0);
      P(ex, ey, 0, 420, 0);
      break;
    }
    case 'f': {
      const id = pick(['SS', '3B', '2B', '1B', 'LF', 'CF', 'RF']), f = F(id);
      const out = id === 'LF' || id === 'CF' || id === 'RF';
      const side = Math.random() < .5 ? -1 : 1;
      const tx = f.hx + side * (out ? 34 : 28), ty = f.hy + (out ? 8 : 0);
      P(tx, ty, out ? 105 : 26, out ? 1250 : 620, 6, {
        fx: [{ at: 0.05, fn: () => moveF(id, tx, ty + 4) }, { at: 0.55, fn: () => diveF(id, side) }]
      });
      break;
    }
    case 'g': {
      // 早め=左方向(サード・ショート) 、 ゴロ
      const id = pick(['SS', '3B']), f = F(id);
      const gx = f.hx - 8, gy = f.hy + 6;
      P(lerp(480, gx, .6), lerp(468, gy, .6), 13, 380, 0);
      P(gx, gy, 8, 340, 8, { fx: [{ at: 0.1, fn: () => moveF(id, gx, gy + 4) }] });
      P(B1.x - 4, B1.y, 26, 560, 10, { fx: [{ at: 0, fn: () => moveF('1B', B1.x - 8, B1.y + 2) }] });
      break;
    }
    case 'dp': {
      const gx = 566, gy = 322;
      P(lerp(480, gx, .6), lerp(468, gy, .6), 13, 380, 0);
      P(gx, gy, 8, 340, 8, { fx: [{ at: 0.1, fn: () => moveF('2B', gx, gy + 4) }] });
      P(B2.x, B2.y + 4, 22, 420, 10, { fx: [{ at: 0.1, fn: () => moveF('SS', 470, 288) }] });
      P(B1.x - 4, B1.y, 26, 520, 10, { fx: [{ at: 0, fn: () => moveF('1B', B1.x - 8, B1.y + 2) }] });
      break;
    }
  }
  return segs;
}

/* ---- 結果の開始 ---- */
function startResult(kind) {
  if (phase !== 'swung' && phase !== 'pitch') return;
  const now = gnow();
  const swung = pitch.swung;
  phase = 'result';
  const seq = ++resultSeq;
  const done = () => { if (seq === resultSeq) finishResult(); };
  swingBtn.classList.remove('ready');
  speedEl.className = '';
  setCue('');

  const res = evaluate(kind, swung);
  curRes = res;
  showBanner(res.label, res.cls);

  if (kind === 'k') {
    if (!swung) { /* 見逃し: ミットは既に鳴っている */ }
    if (ball.mode === 'pitch') { ball.mode = 'mitt'; sfx.mitt(); }
    sfx.out();
    schedule(1200, done);
    return;
  }

  // 打球
  const power = { hr: 1, h3: .85, h2: .75, h1: .6, f: .5, g: .4, dp: .4 }[res.kind] || .5;
  sfx.hit(power);
  if (res.cls === 'hr') { sfx.cheer(3); schedule(1000, () => { spawnConfetti(90); sfx.fanfare(false); }); }
  else if (res.cls === 'hit') { sfx.cheer(1.6); excite = 1.5; }
  else if (res.kind === 'f') { sfx.fine(); sfx.cheer(1.2); excite = 1; }
  else { schedule(700, () => sfx.out()); }

  const segs = planPlay(res);
  startBallAnim(segs, now, () => schedule(450, done));
  // 念のための保険
  schedule(6000, done);
}

/* ---- 結果の反映 ---- */
function finishResult() {
  if (phase !== 'result') return;
  phase = 'after';
  const res = curRes;
  const s = state;

  s.scores[s.half][s.inning - 1] += res.runs;
  s.outs = Math.min(3, s.outs + res.outsAdd);
  if (s.outs < 3) s.bases = res.bases.slice();
  renderHUD();
  if (res.runs > 0) showToast(`+${res.runs}点`);

  // サヨナラ
  if (s.half === 1 && s.inning >= MAX_INNING && totalOf(1) > totalOf(0)) {
    schedule(1300, () => gameOver(true));
    return;
  }
  if (s.outs >= 3) { schedule(1300, endHalf); return; }
  schedule(900, beginAtBat);
}

function endHalf() {
  const s = state;
  s.bases = [false, false, false]; s.outs = 0;
  clearVisuals();
  sfx.fanfare(false);
  if (s.half === 0) {
    if (s.inning >= MAX_INNING && totalOf(1) > totalOf(0)) {       // 後攻がリード → ウラは行わない
      s.scores[1][s.inning - 1] = 'X';
      renderHUD();
      return gameOver(false);
    }
    s.half = 1; s.scores[1][s.inning - 1] = 0;
    renderHUD();
    showOverlay('チェンジ!', `${s.inning > MAX_INNING ? '延長' : ''}${s.inning}回ウラ\n${s.names[1]}のこうげき`, 'スタート', beginAtBat);
  } else {
    if (s.inning >= MAX_INNING && totalOf(0) !== totalOf(1)) return gameOver(false);
    if (s.inning >= MAX_INNING + EXTRA_INNING) return gameOver(false);   // 延長でも決着せず → 引き分け
    s.inning++; s.half = 0; s.scores[0][s.inning - 1] = 0;
    renderHUD();
    const ext = s.inning > MAX_INNING;
    showOverlay(ext ? '延長戦!' : 'チェンジ!', `${ext ? '延長' : ''}${s.inning}回オモテ\n${s.names[0]}のこうげき`, 'スタート', beginAtBat);
  }
}

function gameOver(walkoff) {
  phase = 'over';
  clearVisuals();
  setCue('');
  renderHUD();
  const a = totalOf(0), b = totalOf(1), n = state.names;
  let title, body;
  if (a === b) { title = '引き分け!'; body = `${n[0]} ${a} - ${b} ${n[1]}\nいい勝負でした!`; }
  else {
    const w = a > b ? 0 : 1;
    title = `${n[w]}の勝ち!`;
    body = `${n[0]} ${a} - ${b} ${n[1]}` + (walkoff ? '\nサヨナラ勝ち!' : '');
    spawnConfetti(140);
  }
  sfx.fanfare(true); sfx.cheer(3.5);
  showOverlay(title, body, 'もういちど あそぶ', newGame, 'タイトルにもどる', () => { phase = 'title'; renderHUD(); titleScreen.hidden = false; });
}

/* =========================================================
   8. メインループ
   ========================================================= */
function update(now) {
  // タイマー実行
  if (timers.length) {
    const due = timers.filter(t => t.at <= now);
    if (due.length) {
      timers = timers.filter(t => t.at > now);
      due.sort((a, b) => a.at - b.at).forEach(t => t.fn());
    }
  }

  if (phase === 'pitch' || phase === 'swung') {
    if (!pitch.mitt && ball.mode === 'pitch' && now >= pitch.t0 + pitch.T) {
      pitch.mitt = true; ball.mode = 'mitt';
      if (phase === 'pitch' || pitch.missPlanned) sfx.mitt();
    }
  }
  if (phase === 'pitch') {
    const p = (now - pitch.t0) / (2 * pitch.T);
    setNeedle(Math.min(p, NEEDLE_END));
    if (p >= NEEDLE_END) startResult('k');       // 見逃し三振
  }
  updateBall(now);
}

function frame(realNow) {
  const d = Math.min(realNow - lastReal, 50);
  lastReal = realNow;
  vnow += d;
  try {
    update(vnow);
    drawScene(vnow, d / 1000);
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(frame);
}

/* =========================================================
   9. 入力(マウス / タップ / スイッチ = スペース・Enter など)
   ========================================================= */
function onPress(e) {
  e.preventDefault();
  swing();
}
cv.addEventListener('pointerdown', onPress);
swingBtn.addEventListener('pointerdown', onPress);
cv.addEventListener('contextmenu', e => e.preventDefault());
swingBtn.addEventListener('contextmenu', e => e.preventDefault());

const IGNORE_KEYS = ['Tab', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ContextMenu'];
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target && e.target.tagName === 'INPUT') {
    if (e.key === 'Enter' && !titleScreen.hidden) { e.preventDefault(); $('startBtn').click(); }
    return;
  }
  if (IGNORE_KEYS.includes(e.key) || /^F\d+$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  if (!titleScreen.hidden) { $('startBtn').click(); return; }
  if (!ov.hidden) { ovBtn.click(); return; }
  swing();
});

/* =========================================================
   10. タイトル → 開始
   ========================================================= */
$('startBtn').addEventListener('click', () => guard(() => {
  initAudio();
  const n0 = $('name0').value.trim() || 'プレイヤー1';
  const n1 = $('name1').value.trim() || 'プレイヤー2';
  state.names = [n0, n1];
  titleScreen.hidden = true;
  newGame();
}));

refreshAudioBtns();
renderHUD();
setNeedle(0);
requestAnimationFrame(frame);

})();
