/** The longest a conversation's name runs before it is cut at a word, as the portal names one. */
const TITLE_MAX = 80;

/** A conversation's name from its first message, the portal's way: its first line, cut at a word. */
export function titleFrom(message: string): string | undefined {
  const line =
    message
      .split('\n')
      .map(l => l.trim())
      .find(Boolean)
      ?.replace(/\s+/g, ' ') ?? '';
  if (!line) return undefined;
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}
