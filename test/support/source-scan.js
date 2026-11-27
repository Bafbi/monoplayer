// The source scans the guard tests share (#764, #847): a block, a declaration, a call, and the
// names a block's own depth holds. A guard that reads a source file as text imports one of
// these, and every walk they are built on is private to this module. The exports below are the
// list.
//
// One copy, because a scan that stops matching the file it reads keeps passing. #710's
// rule is that a source scan proves a branch is mentioned and never that it runs; a scan
// whose subject moved proves less than that, and two sets of brace walks over one file
// disagree the day one of them learns a shape the other does not, with nothing red to say
// so. test/tooling/source-scan-home.test.js holds the other direction: a brace walk
// declared in any other file under test/ fails there, read by its shape rather than by a
// name it could spell in advance.
//
// A scan that reads a block or a call throws, naming the byte or the thing it looked for,
// rather than returning a partial read: a case that passes on an empty list is the defect these
// guards exist to catch. topLevelNames is the one export that does not throw, because a literal
// can be partial by nature, and its own comment says what it does not read.
// test/tooling/manifest-reader.js states the same policy for the manifests it reads.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on its own.

// The block whose opening brace is the first one at or after `after`, matched to its
// partner, with where it opens, where it closes, and the text between the two. `what` is
// the thing being read, and it is what a failure names.
export function blockSpan (source, after, what) {
  if (after < 0) throw new Error('source scan: ' + what + ' is not there to open a block after')
  const open = source.indexOf('{', after)
  if (open === -1) throw new Error('source scan: ' + what + ' has no block to open')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { open, close: i, body: source.slice(open + 1, i) }
    }
  }
  throw new Error('source scan: the block of ' + what + ' never closes')
}

// The block a marker opens: the first block whose brace is at or after the marker. A marker the
// source does not hold throws, naming it, so a case cannot read a file's first brace by
// accident and then pass.
export function blockAfter (source, marker, what) {
  const at = source.indexOf(marker)
  if (at === -1) throw new Error('source scan: ' + what + ' is not in the source')
  return blockSpan(source, at, what)
}

// The names a block's own depth holds, in source order: a line at that depth that opens
// with `name:` or `name,`, which is a field of a record literal and a shorthand one
// alike. A nested literal contributes its own name and none of its keys, so a field inside
// an object a record carries is not read as a field of the record.
//
// A literal written on one line is one field to this reader, whatever its commas say, and the
// shorthand that closes a multi-line literal carries no comma and is not read. A case that must
// read either splits the block's body itself (#861).
export function topLevelNames (body) {
  const names = []
  let inner = 0
  for (const line of body.split('\n')) {
    if (inner === 0) {
      const named = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/)
      if (named !== null) names.push(named[1])
    }
    inner += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
  }
  return names
}

// Every `refuseAndCount({...})` call in the source, as where it starts and the object literal
// it passes. The byte is what lets a failure name one site when two of them pass the same
// reason.
//
// A site spelled around the scan (a space before the object, an alias) is not read, so a
// case that must know every call was read compares this list against the file's own count
// of the helper.
export function countedSites (source) {
  const sites = []
  for (let at = source.indexOf('refuseAndCount({'); at !== -1; at = source.indexOf('refuseAndCount({', at + 1)) {
    sites.push({ at, body: blockSpan(source, at, 'the refusal site at byte ' + at).body })
  }
  return sites
}

// One declaration's body and where its body opens, so a case can assert about the text in
// front of a call rather than about the declaration as a whole. The body is brace matched
// from the brace that closes the parameter list, never from the one a destructured
// parameter opens.
export function signatureSpan (source, signature, what) {
  const at = source.indexOf(signature)
  if (at === -1) throw new Error('source scan: ' + what + ' is not in the source')
  const list = source.indexOf(') {', at)
  if (list === -1) throw new Error('source scan: no body brace for ' + what)
  return blockSpan(source, list + 2, what)
}

// Both modules a case reads declare their functions at two spaces inside a factory, and
// that indent is how they are found: a function moved to another indent is not found, and
// the case fails saying what the scan looked for.
export function functionSpan (source, name) {
  const span = signatureSpan(source, '\n  function ' + name + ' (',
    'the function ' + name + ' declared at two spaces inside a factory')
  return { from: span.open + 1, body: span.body }
}

// The body alone, for a case that reads no offset.
export function functionBody (source, name) {
  return functionSpan(source, name).body
}

// Every call of `name` in the source, by paren matching: where the name starts, where its
// arguments open, where the call closes, and the arguments split at the commas that sit
// outside brackets, braces and strings. The name is matched as a whole word, so a scan for
// `log(` does not read `slog(`.
//
// The extent is read by parens alone, so a `)` inside a string argument ends the call early and
// the arguments after it are not read. That is inherited from the scans this replaces, and no
// case reads a call whose string holds one.
export function callSpans (source, name) {
  const sites = []
  for (const found of source.matchAll(new RegExp('\\b' + name + '\\(', 'g'))) {
    const at = found.index
    const open = at + name.length
    let depth = 0
    let close = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    if (close === -1) {
      throw new Error('source scan: the ' + name + ' call at byte ' + at + ' never closes its arguments')
    }
    sites.push({ at, open, close, args: splitArguments(source.slice(open + 1, close)) })
  }
  return sites
}

// Every `endConfiguration(client, '<reason>', <sentence>)` call in the source, with its
// arguments split: the sentence is the last argument, and it is a call or a property access
// as often as a name.
export function endSites (source) {
  return callSpans(source, 'endConfiguration')
    // The definition, not a call.
    .filter(site => !/function\s+$/.test(source.slice(Math.max(0, site.at - 24), site.at)))
    .map(({ at, args }) => ({ at, args }))
}

// One call's arguments, split at the commas that sit outside brackets, braces and strings.
// The second argument of an end is a quoted word as often as a concatenation, so a plain
// split would cut one in two.
function splitArguments (text) {
  const args = []
  let depth = 0
  let quote = null
  let from = 0
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quote !== null) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) { args.push(text.slice(from, i).trim()); from = i + 1 }
  }
  args.push(text.slice(from).trim())
  return args
}
