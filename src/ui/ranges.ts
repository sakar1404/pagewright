/** Parses "1-3, 5" into 0-based inclusive ranges. Throws a message fit for showing to the user. */
export function parseRanges(input: string, pageCount: number): [number, number][] {
  const parts = input.split(",").map((part) => part.trim());
  const fail = (part: string) => new Error(`"${part}" is not a valid page range. Use page numbers from 1 to ${pageCount}, like 1-3, 5.`);
  return parts.map((part): [number, number] => {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) throw fail(part);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > pageCount || from > to) throw fail(part);
    return [from - 1, to - 1];
  });
}

export function rangesToPages(ranges: [number, number][]): number[] {
  const pages: number[] = [];
  for (const [from, to] of ranges) for (let i = from; i <= to; i++) pages.push(i);
  return pages;
}
