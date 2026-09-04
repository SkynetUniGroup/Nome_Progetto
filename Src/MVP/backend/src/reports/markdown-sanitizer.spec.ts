import { sanitizeMarkdown, sanitizeReportBody } from './markdown-sanitizer';
import { Block } from './report.types';

describe('sanitizeMarkdown', () => {
  it('leaves plain Markdown untouched', () => {
    expect(sanitizeMarkdown('# Title\n\nSome **bold** text.')).toBe(
      '# Title\n\nSome **bold** text.',
    );
  });

  it('strips raw HTML tags', () => {
    expect(sanitizeMarkdown('before <script>alert(1)</script> after')).toBe(
      'before alert(1) after',
    );
  });

  it('strips a self-closing or attribute-bearing tag', () => {
    expect(sanitizeMarkdown('<img src="x" onerror="alert(1)">text')).toBe(
      'text',
    );
  });

  it('rejects a javascript: link destination but keeps the link text', () => {
    expect(sanitizeMarkdown('[click me](javascript:alert(1))')).toBe(
      'click me',
    );
  });

  it('rejects a data: link destination, case-insensitively', () => {
    expect(sanitizeMarkdown('[img](DATA:text/html;base64,PHNjcmlwdD4=)')).toBe(
      'img',
    );
  });

  it('leaves an ordinary https link untouched', () => {
    expect(sanitizeMarkdown('[docs](https://example.com)')).toBe(
      '[docs](https://example.com)',
    );
  });

  it('keeps a relative destination, which has no scheme to execute', () => {
    expect(sanitizeMarkdown('[src](./src/auth/login.ts)')).toBe(
      '[src](./src/auth/login.ts)',
    );
    expect(sanitizeMarkdown('[jump](#findings)')).toBe('[jump](#findings)');
  });

  it('keeps a mailto: destination', () => {
    expect(sanitizeMarkdown('[write](mailto:dev@example.com)')).toBe(
      '[write](mailto:dev@example.com)',
    );
  });

  it('keeps an https destination that carries a Markdown title', () => {
    expect(sanitizeMarkdown('[docs](https://example.com "The title")')).toBe(
      '[docs](https://example.com "The title")',
    );
  });

  it('rejects a scheme that is neither javascript: nor data: but still cannot be navigated to safely', () => {
    // The filter is an allowlist, so this needs no dedicated rule: vbscript:
    // is rejected for the same reason ftp: or file: would be — it simply
    // isn't one of the three schemes a report has a reason to link to.
    expect(sanitizeMarkdown('[legacy](vbscript:msgbox(1))')).toBe('legacy');
    expect(sanitizeMarkdown('[local](file:///etc/passwd)')).toBe('local');
  });

  it('drops the leading ! as well when an image destination is rejected', () => {
    // Otherwise the `!` of `![alt](...)` is left dangling in front of the
    // alt text it no longer applies to.
    expect(
      sanitizeMarkdown('![chart](data:image/svg+xml,<svg/onload=1>)'),
    ).toBe('chart');
  });

  it('leaves an unclosed destination alone instead of eating the rest of the text', () => {
    expect(
      sanitizeMarkdown('[oops](https://example.com and then more text'),
    ).toBe('[oops](https://example.com and then more text');
  });

  it('leaves reference-style links and array indexes alone', () => {
    expect(sanitizeMarkdown('see [docs][1] and arr[0] below')).toBe(
      'see [docs][1] and arr[0] below',
    );
  });

  // BE-18's requirement is "rifiutare destinazioni javascript:/data:" — a
  // security property, not "match this specific regex shape". The two tests
  // below encode that property directly (destination rejected, link text
  // kept) rather than any particular implementation's mechanics. Both were
  // written against the original regex, which they defeated; they are kept
  // verbatim as the regression guard for the scanner that replaced it.
  describe('adversarial payloads', () => {
    it('rejects a javascript: destination with two levels of nested parens', () => {
      // Two levels of paren nesting is nothing exotic — it is one
      // perfectly ordinary function call inside another. The original regex
      // balanced exactly one level, so a second made it fail to match at
      // all and the whole link, javascript: scheme included, passed through
      // untouched. The scanner counts depth instead, so no nesting depth is
      // special.
      const output = sanitizeMarkdown(
        '[click](javascript:alert(String.fromCharCode(88)))',
      );

      expect(output).toBe('click');
      expect(output).not.toMatch(/javascript:/i);
    });

    it('rejects a javascript: destination split by a control character within the scheme keyword', () => {
      // Browsers strip ASCII tab/newline/CR from a URL before parsing its
      // scheme (WHATWG URL, "remove all ASCII tab or newline"), so
      // `java<TAB>script:alert(1)` and `javascript:alert(1)` are the same
      // URL to every browser — a well-known javascript: filter bypass. A
      // literal `javascript|data` alternation never matches it; deciding on
      // the destination *after* normalizing it the way the browser does is
      // what closes this, rather than another spelling added to a list.
      const output = sanitizeMarkdown(
        '[click](java\tscript:alert(document.cookie))',
      );

      expect(output).toBe('click');
      expect(output).not.toMatch(/java\tscript:/);
    });
  });
});

