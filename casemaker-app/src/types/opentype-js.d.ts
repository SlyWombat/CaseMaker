// opentype.js 2.x ships no type declarations. This declares only the surface
// the glyph code touches; extend it if more is needed.
declare module 'opentype.js' {
  export interface PathCommand {
    type: 'M' | 'L' | 'C' | 'Q' | 'Z';
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export class Path {
    commands: PathCommand[];
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    close(): void;
  }
  export interface GlyphRenderOptions {
    kerning?: boolean;
    letterSpacing?: number;
  }
  export class Glyph {
    constructor(options: {
      name: string;
      unicode?: number;
      advanceWidth: number;
      path: Path;
    });
  }
  export class Font {
    constructor(options: {
      familyName: string;
      styleName: string;
      unitsPerEm: number;
      ascender: number;
      descender: number;
      glyphs: Glyph[];
    });
    unitsPerEm: number;
    tables: { os2?: { sCapHeight?: number } } & Record<string, unknown>;
    names: Record<string, Record<string, string> | undefined>;
    charToGlyph(c: string): Glyph;
    getPath(text: string, x: number, y: number, fontSize: number, options?: GlyphRenderOptions): Path;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
