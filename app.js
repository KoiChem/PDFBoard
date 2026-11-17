'use strict';
/* PDFBoard v1 — ページ参照記述子方式（チャップ相談で確定）
   元PDFは不変に保持し、編集状態は軽い記述子の配列で管理する。
   保存時にだけ pdf-lib で新しいPDFを組み立てる。 */
import * as pdfjsLib from './pdf.min.mjs';
const { PDFDocument, degrees } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

const BLANK_SIZES = {
  A4: [595, 842], A3: [842, 1191], B5: [516, 729],
  B4: [729, 1032], A5: [420, 595], LETTER: [612, 792],
};
const FORBIDDEN = /[\/\\:*?"<>|]/g;
const LS_KEYS = { zoom: 'pdfboard.zoom', blank: 'pdfboard.blankSize', csv: 'pdfboard.lastCsvName' };

const $ = (id) => document.getElementById(id);
const els = {
  board: $('board'), empty: $('empty-state'), boardWrap: $('board-wrap'),
  fileInput: $('file-input'), csvInput: $('csv-input'),
  btnOpen: $('btn-open'), btnOpenEmpty: $('btn-open-empty'), btnSave: $('btn-save'),
  btnExtract: $('btn-extract'), btnIndividual: $('btn-individual'), btnCsv: $('btn-csv'),
  btnUndo: $('btn-undo'), btnRedo: $('btn-redo'), btnBlank: $('btn-blank'),
  blankSize: $('blank-size'), zoom: $('zoom'), zoomVal: $('zoom-val'),
  progressWrap: $('progress-wrap'), progressFill: $('progress-fill'), progressLabel: $('progress-label'),
  stFile: $('st-file'), stPages: $('st-pages'), stSelected: $('st-selected'),
  stCsv: $('st-csv'), stDirty: $('st-dirty'),
  menu: $('context-menu'), overlay: $('drop-overlay'),
  modalOverlay: $('modal-overlay'), modalMsg: $('modal-message'),
  modalOk: $('modal-ok'), modalCancel: $('modal-cancel'),
  toasts: $('toasts'),
};

/* ---------- 状態 ---------- */
let sources = new Map();       // sourceId -> {id,name,bytes,pdfjsDoc,pdfLibDoc,pageCount,baseRots:[]}
let pages = [];                // {id, kind:'src'|'blank', sourceId?, srcIndex?, rotDelta, blankSize?}
let selected = new Set();      // page instance id
let anchorId = null;           // Shift選択の起点
let focusId = null;            // キーボードフォーカス中のページ
let primarySourceId = null;    // 最初に開いたPDF（ファイル名の基準）
let baseName = 'document';
let csvRules = [];             // {pages:[表示番号...], name, line}
let csvFileName = '';
let history = [];              // 記述子配列のJSONスナップショット
let historyIndex = -1;
let savedKey = null;           // 最後に全体保存した時点のスナップショット
let busy = false;
let renderToken = 0;
let nextSourceId = 1;
let nextPageId = 1;
const thumbCache = new Map();  // cacheKey -> dataURL

const snapshotPages = () => JSON.stringify(pages);
const isDirty = () => pages.length > 0 && savedKey !== null && snapshotPages() !== savedKey;
const renderWidth = () => (pages.length > 200 ? 200 : 360);

/* ---------- 小物 ---------- */
function sanitizeName(name, fallback) {
  let s = String(name == null ? '' : name).replace(FORBIDDEN, '_').trim();
  if (!s) s = fallback || '';
  return s;
}
function baseOf(fileName) {
  return fileName.replace(/\.pdf$/i, '');
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function toast(msg, type = 'info', long = false) {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  els.toasts.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); },
    long || type === 'error' ? 5000 : 3000);
}
/* 確認ダイアログ（仕様19: 既定フォーカスはキャンセル） */
let modalResolve = null;
let modalPromise = null;
/* UIロック中か（処理中 or 確認ダイアログ表示中は新規操作を受け付けない） */
const uiLocked = () => busy || modalPromise !== null;

