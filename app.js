/* ==========================================================
   Kuminy的香水库 · 应用逻辑
   纯前端实现：数据保存在浏览器本地 IndexedDB，无需后端
   ========================================================== */

/* ---------- 分类定义 ---------- */
const GENDERS = ['女性香', '男性香', '中性香'];
const FAMILIES = ['花香调', '柑橘调', '果香调', '木质调', '水生调', '东方调', '馥奇调', '美食调'];
const ALL = '全部';

/* ---------- 通用工具 ---------- */
const $ = (sel, root = document) => root.querySelector(sel);

/** 转义 HTML，防止用户输入破坏页面结构 */
function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** 分割香调文本："佛手柑，柠檬 薄荷" -> ["佛手柑","柠檬","薄荷"] */
function splitNotes(text) {
  return String(text || '').split(/[,，、;；\/|\s]+/).map((s) => s.trim()).filter(Boolean);
}

function formatPrice(price) {
  if (price === null || price === undefined || price === '') return '';
  const n = Number(price);
  if (Number.isNaN(n)) return '';
  return '¥' + n.toLocaleString('zh-CN');
}

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 260);
  }, 2000);
}

/* ---------- 数据层：IndexedDB ---------- */
const DB_NAME = 'kuminy-perfume-db';
const DB_VERSION = 1;
const STORE = 'perfumes';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => done(resolve, req.result);
    req.onerror = () => done(reject, req.error);
    // 被其他标签页占用时给出明确失败，而不是无限等待
    req.onblocked = () => done(reject, new Error('本地数据库被其他标签页占用'));

    // 兜底超时：避免 open 永久挂起导致整页白屏
    setTimeout(() => {
      if (!settled) {
        settled = true;
        dbPromise = null;   // 允许下次重试
        reject(new Error('打开本地数据库超时'));
      }
    }, 5000);
  });
  return dbPromise;
}

function dbAll() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function dbGet(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function dbPut(record) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  }));
}

function dbDelete(id) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

/* ---------- 全局状态 ---------- */
const state = {
  perfumes: [],
  serverIds: new Set(),  // 公共库里已有的 id，删除时只打标记而不真删
  serverReady: false,    // 公共库是否加载成功
  filter: { gender: ALL, family: ALL },
  search: '',
  unlocked: false,      // 是否已通过密钥解锁管理功能
  editingId: null,
  pendingImage: null    // 表单中待保存的图片（dataURL）
};

