/** Compare generated text without treating Git's CRLF conversion as an edit. */
export function equalIgnoringCrlf(left: string, right: string): boolean {
  return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n');
}
