import { generateSmartOgp } from '@takazudo/zudo-image-tweaker/ogp';

const result = await generateSmartOgp('./cover.jpg', {
  outPath: './public/og/cover.jpg',
  landscapeThreshold: 1.5,
});

console.log(`${result.method}: ${result.width}x${result.height}, wrote to ${result.path}`);
