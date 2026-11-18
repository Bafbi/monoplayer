// The small vocabulary every view shares: escaping, the null-versus-zero rules,
// and the two shapes a fact is printed in (#248).
//
// One place, because the page's promise is that a number never appears without
// the record it came from. That promise is enforced by row() and sourced(), and a
// view that did its own string building would be the way it gets broken.

export const escape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

export const present = value => value !== null && value !== undefined && value !== ''
export const yesno = value => (value === true ? 'yes' : value === false ? 'no' : null)
export const dayWord = days => (Math.abs(days) === 1 ? 'day' : 'days')
export const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// A value that came with a record says which record and when. A cap read from the
// Deployment says so too, because the Deployment has no timestamp and the reader
// needs to know that.
export function sourced (fact) {
  if (fact === null || fact === undefined) return null
  const where = present(fact.at) ? fact.source + ', ' + fact.at : fact.source
  return fact.value + ' (' + where + ')'
}

export function bytes (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return unit === 0 ? value + ' B' : value + ' (' + (Math.round(size * 10) / 10) + ' ' + units[unit] + ')'
}

// The Deployment env is a value nobody rewrote at a known instant, so it carries
// the source and no timestamp.
export const env = value => (present(value) ? value + ' (Deployment env, no timestamp)' : null)

// A millisecond cap in the unit an operator reads it in.
export function span (value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value >= 86_400_000) return value + ' ms (' + Math.round((value / 86_400_000) * 10) / 10 + ' days)'
  if (value >= 3_600_000) return value + ' ms (' + Math.round((value / 3_600_000) * 10) / 10 + ' hours)'
  return value + ' ms'
}

export function row (label, value) {
  if (!present(value)) return ''
  return '      <div><dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd></div>\n'
}

export function list (rows) {
  const body = rows.filter(line => line !== '').join('')
  return body === '' ? '' : '    <dl>\n' + body + '    </dl>\n'
}

export function group (title, rows) {
  const body = list(rows)
  return body === '' ? '' : '    <h4>' + escape(title) + '</h4>\n' + body
}

export function heading (title, at, note = null) {
  return '    <h3>' + escape(title) +
    (present(at) ? ' <time>' + escape(at) + '</time>' : '') +
    (present(note) ? ' <span class="note">' + escape(note) + '</span>' : '') +
    '</h3>\n'
}