function confirmDialog(message) {
  if (modalPromise) return Promise.resolve(false); // 再入は拒否（共有すると1回の承認で複数操作が進む）
  modalPromise = new Promise((resolve) => {
    modalResolve = resolve;
    els.modalMsg.textContent = message;
    els.modalOverlay.hidden = false;
    els.modalCancel.focus();
  });
  return modalPromise;
}
function closeModal(result) {
  els.modalOverlay.hidden = true;
  if (modalResolve) { modalResolve(result); modalResolve = null; modalPromise = null; }
}
els.modalOk.addEventListener('click', () => closeModal(true));
els.modalCancel.addEventListener('click', () => closeModal(false));

function setBusy(on, label) {
  busy = on;
  document.body.classList.toggle('busy', on);
  if (label) showProgress(label, 0, 0); else if (!on) hideProgress();
}
function showProgress(label, done, total) {
  els.progressWrap.hidden = false;
  els.progressLabel.textContent = total > 0 ? `${label}（${done} / ${total}ページ）` : label;
  els.progressFill.style.width = total > 0 ? Math.round((done / total) * 100) + '%' : '30%';
}
function hideProgress() { els.progressWrap.hidden = true; }

/* ---------- 設定（LocalStorageは設定のみ） ---------- */
function loadSettings() {
  try {
    const z = parseInt(localStorage.getItem(LS_KEYS.zoom) || '', 10);
    if (z >= 90 && z <= 280) { els.zoom.value = String(z); applyZoom(z); }
    const b = localStorage.getItem(LS_KEYS.blank);
    if (b && BLANK_SIZES[b]) els.blankSize.value = b;
  } catch (e) { /* 設定が読めなくても動作は続ける */ }
}
function applyZoom(px) {
  document.documentElement.style.setProperty('--thumb-w', px + 'px');
  els.zoomVal.textContent = px <= 110 ? '小' : px >= 230 ? '大' : '中';
}
els.zoom.addEventListener('input', () => {
  applyZoom(parseInt(els.zoom.value, 10));
  try { localStorage.setItem(LS_KEYS.zoom, els.zoom.value); } catch (e) {}
});
els.blankSize.addEventListener('change', () => {
  try { localStorage.setItem(LS_KEYS.blank, els.blankSize.value); } catch (e) {}
});

/* ---------- ステータス / ボタン状態 ---------- */
function updateStatus() {
  const has = pages.length > 0;
  els.empty.hidden = has;
  els.board.hidden = !has;
  els.btnSave.disabled = !has;
  els.btnExtract.disabled = selected.size === 0;
  els.btnIndividual.disabled = selected.size === 0;
  els.btnCsv.disabled = !has;
  els.btnBlank.disabled = !has;
  els.btnUndo.disabled = historyIndex <= 0;
  els.btnRedo.disabled = historyIndex >= history.length - 1;
  els.btnIndividual.textContent = csvRules.length
    ? '選択ページを個別保存（CSV分割）' : '選択ページを個別保存';
  if (!has) {
    els.stFile.textContent = 'ファイル未選択';
    els.stPages.textContent = ''; els.stSelected.textContent = '';
    els.stCsv.textContent = ''; els.stDirty.textContent = '';
    return;
  }
  const src = sources.get(primarySourceId);
  els.stFile.textContent = src ? src.name : '';
  els.stPages.textContent = `${pages.length} ページ`;
  els.stSelected.textContent = `選択中 ${selected.size} ページ`;
  els.stCsv.textContent = csvRules.length ? `CSV: ${csvFileName}（${csvRules.length}ルール）` : '';
  const d = isDirty();
  els.stDirty.textContent = d ? '● 未保存' : '保存済み';
  els.stDirty.classList.toggle('dirty', d);
}

/* ---------- 履歴 ---------- */
function pushHistory() {
  history = history.slice(0, historyIndex + 1); // 新しい編集でRedo履歴は破棄
  history.push(snapshotPages());
  if (history.length > 50) history.shift();
  historyIndex = history.length - 1;
  updateStatus();
}
function restoreHistory() {
  pages = JSON.parse(history[historyIndex]);
  selected = new Set([...selected].filter((id) => pages.some((p) => p.id === id)));
  if (focusId && !pages.some((p) => p.id === focusId)) focusId = pages.length ? pages[0].id : null;
  renderBoard();
  updateStatus();
}
function undo() { if (busy) return; if (historyIndex > 0) { historyIndex--; restoreHistory(); } }
function redo() { if (busy) return; if (historyIndex < history.length - 1) { historyIndex++; restoreHistory(); } }
els.btnUndo.addEventListener('click', undo);
els.btnRedo.addEventListener('click', redo);

