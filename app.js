(function () {
  const API_URL = window.CONFIG.API_URL;
  let authToken = localStorage.getItem('bt_auth_token') || '';

  const LOCATION_LABEL = { lab: '研究室', home: '自宅' };
  const STATUS_LABEL = { available: '保管中', lent: '貸出中' };
  const ACQUISITION_LABEL = { lab_budget: '個人研究費', kaken: '科研費', gift: '献本', self: '私費', unknown: 'その他' };

  let books = [];
  let lastUpdated = '';
  let filter = 'all'; // all | lab | home | lent
  let sortBy = 'registered_desc'; // registered_desc | registered_asc | year_desc | year_asc
  let query = '';
  let showForm = false;
  let editingId = null;
  let lendingId = null;
  let scannerInstance = null;
  let lookupTimer = null;
  let isComposingSearch = false;
  let selectionMode = false;
  let selectedIds = new Set();
  let expandedMemoIds = new Set();
  let renderLimit = 60; // 一度に描画するグループ数(スクロールで増える)
  let loadMoreObserver = null;

  function resetRenderLimit() { renderLimit = 60; }

  const root = document.getElementById('app');

  // ---------- API ----------

  async function apiGet(action, params) {
    const url = new URL(API_URL);
    url.searchParams.set('action', action);
    url.searchParams.set('token', authToken);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
  }

  async function apiPost(action, book) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // プリフライトを避けるため text/plain で送る
      body: JSON.stringify({ action, token: authToken, book: book || {} })
    });
    return res.json();
  }

  async function loadBooks() {
    root.innerHTML = '<div class="bt-loading">読み込み中…</div>';
    try {
      const res = await apiGet('list');
      if (!res.ok) {
        if (res.error && res.error.indexOf('unauthorized') !== -1) {
          showLogin();
          return;
        }
        throw new Error(res.error || '読み込みに失敗しました');
      }
      books = res.books;
      lastUpdated = res.lastUpdated || '';
      render();
    } catch (e) {
      root.innerHTML = `<div class="bt-loading">読み込みエラー: ${escapeHtml(String(e.message || e))}<br>しばらくしてから再読み込みしてください。</div>`;
    }
  }

  function showLogin(errorMsg) {
    root.innerHTML = `
      <div class="bt-login">
        <div class="bt-login-title">蔵書管理</div>
        <div class="bt-login-sub">パスワードを入力してください</div>
        ${errorMsg ? `<div class="bt-status-warn">${escapeHtml(errorMsg)}</div>` : ''}
        <input type="password" id="bt-login-password" class="bt-login-input" placeholder="パスワード" />
        <button class="bt-btn-primary" id="bt-login-submit">入る</button>
      </div>
    `;
    const submitBtn = document.getElementById('bt-login-submit');
    const pwInput = document.getElementById('bt-login-password');

    const doLogin = async () => {
      const pw = pwInput.value;
      if (!pw) return;
      authToken = pw;
      submitBtn.disabled = true;
      submitBtn.textContent = '確認中…';
      try {
        const res = await apiGet('list');
        if (res.ok) {
          localStorage.setItem('bt_auth_token', pw);
          books = res.books;
          lastUpdated = res.lastUpdated || '';
          render();
        } else {
          showLogin('パスワードが違います');
        }
      } catch (e) {
        showLogin('通信エラーが発生しました。もう一度お試しください');
      }
    };

    submitBtn.addEventListener('click', doLogin);
    pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    pwInput.focus();
  }

  // ---------- ユーティリティ ----------

  function escapeHtml(s) {
    return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function normalize(s) {
    if (s === null || s === undefined) return '';
    return String(s).toLowerCase().replace(/\s+/g, '');
  }

  function formatLastUpdated(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function groupKey(b) {
    return b.isbn ? 'isbn:' + b.isbn : 'title:' + normalize(b.title);
  }

  function matchesQuery(b) {
    if (!query) return true;
    const q = normalize(query);
    return normalize(b.title).includes(q) || normalize(b.author).includes(q) || normalize(b.isbn).includes(q) || normalize(b.memo).includes(q);
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

    // グループ内では、並べ替え条件を保ったまま「研究室」を常に先頭にする
    order.forEach(key => {
      groups[key].sort((a, b) => {
        if (a.location === b.location) return 0;
        return a.location === 'lab' ? -1 : 1;
      });
    });

    const countLent = books.filter(b => b.status === 'lent').length;

    const visibleOrder = order.slice(0, renderLimit);
    const hasMore = order.length > renderLimit;

    root.innerHTML = `
      <div class="bt-header">
        <div class="bt-title">蔵書管理</div>
        <div class="bt-header-right">
          <div class="bt-count">全 ${books.length} 冊 / 貸出中 ${countLent} 冊 ・ <span class="bt-logout-link" id="bt-logout">ログアウト</span></div>
          ${lastUpdated ? `<div class="bt-last-updated">最終更新: ${formatLastUpdated(lastUpdated)}</div>` : ''}
        </div>
      </div>
      <div class="bt-sticky-header">
        <div class="bt-toolbar">
          <div class="bt-search-wrap">
            <input class="bt-search" id="bt-search" type="text" value="${escapeHtml(query)}" />
            ${query ? `<button type="button" class="bt-search-clear" id="bt-search-clear" aria-label="検索をクリア">×</button>` : ''}
          </div>
          <div class="bt-filters">
            <button class="bt-filter-btn ${filter === 'all' ? 'active' : ''}" data-filter="all">すべて</button>
            <button class="bt-filter-btn ${filter === 'lab' ? 'active' : ''}" data-filter="lab">研究室</button>
            <button class="bt-filter-btn ${filter === 'home' ? 'active' : ''}" data-filter="home">自宅</button>
            <button class="bt-filter-btn ${filter === 'lent' ? 'active' : ''}" data-filter="lent">貸出中</button>
            <button class="bt-filter-btn" id="bt-refresh-btn" title="最新の状態に更新">⟳ 更新</button>
          </div>
          <select class="bt-sort-select" id="bt-sort">
            <option value="registered_desc" ${sortBy === 'registered_desc' ? 'selected' : ''}>登録が新しい順</option>
            <option value="registered_asc" ${sortBy === 'registered_asc' ? 'selected' : ''}>登録が古い順</option>
            <option value="year_desc" ${sortBy === 'year_desc' ? 'selected' : ''}>刊行年が新しい順</option>
            <option value="year_asc" ${sortBy === 'year_asc' ? 'selected' : ''}>刊行年が古い順</option>
          </select>
          ${!showForm ? `<button class="bt-btn-ghost" id="bt-toggle-select">${selectionMode ? '選択をやめる' : '一括選択'}</button>` : ''}
          ${!showForm && !selectionMode ? '<button class="bt-add-btn" id="bt-open-add">+ 本を追加</button>' : ''}
        </div>
        ${selectionMode ? renderBulkBar() : ''}
      </div>
      ${showForm ? renderForm() : ''}
      ${order.length === 0
        ? `<div class="bt-empty">${books.length === 0 ? 'まだ本が登録されていません。「+ 本を追加」から登録してください。' : '該当する本がありません。'}</div>`
        : `<div class="bt-list">${visibleOrder.map(k => renderGroup(groups[k])).join('')}</div>`
      }
      ${hasMore ? '<div id="bt-load-more-sentinel" class="bt-load-more">読み込み中…</div>' : ''}
      <div id="bt-scanner-modal"></div>
    `;

    attachEvents();
    setupLoadMoreObserver();
  }

  function setupLoadMoreObserver() {
    const sentinel = document.getElementById('bt-load-more-sentinel');
    if (!sentinel) return;
    if (!loadMoreObserver) {
      loadMoreObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            renderLimit += 60;
            render();
          }
        });
      }, { rootMargin: '600px' });
    }
    loadMoreObserver.observe(sentinel);
  }

  function renderBulkBar() {
    const count = selectedIds.size;
    return `
      <div class="bt-bulk-bar">
        <span class="bt-bulk-count">${count}冊選択中</span>
        <button class="bt-btn-ghost" id="bt-bulk-lab" ${count === 0 ? 'disabled' : ''}>研究室へ移動</button>
        <button class="bt-btn-ghost" id="bt-bulk-home" ${count === 0 ? 'disabled' : ''}>自宅へ移動</button>
      </div>
    `;
  }

  function renderGroup(items) {
    const first = items[0];
    const multi = items.length > 1;
    const thumb = first.coverUrl
      ? `<img class="bt-thumb" src="${escapeHtml(first.coverUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />`
      : `<div class="bt-thumb bt-thumb-placeholder">📕</div>`;

    const infoBits = [];
    if (first.author) infoBits.push(escapeHtml(first.author));
    let pubBit = '';
    if (first.publisher && first.publishedYear) pubBit = `${first.publisher} (${first.publishedYear})`;
    else if (first.publisher) pubBit = first.publisher;
    else if (first.publishedYear) pubBit = `(${first.publishedYear})`;
    if (pubBit) infoBits.push(escapeHtml(pubBit));

    return `
      <div class="bt-group">
        <div class="bt-group-content">
          ${thumb}
          <div class="bt-group-body">
            <div class="bt-group-title">
              ${escapeHtml(first.title)}
              ${multi ? `<span class="bt-copies">(${items.length}冊)</span>` : ''}
            </div>
            ${infoBits.length ? `<div class="bt-group-meta">${infoBits.join(' ／ ')}</div>` : ''}
            <div class="bt-group-rows">${items.map(renderRow).join('')}</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderRow(b) {
    const locTag = b.location === 'lab'
      ? `<span class="bt-tag bt-tag-lab bt-tag-swap" data-action="toggle-location" data-id="${b.id}" title="タップで自宅へ移動">研究室 <span class="bt-swap-icon">⇄</span></span>`
      : `<span class="bt-tag bt-tag-home bt-tag-swap" data-action="toggle-location" data-id="${b.id}" title="タップで研究室へ移動">自宅 <span class="bt-swap-icon">⇄</span></span>`;
    const lentTag = b.status === 'lent' ? '<span class="bt-tag bt-tag-lent">貸出中</span>' : '';

    const acquisitionText = ACQUISITION_LABEL[b.acquisition]
      ? `<span class="bt-acquisition-inline">${escapeHtml(ACQUISITION_LABEL[b.acquisition])}</span>`
      : '';

    const metaBits = [];
    if (b.status === 'lent' && b.borrower) metaBits.push(`→ ${escapeHtml(b.borrower)}${b.lentDate ? ' (' + escapeHtml(b.lentDate) + '〜)' : ''}`);

    let memoHtml = '';
    if (b.memo) {
      if (expandedMemoIds.has(b.id)) {
        memoHtml = `<div class="bt-row-note" data-action="toggle-memo" data-id="${b.id}">${escapeHtml(b.memo)} <span class="bt-memo-toggle">(閉じる)</span></div>`;
      } else {
        memoHtml = `<div class="bt-row-note-toggle" data-action="toggle-memo" data-id="${b.id}">メモを表示</div>`;
      }
    }

    const lendFormHtml = lendingId === b.id ? `
      <div class="bt-lend-form">
        <input id="bt-borrower-input" type="text" placeholder="貸出先の名前" />
        <button class="bt-icon-btn" id="bt-confirm-lend" data-id="${b.id}">貸出を記録</button>
        <button class="bt-icon-btn" id="bt-cancel-lend">キャンセル</button>
      </div>` : '';

    const checkboxHtml = selectionMode
      ? `<input type="checkbox" class="bt-row-checkbox" data-id="${b.id}" ${selectedIds.has(b.id) ? 'checked' : ''} />`
      : '';

    const rowActionsHtml = selectionMode ? '' : `
        <div class="bt-row-actions">
          ${b.status === 'lent'
            ? `<button class="bt-icon-btn" data-action="return" data-id="${b.id}">返却済み</button>`
            : `<button class="bt-icon-btn" data-action="lend" data-id="${b.id}">貸出</button>`}
          <button class="bt-icon-btn" data-action="edit" data-id="${b.id}">編集</button>
          <button class="bt-icon-btn danger" data-action="delete" data-id="${b.id}">削除</button>
        </div>`;

    return `
      <div class="bt-row">
        ${checkboxHtml}
        <div class="bt-row-main">
          <div class="bt-row-tags">${locTag}${lentTag}${acquisitionText}</div>
          ${metaBits.length ? `<div class="bt-row-meta">${metaBits.join(' ／ ')}</div>` : ''}
          ${memoHtml}
          ${lendFormHtml}
        </div>
        ${rowActionsHtml}
      </div>
    `;
  }

  function scrollToForm() {
    const formEl = document.querySelector('.bt-form');
    if (formEl) formEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          <option value="lab_budget" ${v('acquisition', 'lab_budget') === 'lab_budget' ? 'selected' : ''}>個人研究費</option>
          <option value="kaken" ${v('acquisition') === 'kaken' ? 'selected' : ''}>科研費</option>
          <option value="gift" ${v('acquisition') === 'gift' ? 'selected' : ''}>献本</option>
          <option value="self" ${v('acquisition') === 'self' ? 'selected' : ''}>私費</option>
          <option value="unknown" ${v('acquisition') === 'unknown' ? 'selected' : ''}>その他</option>
        </select>
        <div class="bt-full bt-cover-row">
          <input id="bt-input-coverUrl" type="text" placeholder="書影URL(自動取得できなかった場合は画像URLを直接入力)" value="${escapeHtml(v('coverUrl'))}" />
          <img id="bt-cover-preview" class="bt-thumb" src="${escapeHtml(v('coverUrl'))}" alt="" style="${v('coverUrl') ? '' : 'display:none;'}" onerror="this.style.display='none'" />
        </div>
        <textarea class="bt-full" id="bt-input-memo" placeholder="メモ・タグ(自由記述、検索対象になります。例: #統計学 #教科書 のように書いておくと後で分類しやすいです)">${escapeHtml(v('memo'))}</textarea>
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
        resetRenderLimit();
        render();
        const el = document.getElementById('bt-search');
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      });
      searchEl.addEventListener('input', (e) => {
        if (isComposingSearch) return; // 日本語入力の変換確定前は再描画しない(IMEが確定されてしまうのを防ぐ)
        query = e.target.value;
        resetRenderLimit();
        render();
        const el = document.getElementById('bt-search');
        if (el) { el.focus(); el.selectionStart = el.selectionEnd = el.value.length; }
      });
    }

    const clearSearchBtn = document.getElementById('bt-search-clear');
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener('click', () => {
        query = '';
        resetRenderLimit();
        render();
        const el = document.getElementById('bt-search');
        if (el) el.focus();
      });
    }

    document.querySelectorAll('.bt-filter-btn[data-filter]').forEach(btn => {
      btn.addEventListener('click', () => { filter = btn.getAttribute('data-filter'); resetRenderLimit(); render(); });
    });

    const refreshBtn = document.getElementById('bt-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        resetRenderLimit();
        loadBooks();
      });
    }

    const sortEl = document.getElementById('bt-sort');
    if (sortEl) {
      sortEl.addEventListener('change', (e) => { sortBy = e.target.value; resetRenderLimit(); render(); });
    }

    const logoutLink = document.getElementById('bt-logout');
    if (logoutLink) {
      logoutLink.addEventListener('click', () => {
        localStorage.removeItem('bt_auth_token');
        authToken = '';
        showLogin();
      });
    }

    const toggleSelectBtn = document.getElementById('bt-toggle-select');
    if (toggleSelectBtn) {
      toggleSelectBtn.addEventListener('click', () => {
        selectionMode = !selectionMode;
        if (!selectionMode) selectedIds.clear();
        render();
      });
    }

    document.querySelectorAll('.bt-row-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-id');
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        render();
      });
    });

    const bulkLabBtn = document.getElementById('bt-bulk-lab');
    if (bulkLabBtn) {
      bulkLabBtn.addEventListener('click', () => {
        bulkLabBtn.disabled = true; bulkLabBtn.textContent = '移動中…';
        bulkMoveLocation('lab');
      });
    }
    const bulkHomeBtn = document.getElementById('bt-bulk-home');
    if (bulkHomeBtn) {
      bulkHomeBtn.addEventListener('click', () => {
        bulkHomeBtn.disabled = true; bulkHomeBtn.textContent = '移動中…';
        bulkMoveLocation('home');
      });
    }

    const openAddBtn = document.getElementById('bt-open-add');
    if (openAddBtn) {
      openAddBtn.addEventListener('click', () => {
        showForm = true; editingId = null; render();
        scrollToForm();
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
        if (action === 'edit') { editingId = id; showForm = true; render(); scrollToForm(); }
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
        else if (action === 'toggle-location') {
          btn.style.pointerEvents = 'none';
          btn.style.opacity = '0.5';
          toggleLocationAction(id);
        }
        else if (action === 'toggle-memo') {
          if (expandedMemoIds.has(id)) expandedMemoIds.delete(id); else expandedMemoIds.add(id);
          render();
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
      if (statusEl) {
        if (res.title) {
          statusEl.innerHTML = `<span class="bt-status-ok">${escapeHtml(res.title)} を見つけました (${res.source})</span>`;
        } else if (res.coverUrl) {
          statusEl.innerHTML = `<span class="bt-status-ok">書誌情報は見つかりませんでしたが、書影は取得できました</span>`;
        }
      }

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
      acquisition: document.getElementById('bt-input-acquisition').value,
      memo: document.getElementById('bt-input-memo').value.trim()
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

  async function toggleLocationAction(id) {
    const book = books.find(b => b.id === id);
    if (!book) return;
    const newLocation = book.location === 'lab' ? 'home' : 'lab';
    await apiPost('update', { id, location: newLocation });
    await loadBooks();
  }

  async function bulkMoveLocation(newLocation) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    await Promise.all(ids.map(id => apiPost('update', { id, location: newLocation })));
    selectedIds.clear();
    selectionMode = false;
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

  // 最上部へ戻るボタン(render()の再描画サイクルとは無関係に、ページ読み込み時に1回だけ設定)
  const topBtn = document.getElementById('bt-top-btn');
  if (topBtn) {
    window.addEventListener('scroll', () => {
      if (window.scrollY > 400) topBtn.classList.add('visible');
      else topBtn.classList.remove('visible');
    });
    topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }
})();
