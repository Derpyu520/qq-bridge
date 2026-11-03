// docs-site — small client-side behaviors.
// Pure-vanilla, no deps. Loaded at end of <body> by every page.

(function () {
  // ----- theme toggle -----
  var html = document.documentElement;
  var toggle = document.querySelector('.theme-toggle');
  function applyIcon() {
    if (!toggle) return;
    toggle.textContent = html.getAttribute('data-theme') === 'dark' ? '☀️' : '🌙';
  }
  applyIcon();
  if (toggle) {
    toggle.addEventListener('click', function () {
      var cur = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', cur);
      localStorage.setItem('site-theme', cur);
      applyIcon();
    });
  }

  // ----- mobile nav drawer toggle (button is static; sidebar links wired post-render) -----
  var navToggle = document.querySelector('.mobile-nav-toggle');
  if (navToggle) {
    navToggle.addEventListener('click', function () {
      document.body.classList.toggle('nav-open');
    });
  }

  // ----- share menu (baked button; menu is JS-built so adding share methods
  //        never re-bakes every page). Methods: Save as PDF (A4 paginated) and
  //        Save as long image (one continuous page). -----
  var shareBtn = document.querySelector('.share-btn');
  if (shareBtn) {
    var shareMenu = null;
    function closeShareMenu() {
      if (shareMenu) { shareMenu.remove(); shareMenu = null; }
      shareBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onShareDocClick);
      document.removeEventListener('keydown', onShareEsc);
    }
    function onShareDocClick(e) {
      if (shareMenu && !shareMenu.contains(e.target) && e.target !== shareBtn) closeShareMenu();
    }
    function onShareEsc(e) { if (e.key === 'Escape') { closeShareMenu(); shareBtn.focus(); } }
    function addShareItem(icon, label, onClick) {
      var item = document.createElement('button');
      item.className = 'share-menu-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = '<span class="share-menu-icon">' + icon + '</span>' + label;
      item.addEventListener('click', function () { closeShareMenu(); onClick(); });
      shareMenu.appendChild(item);
    }
    // Single continuous "long image" page: reuse the @media print transform but
    // override @page so Chrome emits ONE tall page (width × full content height)
    // instead of A4 pagination — the long-screenshot feel, still a PDF file.
    function printLongImage() {
      var main = document.querySelector('main.doc-body');
      if (!main) { window.print(); return; }          // no article → plain A4 print
      var root = document.documentElement;
      var layout = main.closest('.site-layout');
      var CONTENT_W = 800, PAD = 24;                   // px @96dpi: reading width + page margin
      // Measure height AS IT WILL PRINT: the print CSS wraps wide code/tables, so
      // they get TALLER than on screen. Force main to CONTENT_W and add a class
      // mirroring the height-affecting print rules, read scrollHeight, then revert
      // — all synchronously, so the intermediate layout is never painted (no flicker).
      var savedMain = main.getAttribute('style');
      var savedLayout = layout ? layout.getAttribute('style') : null;
      if (layout) layout.style.display = 'block';
      main.style.width = main.style.maxWidth = CONTENT_W + 'px';
      main.style.margin = main.style.padding = '0';
      main.style.display = 'flow-root';   // BFC: fold trailing child margins into scrollHeight
      root.classList.add('longimg-measure');
      var hPx = Math.ceil(main.scrollHeight);
      root.classList.remove('longimg-measure');
      if (savedMain === null) main.removeAttribute('style'); else main.setAttribute('style', savedMain);
      if (layout) { if (savedLayout === null) layout.removeAttribute('style'); else layout.setAttribute('style', savedLayout); }
      // Bias TALL (1% + 24px slack) so measurement drift can never spill a thin,
      // near-blank second page. A little empty tail on one long page is invisible.
      var pxToMm = function (px) { return (px / 96 * 25.4).toFixed(2); };
      var pageW = pxToMm(CONTENT_W + 2 * PAD);
      var pageH = pxToMm(Math.ceil(hPx * 1.01) + 2 * PAD + 24);
      var old = document.getElementById('longimg-page');
      if (old) old.remove();
      var style = document.createElement('style');
      style.id = 'longimg-page';
      style.textContent = '@media print { @page { size: ' + pageW + 'mm ' + pageH +
        'mm; margin: ' + pxToMm(PAD) + 'mm; } }';
      document.head.appendChild(style);
      // Neutralise break-avoidance for this print so a sub-pixel bottom-edge
      // overshoot can't bump a whole protected block onto a near-blank page 2.
      root.classList.add('longimg-print');
      function cleanup() {
        root.classList.remove('longimg-print');
        var el = document.getElementById('longimg-page');
        if (el) el.remove();
        window.removeEventListener('afterprint', cleanup);
      }
      window.addEventListener('afterprint', cleanup);
      window.print();
    }
    function openShareMenu() {
      shareMenu = document.createElement('div');
      shareMenu.className = 'share-menu';
      shareMenu.setAttribute('role', 'menu');
      // Future share methods (copy link, etc.) drop in as extra addShareItem calls.
      addShareItem('📄', 'Save as PDF', function () { window.print(); });
      addShareItem('📜', 'Save as long image', printLongImage);
      document.body.appendChild(shareMenu);
      var r = shareBtn.getBoundingClientRect();
      shareMenu.style.top = (r.bottom + 6) + 'px';
      shareMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      shareBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onShareDocClick);
      document.addEventListener('keydown', onShareEsc);
    }
    shareBtn.addEventListener('click', function (e) {
      e.stopPropagation();  // keep this opening click from reaching onShareDocClick
      if (shareMenu) closeShareMenu(); else openShareMenu();
    });
  }

  // ----- force the light palette while printing (Save-as-PDF) -----
  // Dark-theme pages print with large blocks of invisible text: theme-adaptive
  // SVG (fill:currentColor) and dark-tuned colors vanish on white paper. The
  // light theme prints cleanly, so we swap data-theme -> light for the duration
  // of the print and restore after. beforeprint/afterprint fire for BOTH the
  // share menu's window.print() AND a direct Ctrl/Cmd+P.
  (function () {
    var root = document.documentElement, savedTheme = null;
    window.addEventListener('beforeprint', function () {
      savedTheme = root.getAttribute('data-theme');
      root.setAttribute('data-theme', 'light');
    });
    window.addEventListener('afterprint', function () {
      if (savedTheme === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', savedTheme);
      savedTheme = null;
    });
  })();

  // ----- client-rendered navigation (top tabs + left sidebar) -----
  // The nav tree is fetched from assets/nav.json (built by _wrap_handwritten.py
  // from _nav.build_nav_data) and rendered here, so adding/removing/renaming a
  // page touches only that page + the JSON — never every sibling's baked chrome.
  // <body> carries data-asset-prefix / data-tab / data-page-rel for resolution.
  (function () {
    var body = document.body;
    var tabsHost = document.getElementById('site-tabs');
    var sideHost = document.getElementById('sidebar-left');
    if (!tabsHost && !sideHost) return; // external-layout page (e.g. AAS) — skip
    var PREFIX = body.getAttribute('data-asset-prefix') || '';
    var activeTab = body.getAttribute('data-tab') || '';
    var pageRel = body.getAttribute('data-page-rel') || '';

    function el(tag, cls, txt) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (txt != null) e.textContent = txt;
      return e;
    }
    function containsActive(node) {
      if (node.kind === 'page') return node.href === pageRel;
      if (node.href && node.href === pageRel) return true;
      return (node.children || []).some(containsActive);
    }
    function renderNode(node) {
      if (node.kind === 'page') {
        var a = el('a', 'sb-page' + (node.href === pageRel ? ' active' : ''), node.label);
        a.href = PREFIX + node.href;
        return a;
      }
      // section = top-level curated divider (sb-section); group = nested (sb-subsection)
      var isSection = node.kind === 'section';
      // A label-less section renders no divider — its pages sit flat in the sidebar.
      if (isSection && !node.label && !node.href) {
        var frag = document.createDocumentFragment();
        (node.children || []).forEach(function (c) { frag.appendChild(renderNode(c)); });
        return frag;
      }
      var d = el('details', isSection ? 'sb-section' : 'sb-subsection');
      if (node.key) d.setAttribute('data-key', node.key);
      if (containsActive(node)) d.open = true;
      var summary = el('summary', isSection ? 'sb-section-label' : 'sb-subsection-label');
      if (node.href) {
        var link = el('a', 'sb-group-link' + (node.href === pageRel ? ' active' : ''), node.label);
        link.href = PREFIX + node.href;
        summary.appendChild(link);
      } else if (isSection) {
        summary.textContent = node.label;
      } else {
        summary.appendChild(el('span', 'sb-group-label-text', node.label));
      }
      d.appendChild(summary);
      var pages = el('div', 'sb-pages');
      (node.children || []).forEach(function (c) { pages.appendChild(renderNode(c)); });
      d.appendChild(pages);
      return d;
    }
    // ----- grouped tabs (dropdown) -----
    // Tabs that carry the same `group` (nav.json, from _tab.json) collapse into
    // ONE dropdown tab in the strip. The menu is position:fixed and mounted on
    // <body> so the horizontally scrollable strip never clips it — same trick as
    // the share menu above.
    var tabMenu = null, tabMenuOwner = null;
    function closeTabMenu() {
      if (tabMenu) { tabMenu.remove(); tabMenu = null; }
      if (tabMenuOwner) { tabMenuOwner.setAttribute('aria-expanded', 'false'); tabMenuOwner = null; }
      document.removeEventListener('click', onTabMenuDocClick);
      document.removeEventListener('keydown', onTabMenuEsc);
    }
    function onTabMenuDocClick(e) {
      if (tabMenu && !tabMenu.contains(e.target)) closeTabMenu();
    }
    function onTabMenuEsc(e) {
      if (e.key === 'Escape') { var o = tabMenuOwner; closeTabMenu(); if (o) o.focus(); }
    }
    function openTabMenu(btn, group) {
      closeTabMenu();
      var m = el('div', 'tab-menu');
      m.setAttribute('role', 'menu');
      group.members.forEach(function (t) {
        var a = el('a', 'tab-menu-item' + (t.tab === activeTab ? ' active' : ''), t.tab);
        a.href = PREFIX + t.landing;
        a.setAttribute('role', 'menuitem');
        m.appendChild(a);
      });
      document.body.appendChild(m);
      var r = btn.getBoundingClientRect();
      m.style.top = (r.bottom + 6) + 'px';
      m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)) + 'px';
      tabMenu = m;
      tabMenuOwner = btn;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onTabMenuDocClick);
      document.addEventListener('keydown', onTabMenuEsc);
    }

    function renderTabs(data) {
      if (!tabsHost) return;
      closeTabMenu();
      tabsHost.innerHTML = '';
      // Collapse same-`group` tabs into one dropdown item, kept at the position
      // of the group's FIRST member so the strip order stays as authored.
      var items = [], seen = {};
      data.tabs.forEach(function (t) {
        var g = t.group || '';
        if (!g) { items.push({ kind: 'tab', tab: t, pinned: !!t.pinned }); return; }
        if (!seen[g]) {
          seen[g] = { kind: 'group', label: g, members: [], pinned: !!t.pinned };
          items.push(seen[g]);
        }
        seen[g].members.push(t);
      });
      // Pinned items (nav.json `pinned`, from _tab.json) stay always visible;
      // the rest — the project tabs — share one horizontally scrollable strip.
      // Order is preserved: pinned items before the first unpinned one sit to
      // the strip's left, pinned items after it to its right.
      var left = [], mid = [], right = [];
      items.forEach(function (it) {
        if (it.pinned) { (mid.length ? right : left).push(it); }
        else { mid.push(it); }
      });
      function mkTab(t) {
        var a = el('a', 'tab' + (t.tab === activeTab ? ' active' : ''), t.tab);
        a.href = PREFIX + t.landing;
        return a;
      }
      function mkGroup(g) {
        var cur = g.members.filter(function (m) { return m.tab === activeTab; })[0];
        var b = el('button', 'tab tab-group' + (cur ? ' active' : ''));
        b.type = 'button';
        b.setAttribute('aria-haspopup', 'true');
        b.setAttribute('aria-expanded', 'false');
        // The three group triggers split the strip into equal thirds (CSS
        // flex: 1 1 0), so the width is fixed regardless of what's shown —
        // which leaves room to name the member you're on right on the button.
        b.appendChild(el('span', 'tab-group-label', g.label));
        if (cur) b.appendChild(el('span', 'tab-group-current', cur.tab));
        b.appendChild(el('span', 'tab-caret', '\u25be'));
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (tabMenuOwner === b) closeTabMenu();
          else openTabMenu(b, g);
        });
        return b;
      }
      function mk(it) { return it.kind === 'group' ? mkGroup(it) : mkTab(it.tab); }
      left.forEach(function (it) { tabsHost.appendChild(mk(it)); });
      var scroller = null;
      if (mid.length) {
        scroller = el('div', 'tabs-scroll');
        mid.forEach(function (it) { scroller.appendChild(mk(it)); });
        tabsHost.appendChild(scroller);
      }
      // Trailing pinned tabs sit in their own box, pushed to the right edge
      // (see .tabs-right `margin-left:auto`); it collapses to zero when the
      // header runs out of room, so nothing is ever cut off by the alignment.
      if (right.length) {
        var rightBox = el('div', 'tabs-right');
        right.forEach(function (it) { rightBox.appendChild(mk(it)); });
        tabsHost.appendChild(rightBox);
      }
      // A member name squeezed below a few characters degrades to a bare "· …",
      // which is noise, not information — drop it and keep the group name whole.
      // Always measure with the class cleared, so this can't oscillate.
      function fitSegments() {
        var segs = tabsHost.querySelectorAll('.tab-group-current');
        for (var i = 0; i < segs.length; i++) {
          var cur = segs[i];
          cur.classList.remove('too-tight');
          if (cur.scrollWidth > cur.clientWidth && cur.clientWidth < 64) {
            cur.classList.add('too-tight');
          }
        }
      }
      fitSegments();
      window.addEventListener('resize', fitSegments);
      // An open menu is anchored in viewport coords — reposition-free, so just
      // drop it when the strip scrolls or the window resizes.
      window.addEventListener('resize', closeTabMenu);
      if (!scroller) return;
      // Edge fades signal hidden overflow on either side.
      function updateFade() {
        var max = scroller.scrollWidth - scroller.clientWidth;
        scroller.classList.toggle('fade-l', scroller.scrollLeft > 2);
        scroller.classList.toggle('fade-r', scroller.scrollLeft < max - 2);
      }
      scroller.addEventListener('scroll', function () { updateFade(); closeTabMenu(); }, { passive: true });
      window.addEventListener('resize', updateFade);
      // A plain mouse wheel over the strip scrolls it horizontally (trackpads
      // already emit deltaX). Only hijack when there IS overflow.
      scroller.addEventListener('wheel', function (e) {
        if (scroller.scrollWidth <= scroller.clientWidth) return;
        if (!e.deltaX && e.deltaY) { scroller.scrollLeft += e.deltaY; e.preventDefault(); }
      }, { passive: false });
      // Bring the active tab into view ONLY if it isn't already — centering it
      // unconditionally scrolled its neighbours under the edge fades even when
      // they nearly fit. Measured against the scroller itself: offsetLeft is
      // relative to the nearest positioned ancestor (.site-header), not to it.
      var act = scroller.querySelector('.tab.active');
      if (act) {
        var ar = act.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
        var pad = 30;                                  // clear the 28px fade
        if (ar.left < sr.left + pad) scroller.scrollLeft += ar.left - sr.left - pad;
        else if (ar.right > sr.right - pad) scroller.scrollLeft += ar.right - sr.right + pad;
      }
      updateFade();
    }
    function renderSidebar(data) {
      if (!sideHost) return;
      var inner = sideHost.querySelector('.sidebar-inner') || sideHost;
      inner.innerHTML = '';
      var tab = data.tabs.filter(function (t) { return t.tab === activeTab; })[0];
      if (!tab) return;
      tab.nodes.forEach(function (n) { inner.appendChild(renderNode(n)); });
    }
    // Behaviors that depend on the now-rendered sidebar DOM. Mirrors what used to
    // run against baked markup at load time.
    function wireSidebar() {
      // close mobile drawer when a sidebar link is tapped
      document.querySelectorAll('.sidebar-left a').forEach(function (a) {
        a.addEventListener('click', function () { body.classList.remove('nav-open'); });
      });
      // a link inside a <summary> should navigate, not toggle the <details>
      document.querySelectorAll('.sb-subsection > summary .sb-group-link').forEach(function (a) {
        a.addEventListener('click', function (e) { e.stopPropagation(); });
      });
      // persist divider open/closed per session; never fold the active branch
      var STORE = 'sb-open';
      var state = {};
      try { state = JSON.parse(sessionStorage.getItem(STORE) || '{}'); } catch (_) {}
      function persist() { try { sessionStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {} }
      document.querySelectorAll('.sidebar-left details[data-key]').forEach(function (d) {
        var key = d.getAttribute('data-key');
        var hasActive = !!d.querySelector('.active');
        if (key in state) {
          if (state[key]) d.open = true;
          else if (!hasActive) d.open = false;
        }
        d.addEventListener('toggle', function () { state[key] = d.open; persist(); });
      });
    }

    // ----- preserve sidebar scroll across navigation -----
    // The sidebar is re-rendered on every page load, so without this it snaps
    // back to the top each time. We persist .sidebar-left's scrollTop per session
    // and restore it right after the tree is injected. Scroll container is
    // #sidebar-left itself (overflow-y:auto), not .sidebar-inner.
    var SCROLL_KEY = 'sb-scroll';
    function saveScroll() {
      if (!sideHost) return;
      try { sessionStorage.setItem(SCROLL_KEY, String(sideHost.scrollTop)); } catch (_) {}
    }
    function restoreScroll() {
      if (!sideHost) return;
      var v = null;
      try { v = sessionStorage.getItem(SCROLL_KEY); } catch (_) {}
      if (v !== null) sideHost.scrollTop = parseInt(v, 10) || 0;
    }
    if (sideHost) {
      var scrollPending = false;
      sideHost.addEventListener('scroll', function () {
        if (scrollPending) return;
        scrollPending = true;
        requestAnimationFrame(function () { scrollPending = false; saveScroll(); });
      }, { passive: true });
      // Final-position safety net: capture before the document is torn down.
      window.addEventListener('pagehide', saveScroll);
    }

    fetch(PREFIX + 'assets/nav.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderTabs(data);
        renderSidebar(data);
        wireSidebar();
        // Restore after layout settles so scrollTop actually takes effect.
        requestAnimationFrame(restoreScroll);
      })
      .catch(function () { /* leave shells empty if nav.json is unreachable */ });
  })();

  // ----- right-TOC active-section highlighting via IntersectionObserver -----
  var tocLinks = document.querySelectorAll('.sidebar-right a[href^="#"]');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var linkMap = {};
    tocLinks.forEach(function (a) { linkMap[a.getAttribute('href').slice(1)] = a; });

    var lastActive = null;
    function activate(id) {
      if (lastActive) lastActive.classList.remove('toc-active');
      var a = linkMap[id];
      if (a) { a.classList.add('toc-active'); lastActive = a; }
    }

    var headings = Object.keys(linkMap)
      .map(function (id) { return document.getElementById(id); })
      .filter(Boolean);

    var observer = new IntersectionObserver(function (entries) {
      // Pick the topmost intersecting heading
      var visible = entries.filter(function (e) { return e.isIntersecting; });
      if (visible.length) {
        visible.sort(function (a, b) { return a.boundingClientRect.top - b.boundingClientRect.top; });
        activate(visible[0].target.id);
      }
    }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

    headings.forEach(function (h) { observer.observe(h); });
  }

  // ----- client-side search -----
  // Zero-dependency: a flat index (assets/search-index.json) is baked by
  // _wrap_handwritten.py from every page's title + body text. We fetch it
  // lazily on first open and filter in the browser. Links are resolved
  // against data-asset-prefix on <body> so they work at any folder depth and
  // under any GitHub Pages base path.
  (function () {
    var btn = document.querySelector('.search-btn');
    if (!btn) return;
    var PREFIX = document.body.getAttribute('data-asset-prefix') || '';
    var index = null;            // lazily fetched array of {title,url,text}
    var overlay, input, list;    // built on first open
    var results = [];
    var sel = -1;

    function build() {
      overlay = document.createElement('div');
      overlay.className = 'search-overlay';
      overlay.innerHTML =
        '<div class="search-modal" role="dialog" aria-label="Search">' +
        '<input class="search-input" type="search" placeholder="Search…" aria-label="Search query" autocomplete="off" spellcheck="false">' +
        '<div class="search-results"></div>' +
        '<div class="search-hint">↑↓ navigate · ↵ open · esc close</div>' +
        '</div>';
      document.body.appendChild(overlay);
      input = overlay.querySelector('.search-input');
      list = overlay.querySelector('.search-results');
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      input.addEventListener('input', function () { render(input.value); });
      input.addEventListener('keydown', onKey);
    }

    function open() {
      if (!overlay) build();
      overlay.classList.add('open');
      document.body.classList.add('search-open');
      input.value = '';
      render('');
      input.focus();
      if (index === null) {
        fetch(PREFIX + 'assets/search-index.json')
          .then(function (r) { return r.json(); })
          .then(function (data) { index = data; render(input.value); })
          .catch(function () { index = []; render(input.value); });
      }
    }

    function close() {
      if (overlay) overlay.classList.remove('open');
      document.body.classList.remove('search-open');
    }

    function hint(msg) {
      var d = document.createElement('div');
      d.className = 'search-empty';
      d.textContent = msg;
      return d;
    }

    function render(q) {
      q = q.trim().toLowerCase();
      list.innerHTML = '';
      sel = -1;
      results = [];
      if (!q) {
        list.appendChild(hint(index === null ? 'Loading…'
          : 'Type to search ' + index.length + ' page' + (index.length === 1 ? '' : 's') + '.'));
        return;
      }
      if (!index) { list.appendChild(hint('Loading…')); return; }
      results = index.filter(function (e) {
        return e.title.toLowerCase().indexOf(q) !== -1 || e.text.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 20);
      if (!results.length) { list.appendChild(hint('No matches.')); return; }
      results.forEach(function (e, i) { list.appendChild(row(e, q, i)); });
      select(0);
    }

    function row(e, q, i) {
      var a = document.createElement('a');
      a.className = 'search-result';
      a.href = PREFIX + e.url;
      var t = document.createElement('div');
      t.className = 'search-result-title';
      t.textContent = e.title;
      var s = document.createElement('div');
      s.className = 'search-result-snippet';
      s.appendChild(snippet(e.text, q));
      a.appendChild(t);
      a.appendChild(s);
      a.addEventListener('mouseenter', function () { select(i); });
      return a;
    }

    function snippet(text, q) {
      var frag = document.createDocumentFragment();
      var lo = text.toLowerCase().indexOf(q);
      if (lo === -1) {
        frag.appendChild(document.createTextNode(text.slice(0, 120) + (text.length > 120 ? '…' : '')));
        return frag;
      }
      var start = Math.max(0, lo - 40);
      frag.appendChild(document.createTextNode((start > 0 ? '…' : '') + text.slice(start, lo)));
      var mk = document.createElement('mark');
      mk.textContent = text.slice(lo, lo + q.length);
      frag.appendChild(mk);
      var end = lo + q.length;
      frag.appendChild(document.createTextNode(text.slice(end, end + 80) + (end + 80 < text.length ? '…' : '')));
      return frag;
    }

    function select(i) {
      var rows = list.querySelectorAll('.search-result');
      if (!rows.length) { sel = -1; return; }
      sel = (i + rows.length) % rows.length;
      rows.forEach(function (r, j) { r.classList.toggle('sel', j === sel); });
      rows[sel].scrollIntoView({ block: 'nearest' });
    }

    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
      else if (e.key === 'Enter') {
        var rows = list.querySelectorAll('.search-result');
        if (rows[sel]) { e.preventDefault(); window.location.href = rows[sel].href; }
      } else if (e.key === 'Escape') { close(); }
    }

    btn.addEventListener('click', open);
    document.addEventListener('keydown', function (e) {
      var open_ = document.body.classList.contains('search-open');
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if (e.key === '/' && !typing && !open_) { e.preventDefault(); open(); }
      else if (e.key === 'Escape' && open_) { close(); }
    });
  })();
})();