/* ---------- PDF読み込み ---------- */
function isPdfFile(f) {
  return /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
}
async function loadSource(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let pdfjsDoc;
  try {
    // PDF.jsにはコピーを渡す（Worker転送で元バッファが切り離される場合があるため）
    pdfjsDoc = await pdfjsLib.getDocument({ data: buf.slice(), isEvalSupported: false }).promise;
  } catch (e) {
    if (e && (e.name === 'PasswordException' || /password/i.test(String(e.message)))) {
      throw new Error('PASSWORD');
    }
    throw new Error('LOAD');
  }
  let pdfLibDoc;
  try {
    pdfLibDoc = await PDFDocument.load(buf.slice());
  } catch (e) {
    try { await pdfjsDoc.destroy(); } catch (err) {}
    if (e && /encrypt/i.test(String(e.message))) throw new Error('PASSWORD');
    throw new Error('EDIT_UNSUPPORTED');
  }
  const baseRots = [];
  for (let i = 1; i <= pdfjsDoc.numPages; i++) {
    const pg = await pdfjsDoc.getPage(i);
    baseRots.push(((pg.rotate % 360) + 360) % 360);
    pg.cleanup();
  }
  const src = {
    id: nextSourceId++, name: file.name, bytes: buf,
    pdfjsDoc, pdfLibDoc, pageCount: pdfjsDoc.numPages, baseRots,
  };
  return src;
}
function errorToastFor(code) {
  if (code === 'PASSWORD') toast('パスワード付きPDFは開けません', 'error');
  else if (code === 'EDIT_UNSUPPORTED') toast('このPDFは編集に対応していないため開けませんでした', 'error');
  else toast('PDFを読み込めませんでした', 'error');
}
function makeSrcPages(src) {
  const out = [];
  for (let i = 0; i < src.pageCount; i++) {
    out.push({ id: nextPageId++, kind: 'src', sourceId: src.id, srcIndex: i, rotDelta: 0 });
  }
  return out;
}

/* 新規に開く（既存の編集は破棄。未保存なら確認） */
async function openNewPdf(file) {
  if (uiLocked()) return;
  if (isDirty()) {
    const ok = await confirmDialog('未保存の変更があります。保存せずに続けますか？');
    if (!ok || busy) return;
  }
  setBusy(true, '読み込み中…');
  try {
    const src = await loadSource(file);
    for (const s of sources.values()) { try { await s.pdfjsDoc.destroy(); } catch (e) {} }
    sources = new Map([[src.id, src]]);
    primarySourceId = src.id;
    baseName = baseOf(src.name);
    pages = makeSrcPages(src);
    selected = new Set(); anchorId = null;
    focusId = pages.length ? pages[0].id : null;
    csvRules = []; csvFileName = '';
    history = []; historyIndex = -1; savedKey = snapshotPages();
    pushHistory();
    renderBoard();
    toast('PDFを開きました', 'success');
    if (src.pageCount > 100) toast('100ページを超えるPDFです。動作が重くなる場合があります', 'warn', true);
  } catch (e) {
    errorToastFor(e.message);
    console.error(e);
  } finally {
    setBusy(false);
  }
}

/* 末尾に追加（一括検証し、1件でも失敗したら何も追加しない／Undoは1回分） */
async function appendPdfs(files) {
  setBusy(true, '追加するPDFを確認中…');
  const loaded = [];
  try {
    for (const f of files) loaded.push(await loadSource(f));
  } catch (e) {
    for (const s of loaded) { try { await s.pdfjsDoc.destroy(); } catch (err) {} }
    errorToastFor(e.message);
    console.error(e);
    setBusy(false);
    return;
  }
  for (const s of loaded) {
    sources.set(s.id, s);
    pages = pages.concat(makeSrcPages(s));
  }
  pushHistory();
  renderBoard();
  setBusy(false);
  toast('ページを追加しました', 'success');
}

/* ファイル入力・ドロップ共通の入口 */
async function handleIncomingFiles(fileList) {
  if (uiLocked()) return;
  const files = [...fileList];
  const pdfs = files.filter(isPdfFile);
  if (files.length && !pdfs.length) { toast('PDF以外のファイルは開けません', 'error'); return; }
  if (!pdfs.length) return;
  if (pages.length === 0) {
    if (pdfs.length > 1) toast('複数のPDFがドロップされたため、最初の1ファイルのみ開きます', 'warn', true);
    await openNewPdf(pdfs[0]);
  } else {
    await appendPdfs(pdfs);
  }
}

