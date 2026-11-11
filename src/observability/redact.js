// B1 monoplayer core: log redaction with a fixed sentinel.
//
// No token, refresh token, device code, RCON password, or other secret-shaped
// string may survive into logs, reports, or artifacts. `redact()` rewrites
// common secret shapes to the sentinel; every log line the core stores goes
// through it. Shapes are labelled ("field=<sentinel>") so redacted evidence
// stays greppable for the *shape* of the leak.

export const SENTINEL = '[REDACTED]'

// JSON-ish / form-ish field names whose values are always secrets.
const SECRET_FIELDS = [
  'access_token', 'accesstoken', 'refresh_token', 'refreshtoken',
  'id_token', 'device_code', 'device_code_pairing', 'user_code',
  'client_secret', 'xbl_token', 'xsts_token', 'mca_token',
  'authorization', 'cookie', 'rcon_password', 'password'
]

// A bare value stops at the punctuation that ends it: a form's & or ;, and
// the } and ] that close a JSON member or array. A comma is not among them: a
// form value may hold one, and stopping there would leave its tail in the log.
const VALUE_CHARS = String.raw`[^"'}\];&| ]+`

// The RFC 7235 scheme word whose credential follows the word. The scheme is a
// label, not the secret, so the field rule takes both and rule 2 never has to
// fire behind a field name (#92).
const SCHEME = String.raw`bearer\s+`

// A sentinel is the result of redacting, never a value to redact again, so a
// redacted line stays byte-identical when it is passed through twice.
const SENTINEL_GUARD = String.raw`(?!(?:"|')?\[REDACTED\])`

const rules = [
  // JSON / URL / forms: "access_token":"abc", refresh_token=abc, ?password=abc.
  // Also an Authorization header, whose value sits behind a scheme word:
  // Authorization: Bearer abc. Keeps the field name, redacts the value.
  new RegExp(
    String.raw`("?)(?:` + SECRET_FIELDS.join('|') + String.raw`)\1\s*[:=]\s*(?:` + SCHEME + String.raw`)?` +
      SENTINEL_GUARD + String.raw`(?:"[^"]*"|'[^']*'|` + VALUE_CHARS + `)`,
    'gi'
  ),
  // RFC 7235 style: "Bearer eyJ..." (Authorization header values).
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
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
// followed by ':' or '=', or "Authorization's" "Bearer ") so a redacted line
// still shows WHICH secret shape was there.
function keepLabel (match) {
  // JSON-quoted field names keep the label too: "access_token":"x" becomes
  // access_token=[REDACTED] (bare-field match falls back to the old form).
  const head = match.match(/^(?:"([^"]*)"\s*[:=]|([^:"\s'`]+)\s*[:=])/)
  if (head) return `${head[1] ?? head[2]}=${SENTINEL}`
  if (/^Bearer/i.test(match)) return `Bearer ${SENTINEL}`
  return SENTINEL
}
