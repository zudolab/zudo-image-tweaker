// heic-decode ships no type declarations (plain CommonJS, no `types` field
// in its package.json, no @types package). This mirrors only the shape
// this module actually consumes: the default export's single-image decode.
declare module 'heic-decode' {
  interface HeicDecodeInput {
    buffer: Buffer | Uint8Array;
  }

  interface HeicDecodeResult {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }

  export default function decode(input: HeicDecodeInput): Promise<HeicDecodeResult>;
}
