// The scene: three isometric blocks, drawn by CSS, that say what the card below
// them says in words (#248).
//
// The look is built here and in src/panel/public/app.css, and nowhere else. No
// Mojang texture, icon, or font is copied into this repo: the blocks are three
// clipped polygons per cube over a repeating gradient, and the only font is VT323
// under the OFL, which ships beside it.
//
// The scene carries no text and no number. It is aria-hidden, because a colour is
// not a fact an operator can act on: the sentence beside it says which state the
// colour means, and every number stays in the lists under its own timestamp. A
// caption like "1 entry" in the scene would be a number with no record behind it,
// which is the one thing this page does not do.
//
// The colours are the state, and only the state:
//
//   serving   grass   the newest heartbeat is inside three intervals
//   stale     sand    the newest heartbeat is older than that
//   anything else      a block whose top face is dark: not serving, and the
//                      sentence says which fact is missing
import { escape } from './html.js'

// One cube, three faces. The faces are inset by the 2px the cube's own background
// shows through as the edge; the geometry is a true isometric diamond, so the
// blocks sit on the ground plane instead of floating beside each other.
function cube (kind, tone) {
  return '    <div class="cube cube--' + kind + (tone === null ? '' : ' cube--' + escape(tone)) + '">' +
    '<i class="face top"></i><i class="face left"></i><i class="face right"></i></div>\n'
}

// The top face of the puppet's block is the state. The two blocks beside it are
// the world it is dialled into and the list of who may attach: stone and dirt,
// always, because neither has a state the page colours.
function toneOf (state) {
  if (state === 'serving') return 'grass'
  if (state === 'stale') return 'sand'
  if (state === 'not-ready' || state === 'no-heartbeat' || state === 'no-pod') return 'clay'
  return 'bedrock'
}

export function renderStage (facts) {
  const state = facts?.state?.state ?? null
  return [
    '  <div class="stage" aria-hidden="true">',
    '    <div class="ground"></div>',
    '    <div class="row">',
    cube('puppet', state === null ? null : toneOf(state)),
    cube('world', 'stone'),
    cube('attach', 'dirt'),
    '    </div>',
    '  </div>',
    ''
  ].join('\n')
}
