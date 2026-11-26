// B1 monoplayer core: log redaction with a fixed sentinel.
//
// No token, refresh token, device code, RCON password, or other secret-shaped
// string may survive into logs, reports, or artifacts. `redact()` rewrites
// common secret shapes to the sentinel; every log line the core stores goes
// through it. Shapes are labelled ("field=<sentinel>") so redacted evidence
// stays greppable for the *shape* of the leak.
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
  let out = String(text)
  for (const re of rules) out = out.replace(re, keepLabel)
  return out
}

// Each replacement keeps the recognisable label (a quoted or bare field name
// followed by ':' or '=', or the scheme word) so a redacted line still shows WHICH
// secret shape was there.
const SCHEME_LABEL = new RegExp('^(' + KNOWN_SCHEMES + ')\\s+', 'i')

function keepLabel (match) {
  // JSON-quoted field names keep the label too: "access_token":"x" becomes
  // access_token=[REDACTED] (bare-field match falls back to the old form). The
  // closing quote may follow the name, because JSON puts one there.
  // The bare name stops at = as well as at :, because a value that ends in base64
  // padding would otherwise be read back as part of the label.
  const head = match.match(/^(?:"([^"]*)"|([^:="\s'\x60]+))"?\s*[:=]/)
  if (head) return `${head[1] ?? head[2]}=${SENTINEL}`
  const scheme = match.match(SCHEME_LABEL)
  if (scheme) return `${scheme[1]} ${SENTINEL}`
  return SENTINEL
}
