// Minimal HTML → Discord-markdown converter for embed text. Discord doesn't
// render HTML; the rich-text editor in /admin/competitions stores rendered
// HTML, so we transform a small set of tags before sending the embed.
//
// Discord markdown subset we target: **bold**, *italic*, __underline__,
// ~~strike~~, `code`, ```block```, > quote, - list, [link](url).
//
// Unknown tags are stripped, their inner text preserved. Entities are decoded.

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITY_MAP[m] ?? m)
}

function inlineReplace(s: string): string {
  return s
    .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, '*$1*')
    .replace(/<\s*u\s*>([\s\S]*?)<\s*\/\s*u\s*>/gi, '__$1__')
    .replace(/<\s*s\s*>([\s\S]*?)<\s*\/\s*s\s*>/gi, '~~$1~~')
    .replace(/<\s*del\s*>([\s\S]*?)<\s*\/\s*del\s*>/gi, '~~$1~~')
    .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, '`$1`')
    .replace(/<\s*a\s+[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, '[$2]($1)')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
}

function listReplace(s: string): string {
  // Each <li> on its own line with a bullet. Discord doesn't render real lists
  // inside embeds, but the bullet rendering with - is universal.
  return s
    .replace(/<\s*li\s*>([\s\S]*?)<\s*\/\s*li\s*>/gi, '- $1\n')
    .replace(/<\s*\/?\s*(?:ul|ol)\s*>/gi, '\n')
}

function blockReplace(s: string): string {
  return s
    .replace(/<\s*\/p\s*>/gi, '\n\n')
    .replace(/<\s*p[^>]*>/gi, '')
    .replace(/<\s*\/?\s*div[^>]*>/gi, '\n')
    .replace(/<\s*\/?\s*h[1-6][^>]*>/gi, '\n\n')
    .replace(/<\s*blockquote[^>]*>([\s\S]*?)<\s*\/\s*blockquote\s*>/gi, (_m, inner) =>
      String(inner)
        .split('\n')
        .map((l: string) => `> ${l}`)
        .join('\n'),
    )
}

function stripUnknown(s: string): string {
  return s.replace(/<\/?[^>]+>/g, '')
}

function collapseWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function htmlToDiscordMarkdown(input: string | null | undefined): string {
  if (!input) return ''
  // Quick exit: if the input has no tags, just decode entities and return.
  if (!/<[a-z!/]/i.test(input)) return collapseWhitespace(decodeEntities(input))
  let out = input
  out = listReplace(out)
  out = inlineReplace(out)
  out = blockReplace(out)
  out = stripUnknown(out)
  out = decodeEntities(out)
  return collapseWhitespace(out)
}
