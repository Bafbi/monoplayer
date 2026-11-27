// The source scans the guard tests share (#764): every counted refusal site, one function's body,
// and every end call's arguments. The splitter those last two need is private to this module. Two
// guard files read src/legs/live-front.js and src/service/monoplayer.js as text, and each carried
// its own copy of all four.
//
// One copy, because a scan that stops matching the file it reads keeps passing. #710's rule is that
// a source scan proves a branch is mentioned and never that it runs; a scan whose subject moved
// proves less than that, and two sets of brace walks over one file disagree the day one of them
// learns a shape the other does not, with nothing red to say so.
//
// A scan that cannot read what it was asked for throws, naming the byte or the function, rather than
// returning a partial read: a case that passes on an empty list is the defect these guards exist to
// catch. test/tooling/manifest-reader.js states the same policy for the manifests it reads.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on its own.

// Every `refuseAndCount({...})` call in the source, as where it starts and the object literal it
// passes, by brace matching so a record closure nested in one site is not mistaken for the end of
// it. The byte is what lets a failure name one site when two of them pass the same reason.
//
// A site spelled around the scan (a space before the object, an alias) is not read, so a case that
// must know every call was read compares this list against the file's own count of the helper.
export function countedSites (source) {
  const sites = []
  for (let at = source.indexOf('refuseAndCount({'); at !== -1; at = source.indexOf('refuseAndCount({', at + 1)) {
    const from = source.indexOf('{', at)
    let depth = 0
    let end = -1
    for (let i = from; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) throw new Error('source scan: the refusal site at byte ' + at + ' never closes its object')
    sites.push({ at, body: source.slice(from + 1, end) })
  }
  return sites
}

// One function's body and where it starts in the source, so a case can assert about the text in
// front of a call rather than about the function as a whole. The body is brace matched from its own
// body brace, never from the one a destructured parameter opens.
//
// Both modules a case reads declare their functions at two spaces inside a factory, and that indent
// is how they are found: a function moved to another indent is not found, and the case fails saying
// what the scan looked for.
export function functionSpan (source, name) {
  const at = source.indexOf('\n  function ' + name + ' (')
  if (at === -1) {
    throw new Error('source scan: no function ' + name + ' declared at two spaces inside a factory')
  }
  const open = source.indexOf(') {', at) + 2
  if (open <= 2) throw new Error('source scan: the function ' + name + ' has no body brace')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { from: open + 1, body: source.slice(open + 1, i) }
    }
  }
  throw new Error('source scan: the body of ' + name + ' never closes')
}

// The body alone, for a case that reads no offset.
export function functionBody (source, name) {
  return functionSpan(source, name).body
}

// Every `endConfiguration(client, '<reason>', <sentence>)` call in the source, with its arguments
// split: the sentence is the last argument, and it is a call or a property access as often as a
// name.
export function endSites (source) {
  const sites = []
  for (let at = source.indexOf('endConfiguration(');
    at !== -1;
    at = source.indexOf('endConfiguration(', at + 1)) {
    // The definition, not a call.
    if (/function\s+$/.test(source.slice(0, at))) continue
    const open = source.indexOf('(', at)
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end === -1) throw new Error('source scan: the end site at byte ' + at + ' never closes its call')
    sites.push({ at, args: splitArguments(source.slice(open + 1, end)) })
  }
  return sites
}

// One call's arguments, split at the commas that sit outside brackets, braces and strings. The
// second argument of an end is a quoted word as often as a concatenation, so a plain split would
// cut one in two.
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
