// B1 monoplayer core: log redaction with a fixed sentinel.
//
// No token, refresh token, device code, RCON password, or other secret-shaped
// string may survive into logs, reports, or artifacts. `redact()` rewrites
// common secret shapes to the sentinel; every log line the core stores goes
// through it. A redacted span keeps its label, a field's name or the key of a JSON
// member, so redacted evidence stays greppable for the *shape* of the leak.
//
// A JSON document is read as a document, not as text (#553). A regex over the line
// cannot tell an object key from a field, so a counter map keyed by an open string
// (#438) rewrote its own key and the line stopped being JSON. A document that
// carries a secret is rebuilt from its parts, so the document it rewrites parses, and
// a document it has nothing to do in is returned untouched. It costs a count under a
// key that is a secret name, which comes back as the sentinel, and a compact line for
// a document that was pretty-printed.
//
// This module is also where the redaction vocabulary is spelled. `SECRET_FIELDS`
// is the one list of names whose value is a secret: `src/observability/secrets.js`
// imports it, and the custody report helper no longer writes one of its own. And
// the credential grammar below (`CREDENTIAL_SCHEME`, `KNOWN_SCHEMES`,
// `CREDENTIAL`, `CREDENTIAL_SHAPE`) is the one a scheme-shaped secret is read
// with. Two lists that disagree is how a name came to be redacted on one path and
// not the other, in both directions (#181, #183).

export const SENTINEL = '[REDACTED]'

// JSON-ish / form-ish field names whose values are always secrets. Longest name
// first inside a family, so `device_code_pairing` is read as itself rather than
// as `device_code` and a tail.
export const SECRET_FIELDS = [
  'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'id_token', 'device_code_pairing', 'device_code', 'user_code',
  'client_secret', 'xbl_token', 'xsts_token', 'mca_token',
  'authorization', 'cookie', 'rcon_password', 'password',
  'token', 'secret', 'bearer', 'credential', 'passwd', 'api[-_]?key'
]

// An RFC 7235 scheme word. Behind an Authorization field it is a label, not the
// secret, and any scheme counts: the next operator pastes Basic, and `Basic` is
// not `bearer` (#182).
export const CREDENTIAL_SCHEME = String.raw`[A-Za-z][A-Za-z0-9!#$%&'*+.^_\x60|~-]*`

// The schemes a bare credential may follow, with no field name to scope it. A bare
// "word word" is prose, so this list is closed: measured, an open scheme match
// rewrites "loading something into memory" and "the token cache is warm" (#182).
export const KNOWN_SCHEMES = String.raw`Bearer|Basic|Digest|Negotiate`

// A credential. The floor is eight characters, matching the floor the report
// scanner's assignment rule applies, so a value short enough to be a word is not read
// as a secret. The two rules read different character classes, so the number agrees
// by convention and not by construction.
export const CREDENTIAL = String.raw`[A-Za-z0-9._~+/=-]{8,}`

// Prose after a scheme name is letters, as in "Basic authentication is required".
// A credential carries at least one character outside [A-Za-z], so the length
// floor alone never has to tell the two apart (#182).
export const CREDENTIAL_SHAPE = String.raw`(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])`

// A bare value stops at the punctuation that ends it: a form's & or ;, and
// the } and ] that close a JSON member or array. A comma is not among them: a
// form value may hold one, and stopping there would leave its tail in the log.
const VALUE_CHARS = String.raw`[^"'}\];&| ]+`

// A sentinel is the result of redacting, never a value to redact again, so a
// redacted line stays byte-identical when it is passed through twice.
const SENTINEL_GUARD = String.raw`(?!(?:"|')?\[REDACTED\])`

// The names above as a whole object key. A key that IS the name is a field, and its
// value goes. A key that only carries the name is a name about something else: a
// counter called `token_count` counts tokens and is not one. Reading the key by its
// shape is what stops a map key from being rewritten as a field (#553). The key's
// own text still faces the text rules below, because a secret used AS a key is a
// secret, and a JWT is one whatever position it sits in.
const SECRET_KEY = new RegExp('^(?:' + SECRET_FIELDS.join('|') + ')$', 'i')

