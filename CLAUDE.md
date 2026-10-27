# FDownloader

Extension Chrome/Edge (Manifest V3) tải video Facebook ở chất lượng cao nhất. JavaScript thuần, không build step, không dependency. Sửa file xong thì reload extension ở `chrome://extensions` và F5 tab Facebook.

## Kiến trúc

Luồng dữ liệu: `inject.js` (trang) → `content.js` (bridge) → `background.js` → `download.html` → `chrome.downloads`.

| File | Chạy ở | Vai trò |
|---|---|---|
| `options.js` | MAIN world + popup | Dùng chung: `buildOptions(video)` tạo danh sách chất lượng (tốt nhất đứng đầu), `makeJob()` tạo job + tên file |
| `inject.js` | MAIN world, `document_start` | Thu thập dữ liệu video + vẽ nút tải trên trang |
| `content.js` | Isolated world | Chuyển tiếp `window.postMessage` ↔ `chrome.runtime` |
| `background.js` | Service worker | Nhận `fdl:download`, lưu job vào `chrome.storage.session`, mở tab `download.html?job=<id>` |
| `download.js` + `mux.js` | Trang extension | Tải luồng, ghép hình + tiếng, lưu file, báo tiến độ về tab Facebook (`fdl:progress`) |
| `popup.*` | Popup | Chỉ hiện video đang xem (`currentId`), là đường phụ bên cạnh nút trên trang |

Giao thức message:
- `postMessage` dùng `source: 'fdl-inject' | 'fdl-content'`.
- `chrome.runtime` dùng `type: 'fdl:list' | 'fdl:download' | 'fdl:progress'`.

## Những điều không hiển nhiên

**Nguồn dữ liệu video** (`inject.js`)
- Lấy từ `<script type="application/json">` trong HTML, cộng với việc hook `fetch`/XHR cho `/api/graphql`. GraphQL có thể trả nhiều JSON mỗi dòng, và có thể có tiền tố `for (;;);`.
- `walk()` duyệt toàn bộ cây JSON và mang theo 2 ngữ cảnh: `ctx` là ID video gần nhất phía trên, `caption` là `message.text` của bài viết bọc ngoài, dùng làm tên file.
- Các trường đang dùng:
  - `all_video_dash_prefetch_representations[].representations[]` (`base_url`, `mime_type`, `codecs`, `bandwidth`, `width`, `height`)
  - chuỗi DASH MPD (`<MPD`, có `FBQualityLabel`)
  - `browser_native_hd_url` / `_sd_url`
  - `progressive_urls[]`
  - `creation_story.message.text`
- Cấu trúc này do Facebook quyết định và hay thay đổi. Khi hỏng, lấy HTML/response thật rồi chạy `walk()` trên đó để tìm đường dẫn mới.
- MPD được parse bằng regex, không dùng `DOMParser`, vì Trusted Types của Facebook có thể chặn nó. Khi tạo UI trong trang, cũng không dùng `innerHTML`: chỉ dùng `createElement`/`createElementNS` + `element.style`.
- Phải bỏ `bytestart`/`byteend` khỏi URL fbcdn thì mới tải được cả file.
- Một thẻ `<script>` có thể bị quét khi parser chưa nạp xong nội dung. Vì vậy `scanScripts` nhớ độ dài text đã đọc (không phải chỉ nhớ "đã đọc") để quét lại khi nội dung dài thêm.

**Map thẻ `<video>` → ID video**
- Đọc React fiber: `el.__reactFiber$*`, đi ngược lên qua `.return`, tìm `memoizedProps.coreVideoPlayerMetaData.videoFBID`. Biến `__reactFiber$*` chỉ thấy được trong MAIN world, nên logic này phải nằm trong `inject.js`.
- Nếu không tìm được, dùng ID trong URL (`/reel/`, `/videos/`, `?v=`).

**Nút tải trên trang**
- Nằm trong một layer `position: fixed` gắn vào `body` (`#fdl-layer`), không chèn vào DOM của React. Vị trí được tính lại mỗi 500ms và khi scroll/resize (giới hạn theo rAF).
- Trên Reels, nút được đặt phía trên cột Like/Comment/Share. Cột này tìm theo hình học: các `[role="button"]` cỡ 28–64px, mép trái thẳng hàng, nằm trong khoảng 160px bên phải video. Không dựa vào `aria-label` vì nó đổi theo ngôn ngữ.
- Nếu không có cột nút: đặt ngoài mép phải video, hoặc ở góc trong video nếu không đủ chỗ.
- Nút và menu phải `stopPropagation` các sự kiện chuột, nếu không Facebook sẽ pause video hoặc điều hướng đi chỗ khác.

**Chất lượng và ghép file**
- Từ 1080p trở lên chỉ có ở DASH, gồm một luồng hình (không tiếng) và một luồng tiếng riêng. Bản progressive (có sẵn tiếng) thường chỉ tới 720p.
- Codec phụ thuộc vào trình duyệt/phiên mà Facebook phục vụ: có thể là AV1, VP9 hoặc H.264. File AV1 có thể không mở được trong trình phát mặc định của Windows nếu thiếu AV1 Video Extension.
- `mux.js` ghép 2 file fMP4 thành một MP4 có 2 track mà không encode lại, các bước:
  - đổi track_ID thành 1 và 2 (`tkhd`, `trex`, `tfhd`)
  - đánh số lại `mfhd`
  - xếp xen kẽ các fragment theo `tfdt`
  - bỏ `sidx`/`mehd`
  - rebase `base_data_offset` nếu có
- Nếu ghép lỗi, `download.js` lưu thành 2 file riêng.
- Blob URL phải sống đến khi `chrome.downloads` báo `complete`, nên tab tải chỉ đóng sau thời điểm đó (`autoClose` khi job đến từ nút trên trang).

## Kiểm thử

Chưa có test suite trong repo. Cách đã dùng để kiểm chứng:
- **Logic thuần** (`mux.js`, `walk()` trong `inject.js`): chạy bằng Node, stub `window`/`document`, đưa vào fMP4 tổng hợp hoặc HTML thật (`curl` một URL reel công khai kèm User-Agent trình duyệt). Luồng video/audio thật tải được bằng `curl` mà không cần cookie.
- **End-to-end**: dùng `puppeteer-core` với Edge (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`) và cờ `--load-extension=<repo> --disable-extensions-except=<repo> --disable-features=DisableLoadExtensionCommandLineSwitch`, `headless: false`.
  - ID extension lấy từ `Runtime.executionContextCreated` (origin `chrome-extension://…`).
  - Thư mục tải đặt qua `Default/Preferences` (`download.default_directory`), không dùng `Browser.setDownloadBehavior`, vì cách đó đổi tên file thành GUID.
  - Kiểm tra phát được bằng cách mở file qua `file:///` rồi đọc `webkitVideoDecodedByteCount` / `webkitAudioDecodedByteCount`.
- Mới chỉ test khi **chưa đăng nhập**. Giao diện khi đã đăng nhập (news feed, cột nút Reels) có thể khác.

## Quy ước

- Text hiển thị cho người dùng viết bằng tiếng Việt.
- Không thêm thư viện ngoài. Extension phải load unpacked được ngay, không cần build.
