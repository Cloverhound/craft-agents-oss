/**
 * Test setup file - loaded before all tests via bunfig.toml preload.
 *
 * Provides DOM polyfills for packages that require browser APIs (like pdfjs-dist).
 */

// Polyfill DOMMatrix for pdfjs-dist
// @ts-expect-error - Adding to global
globalThis.DOMMatrix = class DOMMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  m11 = 1; m12 = 0; m13 = 0; m14 = 0;
  m21 = 0; m22 = 1; m23 = 0; m24 = 0;
  m31 = 0; m32 = 0; m33 = 1; m34 = 0;
  m41 = 0; m42 = 0; m43 = 0; m44 = 1;
  is2D = true;
  isIdentity = true;
  multiply() { return new DOMMatrix(); }
  translate() { return new DOMMatrix(); }
  scale() { return new DOMMatrix(); }
  rotate() { return new DOMMatrix(); }
  inverse() { return new DOMMatrix(); }
  transformPoint() { return { x: 0, y: 0, z: 0, w: 1 }; }
};

// Polyfill Path2D for pdfjs-dist canvas operations
// @ts-expect-error - Adding to global
globalThis.Path2D = class Path2D {
  addPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
};

// Polyfill OffscreenCanvas for pdfjs-dist
// @ts-expect-error - Adding to global
globalThis.OffscreenCanvas = class OffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    return {
      fillRect: () => {},
      clearRect: () => {},
      getImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
      putImageData: () => {},
      createImageData: () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 }),
      setTransform: () => {},
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      arcTo: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      isPointInPath: () => false,
      isPointInStroke: () => false,
      measureText: () => ({ width: 0 }),
      fillText: () => {},
      strokeText: () => {},
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      createPattern: () => null,
      canvas: { width: 0, height: 0 },
    };
  }
  transferToImageBitmap() { return {}; }
  convertToBlob() { return Promise.resolve(new Blob()); }
};
