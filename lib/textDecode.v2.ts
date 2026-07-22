// lib/textDecode.v2.ts
// v2 of the decode fallback. lib/textDecode.js (v1) only ever reversed one encoding
// (urlEncode/percent-encoding) and is left untouched below it - this file is a structural
// iteration, not a patch: it adds an HTML/XML-entity decoder for flows built with
// `htmlEncode` (or `xmlEncode`) and a dispatcher that inspects the content and picks the
// right decoder, so the route files don't need to know in advance which smart-value
// function a given Rovo flow used.
//
// Confirmed against Atlassian's smart-value text-function docs (support.atlassian.com/
// cloud-automation/docs/jira-smart-values-text-fields/), not assumed - this codebase already
// found one smart-value name (`base64Encode`) that looks real but silently no-ops, so the
// other encode functions were checked before building decoders around them:
//   jsonEncode: "Hello World"        -> "Hello World"            (JSON.parse already reverses it)
//   urlEncode:  "Hello & World"      -> "Hello+%26+World"        (space -> "+", specials -> %XX)
//   htmlEncode: "Waiting for R&D"    -> "Waiting for R&amp;D"    (named HTML entities)
//   xmlEncode:  "Hello & World"      -> "Hello &amp; World"      (same core entities as HTML)
// htmlEncode/xmlEncode overlap on the 5 characters both specs predefine (& < > " '), which is
// what decodeHtmlEntities reverses, plus generic numeric character references (&#39; / &#x27;)
// for anything else that came through as a numeric ref. It does NOT carry the full HTML5 named-
// entity table (&hellip;, &mdash;, etc.) - that's a deliberate scope call, not an oversight: this
// app's content is LLM-generated markdown, not arbitrary rich HTML, so the realistic character
// set is narrow. If Rovo's htmlEncode turns out to emit named entities beyond the basic 5 for
// this app's replies, extend NAMED_ENTITIES rather than pulling in a dependency for it.

const LOOKS_URL_ENCODED = /%[0-9A-Fa-f]{2}/;
const LOOKS_HTML_ENCODED = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/i;
const HTML_ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9A-Fa-f]+));/gi;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Reverses urlEncode(): "+" is a literal space in this convention and decodeURIComponent
// does not touch it, so swap it in before decoding. Guarded + try/catch because
// decodeURIComponent throws on a "%" that isn't followed by two hex digits - which plain
// text containing a percentage ("25% done") would otherwise trip.
export function decodeUrlEncoding(content: string): string {
  if (typeof content !== "string" || !LOOKS_URL_ENCODED.test(content)) return content;
  try {
    const decoded = decodeURIComponent(content.replace(/\+/g, " "));
    return decoded !== content ? decoded : content;
  } catch {
    return content; // malformed escape sequence - show the raw text rather than erroring
  }
}

// Reverses htmlEncode()/xmlEncode(). Bounds-checked: a crafted numeric reference outside the
// valid code point range would make String.fromCodePoint throw, so out-of-range refs are left
// as-is instead of erroring (this endpoint is internet-facing, see route.ts).
export function decodeHtmlEntities(content: string): string {
  if (typeof content !== "string" || !LOOKS_HTML_ENCODED.test(content)) return content;
  return content.replace(
    HTML_ENTITY,
    (match: string, name: string | undefined, dec: string | undefined, hex: string | undefined) => {
      let codePoint: number | undefined;
      if (dec !== undefined) codePoint = parseInt(dec, 10);
      else if (hex !== undefined) codePoint = parseInt(hex, 16);
      if (codePoint !== undefined) {
        return codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
      }
      // The regex's three groups are mutually exclusive alternatives, so reaching here
      // always means `name` matched - but narrow explicitly rather than assert it.
      if (name === undefined) return match;
      return NAMED_ENTITIES[name.toLowerCase()] ?? match;
    }
  );
}

// The dispatcher: inspect the content and apply whichever decoder (if any) matches. Order
// only matters for the (unlikely, for this app's markdown replies) case where a string could
// match both signatures - percent-encoding is the more specific signal, so it's tried first.
// Plain jsonEncode'd text matches neither and passes through unchanged.
export function decodeAgentText(content: string): string {
  if (typeof content !== "string") return content;
  if (LOOKS_URL_ENCODED.test(content)) return decodeUrlEncoding(content);
  if (LOOKS_HTML_ENCODED.test(content)) return decodeHtmlEntities(content);
  return content;
}
