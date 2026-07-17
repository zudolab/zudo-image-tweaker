import { convertHeifToJpeg } from '@takazudo/zudo-image-tweaker/heif';

const { buffer, width, height, iccApplied } = await convertHeifToJpeg('./photo.heic', {
  quality: 90,
});

console.log(`${width}x${height}, icc applied: ${iccApplied}, ${buffer.length} bytes`);