/* ---------- サムネイル生成 ---------- */
function cacheKeyOf(p) {
  return p.kind === 'blank'
    ? `blank|${p.blankSize}|${p.rotDelta}`
    : `src|${p.sourceId}|${p.srcIndex}|${p.rotDelta}`;
}
async function renderThumbData(p) {
  const key = cacheKeyOf(p);
  if (thumbCache.has(key)) return thumbCache.get(key);
  const W = renderWidth();
  let url;
  if (p.kind === 'blank') {
    const [w, h] = BLANK_SIZES[p.blankSize];
    const swap = p.rotDelta === 90 || p.rotDelta === 270;
    const cw = W, ch = Math.round(W * ((swap ? w : h) / (swap ? h : w)));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = '#d6d3d1'; ctx.strokeRect(1, 1, cw - 2, ch - 2);
    ctx.fillStyle = '#a8a29e'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('空白ページ', cw / 2, ch / 2);
    url = c.toDataURL('image/png');
  } else {
    const src = sources.get(p.sourceId);
    const page = await src.pdfjsDoc.getPage(p.srcIndex + 1);
    const rotation = (src.baseRots[p.srcIndex] + p.rotDelta) % 360;
    const baseVp = page.getViewport({ scale: 1, rotation });
    const vp = page.getViewport({ scale: W / baseVp.width, rotation });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
    page.cleanup();
    url = c.toDataURL('image/jpeg', 0.82);
  }
  thumbCache.set(key, url);
  return url;
}
async function fillThumbs(token) {
  const targets = pages.filter((p) => !thumbCache.has(cacheKeyOf(p)));
  let done = pages.length - targets.length;
  if (targets.length && token === renderToken) showProgress('サムネイル生成中', done, pages.length);
  for (const p of targets) {
    if (token !== renderToken) return;
    try {
      const url = await renderThumbData(p);
      const img = els.board.querySelector(`.thumb[data-id="${p.id}"] img`);
      if (img && token === renderToken) {
        img.src = url;
        const ph = img.parentElement.querySelector('.ph');
        if (ph) ph.remove();
      }
    } catch (e) { console.error('thumbnail failed', e); }
    // await の間に別の描画が始まっていたら、古いループは進捗UIに触らない
    if (token !== renderToken) return;
    done++;
    showProgress('サムネイル生成中', done, pages.length);
  }
  if (token === renderToken) hideProgress();
}

