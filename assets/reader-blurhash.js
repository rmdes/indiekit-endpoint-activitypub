/**
 * Blurhash placeholder backgrounds for gallery images.
 *
 * Extracts the average (DC) color from a blurhash string and applies it
 * as a background-color on images with a data-blurhash attribute.
 * This provides a meaningful colored placeholder while images load.
 *
 * The DC component is encoded in the first 4 characters of the blurhash
 * after the size byte, as a base-83 integer representing an sRGB color.
 */

const BASE83_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function decode83(str) {
  let value = 0;
  for (const c of str) {
    const digit = BASE83_CHARS.indexOf(c);
    if (digit === -1) return 0;
    value = value * 83 + digit;
  }
  return value;
}

function decodeDC(value) {
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function blurhashToColor(hash) {
  if (!hash || hash.length < 6) return null;
  const dcValue = decode83(hash.slice(1, 5));
  const { r, g, b } = decodeDC(dcValue);
  return `rgb(${r},${g},${b})`;
}

document.addEventListener("DOMContentLoaded", () => {
  for (const img of document.querySelectorAll("img[data-blurhash]")) {
    const color = blurhashToColor(img.dataset.blurhash);
    if (color) {
      img.style.backgroundColor = color;
    }
  }

  // Handle dynamically loaded images (infinite scroll)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        const imgs = node.querySelectorAll
          ? node.querySelectorAll("img[data-blurhash]")
          : [];
        for (const img of imgs) {
          const color = blurhashToColor(img.dataset.blurhash);
          if (color) {
            img.style.backgroundColor = color;
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
});
