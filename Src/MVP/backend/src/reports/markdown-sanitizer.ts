import { Block } from './report.types';

// Raw HTML embedded in Markdown that's meant to be rendered as Markdown, not
// as HTML — any tag, opening or closing. Deliberately broad (not just
// <script>/<iframe>): the point isn't to allow a "safe" subset of HTML
// through, it's that this content was never supposed to contain HTML at all.
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;

// ...except that HTML_TAG also matches things that are not HTML at all. A
// Markdown autolink is `<` followed by a scheme, so `<https://example.com>`
// starts with an ALPHA exactly like a tag does, and the strip deleted the URL
// along with the angle brackets: `see <https://example.com> ok` became
// `see  ok`. Not merely un-clickable — gone. An agent writing a security
// report produces `<https://cve.example/CVE-2024-1234>` as a matter of
// course, and `[x](<dest>)` lost its destination the same way.
//
// The two forms CommonMark defines, matched against a whole `<...>` run:
// absolute URI (a scheme of 2-32 characters, then anything without
// whitespace or angle brackets) and email (no scheme at all, so nothing it
// can carry).
const URI_AUTOLINK = /^<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>$/;
const EMAIL_AUTOLINK =
  /^<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*>$/;

function isAutolink(candidate: string): boolean {
  return URI_AUTOLINK.test(candidate) || EMAIL_AUTOLINK.test(candidate);
}

// The rest of what CommonMark calls raw HTML, none of which HTML_TAG has
// ever matched: it requires a letter after `<`, and every form below starts
// with `!` or `?`. BE-18 asks for raw HTML *blocks* to be removed, and these
// are exactly that — they were surviving only because the regex above was
// written with tags in mind.
const HTML_CDATA = /<!\[CDATA\[[\s\S]*?\]\]>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_PROCESSING_INSTRUCTION = /<\?[\s\S]*?\?>/g;
const HTML_DECLARATION = /<![a-zA-Z][^>]*>/g;

// A `<!--` with no `-->` after it is not a comment to CommonMark, but an HTML
// parser swallows everything from there to the end of the document. Deleting
// the run would cost the same content the hiding does, so only the opener
// goes: the text stays readable and can no longer open anything.
const UNCLOSED_COMMENT = /<!--/g;

// Raw HTML out, autolinks left standing for the scanner to judge.
//
// Keeping them is what makes them a *new destination surface*: they used to
// be deleted by accident, `<javascript:alert(1)>` included, so preserving
// them without extending the scheme check to this form would close a content
// bug by opening a security one. The allowlist therefore applies to an
// autolink exactly as it applies to `[x](dest)` — see rejectUnsafeLinks,
// which is the only place either form is allowed through.
function stripRawHtml(markdown: string): string {
  // The one ordering constraint in the chain below: HTML_COMMENT has to run
  // before UNCLOSED_COMMENT reaches the same text. Reversed, `<!--` is
  // deleted as a bare opener and the comment's body and its `-->` are left
  // behind as visible text. The other four are independent of each other —
  // HTML_DECLARATION in particular needs a letter after `<!`, so it matches
  // neither CDATA nor a comment.
  return markdown
    .replace(HTML_CDATA, '')
    .replace(HTML_COMMENT, '')
    .replace(HTML_PROCESSING_INSTRUCTION, '')
    .replace(HTML_DECLARATION, '')
    .replace(UNCLOSED_COMMENT, '')
    .replace(HTML_TAG, (tag) => (isAutolink(tag) ? tag : ''));
}

// Schemes a link destination is allowed to keep. An allowlist, not a
// javascript:/data: denylist: BE-18 words the requirement as "reject
// javascript:/data:" and this satisfies it, but a denylist only ever knows
// about the bypasses someone already thought of. The first version of this
// file spelled those two schemes out literally and was defeated twice —
// once by a destination nesting parentheses deeper than its regex
// tolerated, once by `java<TAB>script:`, which every browser reads as
// `javascript:` anyway. Nothing outside these three is something an
// analysis report has a legitimate reason to link to, so anything else
// keeps its text and loses its destination. (If the team would rather have
// the literal denylist, invert this set — but then every new bypass is
// another patch here.)
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

// RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":". No
// match means the destination is relative (`./src/x.ts`, `#anchor`) —
// nothing a browser can execute, so nothing to reject.
const SCHEME = /^([a-z][a-z0-9+.-]*):/;

