/** SVGs are decoded as passive images, never inserted into the page DOM. */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
const SVG_NS = 'http://www.w3.org/2000/svg';

export function validateSvgFile(file) {
  if (!file || !/\.svg$/i.test(file.name ?? '')) return 'Choose an .svg logo file.';
  if (!file.size) return 'That SVG file is empty.';
  if (file.size > MAX_SVG_BYTES) return 'Choose an SVG smaller than 2 MB.';
  return null;
}

/** Keep uploads self-contained and static so preview and exports use the same shape. */
export function prepareSvgSource(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Export the logo as a plain SVG without a document type declaration.');
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.querySelector('parsererror') || root.localName !== 'svg' || (root.namespaceURI && root.namespaceURI !== SVG_NS)) {
    throw new Error('That file is not a valid SVG. Try exporting it again.');
  }
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > 4000) throw new Error('This SVG is too complex. Simplify its paths and try again.');
  const checkPaint = (value) => {
    // Disallow escaped CSS and at-rules as well as remote paint servers.
    const invalidCss = /[\\@]/.test(value);
    const invalidUrl = [...value.matchAll(/url\s*\(([^)]*)\)/gi)].some(([, target]) => {
      const ref = target.trim().replace(/^(['"])(.*)\1$/, '$2');
      return !/^#[^\s]+$/.test(ref);
    });
    if (invalidCss || invalidUrl) {
      throw new Error('Use a self-contained SVG with no linked images, fonts, or styles.');
    }
  };
  for (const el of elements) {
    const name = el.localName.toLowerCase();
    if (['text', 'tspan', 'textpath'].includes(name)) throw new Error('Convert the logo’s text to outlines, then upload the SVG again.');
    if (['script', 'foreignobject', 'image', 'filter', 'animate', 'animatetransform', 'animatemotion', 'set'].includes(name)) {
      throw new Error('Use a static vector SVG with paths and shapes. Flatten images, filters, and animations first.');
    }
    if (name === 'style') checkPaint(el.textContent);
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.localName)) el.removeAttributeNode(attr);
      else if (['href', 'src'].includes(attr.localName) && !/^#[^\s]+$/.test(attr.value.trim())) {
        throw new Error('Use a self-contained SVG with no linked images, fonts, or styles.');
      } else if (attr.localName === 'style' || /url\(/i.test(attr.value)) checkPaint(attr.value);
    }
  }
  const viewBox = root.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (viewBox && (viewBox.length !== 4 || !viewBox.every(Number.isFinite))) {
    throw new Error('The SVG has an invalid viewBox. Try exporting it again.');
  }
  const dimension = (name) => {
    const value = root.getAttribute(name)?.trim() ?? '';
    return /^\d*\.?\d+(?:px)?$/i.test(value) ? parseFloat(value) : NaN;
  };
  const [width, height] = viewBox?.length === 4 && viewBox.every(Number.isFinite)
    ? viewBox.slice(2)
    : [dimension('width'), dimension('height')];
  if (!(width > 0 && height > 0 && Number.isFinite(width / height))) {
    throw new Error('The SVG needs a valid viewBox or width and height. Try exporting it again.');
  }
  if (!viewBox) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const scale = 1024 / Math.max(width, height);
  const rasterWidth = Math.max(1, Math.round(width * scale));
  const rasterHeight = Math.max(1, Math.round(height * scale));
  root.setAttribute('xmlns', SVG_NS);
  root.setAttribute('width', String(rasterWidth));
  root.setAttribute('height', String(rasterHeight));
  return { source: new XMLSerializer().serializeToString(root), width: rasterWidth, height: rasterHeight };
}

export async function loadSvgLogo(file) {
  const problem = validateSvgFile(file);
  if (problem) throw new Error(problem);
  const prepared = prepareSvgSource(await file.text());
  const url = URL.createObjectURL(new Blob([prepared.source], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('This SVG took too long to load. Simplify it and try again.')), 8000);
      const finish = (error) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        if (error) { image.src = ''; reject(error); } else resolve();
      };
      image.onload = () => finish();
      image.onerror = () => finish(new Error('Could not read this SVG. Try exporting it as plain SVG.'));
      image.src = url;
    });
    return { image, width: prepared.width, height: prepared.height, name: file.name };
  } finally {
    URL.revokeObjectURL(url);
  }
}
