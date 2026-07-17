import { encodeUnderByteBudget } from '@takazudo/zudo-image-tweaker/budget';

const result = await encodeUnderByteBudget('./photo.jpg', { maxBytes: 200_000 });

if (result.ok) {
  console.log(`${result.format} @ ${result.width}px, ${result.bytes} bytes, quality ${result.quality}`);
} else {
  console.warn(`could not fit budget: ${result.reason}`);
}