/* ---- Mermaid diagrams ------------------------------------------------------
 * Any doc page can drop a `<pre class="mermaid">…</pre>` block and it renders as
 * a diagram. Loaded here (not per-page) because the wrap step extracts inline
 * <main> scripts to body-end on the first pass and then DROPS them on the next
 * re-wrap — so page-local mermaid init is not durable. Gated on the block being
 * present, so pages without a diagram pay zero (no CDN fetch). Theme follows the
 * site's <html data-theme> and re-renders on toggle. */
(function () {
  var blocks = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
  if (!blocks.length) return;
  // Cache each graph's source — mermaid replaces the element's text with SVG on
  // first run, so we need the original to re-render when the theme flips.
  blocks.forEach(function (b) { b.dataset.src = b.textContent; });
  import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')
    .then(function (mod) {
      var mermaid = mod.default;
      function siteTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'neutral';
      }
      function render() {
        blocks.forEach(function (b) {
          b.removeAttribute('data-processed');
          b.innerHTML = b.dataset.src;
        });
        mermaid.initialize({ startOnLoad: false, theme: siteTheme(), flowchart: { curve: 'basis', useMaxWidth: true } });
        mermaid.run({ nodes: blocks });
      }
      render();
      new MutationObserver(function (muts) {
        muts.forEach(function (m) { if (m.attributeName === 'data-theme') render(); });
      }).observe(document.documentElement, { attributes: true });
    })
    .catch(function (e) { console.error('mermaid load failed', e); });
})();