/* ---------- 图片压缩 ---------- */
function readImageFile(file, maxSize = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- 渲染：首页 ---------- */
function countBy(field, value) {
  return state.perfumes.filter((p) => p[field] === value).length;
}

function chipHTML(label, value, active, count) {
  return `<button type="button" class="chip${active ? ' active' : ''}" data-value="${esc(value)}">
    <span>${esc(label)}</span><span class="count">${count}</span>
  </button>`;
}

function matchesSearch(p, keyword) {
  if (!keyword) return true;
  const haystack = [
    p.name, p.brand, p.gender, p.family,
    p.topNotes, p.middleNotes, p.baseNotes, p.review
  ].map((v) => String(v || '').toLowerCase()).join(' ');
  return haystack.includes(keyword);
}

function filteredList() {
  const keyword = state.search.trim().toLowerCase();
  return state.perfumes.filter((p) => {
    const g = state.filter.gender === ALL || p.gender === state.filter.gender;
    const f = state.filter.family === ALL || p.family === state.filter.family;
    return g && f && matchesSearch(p, keyword);
  });
}

function cardHTML(p) {
  const media = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />`
    : `<div class="media-fallback">${esc((p.name || '✦').trim().slice(0, 1))}</div>`;

  const badges = [
    p.gender ? `<span class="badge">${esc(p.gender)}</span>` : '',
    p.family ? `<span class="badge badge-family">${esc(p.family)}</span>` : ''
  ].join('');

  const allNotes = [
    ...splitNotes(p.topNotes).slice(0, 2),
    ...splitNotes(p.middleNotes).slice(0, 1)
  ];
  const notesLine = allNotes.length
    ? `前调 · ${esc(allNotes.join(' / '))}`
    : '<span style="color:#b6aca1">尚未记录香调</span>';

  const priceText = formatPrice(p.price);

  return `<article class="card" data-id="${esc(p.id)}">
    <div class="card-media">
      ${media}
      <div class="card-badges">${badges}</div>
    </div>
    <div class="card-body">
      <h3 class="card-title">${esc(p.name)}</h3>
      <p class="card-brand">${esc(p.brand || '未填写品牌')}</p>
      <p class="card-notes">${notesLine}</p>
      <div class="card-foot">
        <span class="price${priceText ? '' : ' empty'}">${priceText || '暂无价格'}</span>
        <span class="family-tag">${esc(p.family || '')}</span>
      </div>
    </div>
  </article>`;
}

/* 结果区：统计条 + 卡片网格 / 空状态 */
function resultsHTML() {
  const list = filteredList();
  const keyword = state.search.trim();

  const activeDesc = [
    state.filter.gender !== ALL ? state.filter.gender : '',
    state.filter.family !== ALL ? state.filter.family : ''
  ].filter(Boolean).join(' · ');
  const keywordDesc = keyword ? `搜索「${esc(keyword)}」` : '';
  const descText = [activeDesc, keywordDesc].filter(Boolean).join(' · ');

  let body;
  if (state.perfumes.length === 0) {
    body = `<div class="empty">
      <span class="empty-mark">✦</span>
      <h3>香水库还空着</h3>
      <p>录入你的第一支香水，为它写下前调、中调与后调。</p>
      <button class="btn btn-primary admin-only" data-action="add" type="button">＋ 添加香水</button>
    </div>`;
  } else if (list.length === 0) {
    body = `<div class="empty">
      <span class="empty-mark">✦</span>
      <h3>没有找到符合条件的香水</h3>
      <p>换个关键词或分类试试，也可以导入之前导出的备份。</p>
      <button class="btn btn-ghost" data-action="reset" type="button">清除筛选条件</button>
    </div>`;
  } else {
    body = `<div class="grid">${list.map(cardHTML).join('')}</div>`;
  }

  return `<div class="result-bar">
      <span class="result-text">
        共 <strong>${list.length}</strong> 支香水
        ${descText ? `<span style="color:#b6aca1"> · ${descText}</span>` : ''}
      </span>
    </div>
    ${body}`;
}

/* 只刷新结果区，以保留搜索框输入与分类标签状态 */
function updateResults() {
  const area = $('#resultsArea');
  if (!area) return;
  area.innerHTML = resultsHTML();

  area.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => { location.hash = '#/perfume/' + card.dataset.id; });
  });

  const addBtn = area.querySelector('[data-action="add"]');
  if (addBtn) addBtn.addEventListener('click', () => openForm());

  const resetBtn = area.querySelector('[data-action="reset"]');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    state.search = '';
    state.filter = { gender: ALL, family: ALL };
    renderHome();
  });
}

function renderHome() {
  const genderChips = [
    chipHTML(ALL, ALL, state.filter.gender === ALL, state.perfumes.length),
    ...GENDERS.map((g) => chipHTML(g, g, state.filter.gender === g, countBy('gender', g)))
  ].join('');

  const familyChips = [
    chipHTML(ALL, ALL, state.filter.family === ALL, state.perfumes.length),
    ...FAMILIES.map((f) => chipHTML(f, f, state.filter.family === f, countBy('family', f)))
  ].join('');

  $('#view').innerHTML = `
    <section class="hero">
      <h1>我的<span class="accent-text">香水</span>收藏录</h1>
      <p>记录每一支香气的前调、中调与后调，按性别与香调归档整理。</p>
    </section>

    <div class="search-box">
      <span class="search-icon">🔍</span>
      <input type="search" id="searchInput" placeholder="搜索香水名称、品牌或香调……" value="${esc(state.search)}" />
      <button class="search-clear" id="searchClear" type="button" aria-label="清空搜索"${state.search ? '' : ' hidden'}>✕</button>
    </div>

    <section class="filters">
      <div class="filter-row">
        <span class="filter-label">性别</span>
        <div class="chips" data-group="gender">${genderChips}</div>
      </div>
      <div class="filter-row">
        <span class="filter-label">香调</span>
        <div class="chips" data-group="family">${familyChips}</div>
      </div>
    </section>

    <div id="resultsArea"></div>
  `;

  // 搜索框：输入时只刷新结果区，避免失焦
  const searchInput = $('#searchInput');
  searchInput.addEventListener('input', () => {
    state.search = searchInput.value;
    $('#searchClear').hidden = !state.search;
    updateResults();
  });
  $('#searchClear').addEventListener('click', () => {
    state.search = '';
    searchInput.value = '';
    $('#searchClear').hidden = true;
    searchInput.focus();
    updateResults();
  });

  // 分类筛选：只切换激活样式并刷新结果区
  $('#view').querySelectorAll('.chips').forEach((group) => {
    group.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.filter[group.dataset.group] = chip.dataset.value;
      group.querySelectorAll('.chip').forEach((c) => {
        c.classList.toggle('active', c.dataset.value === chip.dataset.value);
      });
      updateResults();
    });
  });

  updateResults();
}

/* ---------- 渲染：详情页 ---------- */
function pyramidRow(label, dotClass, notes) {
  const chips = notes.length
    ? `<div class="pyramid-chips">${notes.map((n) => `<span class="note-chip">${esc(n)}</span>`).join('')}</div>`
    : `<span class="pyramid-empty">暂未记录</span>`;
  return `<div class="pyramid-row">
    <div class="pyramid-label"><span class="note-dot ${dotClass}"></span>${label}</div>
    ${chips}
  </div>`;
}

function renderDetail(id) {
  const p = state.perfumes.find((x) => x.id === id);

  if (!p) {
    $('#view').innerHTML = `<div class="detail">
      <a class="back-link" href="#/">← 返回香气首页</a>
      <div class="empty">
        <span class="empty-mark">✦</span>
        <h3>没有找到这支香水</h3>
        <p>它可能已被删除。</p>
        <a class="btn btn-primary" href="#/" style="display:inline-block;text-decoration:none">返回首页</a>
      </div>
    </div>`;
    return;
  }

  const media = p.image
    ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" />`
    : `<div class="media-fallback">${esc((p.name || '✦').trim().slice(0, 1))}</div>`;

  const priceText = formatPrice(p.price);

  $('#view').innerHTML = `
    <div class="detail">
      <a class="back-link" href="#/">← 返回香气首页</a>

      <article class="detail-card">
        <div class="detail-top">
          <div class="detail-media">${media}</div>
          <div class="detail-info">
            <div class="detail-tags">
              ${p.gender ? `<span class="tag tag-gender">${esc(p.gender)}</span>` : ''}
              ${p.family ? `<span class="tag tag-family">${esc(p.family)}</span>` : ''}
            </div>
            <h1 class="detail-title">${esc(p.name)}</h1>
            <p class="detail-brand">${esc(p.brand || '未填写品牌')}</p>
            <div class="detail-price${priceText ? '' : ' empty'}">${priceText || '暂无价格'}</div>
            <div class="detail-price-label">PRICE</div>
            <div class="detail-actions admin-only">
              <button class="btn btn-primary" data-action="edit" type="button">编辑</button>
              <button class="btn btn-danger" data-action="delete" type="button">删除</button>
            </div>
          </div>
        </div>

        <div class="detail-bottom">
          <h2 class="section-title">香调金字塔</h2>
          <div class="pyramid">
            ${pyramidRow('前调', 'dot-top', splitNotes(p.topNotes))}
            ${pyramidRow('中调', 'dot-middle', splitNotes(p.middleNotes))}
            ${pyramidRow('后调', 'dot-base', splitNotes(p.baseNotes))}
          </div>

          ${p.review ? `<h2 class="section-title">香评 · 备注</h2><div class="review-box">${esc(p.review)}</div>` : ''}
        </div>
      </article>
    </div>
  `;

  $('#view').querySelector('[data-action="edit"]').addEventListener('click', () => openForm(p));
  $('#view').querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const fromServer = state.serverIds.has(p.id);
    const hint = fromServer
      ? '\n\n它来自网站公共香水库：删除后只对你本机隐藏，导出数据并上传后才会对所有人生效。'
      : '';
    if (!confirm(`确定要删除「${p.name}」吗？${hint}`)) return;

    if (fromServer) {
      // 公共库的数据删不掉，只能在本机打上删除标记
      await dbPut({ id: p.id, deleted: true, updatedAt: Date.now() });
    } else {
      await dbDelete(p.id);
    }
    state.perfumes = state.perfumes.filter((x) => x.id !== p.id);
    toast('已删除「' + p.name + '」');
    location.hash = '#/';
  });
}

