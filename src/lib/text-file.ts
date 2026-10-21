import { readFileSync } from 'node:fs';

/**
 * Decode a buffer that may start with a Unicode BOM: UTF-8 (EF BB BF),
 * UTF-16LE (FF FE) or UTF-16BE (FE FF). BOM-less input decodes as UTF-8.
 *
 * Why: Windows PowerShell 5.1's `>` redirection (the default shell on
 * Windows 10/11) writes UTF-16LE with a BOM, and this CLI's own documentation
 * suggests exactly that redirection for creating plan files. Readers that
 * decode UTF-8 unconditionally turn the CLI's own template into garbage.
 */
export function decodeWithBom(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString('utf16le');
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Buffers have no 'utf16be' decoder: swap the byte pairs, then decode LE.
    const be = Buffer.from(bytes.subarray(2));
    be.swap16();
    return be.toString('utf16le');
  }
  return bytes.toString('utf8');
}

/**
 * Read a small text file, sniffing and stripping UTF-8 / UTF-16LE / UTF-16BE
 * BOMs. BOM-less files decode as UTF-8, byte-for-byte unchanged from
 * `readFileSync(path, 'utf8')`.
 */
export function readTextFileBomAware(path: string): string {
  return decodeWithBom(readFileSync(path));
}
