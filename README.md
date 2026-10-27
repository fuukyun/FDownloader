# FDownloader

Extension Chrome/Edge (Manifest V3) để tải video Facebook với chất lượng cao nhất.

## Cài đặt
1. Mở `chrome://extensions` (hoặc `edge://extensions`), bật **Developer mode**.
2. Bấm **Load unpacked** → chọn thư mục này.
3. Tải lại (F5) các tab Facebook đang mở.

## Sử dụng
1. Mở video / reel / bài viết có video trên Facebook (nên bấm phát video).
2. Bấm biểu tượng FDownloader → chọn chất lượng → **Tải**.
3. Một tab mới hiện tiến trình; file được lưu vào thư mục Downloads.

## Cách hoạt động
- `inject.js` (chạy trong trang) đọc JSON nhúng sẵn trong HTML và chặn các phản hồi GraphQL
  để lấy DASH manifest (các luồng 1080p/720p/... chỉ có hình, và luồng chỉ có tiếng)
  cùng link progressive HD/SD (có sẵn tiếng, thường tối đa 720p).
- Chất lượng cao nhất nằm ở luồng DASH, nên `download.js` tải song song luồng hình tốt nhất
  + luồng tiếng tốt nhất, rồi `mux.js` ghép thành một file MP4 (không encode lại, giữ nguyên chất lượng).
- Nếu ghép thất bại, extension lưu 2 file riêng để bạn ghép bằng
  `ffmpeg -i video.mp4 -i audio.m4a -c copy out.mp4`.

Chỉ dùng để tải video bạn có quyền lưu trữ.
