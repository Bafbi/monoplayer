// The body of a write request, bounded, for every panel route that takes one.
//
// Two routes read a JSON body (#232, #262) and both want the same two facts: the
// bytes, and whether there were more than the panel allows. The cap is this
// module's, and so is the answer a caller gets for exceeding it. A route that names
// its own cap can bound the body differently by accident, and two numbers that agree
// today are two numbers waiting to disagree (#250).
//
// What the bytes past the cap are not is buffered. They are counted and thrown away,
// so a request that is not this route's costs bandwidth and never memory. Both halves
// are one rule, which is why this is one function and not two copies.
//
// A request body is one uuid, or one name, or one address, and the cap is generous
// beside that: it still refuses a body that is not this request at all.
export const MAX_BODY_BYTES = 4096

// The 413 answer, whole, spelled once. It quotes the cap this module enforces, so it
// cannot name a number the reader did not apply, and it is a complete body rather than
// a fragment, so it carries its own line ending.
export const BODY_TOO_LARGE = 'the request body must be at most ' + MAX_BODY_BYTES + ' bytes\n'

export function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: size > MAX_BODY_BYTES }))
    req.on('error', reject)
  })
}
