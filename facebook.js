// Runs in the page's MAIN world on Facebook. Collects video data from the embedded JSON
// and GraphQL responses; the button itself is drawn by ui.js.
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

  // The most visible video on screen; falls back to the id in the URL.
  function currentVideoId() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('video')) {
      const area = FDLUI.visibleArea(el.getBoundingClientRect());
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return (best && fiberVideoId(best)) || urlVideoId();
  }

  // ===================== On-page download button =====================

  FDLUI.init({
    videoSelector: 'video',
    actionSelector: '[role="button"]',
    buttonBg: 'rgba(255,255,255,.12)',
    accent: '#1877f2',
    getId: fiberVideoId,
    buildMenu(el) {
      const id = fiberVideoId(el) || urlVideoId();
      const v = id && videos.get(id);
      const opts = v ? buildOptions(plain(v)) : [];
      if (!opts.length)
        return [{ text: 'Chưa lấy được dữ liệu của video này. Hãy phát video, hoặc tải lại trang (F5) rồi thử lại.', muted: true }];
      const title = v.title.split('\n')[0];
      return [
        { text: title ? (title.length > 70 ? title.slice(0, 70) + '…' : title) : `Video ${id}`, muted: true },
        ...opts.map((opt, i) => ({
          text: (i === 0 ? '★ ' : '') + opt.label,
          bold: i === 0,
          onClick: () => {
            FDLUI.setProgress(id, { state: 'downloading', pct: 0, text: 'Đang tải…' });
            window.postMessage({ source: 'fdl-inject', type: 'download', job: makeJob(plain(v), opt) }, '*');
          },
        })),
      ];
    },
  });

  // ===================== Messages from content.js =====================

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'fdl-content') return;
    if (e.data.type === 'rescan') {
      scanScripts(document);
      postList();
    } else if (e.data.type === 'progress') {
      const { videoId, state, pct, text } = e.data;
      FDLUI.setProgress(videoId, { state, pct, text });
    }
  });
})();
