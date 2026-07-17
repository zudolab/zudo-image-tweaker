import { encodeImageToBlurhash, blurhashToDataUri } from '@takazudo/zudo-image-tweaker/blurhash';

const hash = await encodeImageToBlurhash('./photo.jpg');
const placeholder = await blurhashToDataUri(hash, { size: 24 });

console.log(hash, placeholder.slice(0, 40));