describe('sanitizeReportBody', () => {
  it('sanitizes markdown on a TextBlock', () => {
    const body: Block[] = [
      { kind: 'TEXT', markdown: '<b>hi</b> [x](javascript:1)' },
    ];

    expect(sanitizeReportBody(body)).toEqual([
      { kind: 'TEXT', markdown: 'hi x' },
    ]);
  });

  it('sanitizes explanation and remediation on a FindingBlock, leaves structured fields alone', () => {
    const body: Block[] = [
      {
        kind: 'FINDING',
        category: 'A03:2021',
        severity: 'high',
        filePath: 'src/x.ts',
        startLine: 1,
        endLine: 2,
        explanation: '<script>bad()</script>',
        remediationKind: 'TEXT',
        remediation: '[fix](javascript:void(0))',
      },
    ];

    expect(sanitizeReportBody(body)).toEqual([
      {
        kind: 'FINDING',
        category: 'A03:2021',
        severity: 'high',
        filePath: 'src/x.ts',
        startLine: 1,
        endLine: 2,
        explanation: 'bad()',
        remediationKind: 'TEXT',
        remediation: 'fix',
      },
    ]);
  });

  it('sanitizes explanation and remediation on a PolicyViolationBlock', () => {
    const body: Block[] = [
      {
        kind: 'POLICY_VIOLATION',
        ruleId: 'RULE-1',
        ruleText: 'no console.log',
        filePath: 'src/x.ts',
        explanation: '<i>bad</i>',
        severity: 'low',
        remediation: 'remove it',
      },
    ];

    expect(
      (sanitizeReportBody(body)[0] as { explanation: string }).explanation,
    ).toBe('bad');
  });

  it('sanitizes explanation on a ComplexityWarningBlock', () => {
    const body: Block[] = [
      {
        kind: 'COMPLEXITY_WARNING',
        filePath: 'src/x.ts',
        startLine: 1,
        endLine: 40,
        explanation: '<b>too long</b>',
        severity: 'info',
      },
    ];

    expect(
      (sanitizeReportBody(body)[0] as { explanation: string }).explanation,
    ).toBe('too long');
  });

  it('sanitizes detail on a ChangelogItemBlock', () => {
    const body: Block[] = [
      {
        kind: 'CHANGELOG_ITEM',
        issueRef: 'ISS-1',
        title: 'Added X',
        detail: '<b>details</b>',
      },
    ];

    expect((sanitizeReportBody(body)[0] as { detail: string }).detail).toBe(
      'details',
    );
  });

  it('does not mutate the original blocks', () => {
    const original: Block[] = [{ kind: 'TEXT', markdown: '<b>hi</b>' }];

    sanitizeReportBody(original);

    expect(original[0]).toEqual({ kind: 'TEXT', markdown: '<b>hi</b>' });
  });
});

