// The source scans the guard tests share (#764): a counted call site, one function's body, and an
// end call's arguments. Two guard files read src/legs/live-front.js and src/service/monoplayer.js
// as text, and each kept its own copy of all four helpers.
//
// One copy, because a scan that stops matching the file it reads keeps passing. #710's rule is that
// a source scan proves a branch is mentioned and never that it runs; a scan whose subject moved
// proves less than that, and two sets of brace walks over one file disagree the day one of them
// learns a shape the other does not, with nothing red to say so.
//
// Each scan asserts rather than returning a partial read: a case that cannot see the site it
// judges fails, naming the byte, instead of passing on an empty list.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on its own.
import assert from 'node:assert/strict'

// Every `refuseAndCount({...})` call in the source, as the object literal it passes, by brace
// matching so a record closure nested in one site is not mistaken for the end of it.
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
    assert.notEqual(end, -1, 'the refusal site at byte ' + at + ' closes')
    sites.push(source.slice(from + 1, end))
  }
  return sites
}

// One function's body and where it starts in the source, so a case can assert about the text in
// front of a call rather than about the function as a whole. The body is brace matched from its own
// body brace, never from the one a destructured parameter opens.
//
// Both modules a case reads declare their functions at two spaces inside a factory, and that indent
// is how they are found: a function moved to another indent is not found, and the case fails saying
// the module has no such function.
export function functionSpan (source, name) {
  const at = source.indexOf('\n  function ' + name + ' (')
  assert.notEqual(at, -1, 'the module has the function ' + name)
  const open = source.indexOf(') {', at) + 2
  assert.ok(open > 2, name + ' has a body')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { from: open + 1, body: source.slice(open + 1, i) }
    }
  }
  assert.fail(name + ' closes')
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
    assert.notEqual(end, -1, 'the end site at byte ' + at + ' closes')
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