/* ---------- 表单弹窗 ---------- */
function fillSelect(select, options, value) {
  select.innerHTML = options.map((o) =>
    `<option value="${esc(o)}"${o === value ? ' selected' : ''}>${esc(o)}</option>`
  ).join('');
}

function openForm(perfume = null) {
  const form = $('#perfumeForm');
  form.reset();

  state.editingId = perfume ? perfume.id : null;
  state.pendingImage = perfume ? (perfume.image || null) : null;

  $('#modalTitle').textContent = perfume ? '编辑香水' : '添加香水';
  $('#editId').value = perfume ? perfume.id : '';
  $('#name').value = perfume ? (perfume.name || '') : '';
  $('#brand').value = perfume ? (perfume.brand || '') : '';
  $('#price').value = perfume && perfume.price != null ? perfume.price : '';
  $('#topNotes').value = perfume ? (perfume.topNotes || '') : '';
  $('#middleNotes').value = perfume ? (perfume.middleNotes || '') : '';
  $('#baseNotes').value = perfume ? (perfume.baseNotes || '') : '';
  $('#review').value = perfume ? (perfume.review || '') : '';

  fillSelect($('#gender'), GENDERS, perfume ? perfume.gender : GENDERS[0]);
  fillSelect($('#family'), FAMILIES, perfume ? perfume.family : FAMILIES[0]);

  renderImagePreview();

  $('#modalBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#name').focus(), 60);
}