// markdown-sanitizer.adversarial.spec.ts states the requirement with one
// payload per family. These are the same families spelled differently — the
// question a fix has to survive is not "does the recorded payload fail?" but
// "does anything in this class still get through?". A fix that recognised
// `&#106;` and not `&#X6A;` would pass that file and still be open.
describe('sanitizeMarkdown — other spellings of a hidden scheme', () => {
  const rejected = [
    // Uppercase hex marker and uppercase digits: normalization lowercases
    // before anything else looks at the string.
    ['uppercase hex reference', '[x](&#X6A;avascript:alert(1))'],
    // Leading zeros are legal in a numeric reference and change nothing
    // about what it decodes to.
    ['zero-padded decimal reference', '[x](&#0000106;avascript:alert(1))'],
    ['zero-padded hex reference', '[x](&#x0006a;avascript:alert(1))'],
    // Not the first character of the scheme — any position works, because
    // the parser decodes the whole destination, not a prefix of it.
    ['reference in the middle of the scheme', '[x](java&#115;cript:alert(1))'],
    ['reference at the end of the scheme', '[x](javascrip&#116;:alert(1))'],
    // Named references that are not &colon;. A denylist of "the dangerous
    // entities" would need every one of these; the rule needs none.
    ['&Tab; inside the scheme keyword', '[x](java&Tab;script:alert(1))'],
    [
      '&NewLine; inside the scheme keyword',
      '[x](java&NewLine;script:alert(1))',
    ],
    // data:, hidden by its delimiter rather than by its keyword.
    ['data: with a named colon', '[x](data&colon;text/html,PHN2Zz4=)'],
    // The image form goes down the same path, leading `!` included.
    ['an image destination', '![x](&#106;avascript:alert(1))'],
    // vbscript: is not named in BE-18 at all — it is rejected because it is
    // not in the allowlist, and hiding it changes nothing about that.
    ['a scheme outside the allowlist', '[x](vb&#115;cript:msgbox(1))'],
  ] as const;

  it.each(rejected)('rejects %s', (_name, payload) => {
    const output = sanitizeMarkdown(payload);

    expect(output).toBe('x');
  });

  // The rule is "a character reference makes a destination unsafe unless an
  // allowed scheme is already complete in the clear before it". These are
  // the cases on the other side of that line: they must keep working, or the
  // fix has traded a security hole for a content-destroying one.
  it('keeps an http(s) destination whose query string contains a reference', () => {
    expect(sanitizeMarkdown('[q](https://example.com/s?a=1&amp;b=2)')).toBe(
      '[q](https://example.com/s?a=1&amp;b=2)',
    );
  });

  it('keeps a bare ampersand, which is not a character reference at all', () => {
    // No semicolon, so nothing decodes; the vast majority of real query
    // strings look like this.
    expect(sanitizeMarkdown('[q](https://example.com/s?a=1&b=2)')).toBe(
      '[q](https://example.com/s?a=1&b=2)',
    );
  });

  it('keeps a mailto: destination carrying a reference in its parameters', () => {
    expect(
      sanitizeMarkdown('[m](mailto:dev@example.com?subject=A&amp;B)'),
    ).toBe('[m](mailto:dev@example.com?subject=A&amp;B)');
  });

  it('keeps a relative destination with an unterminated ampersand sequence', () => {
    // `&#106` without the closing `;` is not a character reference, so
    // CommonMark leaves it alone and so does this.
    expect(sanitizeMarkdown('[r](./a&#106b.ts)')).toBe('[r](./a&#106b.ts)');
  });
});

