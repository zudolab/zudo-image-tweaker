import { readFile } from 'node:fs/promises';
import { bakeOrientation, deriveOrientation, parseExifDate } from '@takazudo/zudo-image-tweaker/exif';

const source = await readFile('./photo.jpg');
const upright = await bakeOrientation(source);
const orientation = deriveOrientation(3024, 4032);
const takenAt = parseExifDate(Buffer.from('2026:03:10 08:15:22'));

console.log(orientation, takenAt?.toISOString(), upright.length);
