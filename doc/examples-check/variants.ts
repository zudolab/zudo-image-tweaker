import { processImages, photoVariantsPreset } from '@takazudo/zudo-image-tweaker/variants';

const summary = await processImages({
  ...photoVariantsPreset,
  inputDir: './photos',
  outputDir: './public/photos',
  onMetadata: async (record) => {
    console.log(record.slug, record.width, record.height, record.blurhash);
  },
});

console.log(`processed ${summary.results.length}, failed ${summary.failed.length}`);
