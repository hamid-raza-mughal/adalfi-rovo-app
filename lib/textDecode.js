// lib/textDecode.js
// Fallback decode for agent text that arrives percent-encoded instead of plain text.
//
// The intended path (see app/api/webhook/callback/route.js) is Rovo sending `content` as
// {{agentText.jsonEncode}}, which already yields plain, readable text. But if a flow edit
// routes the text through urlEncode, or a web-request step form-encodes the body, `content`
// shows up as e.g. "%3D%3D%3D+P0+COLD+DISCOVERY+%3D%3D%3D%0A**Product+Names..." - percent
// escapes plus literal "+" for spaces (the application/x-www-form-urlencoded convention).
//
// decodeURIComponent alone does not touch "+", so it has to be swapped for a space first.
// Only attempt this when the string actually looks percent-encoded, and always inside a
// try/catch: plain markdown that happens to contain something like "25% done" is not valid
// percent-encoding and would otherwise throw ("URI malformed").
const LOOKS_PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/;

export function decodeIfPercentEncoded(content) {
  if (typeof content !== "string" || !LOOKS_PERCENT_ENCODED.test(content)) return content;
  try {
    const decoded = decodeURIComponent(content.replace(/\+/g, " "));
    return decoded !== content ? decoded : content;
  } catch {
    return content; // malformed escape sequence - show the raw text rather than erroring
  }
}
