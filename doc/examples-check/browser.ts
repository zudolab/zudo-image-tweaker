import { prepareImageForUpload } from '@takazudo/zudo-image-tweaker/browser';

async function handleFileSelect(file: File) {
  const { file: uploadFile, width, height, orientation, transcodedFromHeic } =
    await prepareImageForUpload(file);

  console.log(`${width}x${height} ${orientation}, transcoded from HEIC: ${transcodedFromHeic}`);
  return uploadFile;
}
