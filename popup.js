const { buildOptions, makeJob } = FDLOptions;
const $status = document.getElementById('status');
const $list = document.getElementById('list');

const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

function startDownload(v, opt, tabId) {
  chrome.runtime.sendMessage({ type: 'fdl:download', job: makeJob(v, opt), tabId });
  window.close();
}

function render(data, tabId) {
  $list.textContent = '';
  const v = (data.videos || []).find((x) => x.id === data.currentId);
  const opts = v ? buildOptions(v) : [];
  if (!opts.length) {
    $status.textContent = 'Chưa thấy video đang xem. Hãy phát video rồi bấm ⟳, hoặc tải lại trang (F5).';
    return;
  }
  $status.textContent = 'Mẹo: có thể bấm nút tải ngay góc trên bên phải video.';

  const li = document.createElement('li');
  li.className = 'current';

  const img = document.createElement('img');
  img.className = 'thumb';
  if (v.thumb) img.src = v.thumb;
  img.alt = '';

  const info = document.createElement('div');
  info.className = 'info';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = v.title || `Video ${v.id}`;
  title.title = title.textContent;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const best = document.createElement('span');
  best.className = 'badge';
  best.textContent = opts[0].label.split(' · ')[0];
  meta.append(best, ` ${fmtDur(v.duration)}`);

  const row = document.createElement('div');
  row.className = 'row';
  const select = document.createElement('select');
  opts.forEach((o, i) => select.add(new Option(o.label, i)));
  const btn = document.createElement('button');
  btn.className = 'dl';
  btn.textContent = 'Tải';
  btn.onclick = () => startDownload(v, opts[select.value], tabId);
  row.append(select, btn);

  info.append(title, meta, row);
  li.append(img, info);
  $list.append(li);
}

async function load() {
  $status.textContent = 'Đang tìm video…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (/^https:\/\/(www|m)\.youtube\.com\//.test(tab?.url || '')) {
    $status.textContent = 'Trên YouTube, hãy bấm nút tải ở góc trên bên phải video (hoặc phía trên nút Thích trên Shorts).';
    $list.textContent = '';
    return;
  }
  if (!tab?.url || !/^https:\/\/([a-z0-9-]+\.)*facebook\.com\//.test(tab.url)) {
    $status.textContent = 'Hãy mở một trang Facebook có video.';
    $list.textContent = '';
    return;
  }
  try {
    render(await chrome.tabs.sendMessage(tab.id, { type: 'fdl:list' }), tab.id);
  } catch {
    $status.textContent = 'Extension chưa chạy trên tab này. Hãy tải lại trang (F5).';
  }
}

document.getElementById('refresh').onclick = load;
load();