// A character reference, in any of the three forms CommonMark resolves:
// decimal, hexadecimal, and named. Matched by *shape*, not against the HTML5
// entity list — see isSafeDestination for why that distinction is the whole
// point of this constant.
//
// The numeric forms are deliberately unbounded in length. They used to be
// capped at 8 decimal and 6 hexadecimal digits, which looked like the
// CommonMark grammar (1-7 and 1-6) with a digit of slack — but a parser does
// not stop there. markdown-it tries its own `#x?[0-9a-f]{1,8}` test first and,
// when that fails, falls through to the `entities` package's HTML5 decoder,
// which accepts any number of leading zeros. So `&#000000106;` (nine digits)
// and `&#x000006a;` (seven) decoded to `j` while this regex saw no reference
// at all, the destination was declared relative, and `&#000000106;avascript:`
// was re-emitted verbatim for the renderer to turn back into an executable
// href. Padding is free for an attacker; a length limit here is a denylist
// wearing a quantifier. Matching any digit count can only reject more, which
// is the direction this whole file fails in.
const CHARACTER_REFERENCE = /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]{1,31});/i;

// How many times the scan may run before the result is forced closed. Real
// content settles on the first or second pass; see below for what needs more.
const MAX_SCAN_PASSES = 16;

// BE-18: the one place Markdown coming out of an agent gets cleaned, so that
// screen rendering and PDF export (BE-20) always consume the same
// already-sanitized string instead of each having to defend against this
// separately.
export function sanitizeMarkdown(markdown: string): string {
  // Strip first, scan second, deliberately: the scanner then sees the same
  // text the renderer will, and a strip that happens to *create* a link is
  // still caught by the scanner downstream of it.
  //
  // Then scan until the text stops changing, because removing a link can
  // leave one behind. The scanner reads `[[lbl](INNER)](OUTER)` as a single
  // link whose label is `[lbl` — the "first `]` wins" rule — so when INNER is
  // rejected it emits that label, odd bracket and all, and resumes past the
  // inner `)`. What is left, `](OUTER)`, has no `[` in front of it any more,
  // so readLink never visits it and it goes out with the tail. The two halves
  // then recombine in the output into `[lbl](OUTER)`: a syntactically perfect
  // link that nothing ever judged, with its scheme in the clear.
  //
  // The property this file owes its callers is about the string it returns,
  // not the string it was given, so the check belongs on the output. This
  // settles, but not by getting shorter — a label whose brackets don't
  // balance, `[lbl` above among them, has each stray `[` escaped to `\[`,
  // one character longer than it was. What cannot go back up is the
  // number of brackets still open to escaping: unmatchedOpenBrackets skips
  // the character after a `\`, so one this pass escaped is invisible to the
  // next, and every other change a pass makes is a deletion. One extra pass
  // over already-clean text is the normal cost.
  let text = stripRawHtml(markdown);
  for (let pass = 0; pass < MAX_SCAN_PASSES; pass += 1) {
    const scanned = rejectUnsafeAutolinks(rejectUnsafeLinks(text));
    if (scanned === text) {
      return text;
    }
    text = scanned;
  }

  // Sixteen passes and still peeling: that is a label nested inside a label
  // sixteen deep, which no report writes by accident. Escaping every `[`
  // leaves a string in which no `[label](destination)` can form at all, and
  // the last pass already judged every autolink in it — so this is closed,
  // not merely tired.
  return text.replace(/\[/g, '\\[');
}

// How deep the re-scan below may nest before it stops recursing and falls
// back to a flat, link-free rewrite of whatever is left.
//
// The re-scan spends one stack frame per nesting level, and the text it walks
// is an agent's output — the one input this file exists because it cannot
// trust. `[a](` repeated ~5 900 times, under 30 KB, was enough to throw
// RangeError out of sanitizeMarkdown on a default Node stack; the throw
// surfaced as an UPSTREAM failure on the Task and cost the whole report. The
// depth that matters for real content is single digits, so a ceiling this far
// above it never fires on anything an analysis report contains, and the
// fallback drops out of the recursion in one pass instead of unwinding into
// the caller's error handler.
const MAX_NESTING_DEPTH = 64;

// Walks the text looking for `[label](destination)` and its `![alt](...)`
// image form, keeping each one only if its destination survives
// isSafeDestination(). A scanner rather than one more regex on purpose: a
// destination can nest parentheses arbitrarily deep — `alert(String
// .fromCharCode(88))` is two levels of perfectly ordinary function calls —
// and a regex that tries to balance them either tolerates a fixed depth,
// silently letting anything deeper through unchecked, or stops at the first
// `)` and leaves half the link behind. Counting depth is the only version
// of this that doesn't have a "one level deeper" bypass already waiting in
// it.
function rejectUnsafeLinks(markdown: string, depth = 0): string {
  if (depth > MAX_NESTING_DEPTH) {
    // Too deep to keep walking, so stop walking rather than stop safely-ish:
    // dropping every `[` and `<` leaves text that no parser can read as a
    // link or an autolink, which is the one thing this function has to
    // guarantee about anything it emits. Content past this depth is already
    // not something an agent wrote by accident.
    return markdown.replace(/[[<]/g, '');
  }

  let out = '';
  let index = 0;

  while (index < markdown.length) {
    const open = markdown.indexOf('[', index);
    const angle = markdown.indexOf('<', index);

    if (open === -1 && angle === -1) {
      out += markdown.slice(index);
      break;
    }

    // Autolinks are destinations too, and stripRawHtml no longer deletes
    // them, so this is where they get the same allowlist treatment
    // `[x](dest)` gets. Whichever form comes first is handled first.
    if (angle !== -1 && (open === -1 || angle < open)) {
      out += markdown.slice(index, angle);
      index = readAutolink(markdown, angle, (kept) => {
        out += kept;
      });
      continue;
    }

    out += markdown.slice(index, open);
    const link = readLink(markdown, open);

    if (!link) {
      // Not a link after all — no `](` following the label, or parentheses
      // that never close. The `[` is just a character.
      out += '[';
      index = open + 1;
      continue;
    }

    if (
      isSafeDestination(link.destination) &&
      !hasUnmatchedOpenBracket(link.destination)
    ) {
      // Safe, but not therefore beyond inspection. The region this scanner
      // calls "the destination" runs to the balanced `)`, while a CommonMark
      // destination ends at the first unescaped whitespace — so the region
      // is a superset, the scheme check only ever looks at its *start*, and
      // everything past the first space used to be judged by nothing at all
      // and then re-emitted whole:
      //
      //   [a](x [b](javascript:alert(1)) )
      //     region:  "x [b](javascript:alert(1)) "
      //     scheme at its start: none -> "relative" -> passes
      //     the parser, however: falls back on the inner link -> javascript:
      //
      // So the region goes back through this same scan before being emitted.
      // Nothing declared safe is re-emitted unexamined, and an inner link is
      // sanitized by exactly the rules an outer one is — including rules
      // this function does not know about yet, since it is the same
      // function.
      //
      // The label goes back through it too. It used to be copied verbatim on
      // the reasoning that "the label ends at the first `]`, so it cannot
      // contain a complete link" — true of `[x](y)`, false of an autolink,
      // which is a complete link and carries no `]` at all. Once the strip
      // stopped deleting autolinks, `[<javascript:alert(1)>](https://ok.com)`
      // sailed through here untouched and rendered as a live javascript:
      // href nested inside a harmless-looking one. The "first `]` wins" bias
      // that makes the scanner latch onto the inner link of
      // `[![img](javascript:1)](x)` is still there and still in the safe
      // direction — re-scanning the label does not disturb it, because a
      // label with no link in it comes back out of this function unchanged.
      out += '[';
      out += escapeUnmatchedBrackets(rejectUnsafeLinks(link.label, depth + 1));
      out += '](';
      out += rejectUnsafeLinks(link.destination, depth + 1);
      out += ')';
    } else {
      // The text the agent wrote is kept; only the destination is dropped.
      // Deleting the whole link would silently lose content, which is worse
      // than showing it without making it clickable. An image's leading `!`
      // goes with it, or it would be left dangling in front of the alt text.
      // The label is examined here for the same reason it is above: this is
      // the other place it reaches the output.
      if (out.endsWith('!')) {
        out = out.slice(0, -1);
      }
      out += escapeUnmatchedBrackets(rejectUnsafeLinks(link.label, depth + 1));
    }
    index = link.end + 1;
  }

  return out;
}

// Whether a region carries a `[` that nothing in it closes.
//
// Such a region cannot be emitted between `](` and `)` and left alone: the
// scanner stops a destination at the first unbalanced `)`, which can fall
// earlier than where a parser would end it, and then the text after that `)`
// goes out through the tail unexamined. In `[a](https://ok.example [[)](data:
// alert(1)) )` the region the scanner accepts is `https://ok.example [[` — an
// https URL, safe by every rule this file has — and the `](data:alert(1))`
// left behind pairs with one of those stray brackets in the *output*. Neither
// half was ever wrong on its own; together they are a link nobody judged.
//
// Balanced brackets are ordinary in a URL (`/arr[0][1]`, a footnote target)
// and stay allowed. An unmatched one is malformed, and malformed is where
// this whole class lives.
function hasUnmatchedOpenBracket(region: string): boolean {
  return unmatchedOpenBrackets(region).length > 0;
}

function unmatchedOpenBrackets(region: string): number[] {
  const open: number[] = [];
  for (let i = 0; i < region.length; i += 1) {
    const char = region[i];
    if (char === '\\') {
      i += 1;
    } else if (char === '[') {
      open.push(i);
    } else if (char === ']' && open.length > 0) {
      open.pop();
    }
  }
  return open;
}

// Backslash-escapes the `[` characters a label leaves open, which is the same
// hazard as the one above reached from the other side: a label emitted as
// text carries its brackets into the output, and one that nothing closes can
// pair with a `](destination)` further along — text this function emitted
// through the tail, never having read it as a link, because by then the `[`
// that would have made it one was already behind the cursor. `[[![alt]()]`
// followed by `(javascript:alert(1))` is two harmless fragments that a parser
// reads as one live link.
//
// `\[` is a literal bracket in CommonMark, so the label still reads the way
// the agent wrote it; it just stops being able to open something. A label
// whose brackets balance — every ordinary one — comes back untouched.
function escapeUnmatchedBrackets(label: string): string {
  const positions = unmatchedOpenBrackets(label);
  if (positions.length === 0) {
    return label;
  }

  let out = '';
  let cursor = 0;
  for (const position of positions) {
    out += label.slice(cursor, position) + '\\[';
    cursor = position + 1;
  }
  return out + label.slice(cursor);
}

// Autolinks only, with the link structure ignored entirely.
//
// rejectUnsafeLinks judges a label and a destination by scanning each one on
// its own, which loses whatever spans the boundary between them: in
// `[<javascript:x](>)` the `<` sits in the label and the `>` that closes it
// sits in the destination, so neither sub-scan sees an autolink and both
// hand their piece back unchanged — while the parser, reading the emitted
// string straight through, sees one and links it. This sweep reads straight
// through as well, so a `<...>` run is judged wherever it happens to start
// and end. On text the main scan already handled it is a no-op.
function rejectUnsafeAutolinks(markdown: string): string {
  let out = '';
  let index = 0;

  while (index < markdown.length) {
    const angle = markdown.indexOf('<', index);
    if (angle === -1) {
      out += markdown.slice(index);
      break;
    }

    out += markdown.slice(index, angle);
    index = readAutolink(markdown, angle, (kept) => {
      out += kept;
    });
  }

  return out;
}

// Handles one `<...>` run and returns where scanning resumes. An autolink
// that survives is written through `keep`; one that doesn't is written
// nowhere — unlike `[label](dest)` there is no text to preserve separately,
// since an autolink *is* its destination, and emitting the bare URI back as
// plain text would just hand a linkifying renderer the same string again.
// Anything that isn't an autolink is not this function's business: the `<`
// goes through as the ordinary character it is.
function readAutolink(
  markdown: string,
  angle: number,
  keep: (kept: string) => void,
): number {
  const close = markdown.indexOf('>', angle + 1);
  const candidate = close === -1 ? null : markdown.slice(angle, close + 1);

  if (candidate === null || !isAutolink(candidate)) {
    keep('<');
    return angle + 1;
  }

  if (isSafeDestination(candidate)) {
    keep(candidate);
  }
  return close + 1;
}

interface ParsedLink {
  label: string;
  destination: string;
  /** Index of the destination's closing parenthesis. */
  end: number;
}

// Where the label closes. CommonMark matches the label's brackets rather than
// stopping at the first `]`, and the difference is not cosmetic: this used to
// take `markdown.indexOf(']')`, so `[nota [2]](data:text/html,x)` was read as
// the label `nota [2` plus the destination... nothing, because the `]` it
// found is not followed by `(`. readLink then returned null, the `[` went out
// as an ordinary character, and the whole string — destination included —
// was copied to the output without any part of it ever being judged. A
// footnote marker, an array index or an image in the label was enough; no
// encoding required.
//
// So: count depth, and honour backslash escapes the way the destination scan
// already does. `firstCandidate` keeps the old reading as a fallback for when
// the balanced close is not followed by `(` at all (an unbalanced label, which
// a parser resolves by looking for a shorter match) — falling back to finding
// *a* link is the fail-closed direction, since every link this function finds
// is a link it judges.
function readLabelEnd(markdown: string, open: number): number {
  let depth = 1;
  let cursor = open + 1;
  let firstCandidate = -1;

  while (cursor < markdown.length) {
    const char = markdown[cursor];

    if (char === '\\' && cursor + 1 < markdown.length) {
      cursor += 2;
      continue;
    }

    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (firstCandidate === -1 && markdown[cursor + 1] === '(') {
        firstCandidate = cursor;
      }
      if (depth === 0) {
        return markdown[cursor + 1] === '(' ? cursor : firstCandidate;
      }
    }

    cursor += 1;
  }

  return firstCandidate;
}

function readLink(markdown: string, open: number): ParsedLink | null {
  const labelEnd = readLabelEnd(markdown, open);
  if (labelEnd === -1 || markdown[labelEnd + 1] !== '(') {
    return null;
  }

  let depth = 1;
  let cursor = labelEnd + 2;
  let destination = '';

  while (cursor < markdown.length) {
    const char = markdown[cursor];

    if (char === '\\' && cursor + 1 < markdown.length) {
      // An escaped character can neither open nor close the destination.
      destination += char + markdown[cursor + 1];
      cursor += 2;
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          label: markdown.slice(open + 1, labelEnd),
          destination,
          end: cursor,
        };
      }
    }

    destination += char;
    cursor += 1;
  }

  return null;
}

