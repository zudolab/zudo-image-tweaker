import { readFile } from 'node:fs/promises';
import { trimPadSquare } from '@takazudo/zudo-image-tweaker/square';

const source = await readFile('./product.png');
const { buffer, width, height } = await trimPadSquare(source, {
  margin: 0.08,
  background: { r: 255, g: 255, b: 255, alpha: 1 },
});

console.log(`${width}x${height}, ${buffer.length} bytes`);
