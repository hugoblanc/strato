/**
 * The Strato mark: a satellite inside a ring. From up there it sees everything, and its amber beacon is the one signal
 * that comes back down to you. The single source of the logo: the board header, the favicon and the files in assets/
 * are all drawn from here (`bun strato.ts brand` writes assets/).
 */

const AMBER = "#f2b84b";
const IDLE = "#4b5058";

export interface MarkOptions {
  /** Colour of the ring and the satellite; `currentColor` follows the text colour of where the mark sits. */
  ink?: string;
  /** Colour of the beacon: amber when something waits, grey otherwise. */
  lamp?: string;
  /** Draw the simplified satellite (one solid panel per wing, no dish): readable at 16 and 32 px. */
  small?: boolean;
}

/** The satellite and its ring, in a 48 x 48 box, without the <svg> wrapper. */
export function markShapes(o: MarkOptions = {}): string {
  const ink = o.ink ?? "currentColor";
  const lamp = o.lamp ?? AMBER;
  if (o.small) {
    return `<circle cx="24" cy="24" r="20.5" stroke="${ink}" stroke-width="4.5" fill="none"/>
<g transform="rotate(-35 24 24)">
<rect x="6.5" y="20" width="10.5" height="9" rx="1.2" fill="${ink}"/>
<rect x="31" y="20" width="10.5" height="9" rx="1.2" fill="${ink}"/>
<rect x="18.5" y="18.5" width="11" height="12" rx="2" fill="${ink}"/>
<rect x="23" y="13" width="2" height="6" fill="${ink}"/>
<circle cx="24" cy="11.5" r="3.8" fill="${lamp}"/>
</g>`;
  }
  const cells = [6.4, 10.3, 14.2, 30.2, 34.1, 38.0].map((x) => `<rect x="${x}" y="20.7" width="3.5" height="7.6" rx="0.5" fill="${ink}" fill-opacity="0.85"/>`).join("");
  return `<circle cx="24" cy="24" r="21.5" stroke="${ink}" stroke-width="3" fill="none"/>
<g transform="rotate(-35 24 24)">
${cells}
<rect x="17.8" y="23.7" width="1.9" height="1.6" fill="${ink}"/><rect x="28.3" y="23.7" width="1.9" height="1.6" fill="${ink}"/>
<rect x="19.5" y="19" width="9" height="11" rx="2" fill="${ink}"/>
<path d="M20 16.9Q24 12.6 28 16.9Z" fill="${ink}" fill-opacity="0.85"/>
<rect x="23.3" y="16.7" width="1.4" height="2.5" fill="${ink}"/>
<rect x="23.4" y="12.8" width="1.2" height="2.6" fill="${ink}" fill-opacity="0.85"/>
<circle cx="24" cy="11" r="2.8" fill="${lamp}"/>
</g>`;
}

/** The mark as inline SVG, `size` pixels square. Below 28 px the simplified satellite is drawn. */
export function stratoMark(size: number, o: MarkOptions = {}): string {
  const small = o.small ?? size < 28;
  return `<svg width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">${markShapes({ ...o, small })}</svg>`;
}

/** The favicon: the simplified mark, light on a dark tile; the beacon is lit when something waits for the person. */
export function faviconSvg(lit = true): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#15181d"/><g transform="translate(4 4) scale(0.8333)">${markShapes({ ink: "#e8eaed", lamp: lit ? AMBER : IDLE, small: true })}</g></svg>`;
}

/** The favicon as a data URI, for the board's <link rel="icon">. */
export function faviconHref(lit = true): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(lit))}`;
}

/** Standalone SVG files for assets/: the mark (detailed and small), the lockup with the wordmark, the social image. */
export function brandFiles(): Record<string, string> {
  const svg = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">${body}</svg>\n`;
  const font = `font-family="'IBM Plex Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif"`;
  const lockup = (ink: string) =>
    svg(300, 96, `<g transform="translate(8 8) scale(1.6667)">${markShapes({ ink })}</g><text x="108" y="64" ${font} font-size="50" font-weight="600" letter-spacing="-1" fill="${ink}">strato</text>`);
  return {
    "strato-mark.svg": svg(48, 48, markShapes({ ink: "#16181c" })),
    "strato-mark-light.svg": svg(48, 48, markShapes({ ink: "#e8eaed" })),
    "strato-mark-small.svg": svg(48, 48, markShapes({ ink: "#16181c", small: true })),
    "favicon.svg": `${faviconSvg(true)}\n`,
    "strato-lockup.svg": lockup("#16181c"),
    "strato-lockup-light.svg": lockup("#e8eaed"),
    "social-preview.svg": svg(
      1280,
      640,
      `<rect width="1280" height="640" fill="#0b0c0e"/><g transform="translate(128 200) scale(5)">${markShapes({ ink: "#e8eaed" })}</g><text x="420" y="330" ${font} font-size="120" font-weight="600" letter-spacing="-3" fill="#e8eaed">strato</text><text x="424" y="400" ${font} font-size="34" fill="#a7acb4">A Slack control tower for Claude Code.</text><text x="424" y="448" ${font} font-size="34" fill="#a7acb4">Read every draft, say go.</text>`,
    ),
  };
}
