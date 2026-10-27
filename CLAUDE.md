# FDownloader

Extension Chrome/Edge (Manifest V3) tải video Facebook và YouTube ở chất lượng cao nhất. JavaScript thuần, không build step, không dependency. Sửa file xong thì reload extension ở `chrome://extensions` và F5 tab Facebook/YouTube.

## Kiến trúc

Hai trang dùng chung một nút tải (`ui.js`) nhưng logic lấy video khác hẳn nhau:
- **Facebook:** `facebook.js` (trang) → `content.js` (bridge) → `background.js` → `download.html` → `chrome.downloads`.
- **YouTube:** mọi thứ chạy trong `youtube.js` ở trang: ghi dữ liệu từ `MediaSource` → `mux.js` → lưu bằng `<a download>`. Không đi qua `content.js`/`background.js`/`download.html`.

| File | Chạy ở | Vai trò |
|---|---|---|
| `ui.js` | MAIN world (cả 2 trang) | Nút tải + menu + hiển thị tiến độ. Trang cung cấp adapter qua `FDLUI.init({...})`, báo tiến độ qua `FDLUI.setProgress(id, {state, pct, text})` |
| `options.js` | MAIN world + popup | Dùng chung: `buildOptions(video)` tạo danh sách chất lượng Facebook (tốt nhất đứng đầu), `makeJob()` tạo job + tên file, `sanitize()` làm sạch tên file |
| `facebook.js` | MAIN world Facebook, `document_start` | Thu thập dữ liệu video Facebook, adapter cho `ui.js` |
| `youtube.js` | MAIN world YouTube, `document_start` | Ghi dữ liệu từ trình phát, tua để tải hết, ghép + lưu file, adapter cho `ui.js` |
| `content.js` | Isolated world Facebook | Chuyển tiếp `window.postMessage` ↔ `chrome.runtime` |
| `background.js` | Service worker | Nhận `fdl:download`, lưu job vào `chrome.storage.session`, mở tab `download.html?job=<id>` |
| `download.js` + `mux.js` | Trang extension | Tải luồng Facebook, ghép hình + tiếng, lưu file, báo tiến độ về tab Facebook (`fdl:progress`) |
| `mux.js` | Trang extension + MAIN world YouTube | Ghép 2 file fMP4 thành 1 MP4 |
| `popup.*` | Popup | Facebook: chỉ hiện video đang xem (`currentId`), là đường phụ bên cạnh nút trên trang. YouTube: chỉ hướng dẫn bấm nút trên trang |

Giao thức message (chỉ Facebook):
- `postMessage` dùng `source: 'fdl-inject' | 'fdl-content'`.
- `chrome.runtime` dùng `type: 'fdl:list' | 'fdl:download' | 'fdl:progress'`.

## Những điều không hiển nhiên

### Facebook

**Nguồn dữ liệu video** (`facebook.js`)
- Lấy từ `<script type="application/json">` trong HTML, cộng với việc hook `fetch`/XHR cho `/api/graphql`. GraphQL có thể trả nhiều JSON mỗi dòng, và có thể có tiền tố `for (;;);`.
- `walk()` duyệt toàn bộ cây JSON và mang theo 2 ngữ cảnh: `ctx` là ID video gần nhất phía trên, `caption` là `message.text` của bài viết bọc ngoài, dùng làm tên file.
- Các trường đang dùng:
  - `all_video_dash_prefetch_representations[].representations[]` (`base_url`, `mime_type`, `codecs`, `bandwidth`, `width`, `height`)
  - chuỗi DASH MPD (`<MPD`, có `FBQualityLabel`)
  - `browser_native_hd_url` / `_sd_url`
  - `progressive_urls[]`
  - `creation_story.message.text`
- Cấu trúc này do Facebook quyết định và hay thay đổi. Khi hỏng, lấy HTML/response thật rồi chạy `walk()` trên đó để tìm đường dẫn mới.
- MPD được parse bằng regex, không dùng `DOMParser`, vì Trusted Types của Facebook có thể chặn nó. Khi tạo UI trong trang (cả `ui.js`), cũng không dùng `innerHTML`: chỉ dùng `createElement`/`createElementNS` + `element.style`. YouTube cũng bật Trusted Types.
- Phải bỏ `bytestart`/`byteend` khỏi URL fbcdn thì mới tải được cả file.
- Một thẻ `<script>` có thể bị quét khi parser chưa nạp xong nội dung. Vì vậy `scanScripts` nhớ độ dài text đã đọc (không phải chỉ nhớ "đã đọc") để quét lại khi nội dung dài thêm.

