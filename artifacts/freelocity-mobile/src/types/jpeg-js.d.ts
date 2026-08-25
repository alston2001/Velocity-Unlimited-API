declare module 'jpeg-js' {
  export type DecodeResult = {
    data: Uint8Array;
    width: number;
    height: number;
  };

  export function decode(
    input: Uint8Array,
    options?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ): DecodeResult;

  const jpeg: { decode: typeof decode };
  export default jpeg;
}