// Judges the *normalized* destination — the way a browser would read it,
// not the way it happens to be spelled. ASCII control characters are
// removed (the WHATWG URL parser strips tab/newline/CR before it looks at
// the scheme, which is exactly why `java<TAB>script:` executes), the rest
// is trimmed and lowercased. Normalizing can only make this check stricter:
// it never turns a destination that would have been rejected into an
// accepted one.
//
// The whole region the scanner read is examined, Markdown title syntax and
// all (`[x](url "title")`). A compliant parser would cut the title off at
// the first space; this filter deliberately looks at more, so that a
// renderer that doesn't cut it off is covered too.
//
// Looking at more is not free, though, and the comment here used to claim it
// was. This function only judges the *start* of what it is given, so the
// surplus it looks at is surplus it does not actually check. That is why the
// caller re-scans a region it has declared safe instead of copying it
// through — see rejectUnsafeLinks. The two halves belong together: this one
// decides the scheme, that one makes sure nothing else is hiding in the part
// no scheme check will ever reach.
//
// Character references are the second half of "the way a browser would read
// it", and the harder half. CommonMark resolves them *inside* destinations
// — `[foo](/f&ouml;&ouml;)` renders as `href="/foo"` with umlauts — so the
// filter was judging the string as written while the renderer judged it
// decoded. `&#106;avascript:`, `&#x6a;avascript:` and `javascript&colon;`
// all sailed past a scheme regex that found no `:` where it expected one,
// were declared relative, and were re-emitted verbatim for the renderer to
// decode back into an executable href.
//
// Two ways to close that, and this is the second one:
//
//   1. decode fully, then judge the decoded string. Most precise, but the
//      named references are hundreds of entries and there is no decoder
//      here — `entities` exists only as a transitive dependency, and
//      promoting it to a direct one to sanitize a handful of report strings
//      buys precision this file does not need.
//   2. treat a destination containing a character reference as unsafe
//      unless an allowed scheme is already spelled in the clear *before*
//      the first reference.
//
// What rules out the third option — a table of "the dangerous entities" —
// is that it is a denylist, the exact mistake the allowlist above replaced.
// `&colon;` alone shows why: hiding the delimiter is enough, and a
// delimiter has many spellings.
//
// Rule 2 is safe because the scheme is decided by the text before the first
// `:`, and a reference can only ever *add* to what precedes it. If `https:`,
// `http:` or `mailto:` is already complete and in the clear, no later
// reference can change which scheme the browser sees:
// `https://ok.example/&#106;avascript:x` is an https URL with an odd path.
// If it is not complete, there is no way to know what the destination
// decodes to without decoding it, so it does not survive.
//
// What carries that below is the `return reference === null` on the relative
// path, alone. There used to be a line here cutting the string at the first
// reference before running SCHEME, which read as the mechanism and was not:
// SCHEME is anchored and stops at the first `:`, so if a reference comes
// before that `:` the `&` blocks the match on the whole string exactly as it
// does on the prefix, and if it comes after, both forms match the same
// scheme. Four hundred thousand generated destinations produced no verdict
// the two spellings disagreed on, so the cut was removed rather than left
// standing as a step a reader would have to prove inert for themselves.
//
// What that costs, stated properly, because it used to be stated as just
// `/f&ouml;&ouml;` and that is the rare half of it: *any* relative
// destination containing `&amp;` loses its link and keeps its text — a query
// string (`/search?a=1&amp;b=2`), an anchor (`#a&amp;b`), a filename
// (`./R&amp;D.md`). Absolute http(s) destinations are unaffected, since the
// scheme is complete in the clear before the reference, so the damage is
// confined to relative links — but `&amp;` in a relative link is far more
// likely in a report than an umlaut entity. The trade is still the right way
// round (the failure mode is a link that isn't clickable rather than one
// that executes) and is worth knowing at its real size.
export function isSafeDestination(destination: string): boolean {
  const normalized = destination
    // Angle brackets go before the scheme check, so that CommonMark's
    // pointy-bracket destination form is judged by its scheme rather than
    // mistaken for a relative path: `[x](<javascript:alert(1)>)` starts with
    // `<`, which no scheme regex matches, and used to be waved through as
    // "relative" for that reason alone.
    //
    // This used to claim the removal "can only tighten the verdict, because
    // it shortens what precedes the first `:`". It does not only shorten: it
    // also *joins* what sits on either side. `htt<p://ok&amp;x` is rejected
    // without the removal (no scheme, and a reference present) and accepted
    // with it, because the fragments weld into `http://ok&amp;x`. That is
    // harmless today only because the renderer does not drop angle brackets
    // — it percent-encodes them, so `htt%3Cp:` is a scheme no browser will
    // execute — which is a different reason from the one written here
    // before, and a weaker one. Anything that later makes the two views
    // agree (percent-decoding, a renderer that normalizes) would turn this
    // into a hole, so the removal earns its place from the pointy-bracket
    // form it exists for, not from a monotonicity it does not have.
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex -- the point is the control characters
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .toLowerCase();

  const reference = CHARACTER_REFERENCE.exec(normalized);
  const scheme = SCHEME.exec(normalized);
  if (scheme === null) {
    // Relative — nothing a browser can execute — but only if it is still
    // relative once decoded, which is only knowable when there is nothing
    // left to decode.
    return reference === null;
  }
  return ALLOWED_SCHEMES.has(scheme[1]);
}

// Applies sanitizeMarkdown to every Markdown-bearing field across the Block
// union, by kind — structured fields (filePath, ruleId, severity, line
// numbers...) are never free-form text an agent could inject through, so
// they're left untouched. Proposal.diffUnified is a unified diff, not
// Markdown, and is intentionally out of scope here.
export function sanitizeReportBody(body: Block[]): Block[] {
  return body.map(sanitizeBlock);
}

function sanitizeBlock(block: Block): Block {
  switch (block.kind) {
    case 'TEXT':
      return { ...block, markdown: sanitizeMarkdown(block.markdown) };
    case 'FINDING':
      return {
        ...block,
        explanation: sanitizeMarkdown(block.explanation),
        remediation: sanitizeMarkdown(block.remediation),
      };
    case 'POLICY_VIOLATION':
      return {
        ...block,
        explanation: sanitizeMarkdown(block.explanation),
        remediation: sanitizeMarkdown(block.remediation),
      };
    case 'COMPLEXITY_WARNING':
      return { ...block, explanation: sanitizeMarkdown(block.explanation) };
    case 'CHANGELOG_ITEM':
      return { ...block, detail: sanitizeMarkdown(block.detail) };
  }
}