/* ---------- ボード描画 ---------- */
function renderBoard() {
  renderToken++;
  const token = renderToken;
  els.board.innerHTML = '';
  pages.forEach((p, idx) => {
    const d = document.createElement('div');
    d.className = 'thumb' + (selected.has(p.id) ? ' selected' : '');
    d.draggable = true;
    d.tabIndex = 0;
    d.dataset.id = String(p.id);
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const cached = thumbCache.get(cacheKeyOf(p));
    if (cached) {
      const img = document.createElement('img'); img.src = cached; img.alt = '';
      wrap.appendChild(img);
    } else {
      const img = document.createElement('img'); img.alt = '';
      const ph = document.createElement('span'); ph.className = 'ph'; ph.textContent = '生成中…';
      wrap.appendChild(img); wrap.appendChild(ph);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    const num = document.createElement('span');
    num.className = 'pnum'; num.textContent = String(idx + 1);
    meta.appendChild(num);
    if (p.kind === 'blank') {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = `空白 ${p.blankSize}`;
      meta.appendChild(b);
    } else if (p.sourceId !== primarySourceId) {
      const b = document.createElement('span');
      b.className = 'badge src'; b.textContent = '追加分';
      b.title = sources.get(p.sourceId) ? sources.get(p.sourceId).name : '';
      meta.appendChild(b);
    } else if (p.rotDelta) {
      const b = document.createElement('span');
      b.className = 'badge'; b.textContent = `${p.rotDelta}°`;
      meta.appendChild(b);
    }
    d.appendChild(wrap); d.appendChild(meta);
    els.board.appendChild(d);
  });
  updateStatus();
  fillThumbs(token);
}

/* ---------- ページ選択 ---------- */
function selectOnly(id) { selected = new Set(id ? [id] : []); }
function applySelectionDom() {
  els.board.querySelectorAll('.thumb').forEach((el) => {
    el.classList.toggle('selected', selected.has(Number(el.dataset.id)));
  });
  updateStatus();
}
function onThumbClick(e, id) {
  focusId = id;
  const idx = pages.findIndex((p) => p.id === id);
  if (e.shiftKey && anchorId !== null) {
    const a = pages.findIndex((p) => p.id === anchorId);
    if (a >= 0) {
      const [s, t] = a < idx ? [a, idx] : [idx, a];
      selected = new Set(pages.slice(s, t + 1).map((p) => p.id));
    }
  } else {
    // 通常クリック／タップは複数選択のトグル（マウス・タッチ共通のオーナー指定）
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchorId = id;
  }
  applySelectionDom();
}
els.board.addEventListener('click', (e) => {
  const t = e.target.closest('.thumb');
  if (t) onThumbClick(e, Number(t.dataset.id));
});
els.boardWrap.addEventListener('click', (e) => {
  if (e.target === els.board || e.target === els.boardWrap) {
    selectOnly(null); anchorId = null; applySelectionDom();
  }
});

/* ---------- ページ操作 ---------- */
function selectedPagesInOrder() {
  return pages.filter((p) => selected.has(p.id));
}
function rotateSelected(delta) {
  if (busy || !selected.size) return;
  for (const p of pages) {
    if (selected.has(p.id)) p.rotDelta = ((p.rotDelta + delta) % 360 + 360) % 360;
  }
  pushHistory();
  renderBoard();
}
function duplicateSelected() {
  if (busy || !selected.size) return;
  const copies = new Map();
  const out = [];
  for (const p of pages) {
    out.push(p);
    if (selected.has(p.id)) {
      const c = { ...p, id: nextPageId++ };
      copies.set(c.id, c);
      out.push(c);
    }
  }
  pages = out;
  selected = new Set(copies.keys());
  anchorId = null;
  pushHistory();
  renderBoard();
  toast('ページを複製しました', 'success');
}
function insertBlank(afterIndex) {
  if (busy) return;
  const size = els.blankSize.value;
  const bp = { id: nextPageId++, kind: 'blank', rotDelta: 0, blankSize: size };
  const at = Math.max(0, Math.min(afterIndex + 1, pages.length));
  pages.splice(at, 0, bp);
  selectOnly(bp.id); anchorId = bp.id; focusId = bp.id;
  pushHistory();
  renderBoard();
  toast('空白ページを追加しました', 'success');
}
els.btnBlank.addEventListener('click', () => {
  if (!pages.length) return;
  let idx = pages.length - 1;
  const sel = selectedPagesInOrder();
  if (sel.length) idx = pages.indexOf(sel[sel.length - 1]);
  insertBlank(idx);
});
async function deleteSelected() {
  if (uiLocked() || !selected.size) return;
  if (selected.size >= pages.length) {
    toast('全てのページを削除することはできません', 'error');
    return;
  }
  const ok = await confirmDialog(`選択した${selected.size}ページを削除しますか？`);
  if (!ok || busy) return;
  pages = pages.filter((p) => !selected.has(p.id));
  selected = new Set();
  pushHistory();
  renderBoard();
  toast('ページを削除しました', 'success');
}

/* ---------- PDF組み立て・保存 ---------- */
async function buildPdfBytes(descs) {
  const out = await PDFDocument.create();
  for (const p of descs) {
    if (p.kind === 'blank') {
      const [w, h] = BLANK_SIZES[p.blankSize];
      const pg = out.addPage([w, h]);
      if (p.rotDelta) pg.setRotation(degrees(p.rotDelta));
    } else {
      const src = sources.get(p.sourceId);
      const copied = await out.copyPages(src.pdfLibDoc, [p.srcIndex]);
      const pg = copied[0];
      const rot = (src.baseRots[p.srcIndex] + p.rotDelta) % 360;
      pg.setRotation(degrees(rot));
      out.addPage(pg);
    }
  }
  return out.save();
}
async function verifyCount(bytes, expect) {
  const doc = await PDFDocument.load(bytes.slice());
  if (doc.getPageCount() !== expect) throw new Error('COUNT_MISMATCH');
}
async function saveAll() {
  if (!pages.length || uiLocked()) return;
  // 保存開始時点の状態で固定する（処理中の編集で保存内容と保存済み判定がずれないように）
  const savePages = JSON.parse(snapshotPages());
  const saveKey = JSON.stringify(savePages);
  setBusy(true, '保存中…');
  try {
    const bytes = await buildPdfBytes(savePages);
    await verifyCount(bytes, savePages.length);
    downloadBytes(bytes, `${sanitizeName(baseName, 'document')}_edited.pdf`);
    savedKey = saveKey;
    updateStatus();
    toast('保存しました', 'success');
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました', 'error');
  } finally { setBusy(false); }
}
async function extractSelected() {
  if (uiLocked()) return;
  const sel = JSON.parse(JSON.stringify(selectedPagesInOrder()));
  if (!sel.length) return;
  setBusy(true, '保存中…');
  try {
    const bytes = await buildPdfBytes(sel);
    await verifyCount(bytes, sel.length);
    downloadBytes(bytes, `${sanitizeName(baseName, 'document')}_extract.pdf`);
    toast('抽出しました', 'success');
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました', 'error');
  } finally { setBusy(false); }
}
async function individualSave() {
  if (uiLocked()) return;
  const sel = selectedPagesInOrder();
  if (!sel.length) return;
  const base = sanitizeName(baseName, 'document');
  const dispNum = new Map(pages.map((p, i) => [p.id, i + 1]));
  /* 出力ファイル一覧を先に決める（CSVありは範囲を1ファイルにまとめる） */
  const outputs = []; // {descs:[], name}
  const covered = new Set();
  if (csvRules.length) {
    for (const rule of csvRules) {
      const descs = sel.filter((p) => rule.pages.includes(dispNum.get(p.id)));
      if (descs.length) {
        outputs.push({ descs, name: `${base}_${rule.name}.pdf` });
        descs.forEach((p) => covered.add(p.id));
      }
    }
  }
  for (const p of sel) {
    if (covered.has(p.id)) continue;
    const n = dispNum.get(p.id);
    let nm = csvRules.length ? findRuleNameFor(n) : null;
    outputs.push({ descs: [p], name: `${base}_${nm || n}.pdf` });
  }
  /* ファイル名の衝突回避（_2, _3…）: 生成済みの名前も含めて一意性を再検査する */
  const usedNames = new Set();
  for (const o of outputs) {
    const stem = o.name.replace(/\.pdf$/i, '');
    let candidate = o.name;
    let suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) {
      candidate = `${stem}_${suffix++}.pdf`;
    }
    usedNames.add(candidate.toLowerCase());
    o.name = candidate;
  }
  const modeNote = csvRules.length ? '\nCSVに従って分割保存します。' : '';
  const ok = await confirmDialog(
    `${outputs.length}ファイルをダウンロードします。${modeNote}\nブラウザが複数ダウンロードの許可を求める場合があります。続けますか？`);
  if (!ok || busy) return;
  // ダイアログ表示中の編集に影響されないよう、出力対象をここで固定する
  const snapOutputs = outputs.map((o) => ({ name: o.name, descs: JSON.parse(JSON.stringify(o.descs)) }));
  setBusy(true, '保存中…');
  try {
    for (const o of snapOutputs) {
      const bytes = await buildPdfBytes(o.descs);
      await verifyCount(bytes, o.descs.length);
      downloadBytes(bytes, o.name);
      await delay(300);
    }
    toast(`個別保存しました（${outputs.length}ファイルのダウンロードを要求しました）`, 'success', true);
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました', 'error');
  } finally { setBusy(false); }
}
function findRuleNameFor(dispN) {
  // 範囲ルールはグループ保存で処理済み。ここに来るのは単一指定のみ想定だが保険として名前を返す
  const r = csvRules.find((rule) => rule.pages.length === 1 && rule.pages[0] === dispN);
  return r ? r.name : null;
}
els.btnSave.addEventListener('click', saveAll);
els.btnExtract.addEventListener('click', extractSelected);
els.btnIndividual.addEventListener('click', individualSave);

