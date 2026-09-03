import { sanitizeMarkdown } from './markdown-sanitizer';

// Written against BE-18's requirement — "normalizzare il Markdown una sola
// volta al confine (rimuovere blocchi HTML grezzi, rifiutare destinazioni
// javascript:/data:)" — not against the scanner that currently implements
// it.
//
// The requirement is about what a *renderer* ends up with, since the whole
// point of sanitizing once at the boundary is that screen rendering and the
// BE-20 PDF both consume this string without defending themselves. So the
// property under test is: after sanitizeMarkdown, no CommonMark parser can
// still derive a javascript: or data: link destination from the result.
//
// Every hostile payload in markdown-sanitizer.spec.ts spells the scheme out
// at character 0 of what the scanner calls the destination — the one shape
// an allowlist keyed on that prefix is guaranteed to catch. The two
// families below are the ones that never reach that check at all: one
// because Markdown decodes the destination *after* this filter has judged
// it, the other because the scanner's idea of "the destination" is greedier
// than any real parser's, so the parser finds a second link inside a region
// the scanner waved through whole.

/**
 * The href a CommonMark parser derives, expressed as the assertion the
 * requirement actually makes. Kept as a regex over the output rather than a
 * dependency on a Markdown library: `javascript:` reaching a renderer as a
 * destination is the thing BE-18 forbids, however it is spelled on the way
 * in.
 */
function expectNoExecutableDestination(output: string): void {
  // Character references are decoded inside link destinations by CommonMark
  // (`[foo](/f&ouml;&ouml;)` → `href="/föö"`), so a destination is only
  // safe if it is still safe once decoded.
  const decoded = output
    .replace(/&#x([0-9a-f]+);/gi, (_: string, hex: string) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_: string, dec: string) =>
      String.fromCodePoint(Number(dec)),
    )
    .replace(/&colon;/gi, ':')
    .replace(/&Tab;|&NewLine;/gi, '');

  expect(decoded).not.toMatch(/\]\([^)]*javascript:/i);
  expect(decoded).not.toMatch(/\]\([^)]*data:/i);
}

describe('sanitizeMarkdown — destinations that are only dangerous once parsed', () => {
  describe('character references in the destination', () => {
    // The filter reads the destination the way it is written; CommonMark
    // reads it after resolving character references. Anything that survives
    // that gap keeps its scheme. Verified against markdown-it 14 with its
    // own link validator disabled: each of these renders as
    // <a href="javascript:alert(1)">.
    it('rejects a scheme whose first letter is a decimal character reference', () => {
      const output = sanitizeMarkdown('[x](&#106;avascript:alert(1))');

      expectNoExecutableDestination(output);
    });

    it('rejects a scheme whose first letter is a hexadecimal character reference', () => {
      const output = sanitizeMarkdown('[x](&#x6a;avascript:alert(1))');

      expectNoExecutableDestination(output);
    });

    it('rejects a scheme whose colon is a named character reference', () => {
      // &colon; is a standard HTML5 named reference, so the scheme keyword
      // itself is spelled in the clear here — only the delimiter is hidden,
      // which is enough for the RFC 3986 scheme regex to find no scheme at
      // all and conclude the destination is relative.
      const output = sanitizeMarkdown('[x](javascript&colon;alert(1))');

      expectNoExecutableDestination(output);
    });

    it('rejects a data: destination hidden the same way', () => {
      // BE-18 names data: alongside javascript:; it is not a javascript:
      // -specific hole.
      const output = sanitizeMarkdown(
        '[x](&#100;ata:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)',
      );

      expectNoExecutableDestination(output);
    });
  });

  describe('a second link inside what the scanner treats as one destination', () => {
    // A CommonMark destination ends at the first unescaped whitespace; the
    // scanner instead runs to the matching `)`, deliberately, so that a
    // Markdown title is examined too. That makes the scanner's destination
    // a superset — and the scheme check only ever looks at its start, so
    // everything after the first space is judged by nothing. When the
    // scanner then decides the region is safe it re-emits it verbatim,
    // inner link included.
    it('rejects a javascript: link nested inside another link’s destination', () => {
      // The scanner sees one link with destination
      // `x [b](javascript:alert(1)) `, finds no scheme at its start, calls
      // it relative and copies the whole span through. markdown-it renders
      // the result as: [a](x <a href="javascript:alert(1)">b</a> )
      const output = sanitizeMarkdown('[a](x [b](javascript:alert(1)) )');

      expectNoExecutableDestination(output);
    });

    it('rejects a data: link nested the same way', () => {
      const output = sanitizeMarkdown(
        '[a](./ok [img](data:text/html,PHN2Zz4=) )',
      );

      expectNoExecutableDestination(output);
    });

    it('still keeps an ordinary destination that merely carries a title', () => {
      // The counterpart the fix must not break while closing the above:
      // a genuine title is not a nested link and has to survive.
      expect(sanitizeMarkdown('[docs](https://example.com "The title")')).toBe(
        '[docs](https://example.com "The title")',
      );
    });
  });
});

describe('sanitizeMarkdown — content the HTML strip destroys', () => {
  // Not a security hole, and not introduced by the link fix: HTML_TAG has
  // matched `<...>` since the first version. It is recorded here because
  // BE-18 asks for "rimuovere blocchi HTML grezzi", and a Markdown autolink
  // is not raw HTML — it is Markdown's own syntax for a link, and one an
  // agent writing an analysis report will produce. The strip deletes the
  // URL along with the brackets, so the reader loses the reference
  // entirely rather than seeing it un-clickable.
  it('keeps the URL of an autolink instead of deleting it with the angle brackets', () => {
    expect(
      sanitizeMarkdown('See <https://example.com/advisory> for detail'),
    ).toContain('https://example.com/advisory');
  });

  it('keeps the address of a mailto autolink', () => {
    expect(sanitizeMarkdown('Contact <mailto:security@example.com>')).toContain(
      'security@example.com',
    );
  });
});
