import { compositeBatch } from '@takazudo/zudo-image-tweaker/composite';

const results = await compositeBatch(
  [
    { ref: 'photo-1', image: './photo-1.jpg' },
    { ref: 'photo-2', image: './photo-2.jpg' },
  ],
  [{ ref: 'watermark', image: './watermark.png' }],
  { widthPercent: 15, paddingPercent: 4 },
);

for (const { baseRef, overlayRef, result } of results) {
  console.log(`${baseRef} + ${overlayRef}: ${result.width}x${result.height}`);
}
