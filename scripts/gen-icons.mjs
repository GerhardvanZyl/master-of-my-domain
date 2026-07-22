import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// PWA icons rasterised from the app's house mark on the forest background.
const house = `<g transform="translate(256 256) scale(11) translate(-12 -12)" fill="none" stroke="#F4F1EA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></g>`;
const svg = (rx) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rx}" fill="#1F4A3A"/>${house}</svg>`;

mkdirSync(fileURLToPath(new URL("../public/icons/", import.meta.url)), { recursive: true });
const out = (f) => fileURLToPath(new URL(`../public/icons/${f}`, import.meta.url));

await sharp(Buffer.from(svg(96))).resize(192, 192).png().toFile(out("icon-192.png"));
await sharp(Buffer.from(svg(96))).resize(512, 512).png().toFile(out("icon-512.png"));
await sharp(Buffer.from(svg(0))).resize(512, 512).png().toFile(out("icon-maskable-512.png"));
await sharp(Buffer.from(svg(0))).resize(180, 180).png().toFile(out("apple-touch-icon.png"));
console.log("icons written to public/icons/");