/* ---- copy-to-clipboard buttons (final-reply raw markdown) ------------------
   Lives here rather than inline in the page: handwritten pages get re-baked
   and inline <script> does not survive. Any element with data-copy="<id>"
   copies the text content of #<id>. */
(function () {
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-copy]');
    if (!btn) return;
    e.preventDefault();
    var src = document.getElementById(btn.getAttribute('data-copy'));
    if (!src) return;
    var text = src.innerText || src.textContent || '';
    var done = function (ok) {
      var old = btn.getAttribute('data-label') || btn.textContent;
      btn.setAttribute('data-label', old);
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      btn.classList.toggle('copied', !!ok);
      setTimeout(function () {
        btn.textContent = btn.getAttribute('data-label');
        btn.classList.remove('copied');
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    var ta = document.createElement('textarea');           // http:// on LAN has no clipboard API
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  });
})();

/* ---------- in-browser page editing (dev server only) ----------
   The dev server exposes /__edit (GET: the authored <main> source + a content
   hash; POST: splice the edited source back into the file). When the probe
   answers, an ✏️ button joins the header actions. Editing swaps <main> for the
   pristine on-disk source before enabling contenteditable, so runtime-injected
   DOM (changelog block, mermaid SVG, note fields) is never saved back. Save
   POSTs with the base hash — a 409 means the file changed on disk meanwhile.
   After a successful save the server's auto-wrap re-bakes chrome and the SSE
   broadcast reloads every tab. On the published static site the probe 404s,
   so no button appears. window.__bbEditing tells the reload snippet to hold
   refreshes while an edit is open. */
