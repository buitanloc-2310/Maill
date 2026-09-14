(() => {
  const qs = (s, r = document) => r.querySelector(s);
  const qsa = (s, r = document) => [...r.querySelectorAll(s)];
  const state = { selected: new Set(), summary: null };

  function toast(text, type = 'ok') {
    let box = qs('#v3-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'v3-toasts';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `v3-toast ${type}`;
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, 2600);
  }

  async function jfetch(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  async function loadSummary() {
    try {
      state.summary = await jfetch('/api/mailbox/summary');
      applySummary();
    } catch {}
  }

  function applySummary() {
    if (!state.summary) return;
    const c = state.summary.counts || {};
    const map = { inbox: c.inbox, starred: c.starred, sent: c.sent, drafts: c.drafts, spam: c.spam, trash: c.trash };
    qsa('[data-folder]').forEach((b) => {
      const f = b.dataset.folder;
      let badge = qs('.v3-nav-count', b);
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'v3-nav-count';
        b.appendChild(badge);
      }
      const n = Number(map[f] || 0);
      badge.textContent = n ? String(n) : '';
      badge.hidden = !n;
    });
    const n = Number(state.summary.unread || 0);
    const bell = qs('#notif');
    if (bell) {
      bell.classList.toggle('has-unread', n > 0);
      bell.dataset.count = n > 99 ? '99+' : String(n || '');
    }
  }

  function enhanceHeader() {
    const h = qs('.workspace>header');
    if (!h || h.dataset.v3) return;
    h.dataset.v3 = '1';
    const launcher = document.createElement('button');
    launcher.className = 'iconbtn v3-launcher';
    launcher.title = 'Ứng dụng Sky First';
    launcher.textContent = '☷';
    h.insertBefore(launcher, h.firstChild);
    launcher.onclick = () => commandPalette();
    const chip = document.createElement('div');
    chip.className = 'v3-online-chip';
    chip.innerHTML = '<i></i><span>Mail Online</span>';
    const bell = qs('#notif');
    if (bell) h.insertBefore(chip, bell);
  }

  function listToolbar() {
    const head = qs('.listhead');
    if (!head || head.dataset.v3) return;
    head.dataset.v3 = '1';
    const wrap = document.createElement('div');
    wrap.className = 'v3-list-actions';
    wrap.innerHTML = `<label class="v3-select-all" title="Chọn tất cả"><input type="checkbox" id="v3all"><span></span></label><button data-bulk="read" title="Đánh dấu đã đọc">✓</button><button data-bulk="star" title="Đánh dấu sao">★</button><button data-bulk="spam" title="Spam">!</button><button data-bulk="trash" title="Thùng rác">⌫</button><span class="v3-selected-count"></span>`;
    head.prepend(wrap);
    qs('#v3all', wrap).onchange = (e) => {
      qsa('.row[data-id]').forEach((r) => {
        const id = Number(r.dataset.id);
        const cb = qs('.v3-row-check', r);
        if (!cb) return;
        cb.checked = e.target.checked;
        r.classList.toggle('selected', e.target.checked);
        if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      });
      selectedCount();
    };
    qsa('[data-bulk]', wrap).forEach((b) => { b.onclick = () => bulk(b.dataset.bulk); });
  }

  function enhanceRows() {
    qsa('.row[data-id]').forEach((r) => {
      if (r.dataset.v3) return;
      r.dataset.v3 = '1';
      const id = Number(r.dataset.id);
      const lab = document.createElement('label');
      lab.className = 'v3-row-selector';
      lab.innerHTML = '<input class="v3-row-check" type="checkbox"><span></span>';
      r.insertBefore(lab, r.firstChild);
      const cb = qs('input', lab);
      cb.checked = state.selected.has(id);
      r.classList.toggle('selected', cb.checked);
      lab.onclick = (e) => e.stopPropagation();
      cb.onchange = () => {
        if (cb.checked) state.selected.add(id); else state.selected.delete(id);
        r.classList.toggle('selected', cb.checked);
        selectedCount();
      };
    });
    selectedCount();
  }

  function selectedCount() {
    const el = qs('.v3-selected-count');
    if (el) el.textContent = state.selected.size ? `${state.selected.size} đã chọn` : '';
  }

  async function bulk(action) {
    const ids = [...state.selected];
    if (!ids.length) return toast('Hãy chọn ít nhất một thư.', 'warn');
    try {
      await jfetch('/api/messages/bulk', { method: 'POST', body: JSON.stringify({ ids, action }) });
      state.selected.clear();
      toast(action === 'trash' ? 'Đã chuyển vào thùng rác.' : 'Đã cập nhật thư.');
      qs('#reload')?.click();
      loadSummary();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  function enhanceAside() {
    const a = qs('.workspace>aside');
    if (!a || a.dataset.v3) return;
    a.dataset.v3 = '1';
    const label = document.createElement('div');
    label.className = 'v3-section-label';
    label.textContent = 'HỘP THƯ';
    const nav = qs('nav', a);
    if (nav) a.insertBefore(label, nav);
    const system = qs('.aside-system', a);
    if (system) system.innerHTML = '<span class="live-dot"></span><span>Sky First Mail v3 · Cloud</span>';
  }

  function commandPalette() {
    if (qs('.v3-command-wrap')) return;
    const w = document.createElement('div');
    w.className = 'v3-command-wrap';
    w.innerHTML = `<div class="v3-command"><div class="v3-command-search">⌕<input autofocus placeholder="Tìm lệnh hoặc chuyển nhanh..."><kbd>Esc</kbd></div><div class="v3-command-list"></div></div>`;
    document.body.appendChild(w);
    const list = qs('.v3-command-list', w);
    const actions = [
      ['Soạn thư mới', 'C', () => qs('#compose')?.click()],
      ['Mở Hộp thư đến', 'G I', () => qs('[data-folder="inbox"]')?.click()],
      ['Mở Đã gửi', 'G S', () => qs('[data-folder="sent"]')?.click()],
      ['Mở Đánh dấu', 'G T', () => qs('[data-folder="starred"]')?.click()],
      ['Danh bạ', '', () => qs('#contacts')?.click()],
      ['Tài khoản & cài đặt', '', () => qs('#accountMini')?.click()],
      ['Quản trị hệ thống', '', () => qs('#admin')?.click()]
    ];
    const render = (q) => {
      const z = q.toLowerCase();
      const filtered = actions.filter((x) => x[0].toLowerCase().includes(z));
      list.innerHTML = filtered.map((x, i) => `<button data-i="${i}"><span>${x[0]}</span><kbd>${x[1]}</kbd></button>`).join('');
      qsa('button', list).forEach((b, idx) => { b.onclick = () => { w.remove(); filtered[idx]?.[2](); }; });
    };
    render('');
    const inp = qs('input', w);
    inp.oninput = () => render(inp.value);
    w.onclick = (e) => { if (e.target === w) w.remove(); };
  }

  function shortcuts() {
    if (window.__sfv3keys) return;
    window.__sfv3keys = 1;
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        commandPalette();
        return;
      }
      if (e.target.matches('input,textarea,select,[contenteditable]')) return;
      if (e.key === '/') { e.preventDefault(); qs('#search')?.focus(); }
      if (e.key.toLowerCase() === 'c') qs('#compose')?.click();
      if (e.key === 'Escape') qsa('.modal-wrap').at(-1)?.remove();
    });
  }

  function enhanceReader() {
    const r = qs('#reader .message');
    if (!r || r.dataset.v3) return;
    r.dataset.v3 = '1';
    const toolbar = qs('.toolbar', r);
    if (toolbar) {
      const print = document.createElement('button');
      print.textContent = '⎙ In';
      print.onclick = () => window.print();
      toolbar.appendChild(print);
    }
    const sender = qs('.senderline', r);
    if (sender) {
      const badge = document.createElement('span');
      badge.className = 'v3-security-badge';
      badge.textContent = '✓ Đã nhận qua Sky First Mail';
      sender.appendChild(badge);
    }
  }

  function enhanceCompose() {
    qsa('.modal').forEach((m) => {
      if (m.dataset.v3compose || !qs('#cf', m)) return;
      m.dataset.v3compose = '1';
      m.classList.add('v3-compose');
      const foot = qs('.compose-foot', m);
      if (foot) {
        const note = document.createElement('span');
        note.className = 'v3-compose-note';
        note.textContent = 'Gửi an toàn qua Sky First Mail · Resend';
        foot.prepend(note);
      }
      const ta = qs('textarea[name="text"]', m);
      if (ta) {
        const tools = document.createElement('div');
        tools.className = 'v3-editor-tools';
        tools.innerHTML = '<button type="button" data-ins="**">B</button><button type="button" data-ins="_">I</button><button type="button" data-ins="• ">• List</button><span>Plain text composer</span>';
        ta.before(tools);
        qsa('[data-ins]', tools).forEach((b) => {
          b.onclick = () => {
            const start = ta.selectionStart, end = ta.selectionEnd, value = ta.value, ins = b.dataset.ins;
            const tail = ins === '**' ? '**' : ins === '_' ? '_' : '';
            ta.value = value.slice(0, start) + ins + value.slice(start, end) + tail + value.slice(end);
            ta.focus();
          };
        });
      }
    });
  }

  function enhanceAuth() {
    const a = qs('.auth-card');
    if (!a || a.dataset.v3) return;
    a.dataset.v3 = '1';
    const trust = document.createElement('div');
    trust.className = 'v3-trust';
    trust.innerHTML = '<span>● Gửi/nhận thật</span><span>● R2 Storage</span><span>● Resend Outbound</span>';
    a.appendChild(trust);
  }

  function run() {
    enhanceHeader();
    enhanceAside();
    listToolbar();
    enhanceRows();
    enhanceReader();
    enhanceCompose();
    enhanceAuth();
  }

  const mo = new MutationObserver(() => run());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  shortcuts();
  run();
  setInterval(() => { if (qs('.workspace')) loadSummary(); }, 30000);
  setTimeout(loadSummary, 800);
})();
