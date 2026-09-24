import { describe, expect, it } from 'vitest';
import { MAX_SVG_BYTES, validateSvgFile } from './svgLogo.js';

describe('SVG file validation', () => {
  it('accepts SVG filenames even when the browser omits the MIME type', () => {
    expect(validateSvgFile({ name: 'Logo.SVG', size: 120, type: '' })).toBeNull();
  });
  it('rejects missing, empty, non-SVG, and oversized files before decoding', () => {
    expect(validateSvgFile(null)).toContain('.svg');
    expect(validateSvgFile({ name: 'logo.png', size: 120 })).toContain('.svg');
    expect(validateSvgFile({ name: 'logo.svg', size: 0 })).toContain('empty');
    expect(validateSvgFile({ name: 'logo.svg', size: MAX_SVG_BYTES + 1 })).toContain('2 MB');
    expect(validateSvgFile({ name: 'logo.svg', size: MAX_SVG_BYTES })).toBeNull();
  });
});
