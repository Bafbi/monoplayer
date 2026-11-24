// The body of a write request, bounded, for every panel route that takes one.
//
// Three routes read a JSON body (#233, #232, #262) and all three want the same two
// facts: the bytes, and whether there were more than the route allows. The cap is the
// caller's, because each route names its own in an answer a caller can act on.
//
// What the bytes past the cap are not is buffered. They are counted and thrown away,
// so a request that is not this route's costs bandwidth and never memory. Both halves
// are one rule, which is why this is one function and not three copies: a route that
// reads its own body is a route that can bound it differently by accident.
export function readBody (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size <= limit) chunks.push(chunk)
    })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: size > limit }))
    req.on('error', reject)
  })
}
