# FDownloader

Extension Chrome/Edge (Manifest V3) để tải video **Facebook** và **YouTube** với chất lượng cao nhất.

## Cài đặt
1. Mở `chrome://extensions` (hoặc `edge://extensions`), bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục này.
3. Tải lại (F5) các tab Facebook / YouTube đang mở.

## Sử dụng

### Facebook
1. Mở video / reel / bài viết có video (nên bấm phát video).
2. Bấm nút **Tải** cạnh video (trên Reels: phía trên nút Thích) → chọn chất lượng.
   Hoặc bấm biểu tượng FDownloader trên thanh công cụ → chọn chất lượng → **Tải**.
3. Một tab chạy nền tải và ghép file; nút hiện % tiến độ. File được lưu vào thư mục Downloads.

### YouTube
1. Mở video (`/watch`) hoặc Shorts.
2. Bấm nút **Tải** trong hàng nút dưới video (trên Shorts: phía trên nút Thích) → chọn chất lượng.
3. Extension tự tua video để trình phát tải hết dữ liệu (video bị tắt tiếng trong lúc này),
   rồi ghép và lưu file. **Giữ tab mở** cho tới khi nút báo "✓ Xong".
4. Nếu đã xem hết video ở một chất lượng, có thể chọn **Lưu phần đã xem** để lưu ngay mà không cần tua lại.

Giới hạn trên YouTube:
- Không hỗ trợ video đang phát trực tiếp và video có DRM (phim thuê/mua).
- Chất lượng cao nhất phụ thuộc video: tới 4K nếu video có bản AV1, nếu không thì tối đa 1080p (H.264).
- File AV1 có thể cần cài **AV1 Video Extension** để mở bằng trình phát mặc định của Windows.

## Cách hoạt động
- **Facebook:** `facebook.js` (chạy trong trang) đọc JSON nhúng sẵn trong HTML và chặn các phản hồi GraphQL
  để lấy DASH manifest (các luồng 1080p/720p/... chỉ có hình, và luồng chỉ có tiếng)
  cùng link progressive HD/SD (có sẵn tiếng, thường tối đa 720p).
  `download.js` tải song song luồng hình tốt nhất + luồng tiếng tốt nhất, rồi `mux.js` ghép thành một file MP4.
- **YouTube:** trình phát web của YouTube không còn để lộ link tải trực tiếp, nên `youtube.js` ghi lại
  dữ liệu mà chính trình phát nạp vào (`MediaSource`), tua video để trình phát tải hết, rồi `mux.js` ghép
  hình + tiếng ngay trong trang.
- Ghép file không encode lại, giữ nguyên chất lượng. Nếu ghép thất bại, extension lưu 2 file riêng để bạn ghép bằng
  `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`.

Chỉ dùng để tải video bạn có quyền lưu trữ.