// Same idea as the block above, for the other family: the recorded payload is
// one link nested one level inside another link's destination region. The
// property is "nothing declared safe is re-emitted unexamined", so the tests
// that matter are the ones the recorded payload does not reach — deeper
// nesting, the image form, a nested link inside a title — plus the cases that
// must survive, since re-scanning a region is only correct if it leaves
// ordinary content exactly as it found it.
describe('sanitizeMarkdown — links hiding inside another destination', () => {
  it('rejects a nested link two levels down', () => {
    // Nothing about the fix is keyed to depth: the region is re-scanned by
    // the same function, so each level is examined by the level above it.
    expect(sanitizeMarkdown('[a](x [b](y [c](javascript:alert(1)) ) )')).toBe(
      '[a](x [b](y c ) )',
    );
  });

  it('rejects a nested image destination, dropping its ! with it', () => {
    expect(sanitizeMarkdown('[a](ok ![i](data:text/html,PHN2Zz4=) )')).toBe(
      '[a](ok i )',
    );
  });

  it('rejects a link nested inside what looks like a title', () => {
    // The outer destination has a perfectly good https scheme, so the outer
    // link is kept — and the inner one is still sanitized, because being
    // safe is not the same as being beyond inspection.
    expect(
      sanitizeMarkdown('[a](https://ok.example "t [b](javascript:1)")'),
    ).toBe('[a](https://ok.example "t b")');
  });

  it('rejects only the unsafe one when a region holds several nested links', () => {
    expect(
      sanitizeMarkdown('[a](x [ok](https://e.example) [no](javascript:1) )'),
    ).toBe('[a](x [ok](https://e.example) no )');
  });

  it('keeps a nested link whose own destination is safe', () => {
    expect(sanitizeMarkdown('[a](x [b](https://e.example) )')).toBe(
      '[a](x [b](https://e.example) )',
    );
  });

  it('keeps brackets inside a title that are not a link', () => {
    // Re-scanning must not start rewriting ordinary punctuation: `[b]` with
    // no `(` after it is not a link and comes through untouched.
    expect(sanitizeMarkdown('[a](https://e.example "a [b] c")')).toBe(
      '[a](https://e.example "a [b] c")',
    );
  });

  it('keeps an ordinary destination with nested parentheses', () => {
    // The depth counting the scanner was built for still has to work.
    expect(sanitizeMarkdown('[wiki](https://e.example/Foo_(bar)_(baz))')).toBe(
      '[wiki](https://e.example/Foo_(bar)_(baz))',
    );
  });

  it('strips a javascript: image inside a label without taking the outer link with it', () => {
    // This used to assert `![img](x)`, which was the "first `]` wins" reading:
    // the scanner took `[![img]` for the label and `javascript:1` for the
    // destination, dropped it, and left the outer `](x)` to recombine with the
    // `!` in front. Now that the label's brackets are matched, the string is
    // read the way a parser reads it — an outer link to `x` whose label holds
    // an image — and each half is judged on its own: the outer destination is
    // relative and stays, the image's destination is not and goes, its alt
    // text surviving as the same plain text every other rejected link leaves
    // behind.
    expect(sanitizeMarkdown('[![img](javascript:1)](x)')).toBe('[img](x)');
    expect(
      sanitizeMarkdown('[![img](javascript:alert(1))](https://ok.com)'),
    ).toBe('[img](https://ok.com)');
  });
});