(function () {
  var body = document.body;
  var rel = body.getAttribute('data-page-rel') || '';
  var main = document.querySelector('main.doc-body');
  var actions = document.querySelector('.site-actions');
  if (!rel || !main || !actions) return;
  var API = '/__edit?page=' + encodeURIComponent(rel);

  fetch(API).then(function (r) {
    if (r.ok && (r.headers.get('content-type') || '').indexOf('json') >= 0) install();
  }).catch(function () { /* static hosting — no edit backend */ });

  function mkBtn(cls, label, text) {
    var b = document.createElement('button');
    b.className = 'site-action ' + cls;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.textContent = text;
    return b;
  }

  function install() {
    var editBtn = mkBtn('edit-btn', 'Edit this page', '✏️');
    var saveBtn = mkBtn('edit-save-btn', 'Save to source file', '💾');
    var cancelBtn = mkBtn('edit-cancel-btn', 'Discard edits', '✕');
    var status = document.createElement('span');
    status.className = 'edit-status';
    saveBtn.style.display = 'none';
    cancelBtn.style.display = 'none';
    var theme = actions.querySelector('.theme-toggle');
    actions.insertBefore(status, theme);
    actions.insertBefore(editBtn, theme);
    actions.insertBefore(saveBtn, theme);
    actions.insertBefore(cancelBtn, theme);

    var baseHash = null;
    var dirty = false;
    var confirmDiscard = false;

    function setStatus(msg, warn) {
      status.textContent = msg || '';
      status.classList.toggle('warn', !!warn);
    }

    function leaveEditMode() {
      window.__bbEditing = false;
      dirty = false;
      location.reload();
    }

    editBtn.addEventListener('click', function () {
      setStatus('loading…');
      fetch(API).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
        if (!data || !data.ok) { setStatus('load failed', true); return; }
        baseHash = data.hash;
        main.innerHTML = data.source;
        main.setAttribute('contenteditable', 'true');
        main.setAttribute('spellcheck', 'false');
        window.__bbEditing = true;
        dirty = false;
        confirmDiscard = false;
        editBtn.style.display = 'none';
        saveBtn.style.display = '';
        cancelBtn.style.display = '';
        setStatus('editing');
        main.focus();
      }).catch(function () { setStatus('load failed', true); });
    });

    main.addEventListener('input', function () {
      if (window.__bbEditing) { dirty = true; confirmDiscard = false; setStatus('editing • unsaved'); }
    });

    window.addEventListener('beforeunload', function (e) {
      if (window.__bbEditing && dirty) { e.preventDefault(); e.returnValue = ''; }
    });

    cancelBtn.addEventListener('click', function () {
      if (dirty && !confirmDiscard) {
        confirmDiscard = true;
        setStatus('unsaved edits — click ✕ again to discard', true);
        return;
      }
      leaveEditMode();
    });

    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      setStatus('saving…');
      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: main.innerHTML, base_hash: baseHash })
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j }; });
      }).then(function (res) {
        if (res.j && res.j.ok) { leaveEditMode(); return; }
        saveBtn.disabled = false;
        if (res.status === 409) {
          setStatus('conflict: file changed on disk — copy your text, then reload', true);
        } else {
          setStatus('save failed: ' + ((res.j && res.j.error) || res.status), true);
        }
      }).catch(function () {
        saveBtn.disabled = false;
        setStatus('save failed: server unreachable', true);
      });
    });
  }
})();

