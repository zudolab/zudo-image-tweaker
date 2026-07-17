import { removeBackground, alphaTrim, composeProductPhoto } from '@takazudo/zudo-image-tweaker/product-photo';

const cutout = await removeBackground('./product.jpg');
const trimmed = await alphaTrim(cutout);
const { buffer, width, height } = await composeProductPhoto(trimmed, {
  background: { color: '#ffffff' },
  shadow: { mode: 'grounded' },
});

console.log(`${width}x${height}, ${buffer.length} bytes`);