// The condition attached to keeping autolinks. Before, `<javascript:alert(1)>`
// was deleted by accident — HTML_TAG ate every `<...>` run, dangerous or not.
// Preserving autolinks removes that accident, which makes them a destination
// surface that has to be defended on purpose. These tests are the defence:
// without them, closing the content bug would open a security one.
describe('sanitizeMarkdown — autolinks are destinations too', () => {
  const removed = [
    ['javascript:', '<javascript:alert(1)>'],
    ['JavaScript: in mixed case', '<JavaScript:alert(1)>'],
    ['data:', '<data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+>'],
    // Not named by BE-18 — rejected for being outside the allowlist, which
    // is the only reason anything is rejected here.
    ['a scheme outside the allowlist', '<vbscript:msgbox(1)>'],
    ['file:', '<file:///etc/passwd>'],
    // A stray `)` inside the URI is still no whitespace and no angle
    // bracket, so this is a well-formed autolink and has to be judged, not
    // waved through for being malformed.
    ['javascript: with an unbalanced paren', '<javascript:alert(1))>'],
  ] as const;

  it.each(removed)('removes an autolink with %s', (_name, payload) => {
    const output = sanitizeMarkdown(`see ${payload} here`);

    expect(output).toBe('see  here');
  });

  it('removes a scheme split by a control character inside the keyword', () => {
    // Not a well-formed autolink (a tab is not allowed in a scheme), so it
    // never reaches the allowlist — the raw-HTML strip still deletes it.
    // Asserted so that a later loosening of the autolink grammar cannot
    // quietly promote this into a preserved destination.
    const payload = `<java${String.fromCharCode(9)}script:alert(1)>`;

    expect(sanitizeMarkdown(`see ${payload} here`)).not.toMatch(/script:/i);
  });

  const kept = [
    ['https', '<https://cve.example/CVE-2024-1234>'],
    ['http', '<http://example.com/a?b=1>'],
    ['mailto', '<mailto:security@example.com>'],
    // The email form carries no scheme at all, so there is nothing in it an
    // allowlist could object to.
    ['a bare email address', '<security@example.com>'],
  ] as const;

  it.each(kept)('keeps a %s autolink whole', (_name, payload) => {
    expect(sanitizeMarkdown(`see ${payload} here`)).toBe(`see ${payload} here`);
  });

  // CommonMark also allows a destination to be wrapped in angle brackets.
  // That form goes through the same door, and it is the one that would have
  // been quietly opened by keeping autolinks without extending the scheme
  // check: `<` is not a scheme character, so an unextended check reads
  // `<javascript:...>` as a relative path.
  describe('the pointy-bracket destination form', () => {
    it('keeps a safe one, brackets included', () => {
      expect(sanitizeMarkdown('[x](<https://example.com/a>)')).toBe(
        '[x](<https://example.com/a>)',
      );
    });

    it('still drops one whose URL contains a space', () => {
      // Recorded as a known limit, not as an endorsement. The pointy-bracket
      // form is the one CommonMark destination that may contain spaces, but
      // an autolink may not — so this run is not an autolink, and the raw
      // HTML strip removes it exactly as it always did. Widening the
      // autolink grammar to cover it would mean guessing which `<... ...>`
      // runs are destinations and which are tags, which is where the next
      // bypass would come from. The loss is a link, never an execution.
      expect(sanitizeMarkdown('[x](<https://example.com/a b>)')).toBe('[x]()');
    });

    it('rejects a javascript: one', () => {
      expect(sanitizeMarkdown('[x](<javascript:alert(1)>)')).toBe('x');
    });

    it('rejects a data: one', () => {
      expect(sanitizeMarkdown('[x](<data:text/html,PHN2Zz4=>)')).toBe('x');
    });

    it('rejects one hiding its scheme behind a character reference', () => {
      // Both families at once: angle brackets to dodge the scheme regex, a
      // character reference to dodge the keyword.
      expect(sanitizeMarkdown('[x](<&#106;avascript:alert(1)>)')).toBe('x');
    });
  });

  it('still strips raw HTML that merely resembles an autolink', () => {
    // An attribute means whitespace, and whitespace means it is not an
    // autolink — it is a tag, and tags still go.
    expect(sanitizeMarkdown('a <a href="https://e.example">b</a> c')).toBe(
      'a b c',
    );
    expect(sanitizeMarkdown('<img src="x" onerror="alert(1)">t')).toBe('t');
  });

  it('leaves a lone angle bracket in prose alone', () => {
    expect(sanitizeMarkdown('use a < b and c > d here')).toBe(
      'use a < b and c > d here',
    );
    expect(sanitizeMarkdown('if (n < 3) fail')).toBe('if (n < 3) fail');
  });

  it('judges an autolink nested inside another link’s destination', () => {
    // The region is declared relative and re-scanned (see the nesting tests
    // above); the autolink inside it is judged by the same allowlist.
    expect(sanitizeMarkdown('[a](./ok <javascript:alert(1)> )')).toBe(
      '[a](./ok  )',
    );
    expect(sanitizeMarkdown('[a](./ok <https://e.example> )')).toBe(
      '[a](./ok <https://e.example> )',
    );
  });
});