/* ---------- CSVリネームルール ---------- */
function parseCsv(text) {
  const rules = [];
  const errors = [];
  const covered = new Map(); // 表示番号 -> ルール
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (!line) return;
    const comma = line.indexOf(',');
    if (comma < 0) { errors.push(lineNo); return; }
    const spec = line.slice(0, comma).trim();
    let name = line.slice(comma + 1).trim();
    if (/^\d+(,\d+)+$/.test(name)) { errors.push(lineNo); return; } // 1,3,5 形式は不可
    const m = spec.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { errors.push(lineNo); return; }
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    if (from < 1 || to < from || to > pages.length) { errors.push(lineNo); return; }
    name = sanitizeName(name, '');
    if (!name) { errors.push(lineNo); return; }
    const nums = [];
    for (let n = from; n <= to; n++) nums.push(n);
    if (nums.some((n) => covered.has(n))) { errors.push(lineNo); return; } // 重複範囲は後行を無効
    const rule = { pages: nums, name, line: lineNo };
    nums.forEach((n) => covered.set(n, rule));
    rules.push(rule);
  });
  return { rules, errors };
}
els.btnCsv.addEventListener('click', () => els.csvInput.click());
els.csvInput.addEventListener('change', async () => {
  const f = els.csvInput.files[0];
  els.csvInput.value = '';
  if (!f) return;
  try {
    const text = await f.text();
    const { rules, errors } = parseCsv(text);
    if (!rules.length) {
      toast('CSVの形式が正しくありません', 'error');
      return;
    }
    csvRules = rules;
    csvFileName = f.name;
    try { localStorage.setItem(LS_KEYS.csv, f.name); } catch (e) {}
    toast('CSVを読み込みました', 'success');
    if (errors.length) {
      toast(`CSVの${errors.length}行をスキップしました（行: ${errors.join(', ')}）`, 'warn', true);
    }
    updateStatus();
  } catch (e) {
    console.error(e);
    toast('CSVを読み込めませんでした', 'error');
  }
});