/* ---------- site settings panel (dev server only) ----------
   The dev server exposes /__settings (GET: current state; POST: apply changes).
   When the probe answers, a ⚙ joins the header actions. It 404s on the published
   static site, so no button appears there. On the dev server the gear shows for
   every client alike, local or LAN (no distinction, by the owner's choice); with
   a password set, the gate has already been passed. Every change re-sends the CURRENT password, so a
   viewer who merely knows it cannot silently be someone who never did. */
(function () {
  var actions = document.querySelector('.site-actions');
  if (!actions) return;

  fetch('/__settings').then(function (r) {
    if (r.ok && (r.headers.get('content-type') || '').indexOf('json') >= 0) return r.json();
    return null;
  }).then(function (state) { if (state) install(state); })
    .catch(function () { /* static hosting — no settings backend */ });

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function install(state) {
    var btn = el('button', 'site-action settings-btn', '⚙');
    btn.setAttribute('aria-label', 'Site settings');
    btn.title = 'Site settings';
    var theme = actions.querySelector('.theme-toggle');
    if (theme) actions.insertBefore(btn, theme); else actions.appendChild(btn);

    var overlay = null;
    btn.addEventListener('click', function () { overlay ? close() : open(); });

    function close() {
      if (overlay) { overlay.remove(); overlay = null; }
      document.removeEventListener('keydown', onEsc);
    }
    function onEsc(e) { if (e.key === 'Escape') { close(); btn.focus(); } }

    function row(label, hint) {
      var r = el('div', 'set-row');
      var l = el('div', 'set-label', label);
      r.appendChild(l);
      if (hint) r.appendChild(el('div', 'set-hint', hint));
      return r;
    }
    function toggle(key, label, hint, checked, disabled) {
      var r = el('label', 'set-row set-toggle');
      var box = el('input');
      box.type = 'checkbox';
      box.checked = !!checked;
      box.disabled = !!disabled;
      box.dataset.key = key;
      var wrap = el('div', 'set-toggle-text');
      wrap.appendChild(el('div', 'set-label', label));
      if (hint) wrap.appendChild(el('div', 'set-hint', hint));
      r.appendChild(box);
      r.appendChild(wrap);
      return r;
    }

    function open() {
      fetch('/__settings').then(function (r) { return r.json(); }).then(render)
        .catch(function () { /* server went away */ });
    }

    function render(s) {
      close();
      overlay = el('div', 'settings-overlay');
      var panel = el('div', 'settings-panel');
      panel.addEventListener('click', function (e) { e.stopPropagation(); });
      overlay.addEventListener('click', close);
      document.addEventListener('keydown', onEsc);

      panel.appendChild(el('h2', 'set-title', 'Site settings'));
      panel.appendChild(el('p', 'set-sub', 'Changes apply immediately and are saved to .site.json next to the site (gitignored).'));

      // --- access ---
      panel.appendChild(el('h3', 'set-group', 'Access'));
      var pwToggle = toggle('has_password', 'Password protection',
        s.password_from_env ? 'Set by $DOCSITE_PASS; cannot be changed here.'
                            : 'When on, LAN visitors need the password to view the site. Plain HTTP: keeps out casual visitors, not eavesdroppers.',
        s.has_password, s.password_from_env);
      panel.appendChild(pwToggle);
      var newPw = el('input', 'set-input');
      newPw.type = 'password';
      newPw.placeholder = s.has_password ? 'New password (empty = keep)' : 'Set a password';
      newPw.autocomplete = 'new-password';
      newPw.disabled = s.password_from_env;
      var newPwRow = el('div', 'set-row set-indent');
      newPwRow.appendChild(newPw);
      panel.appendChild(newPwRow);
      function syncPw() { newPwRow.hidden = !pwToggle.querySelector('input').checked; }
      pwToggle.querySelector('input').addEventListener('change', syncPw);
      syncPw();

      panel.appendChild(toggle('remember_ip', 'One login per IP per day',
        'After a successful login the IP is remembered for ' + s.grant_hours + ' hours, across server restarts. '
        + 'It trusts the network address, not the person: everyone behind the same NAT / VPN exit gets in too.',
        s.remember_ip));

      var kickRow = el('div', 'set-row set-indent');
      var kick = el('button', 'set-btn set-btn-quiet', 'Sign out all other devices');
      kickRow.appendChild(kick);
      kickRow.appendChild(el('div', 'set-hint',
        'Others must enter the password again; you stay signed in. Remembered IPs are cleared too.'));
      panel.appendChild(kickRow);

      // --- write access ---
      panel.appendChild(el('h3', 'set-group', 'Write access'));
      panel.appendChild(toggle('allow_edit', 'In-browser page editing',
        'When off, the ✏️ button disappears and /__edit returns 403 — nobody can change page files.', s.allow_edit));

      // --- server ---
      panel.appendChild(el('h3', 'set-group', 'Server'));
      panel.appendChild(toggle('autowrap', 'Re-bake on save',
        s.autowrap_forced_off ? 'Forced off by the NO_AUTOWRAP environment variable.'
                              : 'Re-bake page chrome and indices whenever a file changes. When off, run _wrap_handwritten.py by hand.',
        s.autowrap, s.autowrap_forced_off));

      var info = el('div', 'set-info');
      var lan = el('div', 'set-info-row');
      lan.appendChild(el('span', 'set-info-k', 'LAN address'));
      var lanA = el('a', 'set-info-v', s.lan_url);
      lanA.href = s.lan_url;
      lan.appendChild(lanA);
      info.appendChild(lan);
      var ips = el('div', 'set-info-row');
      ips.appendChild(el('span', 'set-info-k', 'Remembered IPs'));
      ips.appendChild(el('span', 'set-info-v', String(s.remembered_ips)));
      info.appendChild(ips);
      var cnt = el('div', 'set-info-row');
      cnt.appendChild(el('span', 'set-info-k', 'HTML files'));
      cnt.appendChild(el('span', 'set-info-v', String(s.page_count)));
      info.appendChild(cnt);
      panel.appendChild(info);

      // --- confirm + save ---
      var foot = el('div', 'set-foot');
      var cur = el('input', 'set-input');
      cur.type = 'password';
      cur.placeholder = 'Current password';
      cur.autocomplete = 'current-password';
      if (s.has_password) foot.appendChild(cur);
      var status = el('div', 'set-status');
      var bar = el('div', 'set-actions');
      var cancel = el('button', 'set-btn set-btn-quiet', 'Cancel');
      var save = el('button', 'set-btn', 'Save');
      bar.appendChild(status);
      bar.appendChild(cancel);
      bar.appendChild(save);
      foot.appendChild(bar);
      panel.appendChild(foot);
      cancel.addEventListener('click', close);

      function post(body, onOk) {
        status.textContent = '…';
        status.className = 'set-status';
        body.current_password = cur.value;
        fetch('/__settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, j: j }; });
        }).then(function (res) {
          if (!res.ok) {
            status.textContent = res.j.error || 'Something went wrong';
            status.className = 'set-status set-status-err';
            return;
          }
          onOk(res.j);
        }).catch(function () {
          status.textContent = 'Cannot reach the server';
          status.className = 'set-status set-status-err';
        });
      }

      kick.addEventListener('click', function () {
        post({ sign_out_everyone: true }, function () {
          status.textContent = 'Other devices signed out';
          status.className = 'set-status set-status-ok';
        });
      });

      save.addEventListener('click', function () {
        var changes = {};
        panel.querySelectorAll('input[type=checkbox][data-key]').forEach(function (b) {
          if (b.disabled) return;
          if (b.dataset.key === 'has_password') return;   // handled below
          changes[b.dataset.key] = b.checked;
        });
        var wantPw = pwToggle.querySelector('input');
        if (!wantPw.disabled) {
          if (!wantPw.checked) changes.password = '';
          else if (newPw.value) changes.password = newPw.value;
          else if (!s.has_password) {
            status.textContent = 'Enter a password';
            status.className = 'set-status set-status-err';
            return;
          }
        }
        post({ changes: changes }, function (next) {
          status.textContent = 'Saved';
          status.className = 'set-status set-status-ok';
          setTimeout(function () { close(); }, 700);
          if (next.allow_edit !== s.allow_edit) location.reload();
        });
      });

      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      (s.has_password ? cur : newPw).focus();
    }
  }
})();
