import { createHash } from "node:crypto";

export type AspectRatio = "1:1" | "16:9" | "9:16";

const SIZES: Record<AspectRatio, { width: number; height: number }> = {
  "1:1": { width: 512, height: 512 },
  "16:9": { width: 640, height: 360 },
  "9:16": { width: 360, height: 640 },
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.trim().split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${(kept[maxLines - 1] ?? "").slice(0, Math.max(0, width - 3))}...`;
    return kept;
  }
  return lines;
}

/**
 * Deterministic placeholder artwork: the same prompt and aspect ratio always give
 * the same SVG. Stands in for a real image model so the example needs no paid service.
 */
export function renderImageSvg(prompt: string, aspectRatio: AspectRatio): string {
  const digest = createHash("sha256").update(prompt).digest();
  const byte = (i: number) => digest[i % digest.length] ?? 0;
  const { width, height } = SIZES[aspectRatio];
  const hue = (byte(0) * 360) / 255;
  const hue2 = (hue + 40 + (byte(1) % 80)) % 360;
  const bg1 = `hsl(${hue.toFixed(0)} 60% 28%)`;
  const bg2 = `hsl(${hue2.toFixed(0)} 70% 46%)`;

  const shapes: string[] = [];
  for (let i = 0; i < 6; i++) {
    const cx = (byte(2 + i * 3) / 255) * width;
    const cy = (byte(3 + i * 3) / 255) * height;
    const r = (0.08 + (byte(4 + i * 3) / 255) * 0.22) * Math.min(width, height);
    const h = (hue + i * 47) % 360;
    shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="hsl(${h.toFixed(0)} 75% 65%)" fill-opacity="0.35"/>`);
  }

  const lines = wrap(prompt, aspectRatio === "9:16" ? 22 : 34, 4);
  const fontSize = aspectRatio === "9:16" ? 20 : 22;
  const startY = height - 24 - (lines.length - 1) * (fontSize + 6);
  const text = lines
    .map((l, i) => `<text x="24" y="${startY + i * (fontSize + 6)}" font-family="sans-serif" font-size="${fontSize}" fill="#fff">${escapeXml(l)}</text>`)
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#g)"/>`,
    shapes.join(""),
    `<rect x="0" y="${startY - fontSize - 8}" width="${width}" height="${height}" fill="#000" fill-opacity="0.35"/>`,
    text,
    `</svg>`,
  ].join("");
}