/* ---------- 右クリックメニュー ---------- */
let menuTargetIndex = -1;
function hideMenu() { els.menu.hidden = true; }
function showMenu(x, y, idx) {
  menuTargetIndex = idx;
  const items = [
    { label: '左に90°回転', act: () => rotateSelected(-90) },
    { label: '右に90°回転', act: () => rotateSelected(90) },
    { label: '180°回転', act: () => rotateSelected(180) },
    'sep',
    { label: 'ページを複製', act: () => duplicateSelected() },
    { label: '空白ページを後に追加', act: () => insertBlank(menuTargetIndex) },
    'sep',
    { label: '選択ページを抽出…', act: () => extractSelected() },
    { label: csvRules.length ? '選択ページを個別保存（CSV分割）' : '選択ページを個別保存', act: () => individualSave() },
    'sep',
    { label: '削除', act: () => deleteSelected(), danger: true },
  ];
  els.menu.innerHTML = '';
  for (const it of items) {
    if (it === 'sep') {
      const s = document.createElement('div'); s.className = 'sep';
      els.menu.appendChild(s); continue;
    }
    const d = document.createElement('div');
    d.className = 'mi' + (it.danger ? ' danger' : '');
    d.textContent = it.label;
    d.addEventListener('click', () => { hideMenu(); it.act(); });
    els.menu.appendChild(d);
  }
  els.menu.hidden = false;
  const r = els.menu.getBoundingClientRect();
  els.menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  els.menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
els.board.addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  e.preventDefault();
  const id = Number(t.dataset.id);
  const idx = pages.findIndex((p) => p.id === id);
  // 選択内なら選択を維持、選択外なら選択に追加する（複数選択トグル方式に統一）
  if (!selected.has(id)) { selected.add(id); anchorId = id; applySelectionDom(); }
  focusId = id;
  showMenu(e.clientX, e.clientY, idx);
});
document.addEventListener('click', (e) => {
  if (!els.menu.hidden && !els.menu.contains(e.target)) hideMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

/* ---------- ドラッグ＆ドロップ：ページ並び替え ---------- */
let dragIds = [];
function clearDropMarks() {
  els.board.querySelectorAll('.drop-before,.drop-after')
    .forEach((el) => el.classList.remove('drop-before', 'drop-after'));
}
els.board.addEventListener('dragstart', (e) => {
  const t = e.target.closest('.thumb');
  if (!t) return;
  const id = Number(t.dataset.id);
  if (!selected.has(id)) { selected.add(id); anchorId = id; applySelectionDom(); }
  dragIds = selectedPagesInOrder().map((p) => p.id);
  t.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', 'pdfboard-pages'); } catch (err) {}
});
els.board.addEventListener('dragend', () => {
  dragIds = [];
  clearDropMarks();
  els.board.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
});
function dropIndexFromEvent(e) {
  const t = e.target.closest('.thumb');
  if (!t) return pages.length;
  const idx = pages.findIndex((p) => p.id === Number(t.dataset.id));
  const r = t.getBoundingClientRect();
  const after = (e.clientX - r.left) > r.width / 2;
  return after ? idx + 1 : idx;
}
els.board.addEventListener('dragover', (e) => {
  if (!dragIds.length) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  const t = e.target.closest('.thumb');
  if (t) {
    const r = t.getBoundingClientRect();
    t.classList.add((e.clientX - r.left) > r.width / 2 ? 'drop-after' : 'drop-before');
  }
});
els.board.addEventListener('drop', (e) => {
  if (!dragIds.length || busy) return;
  e.preventDefault();
  const target = dropIndexFromEvent(e);
  const moving = pages.filter((p) => dragIds.includes(p.id));
  const rest = pages.filter((p) => !dragIds.includes(p.id));
  const removedBefore = pages.slice(0, target).filter((p) => dragIds.includes(p.id)).length;
  const at = Math.max(0, Math.min(target - removedBefore, rest.length));
  const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  clearDropMarks();
  if (next.every((p, i) => p.id === pages[i].id)) { dragIds = []; return; }
  pages = next;
  dragIds = [];
  pushHistory();
  renderBoard();
});

/* ---------- ドラッグ＆ドロップ：ファイル ---------- */
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    dragDepth++;
    els.overlay.hidden = false;
  }
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.overlay.hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.overlay.hidden = true;
  if (dragIds.length) return; // ページ並び替えのドロップはボード側で処理済み
  if (e.dataTransfer && e.dataTransfer.files.length) {
    handleIncomingFiles(e.dataTransfer.files);
  }
});

