import {
  calibrateTargetFromSamples,
  normalizeBackgroundColor,
} from '@takazudo/zudo-image-tweaker/calibrate';

const target = await calibrateTargetFromSamples(['./ref-1.jpg', './ref-2.jpg', './ref-3.jpg']);
const { buffer, applied } = await normalizeBackgroundColor('./new-photo.jpg', { target });

console.log(`scale r${applied.scaleR} g${applied.scaleG} b${applied.scaleB}, ${buffer.length} bytes`);
