(function () {
  const API_URL = window.CONFIG.API_URL;
  const TOKEN = window.CONFIG.TOKEN;

  const LOCATION_LABEL = { lab: '研究室', home: '自宅' };
  const STATUS_LABEL = { available: '保管中', lent: '貸出中' };
  const ACQUISITION_LABEL = { self: '自費', lab_budget: '個人研究費', kaken: '科研費', gift: '献本', unknown: 'その他・不明' };

  let books = [];
  let filter = 'all'; // all | lab | home | lent
  let sortBy = 'registered_desc'; // registered_desc | registered_asc | year_desc | year_asc
  let query = '';
  let showForm = false;
  let editingId = null;
  let lendingId = null;
  let scannerInstance = null;
  let lookupTimer = null;
  let isComposingSearch = false;

  const root = document.getElementById('app');

  // ---------- API ----------

  async function apiGet(action, params) {
    const url = new URL(API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('token', TOKEN);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
  }

  async function apiPost(action, book) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライトを避けるため text/plain で送る
      body: JSON.stringify({ action, token: TOKEN, book: book || {} })
    });
    return res.json();
  }

  async function loadBooks() {
    root.innerHTML = '<div class="bt-loading">読み込み中…</div>';
    try {
      const res = await apiGet('list');
      if (!res.ok) throw new Error(res.error || '読み込みに失敗しました');
      books = res.books;
      render();
    } catch (e) {
      root.innerHTML = `<div class="bt-loading">読み込みエラー: ${escapeHtml(String(e.message || e))}<br>config.js の API_URL / TOKEN を確認してください。</div>`;
    }
  }

  // ---------- ユーティリティ ----------

  function escapeHtml(s) {
    return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function normalize(s) {
    if (s === null || s === undefined) return '';
    return String(s).toLowerCase().replace(/\s+/g, '');
  }

  function groupKey(b) {
    return b.isbn ? 'isbn:' + b.isbn : 'title:' + normalize(b.title);
  }

  function matchesQuery(b) {
    if (!query) return true;
    const q = normalize(query);
    return normalize(b.title).includes(q) || normalize(b.author).includes(q) || normalize(b.isbn).includes(q);
  }

  function matchesFilter(b) {
    if (filter === 'all') return true;
    if (filter === 'lab') return b.location === 'lab';
    if (filter === 'home') return b.location === 'home';
    if (filter === 'lent') return b.status === 'lent';
    return true;
  }

  function compareBooks(a, b) {
    if (sortBy === 'year_desc' || sortBy === 'year_asc') {
      const ay = String(a.publishedYear || '');
      const by = String(b.publishedYear || '');
      if (!ay && !by) return 0;
      if (!ay) return 1; // 刊行年が無いものは常に末尾
      if (!by) return -1;
      return sortBy === 'year_desc' ? by.localeCompare(ay) : ay.localeCompare(by);
    }
    const ad = String(a.registeredDate || '');
    const bd = String(b.registeredDate || '');
    return sortBy === 'registered_desc' ? bd.localeCompare(ad) : ad.localeCompare(bd);
  }

  function findSameBooks(title, isbn, excludeId) {
    const nt = normalize(title);
    const cleanIsbn = String(isbn || '').replace(/[^0-9Xx]/g, '');
    return books.filter(b => {
      if (b.id === excludeId) return false;
      if (cleanIsbn && b.isbn && String(b.isbn).replace(/[^0-9Xx]/g, '') === cleanIsbn) return true;
      if (!cleanIsbn && nt && normalize(b.title) === nt) return true;
      return false;
    });
  }

  // ---------- レンダリング ----------

  function render() {
    const visible = books.filter(b => matchesQuery(b) && matchesFilter(b));
    visible.sort(compareBooks);
    const groups = {};
    const order = [];
    visible.forEach(b => {
      const key = groupKey(b);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(b);
    });

    const countLent = books.filter(b => b.status === 'lent').length;

    root.innerHTML = `
      <div class="bt-header">
        <div class="bt-title">蔵書管理</div>
        <div class="bt-count">全 ${books.length} 冊 / 貸出中 ${countLent} 冊</div>
      </div>
      <div class="bt-toolbar">
        <input class="bt-search" id="bt-search" type="text" placeholder="タイトル・著者・ISBNで検索(購入前チェックにも)" value="${escapeHtml(query)}" />
        <div class="bt-filters">
          <button class="bt-filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">すべて</button>
          <button class="bt-filter-btn ${filter === 'lab' ? 'active' : ''}" data-filter="lab">研究室</button>
          <button class="bt-filter-btn ${filter === 'home' ? 'active' : ''}" data-filter="home">自宅</button>
          <button class="bt-filter-btn ${filter === 'lent' ? 'active' : ''}" data-filter="lent">貸出中</button>
        </div>
        <select class="bt-sort-select" id="bt-sort">
          <option value="registered_desc" ${sortBy === 'registered_desc' ? 'selected' : ''}>登録が新しい順</option>
          <option value="registered_asc" ${sortBy === 'registered_asc' ? 'selected' : ''}>登録が古い順</option>
          <option value="year_desc" ${sortBy === 'year_desc' ? 'selected' : ''}>刊行年が新しい順</option>
          <option value="year_asc" ${sortBy === 'year_asc' ? 'selected' : ''}>刊行年が古い順</option>
        </select>
        ${!showForm ? '<button class="bt-add-btn" id="bt-open-add">+ 本を追加</button>' : ''}
      </div>
      ${showForm ? renderForm() : ''}
      ${order.length === 0
        ? `<div class="bt-empty">${books.length === 0 ? 'まだ本が登録されていません。「+ 本を追加」から登録してください。' : '該当する本がありません。'}</div>`
        : `<div class="bt-list">${order.map(k => renderGroup(groups[k])).join('')}</div>`
      }
      <div id="bt-scanner-modal"></div>
    `;

    attachEvents();
  }

  function renderGroup(items) {
    const first = items[0];
    const multi = items.length > 1;
    return `
      <div class="bt-group">
        <div class="bt-group-title">
          ${escapeHtml(first.title)}
          ${multi ? `<span class="bt-copies">(${items.length}冊)</span>` : ''}
        </div>
        ${items.map(renderRow).join('')}
      </div>
    `;
  }

  function renderRow(b) {
    const locTag = b.location === 'lab' ? '<span class="bt-tag bt-tag-lab">研究室</span>' : '<span class="bt-tag bt-tag-home">自宅</span>';
    const lentTag = b.status === 'lent' ? '<span class="bt-tag bt-tag-lent">貸出中</span>' : '';

    const metaBits = [];
    if (b.author) metaBits.push(escapeHtml(b.author));
    let pubBit = '';
    if (b.publisher && b.publishedYear) pubBit = `${b.publisher}(${b.publishedYear})`;
    else if (b.publisher) pubBit = b.publisher;
    else if (b.publishedYear) pubBit = `(${b.publishedYear})`;
    if (pubBit) metaBits.push(escapeHtml(pubBit));
    if (ACQUISITION_LABEL[b.acquisition]) metaBits.push(ACQUISITION_LABEL[b.acquisition]);
    if (b.status === 'lent' && b.borrower) metaBits.push(`→ ${escapeHtml(b.borrower)}${b.lentDate ? ' (' + escapeHtml(b.lentDate) + '〜)' : ''}`);

    const lendFormHtml = lendingId === b.id ? `
      <div class="bt-lend-form">
        <input id="bt-borrower-input" type="text" placeholder="貸出先の名前" />
        <button class="bt-icon-btn" id="bt-confirm-lend" data-id="${b.id}">貸出を記録</button>
        <button class="bt-icon-btn" id="bt-cancel-lend">キャンセル</button>
      </div>` : '';

    const thumb = b.coverUrl
      ? `<img class="bt-thumb" src="${escapeHtml(b.coverUrl)}" alt="" />`
      : `<div class="bt-thumb bt-thumb-placeholder">📕</div>`;

    return `
      <div class="bt-row">
        ${thumb}
        <div class="bt-row-main">
          <div class="bt-row-tags">${locTag}${lentTag}</div>
          ${metaBits.length ? `<div class="bt-row-meta">${metaBits.join(' ・ ')}</div>` : ''}
          ${lendFormHtml}
        </div>
        <div class="bt-row-actions">
          ${b.status === 'lent'
            ? `<button class="bt-icon-btn" data-action="return" data-id="${b.id}">返却済み</button>`
            : `<button class="bt-icon-btn" data-action="lend" data-id="${b.id}">貸出</button>`}
          <button class="bt-icon-btn" data-action="edit" data-id="${b.id}">編集</button>
          <button class="bt-icon-btn danger" data-action="delete" data-id="${b.id}">削除</button>
        </div>
      </div>
    `;
  }

  function renderDupWarningHtml(title, isbn, excludeId) {
    const dupes = findSameBooks(title, isbn, excludeId);
    if (dupes.length === 0) return '';
    return `<div class="bt-dup-warning">📚 この本はすでに${dupes.length}冊あります: ${dupes.map(d => `${LOCATION_LABEL[d.location]}(${ACQUISITION_LABEL[d.acquisition] || '不明'})`).join('、')} ー そのまま追加できます</div>`;
  }

  function updateDupWarningLive() {
    const titleEl = document.getElementById('bt-input-title');
    const isbnEl = document.getElementById('bt-input-isbn');
    const container = document.getElementById('bt-dup-container');
    if (!titleEl || !container) return;
    container.innerHTML = renderDupWarningHtml(titleEl.value, isbnEl ? isbnEl.value : '', editingId);
  }

  function updateCoverPreview(url) {
    const preview = document.getElementById('bt-cover-preview');
    if (!preview) return;
    if (url) { preview.src = url; preview.style.display = ''; }
    else { preview.style.display = 'none'; }
  }

  function renderForm() {
    const editing = editingId ? books.find(b => b.id === editingId) : null;
    const v = (f, d) => editing ? (editing[f] || d || '') : (d || '');

    return `
      <div class="bt-form">
        <div class="bt-full bt-isbn-row">
          <input id="bt-input-isbn" type="text" inputmode="numeric" placeholder="ISBN(バーコードをスキャン or 手入力、無くてもOK)" value="${escapeHtml(v('isbn'))}" />
          <button type="button" class="bt-btn-ghost" id="bt-scan-btn">📷 スキャン</button>
          <button type="button" class="bt-btn-ghost" id="bt-lookup-btn">検索</button>
        </div>
        <div class="bt-full" id="bt-lookup-status"></div>
        <div class="bt-full" id="bt-dup-container">${renderDupWarningHtml(v('title'), v('isbn'), editingId)}</div>
        <input class="bt-full" id="bt-input-title" type="text" placeholder="タイトル(必須)" value="${escapeHtml(v('title'))}" />
        <input id="bt-input-author" type="text" placeholder="著者" value="${escapeHtml(v('author'))}" />
        <input id="bt-input-publisher" type="text" placeholder="出版社" value="${escapeHtml(v('publisher'))}" />
        <input id="bt-input-publishedYear" type="text" inputmode="numeric" placeholder="刊行年(西暦4桁、任意)" value="${escapeHtml(v('publishedYear'))}" />
        <select id="bt-input-location">
          <option value="lab" ${v('location', 'lab') === 'lab' ? 'selected' : ''}>研究室</option>
          <option value="home" ${v('location') === 'home' ? 'selected' : ''}>自宅</option>
        </select>
        <select id="bt-input-acquisition">
          <option value="self" ${v('acquisition', 'self') === 'self' ? 'selected' : ''}>自費</option>
          <option value="lab_budget" ${v('acquisition') === 'lab_budget' ? 'selected' : ''}>研究費</option>
          <option value="gift" ${v('acquisition') === 'gift' ? 'selected' : ''}>献本</option>
          <option value="unknown" ${v('acquisition') === 'unknown' ? 'selected' : ''}>不明</option>
        </select>
        <div class="bt-full bt-cover-row">
          <input id="bt-input-coverUrl" type="text" placeholder="書影URL(自動取得できなかった場合は画像URLを直接入力)" value="${escapeHtml(v('coverUrl'))}" />
          <img id="bt-cover-preview" class="bt-thumb" src="${escapeHtml(v('coverUrl'))}" alt="" style="${v('coverUrl') ? '' : 'display:none;'}" onerror="this.style.display='none'" />
        </div>
        <div class="bt-form-actions bt-full">
          <button class="bt-btn-ghost" id="bt-cancel-form">キャンセル</button>
          <button class="bt-btn-primary" id="bt-save-form">${editing ? '更新する' : '登録する'}</button>
        </div>
      </div>
    `;
  }

  // ---------- イベント ----------

  function attachEvents() {
    const searchEl = document.getElementById('bt-search');
    if (searchEl) {
      searchEl.addEventListener('compositionstart', () => { isComposingSearch = true; });
      searchEl.addEventListener('compositionend', (e) => {
        isComposingSearch = false;
        query = e.target.value;
        render();
        const el = document.getElementById('bt-search');
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      });
      searchEl.addEventListener('input', (e) => {
        if (isComposingSearch) return; // 日本語入力の変換確定前は再描画しない(IMEが確定されてしまうのを防ぐ)
        query = e.target.value;
        render();
        const el = document.getElementById('bt-search');
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      });
    }

    document.querySelectorAll('.bt-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => { filter = btn.getAttribute('data-filter'); render(); });
    });

    const sortEl = document.getElementById('bt-sort');
    if (sortEl) {
      sortEl.addEventListener('change', (e) => { sortBy = e.target.value; render(); });
    }

    const openAddBtn = document.getElementById('bt-open-add');
    if (openAddBtn) {
      openAddBtn.addEventListener('click', () => {
        showForm = true; editingId = null; render();
        const isbnInput = document.getElementById('bt-input-isbn');
        if (isbnInput) isbnInput.focus(); // USBリーダーはここにフォーカスがあれば直接入力される
      });
    }

    const titleInput = document.getElementById('bt-input-title');
    if (titleInput) {
      titleInput.addEventListener('input', updateDupWarningLive);
    }

    const isbnInput = document.getElementById('bt-input-isbn');
    if (isbnInput) {
      isbnInput.addEventListener('input', () => {
        updateDupWarningLive();
        clearTimeout(lookupTimer);
        lookupTimer = setTimeout(() => doLookup(isbnInput.value), 500);
      });
      isbnInput.addEventListener('keydown', (e) => {
        // USBバーコードリーダーはスキャン後に Enter を送ることが多い
        if (e.key === 'Enter') { e.preventDefault(); doLookup(isbnInput.value); }
      });
    }

    const coverInput = document.getElementById('bt-input-coverUrl');
    if (coverInput) {
      coverInput.addEventListener('input', () => updateCoverPreview(coverInput.value));
    }

    const lookupBtn = document.getElementById('bt-lookup-btn');
    if (lookupBtn) lookupBtn.addEventListener('click', () => doLookup(document.getElementById('bt-input-isbn').value));

    const scanBtn = document.getElementById('bt-scan-btn');
    if (scanBtn) scanBtn.addEventListener('click', openScanner);

    const cancelFormBtn = document.getElementById('bt-cancel-form');
    if (cancelFormBtn) cancelFormBtn.addEventListener('click', () => { showForm = false; editingId = null; render(); });

    const saveFormBtn = document.getElementById('bt-save-form');
    if (saveFormBtn) saveFormBtn.addEventListener('click', saveForm);

    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-id');
        if (action === 'edit') { editingId = id; showForm = true; render(); }
        else if (action === 'delete') {
          if (!confirm('この本を削除しますか？')) return;
          btn.disabled = true; btn.textContent = '削除中…';
          deleteBook(id);
        }
        else if (action === 'lend') { lendingId = id; render(); const inp = document.getElementById('bt-borrower-input'); if (inp) inp.focus(); }
        else if (action === 'return') {
          btn.disabled = true; btn.textContent = '処理中…';
          returnBook(id);
        }
      });
    });

    const confirmLendBtn = document.getElementById('bt-confirm-lend');
    if (confirmLendBtn) {
      confirmLendBtn.addEventListener('click', () => {
        const id = confirmLendBtn.getAttribute('data-id');
        const name = document.getElementById('bt-borrower-input').value.trim();
        confirmLendBtn.disabled = true;
        confirmLendBtn.textContent = '処理中…';
        lendBookAction(id, name);
      });
    }
    const cancelLendBtn = document.getElementById('bt-cancel-lend');
    if (cancelLendBtn) cancelLendBtn.addEventListener('click', () => { lendingId = null; render(); });
  }

  async function doLookup(rawIsbn) {
    const isbn = (rawIsbn || '').replace(/[^0-9Xx]/g, '');
    const statusEl = document.getElementById('bt-lookup-status');
    if (!isbn) return;
    if (isbn.length !== 10 && isbn.length !== 13) {
      if (statusEl) statusEl.innerHTML = '<span class="bt-status-warn">ISBNは10桁または13桁で入力してください</span>';
      return;
    }
    if (statusEl) statusEl.innerHTML = '<span class="bt-status-info">検索中…</span>';
    try {
      const res = await apiGet('lookupIsbn', { isbn });
      if (!res.found) {
        if (statusEl) statusEl.innerHTML = '<span class="bt-status-warn">書誌情報が見つかりませんでした。タイトル等を手入力してください</span>';
        return;
      }
      const titleEl = document.getElementById('bt-input-title');
      const authorEl = document.getElementById('bt-input-author');
      const publisherEl = document.getElementById('bt-input-publisher');
      const yearEl = document.getElementById('bt-input-publishedYear');
      const coverEl = document.getElementById('bt-input-coverUrl');
      if (titleEl && !titleEl.value) titleEl.value = res.title || '';
      if (authorEl && !authorEl.value) authorEl.value = res.author || '';
      if (publisherEl && !publisherEl.value) publisherEl.value = res.publisher || '';
      if (yearEl && !yearEl.value) yearEl.value = res.publishedYear || '';
      if (coverEl && !coverEl.value) coverEl.value = res.coverUrl || '';
      if (coverEl) updateCoverPreview(coverEl.value);
      if (statusEl) statusEl.innerHTML = `<span class="bt-status-ok">${escapeHtml(res.title)} を見つけました (${res.source})</span>`;

      updateDupWarningLive();
    } catch (e) {
      if (statusEl) statusEl.innerHTML = '<span class="bt-status-warn">検索中にエラーが発生しました</span>';
    }
  }

  async function saveForm() {
    const title = document.getElementById('bt-input-title').value.trim();
    if (!title) { document.getElementById('bt-input-title').focus(); return; }

    const book = {
      title,
      author: document.getElementById('bt-input-author').value.trim(),
      publisher: document.getElementById('bt-input-publisher').value.trim(),
      publishedYear: document.getElementById('bt-input-publishedYear').value.trim(),
      isbn: document.getElementById('bt-input-isbn').value.trim(),
      coverUrl: document.getElementById('bt-input-coverUrl').value.trim(),
      location: document.getElementById('bt-input-location').value,
      acquisition: document.getElementById('bt-input-acquisition').value
    };

    const saveBtn = document.getElementById('bt-save-form');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';

    try {
      if (editingId) {
        await apiPost('update', Object.assign({ id: editingId }, book));
      } else {
        await apiPost('add', book);
      }
      showForm = false; editingId = null;
      await loadBooks();
    } catch (e) {
      alert('保存に失敗しました: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = editingId ? '更新する' : '登録する';
    }
  }

  async function deleteBook(id) {
    await apiPost('delete', { id });
    await loadBooks();
  }

  async function lendBookAction(id, borrower) {
    await apiPost('lend', { id, borrower });
    lendingId = null;
    await loadBooks();
  }

  async function returnBook(id) {
    await apiPost('return', { id });
    await loadBooks();
  }

  // ---------- バーコードスキャン (iPhoneカメラ) ----------

  function openScanner() {
    const modal = document.getElementById('bt-scanner-modal');
    modal.innerHTML = `
      <div class="bt-modal-overlay" id="bt-modal-overlay">
        <div class="bt-modal">
          <div class="bt-modal-header">
            <span>バーコードをスキャン</span>
            <button class="bt-icon-btn" id="bt-close-scanner">閉じる</button>
          </div>
          <div id="bt-reader"></div>
          <div class="bt-modal-hint">本の裏表紙のバーコード(ISBN)にカメラを向けてください</div>
        </div>
      </div>
    `;
    document.getElementById('bt-close-scanner').addEventListener('click', closeScanner);

    if (typeof Html5Qrcode === 'undefined') {
      document.getElementById('bt-reader').innerHTML = '<div class="bt-status-warn">スキャナーの読み込みに失敗しました。手入力してください。</div>';
      return;
    }

    scannerInstance = new Html5Qrcode('bt-reader', {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.CODE_128
      ]
    });

    scannerInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 150 } },
      (decodedText) => {
        const isbnInput = document.getElementById('bt-input-isbn');
        if (isbnInput) isbnInput.value = decodedText.replace(/[^0-9Xx]/g, '');
        closeScanner();
        if (isbnInput) doLookup(isbnInput.value);
      },
      () => { /* 読み取り失敗は毎フレーム起きうるので無視 */ }
    ).catch(() => {
      document.getElementById('bt-reader').innerHTML = '<div class="bt-status-warn">カメラを起動できませんでした。ブラウザのカメラ権限を確認してください。</div>';
    });
  }

  function closeScanner() {
    const modal = document.getElementById('bt-scanner-modal');
    if (scannerInstance) {
      scannerInstance.stop().catch(() => {}).finally(() => { scannerInstance = null; });
    }
    if (modal) modal.innerHTML = '';
  }

  loadBooks();
})();
