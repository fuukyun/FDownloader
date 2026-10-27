// Runs in the page's MAIN world. Collects video data from Facebook's embedded JSON
// and GraphQL responses, and draws a download button on top of every visible video.
(() => {
  if (window.__fdlInjected) return;
  window.__fdlInjected = true;

  const { buildOptions, makeJob } = globalThis.FDLOptions;
  const HINT = /fbcdn|browser_native|playable_url|dash_manifest|progressive_url|<MPD/;
  const videos = new Map();
  let postTimer = null;

  function getVideo(id) {
    let v = videos.get(id);
    if (!v) {
      v = { id, title: '', thumb: '', duration: 0, progressive: {}, reps: new Map(), seen: Date.now() };
      videos.set(id, v);
    }
    return v;
  }

  const plain = (v) => ({ ...v, reps: [...v.reps.values()] });

  function postList() {
    const list = [...videos.values()].filter((v) => v.reps.size || v.progressive.HD || v.progressive.SD).map(plain);
    window.postMessage({ source: 'fdl-inject', type: 'list', videos: list, currentId: currentVideoId() }, '*');
  }

  function schedulePost() {
    clearTimeout(postTimer);
    postTimer = setTimeout(postList, 300);
  }

  function cleanUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
      return u.toString();
    } catch {
      return url;
    }
  }

  function repKey(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }

  function addRep(id, rep) {
    if (!rep.url) return;
    rep.url = cleanUrl(rep.url);
    const v = getVideo(id);
    const key = repKey(rep.url);
    const old = v.reps.get(key);
    v.reps.set(key, old ? { ...old, ...Object.fromEntries(Object.entries(rep).filter(([, x]) => x)) } : rep);
    schedulePost();
  }

  function setProgressive(id, quality, url) {
    if (typeof url !== 'string' || !url.startsWith('http')) return;
    const v = getVideo(id);
    if (!v.progressive[quality]) {
      v.progressive[quality] = cleanUrl(url);
      schedulePost();
    }
  }

  const decodeXml = (s) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");

  function attr(head, name) {
    const m = head.match(new RegExp('\\b' + name + '="([^"]*)"'));
    return m ? decodeXml(m[1]) : '';
  }

  // Regex-based MPD parsing: DOMParser may be blocked by Facebook's Trusted Types policy.
  function parseMpd(xml, id) {
    for (const set of xml.split(/<AdaptationSet\b/).slice(1)) {
      const setHead = set.slice(0, set.indexOf('>'));
      const setType = attr(setHead, 'mimeType') || attr(setHead, 'contentType');
      for (const r of set.split(/<Representation\b/).slice(1)) {
        const head = r.slice(0, r.indexOf('>'));
        const base = r.match(/<BaseURL>([^<]+)<\/BaseURL>/);
        if (!base) continue;
        const type = attr(head, 'mimeType') || setType;
        addRep(id, {
          kind: type.includes('audio') ? 'audio' : 'video',
          url: decodeXml(base[1].trim()),
          bandwidth: +attr(head, 'bandwidth') || 0,
          width: +attr(head, 'width') || 0,
          height: +attr(head, 'height') || 0,
          label: attr(head, 'FBQualityLabel'),
          codecs: attr(head, 'codecs'),
        });
      }
    }
  }

  const isNumId = (x) => (typeof x === 'string' || typeof x === 'number') && /^\d{5,}$/.test(String(x));

  function videoIdOf(o) {
    if (isNumId(o.videoId)) return String(o.videoId);
    if (isNumId(o.video_id)) return String(o.video_id);
    if (
      isNumId(o.id) &&
      (o.__typename === 'Video' ||
        'playable_url' in o ||
        'browser_native_hd_url' in o ||
        'dash_manifest' in o ||
        'videoDeliveryLegacyFields' in o ||
        'videoDeliveryResponseFragment' in o)
    )
      return String(o.id);
    return null;
  }

  function readMeta(id, o, caption) {
    const v = getVideo(id);
    const title =
      o.title?.text ||
      o.savable_title?.text ||
      (typeof o.title === 'string' ? o.title : '') ||
      (typeof o.name === 'string' ? o.name : '') ||
      o.creation_story?.message?.text ||
      caption;
    if (title && !v.title) v.title = title;
    const thumb = o.preferred_thumbnail?.image?.uri || o.thumbnailImage?.uri || o.thumbnail?.uri;
    if (thumb && !v.thumb) v.thumb = thumb;
    const dur = o.playable_duration_in_ms ? o.playable_duration_in_ms / 1000 : o.length_in_second;
    if (dur && !v.duration) v.duration = dur;
    v.seen = Date.now();
  }

  // ctx: id of the closest enclosing video; caption: text of the closest enclosing post.
  function walk(node, ctx, caption, depth) {
    if (depth > 80 || node === null) return;
    if (typeof node === 'string') {
      if (ctx && node.includes('<MPD')) parseMpd(node, ctx);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, ctx, caption, depth + 1);
      return;
    }

    if (typeof node.message?.text === 'string') caption = node.message.text;

    const id = videoIdOf(node);
    if (id) {
      ctx = id;
      readMeta(id, node, caption);
    }

    if (ctx) {
      setProgressive(ctx, 'HD', node.browser_native_hd_url || node.playable_url_quality_hd || node.hd_src);
      setProgressive(ctx, 'SD', node.browser_native_sd_url || node.playable_url || node.sd_src);
      if (typeof node.progressive_url === 'string') {
        setProgressive(ctx, node.metadata?.quality === 'HD' ? 'HD' : 'SD', node.progressive_url);
      }
      // all_video_dash_prefetch_representations[].representations[]
      if (typeof node.base_url === 'string' && typeof node.mime_type === 'string') {
        addRep(ctx, {
          kind: node.mime_type.includes('audio') ? 'audio' : 'video',
          url: node.base_url,
          bandwidth: +node.bandwidth || 0,
          width: +node.width || 0,
          height: +node.height || 0,
          label: '',
          codecs: node.codecs || '',
        });
      }
    }

    for (const k in node) walk(node[k], ctx, caption, depth + 1);
  }

  function processText(text) {
    if (!text || !HINT.test(text)) return;
    text = text.replace(/^for \(;;\);/, '');
    try {
      walk(JSON.parse(text), null, '', 0);
      return;
    } catch {}
    // GraphQL streams several JSON documents separated by newlines.
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        walk(JSON.parse(line), null, '', 0);
      } catch {}
    }
  }

  const isApi = (url) => /\/api\/graphql|\/ajax\/|\/video\//.test(url || '');

  // --- Hook fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (isApi(url)) res.clone().text().then(processText, () => {});
    } catch {}
    return res;
  };

  // --- Hook XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isApi(String(url))) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') processText(this.responseText);
        } catch {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };

  // --- Embedded JSON in the initial HTML ---
  // A script can be observed while the parser is still streaming its text in,
  // so remember the length we parsed and rescan if it grew.
  const scannedLen = new WeakMap();
  function scanScripts(root) {
    const scripts = root.querySelectorAll ? root.querySelectorAll('script[type="application/json"]') : [];
    for (const s of scripts) {
      const text = s.textContent;
      if (scannedLen.get(s) === text.length) continue;
      scannedLen.set(s, text.length);
      processText(text);
    }
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'SCRIPT') scanScripts(n.parentNode || document);
        else if (n.querySelector?.('script[type="application/json"]')) scanScripts(n);
      }
    }
  }).observe(document, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', () => scanScripts(document));

  // ===================== Mapping <video> elements to video ids =====================

  function urlVideoId() {
    const m = location.href.match(/\/(?:videos|reel|watch\/live)\/(?:[^/?]+\/)?(\d{5,})/) || location.href.match(/[?&]v=(\d{5,})/);
    return m ? m[1] : null;
  }

  // Facebook's player keeps the id in React props (coreVideoPlayerMetaData.videoFBID).
  function fiberVideoId(el) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = key && el[key];
    for (let d = 0; f && d < 60; d++, f = f.return) {
      const p = f.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      const id = p.coreVideoPlayerMetaData?.videoFBID ?? p.videoFBID ?? p.videoID ?? p.videoId ?? p.video?.id;
      if (isNumId(id)) return String(id);
    }
    return null;
  }

  function visibleArea(r) {
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? w * h : 0;
  }

  // The most visible video on screen; falls back to the id in the URL.
  function currentVideoId() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('video')) {
      const area = visibleArea(el.getBoundingClientRect());
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return (best && fiberVideoId(best)) || urlVideoId();
  }

  // ===================== On-page download button =====================

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const buttons = new Map(); // <video> -> button
  const progress = new Map(); // video id -> { state, pct, text }
  let layer = null;
  let menu = null;

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

  const BTN_SIZE = 40;
  const LABEL_H = 18;
  const CIRCLE_BG = 'rgba(255,255,255,.12)';

  // Styled like Facebook's Reels action buttons: a round icon with a caption under it.
  function makeButton(el) {
    const btn = css(document.createElement('div'), {
      position: 'fixed',
      width: `${BTN_SIZE}px`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      pointerEvents: 'auto',
      cursor: 'pointer',
      color: '#fff',
      userSelect: 'none',
    });
    const circle = css(document.createElement('button'), {
      width: `${BTN_SIZE}px`,
      height: `${BTN_SIZE}px`,
      borderRadius: '50%',
      border: '0',
      padding: '0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: CIRCLE_BG,
      color: '#fff',
      cursor: 'pointer',
      transition: 'background .15s',
    });
    circle.type = 'button';
    circle.append(downloadIcon());
    const label = css(document.createElement('span'), {
      height: `${LABEL_H}px`,
      marginTop: '4px',
      font: '600 12px/18px system-ui, "Segoe UI", sans-serif',
      whiteSpace: 'nowrap',
      textShadow: '0 1px 2px rgba(0,0,0,.5)',
    });
    label.className = 'fdl-label';
    btn.append(circle, label);
    btn.title = 'Tải video (FDownloader)';
    btn.addEventListener('mouseenter', () => (circle.style.background = '#1877f2'));
    btn.addEventListener('mouseleave', () => (circle.style.background = CIRCLE_BG));
    stopAll(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (menu?.dataset.owner === btn.dataset.key) closeMenu();
      else openMenu(btn, el);
    });
    return btn;
  }

  const STATE_LABEL = { downloading: (p) => `${p.pct}%`, muxing: () => 'Ghép…', done: () => '✓ Xong', error: () => '! Lỗi' };

  function renderButtonState(btn, id) {
    const p = id && progress.get(id);
    const text = p ? STATE_LABEL[p.state](p) : 'Tải';
    const label = btn.querySelector('.fdl-label');
    if (label.textContent !== text) label.textContent = text;
    btn.title = p?.text || 'Tải video (FDownloader)';
  }

  // Reels show a column of round buttons (Like, Comment, Share…) right next to the
  // video. Find it by geometry so it works in every UI language; returns the top one.
  function findActionColumnTop(r) {
    const cands = [];
    for (const e of document.querySelectorAll('[role="button"]')) {
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

  function placeButton(btn, r) {
    const top = findActionColumnTop(r);
    if (top) {
      // Directly above the first action button (Like), centred on its column.
      return css(btn, {
        left: `${top.left + top.width / 2 - BTN_SIZE / 2}px`,
        top: `${top.top - BTN_SIZE - LABEL_H - 4 - 16}px`,
      });
    }
    // No action column (feed, watch page): sit just outside the video's right edge,
    // or inside its top-right corner when there is no room.
    const outside = r.right + 12 + BTN_SIZE <= innerWidth;
    css(btn, {
      left: `${outside ? r.right + 12 : Math.min(r.right, innerWidth) - BTN_SIZE - 12}px`,
      top: `${Math.max(r.top, 0) + 12}px`,
    });
  }

  let keySeq = 0;
  function tick() {
    ensureLayer();
    for (const [el, btn] of buttons) {
      if (!el.isConnected) {
        btn.remove();
        buttons.delete(el);
      }
    }
    for (const el of document.querySelectorAll('video')) {
      const r = el.getBoundingClientRect();
      const visible = r.width >= 140 && r.height >= 100 && visibleArea(r) > 140 * 100;
      let btn = buttons.get(el);
      if (!visible) {
        if (btn) btn.style.display = 'none';
        continue;
      }
      if (!btn) {
        btn = makeButton(el);
        btn.dataset.key = String(++keySeq);
        buttons.set(el, btn);
      }
      if (btn.parentNode !== layer) layer.append(btn);
      btn.style.display = 'flex';
      placeButton(btn, r);
      renderButtonState(btn, fiberVideoId(el));
    }
  }

  function closeMenu() {
    menu?.remove();
    menu = null;
  }

  function menuItem(text, { onClick, muted, bold } = {}) {
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
        onClick();
      });
    }
    return item;
  }

  function openMenu(btn, el) {
    closeMenu();
    const id = fiberVideoId(el) || urlVideoId();
    const v = id && videos.get(id);
    const opts = v ? buildOptions(plain(v)) : [];

    menu = css(document.createElement('div'), {
      position: 'fixed',
      width: '260px',
      maxHeight: '360px',
      boxSizing: 'border-box',
      overflowX: 'hidden',
      overflowY: 'auto',
      padding: '6px',
      background: '#242526',
      border: '1px solid #3a3b3c',
      borderRadius: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,.45)',
      pointerEvents: 'auto',
    });
    menu.dataset.owner = btn.dataset.key;
    stopAll(menu);

    if (!opts.length) {
      menu.append(menuItem('Chưa lấy được dữ liệu của video này. Hãy phát video, hoặc tải lại trang (F5) rồi thử lại.', { muted: true }));
    } else {
      const title = v.title.split('\n')[0];
      menu.append(menuItem(title ? (title.length > 70 ? title.slice(0, 70) + '…' : title) : `Video ${id}`, { muted: true }));
      opts.forEach((opt, i) =>
        menu.append(
          menuItem((i === 0 ? '★ ' : '') + opt.label, {
            bold: i === 0,
            onClick: () => {
              closeMenu();
              progress.set(id, { state: 'downloading', pct: 0, text: 'Đang tải…' });
              window.postMessage({ source: 'fdl-inject', type: 'download', job: makeJob(plain(v), opt) }, '*');
            },
          })
        )
      );
    }

    layer.append(menu);
    const r = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    const top = r.bottom + 6 + h > innerHeight ? Math.max(8, r.top - 6 - h) : r.bottom + 6;
    css(menu, { top: `${top}px`, left: `${Math.max(8, r.right - 260)}px` });
  }

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
  window.addEventListener('scroll', () => { closeMenu(); queueTick(); }, { passive: true, capture: true });
  window.addEventListener('resize', queueTick, { passive: true });
  setInterval(tick, 500);

  // ===================== Messages from content.js =====================

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'fdl-content') return;
    if (e.data.type === 'rescan') {
      scanScripts(document);
      postList();
    } else if (e.data.type === 'progress') {
      const { videoId, state, pct, text } = e.data;
      progress.set(videoId, { state, pct, text });
      if (state === 'done') setTimeout(() => progress.get(videoId)?.state === 'done' && progress.delete(videoId), 4000);
      tick();
    }
  });
})();