**Map thẻ `<video>` → ID video**
- Đọc React fiber: `el.__reactFiber$*`, đi ngược lên qua `.return`, tìm `memoizedProps.coreVideoPlayerMetaData.videoFBID`. Biến `__reactFiber$*` chỉ thấy được trong MAIN world, nên logic này phải nằm trong `facebook.js`.
- Nếu không tìm được, dùng ID trong URL (`/reel/`, `/videos/`, `?v=`).

### YouTube (`youtube.js`)

**Vì sao không tải theo URL như Facebook**
- `ytInitialPlayerResponse.streamingData.adaptiveFormats` của web client không có `url` lẫn `signatureCipher`, chỉ có `serverAbrStreamingUrl` (giao thức SABR: request protobuf + PO token).
- Các cách lấy URL trực tiếp (giả làm client Android/iOS/TV, giải mã chữ ký/`n`, PO token) là vượt cơ chế chống bot của YouTube. **Không dùng các cách này.**
- Thay vào đó: hook `MediaSource.prototype.addSourceBuffer`, `SourceBuffer.prototype.appendBuffer`/`abort` để chép lại các byte fMP4 mà trình phát nạp vào. Nhờ vậy không cần gọi API riêng.

**Ghi dữ liệu**
- Ẩn WebM và AV1 bằng cách patch `MediaSource.isTypeSupported`, `canPlayType` và `MediaCapabilities.decodingInfo` (từ chối `webm|vp9|opus|av01`). Trình phát khi đó chọn H.264 + AAC trong fMP4, là thứ `mux.js` ghép được và mở được ở mọi trình phát (file AV1 mở bằng trình phát của Windows chỉ có tiếng, không có hình). Hệ quả: tối đa 1080p.
- Trong menu có mục bật AV1 (lưu `localStorage['fdl-yt-av1']`, tải lại trang vì player chỉ chọn codec lúc nạp) để có 1440p/4K. Tên file có thêm ` AV1` khi track hình là `av01`.
- Một lần `appendBuffer` có thể cắt ngang box. `feed()` giữ phần đuôi chưa trọn (`pending`) cho lần sau. `abort()` thì xóa phần đó.
- Init segment (`ftyp`+`moov`) → `describe()` lấy codec, kích thước (video) hoặc số kênh (audio), timescale, default duration từ `trex`. Key của track là `kind|codec|w|h|channels|timescale`.
- Mỗi fragment (`moof`+`mdat`) được lưu theo `tfdt`, nên trùng lặp khi tua sẽ tự loại. Thời lượng tính từ `trun` (hoặc default duration của `tfhd`/`trex`).
- ID video lấy lúc nạp: `<video>` có `src` trùng blob URL của MediaSource (hook `URL.createObjectURL`) → `.closest('.html5-video-player').getVideoData().video_id`. Bỏ qua khi player có class `ad-showing` (quảng cáo).
- Codec `encv`/`enca` → video có DRM, đánh dấu `rec.drm` và không ghi.
- Chỉ giữ dữ liệu của 3 video gần nhất (dữ liệu nặng, nằm trong RAM của tab).

**Thu toàn bộ video** (`runCapture`)
- Khóa chất lượng bằng `player.setPlaybackQualityRange(q, q)` (API nội bộ của player). Nếu sau 15s vẫn chưa có track đúng chiều cao, nhận track mà player đang phát.
- Mỗi khi có dữ liệu mới: tính `coveredUntil` (cuối đoạn liên tục tính từ 0) của cả hình và tiếng, rồi `player.seekTo()` tới chỗ thiếu đầu tiên. Player sẽ tải tiếp ngay chỗ đó. Vòng lặp được kích bởi chính hook `appendBuffer`, cộng thêm `setInterval` 300ms, vì timer bị throttle khi tab ở nền.
- Xong khi cả hai track phủ tới `duration - 0.5s`, hoặc phủ tới `duration - 2s` và 8s không có dữ liệu mới. Lỗi nếu 45s không có dữ liệu mới. Sau đó khôi phục vị trí, trạng thái tạm dừng và tiếng.
- Lưu file bằng `<a download>` với blob URL của trang. Khi ghép, bỏ các fragment chồng lên đoạn đã có.

### Nút tải trên trang (`ui.js`)
- Nút **không được đè lên video**. Có 2 kiểu đặt:
  - **inline**: adapter có `mount(el, btn)` tự chèn nút vào DOM của trang và trả `true`. YouTube `/watch` dùng kiểu này: nút là phần tử đầu của `ytd-watch-metadata #actions ytd-menu-renderer` (hàng Like/Share), dạng nút tròn dài theo màu `--yt-spec-*`.
  - **nổi**: layer `position: fixed` gắn vào `body` (`#fdl-layer`), không chèn vào DOM của React. Vị trí được tính lại mỗi 500ms và khi scroll/resize (giới hạn theo rAF).