/* ---------- ファイルを開く ---------- */
function requestOpen() { els.fileInput.click(); }
els.btnOpen.addEventListener('click', requestOpen);
els.btnOpenEmpty.addEventListener('click', requestOpen);
els.fileInput.addEventListener('change', () => {
  const files = [...els.fileInput.files];
  els.fileInput.value = '';
  if (!files.length) return;
  const pdfs = files.filter(isPdfFile);
  if (!pdfs.length) { toast('PDF以外のファイルは開けません', 'error'); return; }
  openNewPdf(pdfs[0]);
});

/* ---------- キーボードショートカット ---------- */
function columnsCount() {
  const cs = getComputedStyle(els.board).gridTemplateColumns.split(' ').length;
  return Math.max(1, cs);
}
function moveFocus(delta) {
  if (!pages.length) return;
  let idx = pages.findIndex((p) => p.id === focusId);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(pages.length - 1, idx + delta));
  focusId = pages[idx].id;
  const el = els.board.querySelector(`.thumb[data-id="${focusId}"]`);
  if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); }
}
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (uiLocked()) return; // 処理中・ダイアログ表示中は編集系ショートカットを受け付けない
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveAll(); }
  else if (mod && e.key.toLowerCase() === 'a') {
    if (pages.length) { e.preventDefault(); selected = new Set(pages.map((p) => p.id)); applySelectionDom(); }
  }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selected.size) { e.preventDefault(); deleteSelected(); }
  }
  else if (e.key === 'ArrowRight') { e.preventDefault(); moveFocus(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); moveFocus(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(columnsCount()); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-columnsCount()); }
  else if (e.key === ' ' && focusId !== null && pages.length) {
    e.preventDefault();
    if (selected.has(focusId)) selected.delete(focusId); else selected.add(focusId);
    anchorId = focusId;
    applySelectionDom();
  }
});
els.board.addEventListener('focusin', (e) => {
  const t = e.target.closest('.thumb');
  if (t) focusId = Number(t.dataset.id);
});

/* ---------- 未保存警告（ブラウザを閉じる／リロード） ---------- */
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------- 初期化 ---------- */
loadSettings();
applyZoom(parseInt(els.zoom.value, 10));
updateStatus();
