import { readFileSync, writeFileSync } from 'fs'

const raw = readFileSync('/dev/stdin', 'utf-8').trim()
const FM_RE = /^---\n([\s\S]*?)\n---\n\n?/
const m = raw.match(FM_RE)
if (!m) { console.log(raw); process.exit(0) }

const fmRaw = m[1]
const body = m[2]

// Parse YAML-ish frontmatter
const fm = {}
for (const line of fmRaw.split('\n')) {
  const [k, ...rest] = line.split(': ')
  const v = rest.join(': ').trim()
  if (line.startsWith('  ')) continue // skip nested
  if (k && v) fm[k.trim()] = v
}

// Extract ## Draft section (fixed logic)
let preamble = body
let draft = ''
const draftMatch = body.match(/^## Draft\n\n([\s\S]*)$/m)
if (draftMatch) {
  draft = draftMatch[1].trim()
  preamble = body.replace(/^## Draft\n\n[\s\S]*$/, '').trim()
}

// For archive, the body is corrupted with draft text. Original idea = first sentence.
const firstSentence = preamble.split(/\.\s+/)[0] + '.'
const cleanBody = firstSentence

// Reconstruct
const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`)
const parts = [`---`, ...fmLines, `---`, '', cleanBody]
if (draft) parts.push('', `## Draft`, '', draft)
console.log(parts.join('\n'))
