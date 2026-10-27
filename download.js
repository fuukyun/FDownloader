const $msg = document.getElementById('msg');
const $tracks = document.getElementById('tracks');

const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
let job = null;

function setMsg(text, cls = '') {
  $msg.textContent = text;
  $msg.className = cls;
}

// Mirrors progress onto the download button in the Facebook tab.
let lastReport = 0;
function report(state, pct, text) {
  if (!job?.tabId) return;
  const now = Date.now();
  if (state === 'downloading' && now - lastReport < 250) return;
  lastReport = now;
  chrome.tabs.sendMessage(job.tabId, { type: 'fdl:progress', progress: { videoId: job.videoId, state, pct, text } }).catch(() => {});
}

const totals = [];
function addTrack(name) {
  const el = document.createElement('div');
  el.className = 'track';
  el.innerHTML = '<div class="label"><span></span><span></span></div><div class="bar"><div></div></div>';
  el.querySelector('.label span').textContent = name;
  $tracks.append(el);
  const [, size] = el.querySelectorAll('.label span');
  const fill = el.querySelector('.bar > div');
  const t = { got: 0, total: 0 };
  totals.push(t);
  return (got, total) => {
    t.got = got;
    t.total = total;
    size.textContent = total ? `${fmtMB(got)} / ${fmtMB(total)}` : fmtMB(got);
    fill.style.width = total ? `${(got / total) * 100}%` : '100%';
    const sumTotal = totals.reduce((n, x) => n + x.total, 0);
    const sumGot = totals.reduce((n, x) => n + x.got, 0);
    if (sumTotal) report('downloading', Math.min(99, Math.floor((sumGot / sumTotal) * 100)), `Đang tải ${fmtMB(sumGot)}`);
  };
}

async function fetchBytes(url, onProgress) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${new URL(url).hostname}`);
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        URL.revokeObjectURL(url);
        return reject(new Error(chrome.runtime.lastError?.message || 'Không thể lưu file'));
      }
      // The blob URL must stay alive until Chrome finishes writing the file.
      const onChanged = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete' || d.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          URL.revokeObjectURL(url);
          d.state.current === 'complete' ? resolve() : reject(new Error('Tải xuống bị gián đoạn'));
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  });
}

async function closeSelf() {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
}

async function showSelf() {
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.update(tab.id, { active: true });
}

async function run() {
  const jobId = new URLSearchParams(location.search).get('job');
  job = (await chrome.storage.session.get(jobId))[jobId];
  if (!job) return setMsg('Không tìm thấy yêu cầu tải. Hãy thử lại.', 'err');
  chrome.storage.session.remove(jobId);
  document.getElementById('name').textContent = job.filename;
  document.title = `Đang tải – ${job.filename}`;

  const audioOnly = job.audioOnly;
  const pVideo = fetchBytes(job.videoUrl, addTrack(audioOnly ? 'Âm thanh' : 'Hình ảnh'));
  const pAudio = job.audioUrl ? fetchBytes(job.audioUrl, addTrack('Âm thanh')) : null;
  const [video, audio] = await Promise.all([pVideo, pAudio]);

  let blob;
  if (audio) {
    setMsg('Đang ghép hình và tiếng…');
    report('muxing', 100, 'Đang ghép hình và tiếng…');
    try {
      blob = FDLMux.mux(video, audio);
    } catch (e) {
      // Fall back to two separate files so the user still gets the content.
      console.error(e);
      setMsg(`Không ghép được (${e.message}). Đang lưu hình và tiếng thành 2 file riêng…`, 'err');
      const base = job.filename.replace(/\.mp4$/, '');
      await Promise.all([
        saveBlob(new Blob([video], { type: 'video/mp4' }), `${base} (video).mp4`),
        saveBlob(new Blob([audio], { type: 'audio/mp4' }), `${base} (audio).m4a`),
      ]);
      setMsg('Đã lưu 2 file riêng (video + audio). Có thể ghép bằng ffmpeg.', 'err');
      report('error', 100, 'Không ghép được, đã lưu 2 file riêng');
      showSelf();
      return;
    }
  } else {
    blob = new Blob([video], { type: audioOnly ? 'audio/mp4' : 'video/mp4' });
  }

  setMsg(`Đang lưu ${fmtMB(blob.size)}…`);
  await saveBlob(blob, job.filename);
  setMsg('✓ Hoàn tất! Bạn có thể đóng tab này.', 'ok');
  report('done', 100, 'Đã tải xong');
  if (job.autoClose) setTimeout(closeSelf, 800);
}

run().catch((e) => {
  console.error(e);
  setMsg('Lỗi: ' + e.message + '. Link video có thể đã hết hạn — hãy tải lại trang Facebook rồi thử lại.', 'err');
  report('error', 0, 'Lỗi: ' + e.message);
  showSelf();
});