- Kiểu nổi trên Reels/Shorts: nút được đặt phía trên cột Like/Comment/Share. Cột này tìm theo hình học: các phần tử khớp `actionSelector` cỡ 28–64px, mép trái thẳng hàng, nằm trong khoảng 160px bên phải video. Facebook dùng `[role="button"]`. YouTube dùng `button`, nhưng chỉ khi ở `/shorts/`, vì trên trang watch bên phải video là danh sách đề xuất. Không dựa vào `aria-label` vì nó đổi theo ngôn ngữ. Bỏ qua chính nút của mình (`.fdl-btn`), vì trên YouTube nó cũng là `button` nằm cùng cột. Nếu không, mỗi tick nút lại tự đẩy mình lên trên, gây nhảy liên tục.
- Nếu không có cột nút: thử lần lượt ngoài mép phải → ngoài mép trái → phía trên → phía dưới video. Không còn chỗ nào thì ẩn nút.
- Menu ưu tiên mở xuống dưới nút (co `maxHeight` cho vừa). Chỉ lật lên khi bên dưới còn chưa tới 160px.
- Sự kiện scroll đóng menu, trừ khi chính menu đang cuộn (`menu.contains(e.target)`). Menu có `overscrollBehavior: contain`.
- Nút và menu phải `stopPropagation` các sự kiện chuột, nếu không trang sẽ pause video hoặc điều hướng đi chỗ khác.

### Chất lượng và ghép file
- Facebook: từ 1080p trở lên chỉ có ở DASH, gồm một luồng hình (không tiếng) và một luồng tiếng riêng. Bản progressive (có sẵn tiếng) thường chỉ tới 720p.
- Codec phụ thuộc vào trình duyệt/phiên: Facebook có thể phục vụ AV1, VP9 hoặc H.264; YouTube (sau khi ẩn WebM) là AV1 hoặc H.264. File AV1 có thể không mở được trong trình phát mặc định của Windows nếu thiếu AV1 Video Extension.
- `mux.js` ghép 2 file fMP4 thành một MP4 có 2 track mà không encode lại, các bước:
  - đổi track_ID thành 1 và 2 (`tkhd`, `trex`, `tfhd`)
  - đánh số lại `mfhd`
  - xếp xen kẽ các fragment theo `tfdt`
  - bỏ `sidx`/`mehd`
  - rebase `base_data_offset` nếu có
  - chuyển duration của `tkhd`/`elst` sang timescale của `mvhd` file hình, và đặt duration của edit cuối trong `elst` về 0. Nếu giữ duration thật, trình phát của Windows (Media Foundation) báo "unsupported" với file H.264 từ YouTube.
- Nếu ghép lỗi, cả `download.js` (Facebook) lẫn `youtube.js` đều lưu thành 2 file riêng.
- Facebook: blob URL phải sống đến khi `chrome.downloads` báo `complete`, nên tab tải chỉ đóng sau thời điểm đó (`autoClose` khi job đến từ nút trên trang). YouTube: blob URL được thu hồi sau 2 phút.

## Kiểm thử

Chưa có test suite trong repo. Cách đã dùng để kiểm chứng:
- **Logic thuần** (`mux.js`, `walk()` trong `facebook.js`): chạy bằng Node, stub `window`/`document`, đưa vào fMP4 tổng hợp hoặc HTML thật (`curl` một URL reel công khai kèm User-Agent trình duyệt). Luồng video/audio thật của Facebook tải được bằng `curl` mà không cần cookie.
- **End-to-end**: dùng `puppeteer-core` với Edge (`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`) và cờ `--load-extension=<repo> --disable-extensions-except=<repo> --disable-features=DisableLoadExtensionCommandLineSwitch`, `headless: false`. Với YouTube nên thêm `--autoplay-policy=no-user-gesture-required`.
  - ID extension lấy từ `Runtime.executionContextCreated` (origin `chrome-extension://…`).
  - Thư mục tải đặt qua `Default/Preferences` (`download.default_directory`), không dùng `Browser.setDownloadBehavior`, vì cách đó đổi tên file thành GUID.
  - Kiểm tra phát được bằng cách mở file qua `file:///` rồi đọc `webkitVideoDecodedByteCount` / `webkitAudioDecodedByteCount`.
- Facebook mới chỉ test khi **chưa đăng nhập**. Giao diện khi đã đăng nhập (news feed, cột nút Reels) có thể khác.
- YouTube: đã thử tay trên trang watch (nút inline, menu, dữ liệu được ghi ở 1080p). **Chưa** kiểm chứng end-to-end việc thu toàn bộ video → file phát được. Vị trí nút trên Shorts cũng chưa kiểm chứng.

## Quy ước

- Text hiển thị cho người dùng viết bằng tiếng Việt.
- Không thêm thư viện ngoài. Extension phải load unpacked được ngay, không cần build.
