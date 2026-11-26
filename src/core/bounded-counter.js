// #438: one bounded map of counts, keyed by a string that is not a closed set.
//
// Two copies of this rule lived either side of the leg/service boundary: the front
// leg's refusal reasons (#417) and the composition root's packet names. They
// drifted three ways: the cap, what an empty key became, and whether the map came
// back. #417's comment also named the other copy as the one to imitate. So one rule,
// one home, and the caller supplies the part that is its own fact.
//
// The cap is a parameter, because how much headroom a map wants is the caller's
// fact: packet names are a fixed protocol vocabulary with room for one client's
// nonsense, while a refusal reason is one word out of a set the leg itself writes.
//
// A key that is not a name counts as UNKNOWN_KEY, and an empty string is not a
// name. `''` is a label with nothing in it, which reads the same as a label that is
// missing, so a chart cannot say which happened and neither says the one thing an
// operator needs, which is that something was counted under a word nobody had. Both
// maps answer `unknown`, so the two charts read alike.
//
// It never throws. This runs in a live session's relay path, so a caller that
// passes a cap bounding nothing must not take a session down with it.
//
// Past the cap, a name the map has never held lands in OVERFLOW_KEY: the map stops
// growing and a reader still sees that something was counted. A name already in the
// map keeps counting on its own key after the cap is reached, because the overflow
// bucket is for the names the map turned away, not for the ones it promised to keep.
export const UNKNOWN_KEY = 'unknown'
export const OVERFLOW_KEY = 'other'

export function bumpBounded (map, key, cap) {
  const name = typeof key === 'string' && key.length > 0 ? key : UNKNOWN_KEY
  if (map[name] !== undefined) { map[name]++; return map }
  if (Object.keys(map).length >= cap) { map[OVERFLOW_KEY] = (map[OVERFLOW_KEY] ?? 0) + 1; return map }
  map[name] = 1
  return map
}