// A document starts with an object or an array. Anything else goes to the text
// rules, including a bare JSON string or number, which is a value and not a line.
const DOCUMENT = /^\s*[{[]/

const rules = [
  // JSON / URL / forms: "access_token":"abc", refresh_token=abc, ?password=abc.
  // Also an Authorization header, whose value sits behind a scheme word:
  // Authorization: Basic abc. Any scheme, because the field name is what scopes
  // the match; keeps the field name, redacts the scheme and the value.
  new RegExp(
    String.raw`("?)(?:` + SECRET_FIELDS.join('|') + String.raw`)\1\s*[:=]\s*(?:` + CREDENTIAL_SCHEME + String.raw`\s+)?` +
      SENTINEL_GUARD + String.raw`(?:"[^"]*"|'[^']*'|` + VALUE_CHARS + `)`,
    'gi'
  ),
  // A bare credential behind a scheme name, with no field name to scope it:
  // "sent Bearer eyJ...". The scheme stays as the label.
  new RegExp(String.raw`\b(?:` + KNOWN_SCHEMES + String.raw`)\s+` + CREDENTIAL_SHAPE + CREDENTIAL, 'gi'),
  // Bare JWTs (base64url header.payload) that appear as raw strings.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9_-]{6,})?\b/g
]

export function redact (text) {
  if (text == null) return text
  const source = String(text)
  if (DOCUMENT.test(source)) {
    try {
      return redactDocument(source)
    } catch {
      // Not a document after all, or one too deep to walk: a log line, a chat
      // string, a form. The text rules own it, and they cannot throw.
    }
  }
  return redactText(source)
}

// A document with nothing to redact is returned byte-identical, so a line keeps the
// spelling it was written with. Rebuilding it anyway would reprint a number and
// reorder an integer-like key, and a log line is evidence. A document that does
// carry a secret is rebuilt from its own parts, because there is no way to splice a
// sentinel into one by hand and still have it parse. Every sink this tree has writes
// `JSON.stringify` output, where that round trip is the identity. Two secret-shaped
// keys in one object rebuild as one sentinel key, so the later member keeps the
// place: both keys were secrets, and neither may be printed.
function redactDocument (source) {
  let changed = false
  const redactNode = item => {
    if (Array.isArray(item)) return item.map(redactNode)
    if (item !== null && typeof item === 'object') {
      // Object.fromEntries defines an own property, so a key named __proto__ is
      // rebuilt as a member. Assigning it would set the prototype instead, and the
      // member would leave the document.
      return Object.fromEntries(Object.entries(item).map(([key, child]) => {
        // The key keeps its label, and the sentinel takes the place of the value
        // under it. The key's own text faces the text rules, for a secret used as a
        // key.
        const label = redactText(key)
        if (label !== key) changed = true
        if (SECRET_KEY.test(key)) {
          changed = true
          return [label, SENTINEL]
        }
        return [label, redactNode(child)]
      }))
    }
    if (typeof item !== 'string') return item
    const redacted = redactText(item)
    if (redacted === item) return item
    changed = true
    return redacted
  }
  const out = redactNode(JSON.parse(source))
  return changed ? JSON.stringify(out) : source
}

function redactText (text) {
  let out = String(text)
  for (const re of rules) out = out.replace(re, keepLabel)
  return out
}

// Each replacement keeps the recognisable label (a quoted or bare field name
// followed by ':' or '=', or the scheme word) so a redacted line still shows WHICH
// secret shape was there. This is the text rule: a JSON document has already been
// read by `redactDocument` above, so a quoted label here sits inside a string value.
const SCHEME_LABEL = new RegExp('^(' + KNOWN_SCHEMES + ')\\s+', 'i')

function keepLabel (match) {
  // The closing quote may follow the name, because a value inside a JSON string can
  // carry one: the document was already walked, so what reaches here is text.
  // The bare name stops at = as well as at :, because a value that ends in base64
  // padding would otherwise be read back as part of the label.
  const head = match.match(/^(?:"([^"]*)"|([^:="\s'\x60]+))"?\s*[:=]/)
  if (head) return `${head[1] ?? head[2]}=${SENTINEL}`
  const scheme = match.match(SCHEME_LABEL)
  if (scheme) return `${scheme[1]} ${SENTINEL}`
  return SENTINEL
}