// A destination is only sanitized if the scanner ever reads it as one. Every
// test below is a string where it did not, found by running the sanitized
// output back through a real CommonMark parser instead of by inspecting it.
// They are grouped by how the string got past, because the payloads are
// examples of those routes and not the definition of them.
describe('sanitizeMarkdown — routes that used to skip the scheme check', () => {
  describe('the label is examined too', () => {
    // An autolink is a complete link that contains no `]`, so "the label ends
    // at the first `]`, therefore it cannot hold a link" was true of
    // `[x](y)` and false of `<javascript:...>`. Once the HTML strip stopped
    // deleting autolinks, the label became a place to park one.
    it('removes a javascript: autolink sitting in a label', () => {
      expect(sanitizeMarkdown('[<javascript:alert(1)>](https://ok.com)')).toBe(
        '[](https://ok.com)',
      );
    });

    it('removes a data: autolink from a label, keeping the words around it', () => {
      expect(
        sanitizeMarkdown(
          '[see <data:text/html,PHN2Zz4=> here](https://ok.com)',
        ),
      ).toBe('[see  here](https://ok.com)');
    });

    it('removes an autolink from the label of a link that is itself rejected', () => {
      // Both halves are unsafe here: the outer destination goes, and the
      // label it leaves behind must not still carry the autolink.
      expect(sanitizeMarkdown('[<javascript:alert(1)>](javascript:evil)')).toBe(
        '',
      );
    });

    it('keeps a safe autolink in a label untouched', () => {
      expect(
        sanitizeMarkdown('[see <https://ok.com> here](https://ok.com)'),
      ).toBe('[see <https://ok.com> here](https://ok.com)');
    });
  });

  describe("the label's brackets are matched, not scanned to the first `]`", () => {
    // These need no encoding at all. A footnote marker or an array index in
    // the label was enough: the first `]` was not followed by `(`, readLink
    // gave up, and the whole string — destination included — was copied out
    // without any part of it being judged.
    it('rejects a data: destination behind a bracketed label', () => {
      expect(sanitizeMarkdown('[nota [2]](data:text/html,x)')).toBe('nota [2]');
    });

    it('rejects a javascript: destination behind a footnote-style label', () => {
      expect(sanitizeMarkdown('[see [1] here](javascript:alert(1))')).toBe(
        'see [1] here',
      );
    });

    it('rejects the outer destination while keeping a safe inner link', () => {
      expect(
        sanitizeMarkdown('[a [b](https://ok.com) c](javascript:alert(1))'),
      ).toBe('a [b](https://ok.com) c');
    });

    it('keeps a bracketed label whose destination is safe', () => {
      // The counterweight: matching brackets must not cost a legitimate link.
      expect(sanitizeMarkdown('[nota [2]](https://ok.com)')).toBe(
        '[nota [2]](https://ok.com)',
      );
      // The citation form keeps its link and its text; the bracket that
      // opens nothing is escaped rather than left able to pair with whatever
      // follows, so the string changes by one backslash and renders the same.
      expect(sanitizeMarkdown('[[1](https://ref.example)]')).toBe(
        '[\\[1](https://ref.example)]',
      );
    });
  });

  describe('nothing recombines in the output', () => {
    // Rejecting a link can leave a stray `[` in front of a `](destination)`
    // that the scan had already walked past, and the two halves then read as
    // a link nobody judged. The scan runs until its own output stops
    // changing, and a label's unmatched brackets are escaped so they cannot
    // open anything.
    it('does not leave a live link behind after rejecting an inner one', () => {
      expect(
        sanitizeMarkdown('[[lbl](javascript&#106;x)](javascript:alert(1))'),
      ).toBe('lbl');
    });

    it('does not leave one behind when the stray bracket comes from a destination', () => {
      expect(
        sanitizeMarkdown('[a](https://ok.example [[)](data:alert(1)) )'),
      ).toBe('a](data:alert(1)) )');
    });

    it('escapes a label bracket that nothing closes', () => {
      // `\[` is a literal bracket, so the text survives and the opener does
      // not.
      expect(
        sanitizeMarkdown('[[![alt](<data:alert(1))](x)](javascript:alert(1))'),
      ).not.toMatch(/\]\(javascript:/);
    });

    it('leaves balanced brackets in a destination alone', () => {
      expect(sanitizeMarkdown('[x](https://ex.com/arr[0][1])')).toBe(
        '[x](https://ex.com/arr[0][1])',
      );
    });
  });

  describe('character references of any length', () => {
    // The regex used to stop at 8 decimal and 6 hexadecimal digits. A parser
    // does not: markdown-it falls through to an HTML5 decoder that accepts
    // any number of leading zeros, so padding walked straight past the check.
    it('rejects a decimal reference longer than the old bound', () => {
      expect(sanitizeMarkdown('[x](&#000000106;avascript:alert(1))')).toBe('x');
    });

    it('rejects a hexadecimal reference longer than the old bound', () => {
      expect(sanitizeMarkdown('[x](&#x000006a;avascript:alert(1))')).toBe('x');
    });

    it('rejects a padded data: reference the same way', () => {
      expect(sanitizeMarkdown('[x](&#000000100;ata:text/html,PHN2Zz4=)')).toBe(
        'x',
      );
    });

    it('rejects a padded reference reached through the pointy-bracket form', () => {
      expect(sanitizeMarkdown('[x](<&#000000106;avascript:alert(1)>)')).toBe(
        'x',
      );
    });

    it('still keeps a query string, however long its ampersands', () => {
      // The counterweight to an unbounded quantifier: `&amp;` after a scheme
      // in the clear is still a legitimate URL.
      expect(
        sanitizeMarkdown('[q](https://ok.com/s?a=1&amp;b=2&amp;c=3)'),
      ).toBe('[q](https://ok.com/s?a=1&amp;b=2&amp;c=3)');
    });
  });

  describe('deeply nested input is bounded', () => {
    // The re-scan spends a stack frame per level, and an agent can emit any
    // shape at all. This used to throw RangeError out of sanitizeMarkdown at
    // roughly 30 KB, which reached TaskProcessor as an UPSTREAM failure and
    // cost the whole report.
    function nest(levels: number): string {
      let text = 'x';
      for (let i = 0; i < levels; i += 1) {
        text = `[a](${text})`;
      }
      return text;
    }

    it('does not throw on nesting far past any real report', () => {
      expect(() => sanitizeMarkdown(nest(20000))).not.toThrow();
    });

    it('still rejects an unsafe destination buried under deep nesting', () => {
      // Well inside the ceiling, so this is the ordinary path: the innermost
      // destination is judged like any other and dropped, taking the scheme
      // with it.
      expect(
        sanitizeMarkdown(nest(40).replace('x', 'javascript:alert(1)')),
      ).not.toMatch(/javascript:/);
    });

    it('leaves nothing linkable behind once past the ceiling', () => {
      // Past MAX_NESTING_DEPTH the region is rewritten flat instead of walked,
      // which keeps the text but removes every `[`. Nothing is left that can
      // open a destination, which is the property that has to survive — not
      // the shape of the text, which at this depth is already nonsense.
      const output = sanitizeMarkdown(
        nest(200).replace('x', 'javascript:alert(1)'),
      );

      expect(output).not.toMatch(/\[[^[\]]*\]\(javascript:/);
    });

    it('leaves ordinary shallow nesting exactly as it was', () => {
      expect(sanitizeMarkdown(nest(3))).toBe(nest(3));
    });
  });
});

// HTML_TAG requires a letter after `<`, so every form below — all of them
// raw HTML by CommonMark's own definition — went straight through the strip
// that exists to remove raw HTML. Nothing executable came out of them with
// markdown-it, but "we checked one renderer" is not the property BE-18 asks
// for, and an unclosed comment hides real content in any of them.
describe('sanitizeMarkdown — raw HTML that is not a tag', () => {
  it('removes an HTML comment and what it hides', () => {
    expect(
      sanitizeMarkdown(
        'testo <!-- <a href="javascript:alert(1)">x</a> --> qui',
      ),
    ).toBe('testo  qui');
  });

  it('removes a declaration', () => {
    expect(sanitizeMarkdown('<!DOCTYPE html>report')).toBe('report');
  });

  it('removes a processing instruction', () => {
    expect(sanitizeMarkdown('<?php system($_GET[0]); ?>ok')).toBe('ok');
  });

  it('removes a CDATA section', () => {
    expect(
      sanitizeMarkdown('<![CDATA[<a href="javascript:alert(1)">x</a>]]>'),
    ).toBe('');
  });

  it('defuses an unclosed comment without eating the text after it', () => {
    // A parser swallows everything from `<!--` to the end of the document.
    // Deleting the run would cost the same content the hiding does, so only
    // the opener goes.
    expect(sanitizeMarkdown('prima <!-- e tutto il resto')).toBe(
      'prima  e tutto il resto',
    );
  });

  it('leaves ordinary prose containing < and ! alone', () => {
    expect(sanitizeMarkdown('if (a < b) then! else')).toBe(
      'if (a < b) then! else',
    );
    expect(sanitizeMarkdown('vedi <https://ok.example> e basta')).toBe(
      'vedi <https://ok.example> e basta',
    );
  });
});
