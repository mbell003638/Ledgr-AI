/**
 * Minimal typings for the `qrcode` package, which ships no declarations.
 *
 * Added because sync-settings renders its pairing QR with qrcode plus
 * react-native-svg -- the two libraries the app already depends on -- rather
 * than pulling in react-native-qrcode-svg for one screen.
 */
declare module 'qrcode' {
  export type QRCodeErrorCorrectionLevel = 'low' | 'medium' | 'quartile' | 'high' | 'L' | 'M' | 'Q' | 'H';

  export type QRCodeToStringOptions = {
    type?: 'svg' | 'utf8' | 'terminal';
    margin?: number;
    scale?: number;
    width?: number;
    errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
    color?: { dark?: string; light?: string };
  };

  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
  export function toDataURL(text: string, options?: QRCodeToStringOptions): Promise<string>;

  const QRCode: { toString: typeof toString; toDataURL: typeof toDataURL };
  export default QRCode;
}