function closeForm() {
  $('#modalBackdrop').hidden = true;
  document.body.style.overflow = '';
  state.editingId = null;
  state.pendingImage = null;
}

function renderImagePreview() {
  const has = !!state.pendingImage;
  const preview = $('#imagePreview');
  const hint = $('#uploadHint');
  if (has) {
    preview.src = state.pendingImage;
    preview.hidden = false;
    hint.hidden = true;
  } else {
    preview.removeAttribute('src');
    preview.hidden = true;
    hint.hidden = false;
  }
  $('#clearImage').hidden = !has;
}

async function handleSave(e) {
  e.preventDefault();

  const name = $('#name').value.trim();
  if (!name) {
    toast('请填写香水名称');
    $('#name').focus();
    return;
  }

  const priceRaw = $('#price').value.trim();
  const price = priceRaw === '' ? null : Number(priceRaw);

  const record = {
    id: state.editingId || uid(),
    name,
    brand: $('#brand').value.trim(),
    gender: $('#gender').value,
    family: $('#family').value,
    topNotes: $('#topNotes').value.trim(),
    middleNotes: $('#middleNotes').value.trim(),
    baseNotes: $('#baseNotes').value.trim(),
    price: Number.isNaN(price) ? null : price,
    image: state.pendingImage || null,
    review: $('#review').value.trim(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  const existing = state.editingId ? state.perfumes.find((x) => x.id === state.editingId) : null;
  if (existing) record.createdAt = existing.createdAt;

  try {
    const saveBtn = $('#saveBtn');
    saveBtn.disabled = true;
    await dbPut(record);
    if (existing) {
      const idx = state.perfumes.findIndex((x) => x.id === record.id);
      state.perfumes[idx] = record;
    } else {
      state.perfumes.unshift(record);
    }
    saveBtn.disabled = false;
    closeForm();
    toast(existing ? '已保存修改' : '已收藏「' + record.name + '」');
    location.hash = '#/perfume/' + record.id;
  } catch (err) {
    console.error(err);
    toast('保存失败，请重试');
    $('#saveBtn').disabled = false;
  }
}

/* ---------- 密钥锁 ---------- */
const ACCESS_KEY = '070404';
const ACCESS_STORAGE = 'kuminy.access';

function readAccess() {
  try {
    return localStorage.getItem(ACCESS_STORAGE) === '1';
  } catch (err) {
    return false;   // 隐私模式下不可用，按未解锁处理
  }
}

function setAccess(unlocked) {
  state.unlocked = unlocked;
  try {
    localStorage.setItem(ACCESS_STORAGE, unlocked ? '1' : '0');
  } catch (err) { /* 忽略存储失败 */ }
  applyAccess();
}

function applyAccess() {
  document.body.classList.toggle('unlocked', state.unlocked);
  const btn = $('#keyBtn');
  btn.textContent = state.unlocked ? '🔓 已解锁' : '🔑 密钥';
  btn.classList.toggle('is-unlocked', state.unlocked);
}

function openKeyModal() {
  $('#keyInput').value = '';
  $('#keyBackdrop').hidden = false;
  document.body.style.overflow = 'hidden';
  setTimeout(() => $('#keyInput').focus(), 60);
}

function closeKeyModal() {
  $('#keyBackdrop').hidden = true;
  document.body.style.overflow = '';
}

function confirmKey() {
  if ($('#keyInput').value.trim() === ACCESS_KEY) {
    setAccess(true);
    closeKeyModal();
    toast('已解锁，管理功能已显示');
  } else {
    toast('密钥不正确');
    $('#keyInput').select();
  }
}

/* ---------- 数据来源：公共库（服务器）+ 本地工作副本 ---------- */
const LIBRARY_URL = 'data/perfumes.json';

/**
 * 拉取网站自带的公共香水库。
 * 用相对路径，部署到 GitHub Pages 的子路径下也能正确取到。
 */
async function fetchServerLibrary() {
  const res = await fetch(LIBRARY_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const raw = Array.isArray(data) ? data : (Array.isArray(data.perfumes) ? data.perfumes : []);
  return raw.map(normalizeImported).filter(Boolean);
}

/** 比较两支香水的实际内容，忽略 id / 时间戳这类元数据 */
const CONTENT_FIELDS = ['name', 'brand', 'gender', 'family', 'topNotes', 'middleNotes', 'baseNotes', 'price', 'image', 'review'];
function sameContent(a, b) {
  return CONTENT_FIELDS.every((k) => (a[k] == null ? '' : a[k]) === (b[k] == null ? '' : b[k]));
}

/**
 * 合成最终展示列表：
 *   1. 公共库 —— 所有人可见的基础数据，每次打开都取最新版
 *   2. 本地副本 —— 本机新增/修改/删除的内容，覆盖同 id 的公共数据
 * 这样访客永远看到最新的公开内容，而本站主人未发布的改动也保留在自己浏览器里。
 */
async function loadLibrary() {
  let server = [];
  try {
    server = await fetchServerLibrary();
    state.serverReady = true;
  } catch (err) {
    console.error(err);
    state.serverReady = false;
  }

  const serverMap = new Map(server.map((r) => [r.id, r]));
  state.serverIds = new Set(serverMap.keys());

  let local = await dbAll();

  // 清理旧版本遗留的、与公共库完全相同的历史副本，否则它们会一直遮蔽公共库的后续更新
  const redundant = local.filter((r) => !r.deleted && serverMap.has(r.id) && sameContent(r, serverMap.get(r.id)));
  if (redundant.length) {
    const dropIds = new Set(redundant.map((r) => r.id));
    for (const id of dropIds) await dbDelete(id);
    local = local.filter((r) => !dropIds.has(r.id));
  }

  const removed = new Set(local.filter((r) => r.deleted).map((r) => r.id));
  const localMap = new Map(local.filter((r) => !r.deleted).map((r) => [r.id, r]));

  // 公共库为主干，本地有改动的（同 id）覆盖之
  const merged = server
    .filter((r) => !removed.has(r.id))
    .map((r) => localMap.get(r.id) || r);

  // 本地新增的（公共库里没有的）一并展示
  local.forEach((r) => {
    if (!r.deleted && !state.serverIds.has(r.id)) merged.push(r);
  });

  merged.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return merged;
}

/* ---------- 数据备份：导出 / 导入 ---------- */
/**
 * 导出的是「当前屏幕上看到的全部香水」。
 * 这个文件有两个用途：
 *   1. 作为备份，可用「导入数据」还原到任何浏览器
 *   2. 直接替换网站上的 data/perfumes.json，即完成一次对外发布
 */
function exportLibrary() {
  const list = state.perfumes;
  if (!list.length) {
    toast('香水库还是空的，暂时没有可导出的数据');
    return;
  }

  const payload = {
    app: 'Kuminy的香水库',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: list.length,
    perfumes: list
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'perfumes.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  toast(`已导出 ${list.length} 支香水，上传到网站即可发布`);
}

/** 把导入的原始对象规范化为一条合法记录，无法识别则返回 null */
function normalizeImported(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;

  const priceNum = Number(raw.price);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
    name,
    brand: String(raw.brand || ''),
    gender: GENDERS.includes(raw.gender) ? raw.gender : GENDERS[0],
    family: FAMILIES.includes(raw.family) ? raw.family : FAMILIES[0],
    topNotes: String(raw.topNotes || ''),
    middleNotes: String(raw.middleNotes || ''),
    baseNotes: String(raw.baseNotes || ''),
    price: raw.price === null || raw.price === '' || Number.isNaN(priceNum) ? null : priceNum,
    image: typeof raw.image === 'string' && raw.image.startsWith('data:image') ? raw.image : null,
    review: String(raw.review || ''),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Date.now()
  };
}

async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast('文件内容不是有效的 JSON，导入失败');
    return;
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.perfumes) ? parsed.perfumes : null);
  if (!rawList) {
    toast('无法识别的备份文件格式');
    return;
  }

  const items = rawList.map(normalizeImported).filter(Boolean);
  if (!items.length) {
    toast('备份文件中没有可导入的香水');
    return;
  }

  if (!confirm(`解析到 ${items.length} 支香水。\n\n将合并导入到香水库，相同 ID 的记录会被覆盖，其余现有香水保持不变。\n\n确定继续吗？`)) {
    return;
  }

  try {
    for (const item of items) await dbPut(item);
    state.perfumes = await loadLibrary();
    // 重置筛选条件，确保刚导入的香水可见
    state.search = '';
    state.filter = { gender: ALL, family: ALL };
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    renderHome();
    toast(`已导入 ${items.length} 支香水`);
  } catch (err) {
    console.error(err);
    toast('导入过程中出错，请重试');
  }
}

