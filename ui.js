// Runs in the page's MAIN world on every supported site. Draws the download button on
// top of each visible video and its menu; the site script (facebook.js / youtube.js)
// supplies the video ids and menu items through FDLUI.init(adapter).
(function (g) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BTN_SIZE = 40;
  const LABEL_H = 18;

  const buttons = new Map(); // <video> -> button
  const progress = new Map(); // video id -> { state, pct, text }
  let layer = null;
  let menu = null;
  let site = null;

  function css(el, styles) {
    Object.assign(el.style, styles);
    return el;
  }

  function stopAll(el) {
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart'])
      el.addEventListener(t, (e) => e.stopPropagation());
  }

  function downloadIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1zM5 19h14a1 1 0 1 1 0 2H5a1 1 0 1 1 0-2z');
    svg.append(path);
    return svg;
  }

  function ensureLayer() {
    if (layer?.isConnected) return layer;
    layer = css(document.createElement('div'), {
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483000',
    });
    layer.id = 'fdl-layer';
    (document.body || document.documentElement).append(layer);
    return layer;
  }

  function visibleArea(r) {
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // Floating: a round icon with a caption under it, like the Reels/Shorts action buttons.
  // Inline: a pill (icon + caption) placed in the site's own toolbar under the video.
  const FLOAT = {
    btn: { position: 'fixed', width: `${BTN_SIZE}px`, height: '', flexDirection: 'column', gap: '0', padding: '0', marginRight: '0', borderRadius: '0', background: 'transparent', color: '#fff' },
    circle: { width: `${BTN_SIZE}px`, height: `${BTN_SIZE}px` },
    label: { height: `${LABEL_H}px`, marginTop: '4px', font: '600 12px/18px system-ui, "Segoe UI", sans-serif', textShadow: '0 1px 2px rgba(0,0,0,.8)' },
  };
  const INLINE = {
    btn: { position: 'static', left: '', top: '', width: 'auto', height: '36px', flexDirection: 'row', gap: '4px', padding: '0 14px 0 8px', marginRight: '8px', borderRadius: '18px', color: 'inherit' },
    circle: { width: '24px', height: '24px', background: 'transparent' },
    label: { height: 'auto', marginTop: '0', font: '500 14px/36px "Roboto", system-ui, "Segoe UI", sans-serif', textShadow: 'none' },
  };

  function setMode(btn, mode) {
    if (btn.dataset.mode === mode) return;
    btn.dataset.mode = mode;
    const m = mode === 'inline' ? INLINE : FLOAT;
    css(btn, m.btn);
    css(btn.firstChild, m.circle);
    css(btn.lastChild, m.label);
    paintIdle(btn);
  }

  function paintIdle(btn) {
    if (btn.dataset.mode === 'inline') {
      btn.style.background = site.inlineBg;
      btn.firstChild.style.background = 'transparent';
    } else btn.firstChild.style.background = site.buttonBg;
  }

  function paintHover(btn) {
    if (btn.dataset.mode === 'inline') btn.style.background = site.inlineHover;
    else btn.firstChild.style.background = site.accent;
  }

  function makeButton(el) {
    const btn = css(document.createElement('div'), {
      display: 'flex',
      alignItems: 'center',
      flex: 'none',
      boxSizing: 'border-box',
      pointerEvents: 'auto',
      cursor: 'pointer',
      userSelect: 'none',
      transition: 'background .15s',
    });
    const circle = css(document.createElement('button'), {
      borderRadius: '50%',
      border: '0',
      padding: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'inherit',
      cursor: 'pointer',
      transition: 'background .15s',
    });
    circle.type = 'button';
    circle.append(downloadIcon());
    const label = css(document.createElement('span'), { whiteSpace: 'nowrap' });
    label.className = 'fdl-label';
    btn.append(circle, label);
    btn.className = 'fdl-btn';
    btn.title = 'Tải video (FDownloader)';
    btn.addEventListener('mouseenter', () => paintHover(btn));
    btn.addEventListener('mouseleave', () => paintIdle(btn));
    stopAll(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu?.dataset.owner === btn.dataset.key) closeMenu();
      else openMenu(btn, el);
    });
    return btn;
  }

  const STATE_LABEL = {
    downloading: (p) => `${p.pct}%`,
    waiting: () => 'Chờ…',
    muxing: () => 'Ghép…',
    done: () => '✓ Xong',
    error: () => '! Lỗi',
  };

  function renderButtonState(btn, id) {
    const p = id && progress.get(id);
    const text = p ? STATE_LABEL[p.state](p) : 'Tải';
    const label = btn.querySelector('.fdl-label');
    if (label.textContent !== text) label.textContent = text;
    btn.title = p?.text || 'Tải video (FDownloader)';
  }

  // Reels/Shorts show a column of round buttons (Like, Comment, Share…) right next to
  // the video. Find it by geometry so it works in every UI language; returns the top one.
  function findActionColumnTop(r) {
    const sel = typeof site.actionSelector === 'function' ? site.actionSelector() : site.actionSelector;
    if (!sel) return null;
    const cands = [];
    for (const e of document.querySelectorAll(sel)) {
      // Our own round button sits in that column too; counting it makes it climb every tick.
      if (e.closest('.fdl-btn')) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 28 || b.width > 64 || b.height < 28 || b.height > 64) continue;
      if (b.left < r.right - 4 || b.left > r.right + 160) continue;
      const cy = b.top + b.height / 2;
      if (cy < r.top || cy > r.bottom) continue;
      cands.push(b);
    }
    cands.sort((a, b) => a.left - b.left);
    // Columns: buttons whose left edges line up; take the nearest one with 2+ buttons.
    for (let i = 0; i < cands.length; ) {
      let j = i;
      while (j < cands.length && cands[j].left - cands[i].left <= 6) j++;
      if (j - i >= 2) return cands.slice(i, j).reduce((a, b) => (b.top < a.top ? b : a));
      i = j;
    }
    return null;
  }

  // Floating position that never covers the video; false when there is no free spot.
  function placeButton(btn, r) {
    const H = BTN_SIZE + 4 + LABEL_H;
    const top = findActionColumnTop(r);
    if (top) {
      // Directly above the first action button (Like), centred on its column.
      css(btn, { left: `${top.left + top.width / 2 - BTN_SIZE / 2}px`, top: `${top.top - H - 16}px` });
      return true;
    }
    // Beside the video (right, then left), level with its top; else above or below it.
    const y = Math.min(Math.max(r.top, 0) + 12, innerHeight - H - 8);
    const x = Math.min(r.right, innerWidth) - BTN_SIZE;
    const spots = [
      [r.right + 12, y, r.right + 12 + BTN_SIZE <= innerWidth],
      [r.left - 12 - BTN_SIZE, y, r.left - 12 - BTN_SIZE >= 0],
      [x, r.top - H - 8, r.top - H - 8 >= 0],
      [x, r.bottom + 8, r.bottom + 8 + H <= innerHeight],
    ];
    const spot = spots.find((s) => s[2]);
    if (spot) css(btn, { left: `${spot[0]}px`, top: `${spot[1]}px` });
    return !!spot;
  }

  let keySeq = 0;
  function tick() {
    if (!site) return;
    ensureLayer();
    for (const [el, btn] of buttons) {
      if (!el.isConnected) {
        btn.remove();
        buttons.delete(el);
      }
    }
    for (const el of document.querySelectorAll(site.videoSelector)) {
      let btn = buttons.get(el);
      if (!btn) {
        btn = makeButton(el);
        btn.dataset.key = String(++keySeq);
        buttons.set(el, btn);
      }
      // The site may host the button in its own toolbar (e.g. YouTube's Like/Share row).
      if (site.mount?.(el, btn)) {
        setMode(btn, 'inline');
        btn.style.display = 'flex';
        renderButtonState(btn, site.getId(el));
        continue;
      }
      const r = el.getBoundingClientRect();
      const visible = r.width >= 140 && r.height >= 100 && visibleArea(r) > 140 * 100;
      if (!visible) {
        btn.style.display = 'none';
        continue;
      }
      setMode(btn, 'float');
      if (btn.parentNode !== layer) layer.append(btn);
      btn.style.display = placeButton(btn, r) ? 'flex' : 'none';
      renderButtonState(btn, site.getId(el));
    }
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function menuItem({ text, onClick, muted, bold }) {
    const item = css(document.createElement(onClick ? 'button' : 'div'), {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      textAlign: 'left',
      padding: '8px 12px',
      border: '0',
      background: 'transparent',
      color: muted ? '#b0b3b8' : '#e4e6eb',
      font: `${bold ? 600 : 400} 13px/1.35 system-ui, "Segoe UI", sans-serif`,
      cursor: onClick ? 'pointer' : 'default',
      borderRadius: '6px',
      whiteSpace: 'normal',
    });
    item.textContent = text;
    if (onClick) {
      item.type = 'button';
      item.addEventListener('mouseenter', () => (item.style.background = '#3a3b3c'));
      item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
      item.addEventListener('click', (e) => {
        e.preventDefault();
        closeMenu();
        onClick();
      });
    }
    return item;
  }

  function openMenu(btn, el) {
    closeMenu();
    menu = css(document.createElement('div'), {
      position: 'fixed',
      width: '260px',
      maxHeight: '360px',
      boxSizing: 'border-box',
      overflowX: 'hidden',
      overflowY: 'auto',
      overscrollBehavior: 'contain', // reaching the end must not scroll (and close over) the page
      padding: '6px',
      background: '#242526',
      border: '1px solid #3a3b3c',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,.45)',
      pointerEvents: 'auto',
    });
    menu.dataset.owner = btn.dataset.key;
    stopAll(menu);
    for (const item of site.buildMenu(el, site.getId(el))) menu.append(menuItem(item));

    layer.append(menu);
    // Prefer opening downwards (away from the video when the button sits under it),
    // shrinking the menu to fit; flip up only when there is hardly any room below.
    const r = btn.getBoundingClientRect();
    const below = innerHeight - r.bottom - 14;
    if (below >= 160) css(menu, { top: `${r.bottom + 6}px`, maxHeight: `${Math.min(360, below)}px` });
    else css(menu, { top: `${Math.max(8, r.top - 6 - menu.offsetHeight)}px` });
    css(menu, { left: `${Math.min(Math.max(8, r.right - 260), innerWidth - 268)}px` });
  }

  function setProgress(id, p) {
    if (!id) return;
    if (!p) progress.delete(id);
    else {
      progress.set(id, p);
      if (p.state === 'done') setTimeout(() => progress.get(id) === p && progress.delete(id), 4000);
    }
    tick();
  }

  /**
   * @param {{
   *   videoSelector: string, actionSelector: string | (() => string),
   *   buttonBg: string, accent: string,
   *   mount?(el: HTMLVideoElement, btn: HTMLElement): boolean,  // put btn in the page; true if done
   *   inlineBg?: string, inlineHover?: string,
   *   getId(el: HTMLVideoElement): string | null,
   *   buildMenu(el: HTMLVideoElement, id: string | null): {text: string, onClick?: Function, muted?: boolean, bold?: boolean}[],
   * }} adapter
   */
  function init(adapter) {
    site = adapter;
    document.addEventListener('mousedown', (e) => {
      if (menu && !menu.contains(e.target)) closeMenu();
    }, true);
    window.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
    let tickQueued = false;
    const queueTick = () => {
      if (tickQueued) return;
      tickQueued = true;
      requestAnimationFrame(() => {
        tickQueued = false;
        tick();
      });
    };
    window.addEventListener('scroll', (e) => {
      // Scrolling inside the menu itself must not close it.
      if (menu && menu.contains(e.target)) return;
      closeMenu();
      queueTick();
    }, { passive: true, capture: true });
    window.addEventListener('resize', queueTick, { passive: true });
    setInterval(tick, 500);
  }

  g.FDLUI = { init, setProgress, visibleArea };
})(globalThis);