/* ---------- 路由 ---------- */
function route() {
  const hash = location.hash || '#/';
  const match = hash.match(/^#\/perfume\/(.+)$/);
  if (match) {
    renderDetail(decodeURIComponent(match[1]));
  } else {
    renderHome();
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ---------- 初始化 ---------- */
async function init() {
  // 事件绑定
  $('#openAdd').addEventListener('click', () => openForm());
  $('#closeModal').addEventListener('click', closeForm);
  $('#cancelForm').addEventListener('click', closeForm);
  $('#perfumeForm').addEventListener('submit', handleSave);
  $('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#modalBackdrop')) closeForm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#keyBackdrop').hidden) { closeKeyModal(); return; }
    if (!$('#modalBackdrop').hidden) closeForm();
  });

  // 密钥锁
  state.unlocked = readAccess();
  applyAccess();
  $('#keyBtn').addEventListener('click', () => {
    if (state.unlocked) {
      setAccess(false);
      toast('已锁定，管理功能已隐藏');
      return;
    }
    openKeyModal();
  });
  $('#closeKey').addEventListener('click', closeKeyModal);
  $('#cancelKey').addEventListener('click', closeKeyModal);
  $('#confirmKey').addEventListener('click', confirmKey);
  $('#keyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmKey(); }
  });
  $('#keyBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#keyBackdrop')) closeKeyModal();
  });

  $('#imageInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
    try {
      state.pendingImage = await readImageFile(file);
      renderImagePreview();
    } catch (err) {
      console.error(err);
      toast('图片处理失败');
    }
    e.target.value = '';
  });

  $('#clearImage').addEventListener('click', () => {
    state.pendingImage = null;
    renderImagePreview();
  });

  // 数据备份
  $('#exportBtn').addEventListener('click', exportLibrary);
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      await importBackup(file);
    } catch (err) {
      console.error(err);
      toast('导入失败，请确认文件可读');
    }
    e.target.value = '';
  });

  window.addEventListener('hashchange', route);

  // 先渲染界面，避免数据层异常时出现整页白屏
  route();

  // 再读取数据：公共库 + 本地副本
  try {
    state.perfumes = await loadLibrary();
  } catch (err) {
    console.error(err);
    toast('本地数据读取失败，香水列表暂时无法显示');
    return;
  }

  if (!state.serverReady) {
    toast('公共香水库加载失败，当前只显示本机数据');
  }

  route();
}

document.addEventListener('DOMContentLoaded', init);
