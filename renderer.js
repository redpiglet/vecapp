/* A small perspective renderer for the packaging preview. No network or GPU required. */
(() => {
  'use strict';

  const CAMERA_DISTANCE = 5.4;
  const PAPER = {
    kraft: [195, 145, 91],
    white: [230, 223, 201],
    charcoal: [76, 75, 70],
  };
  const RIBBON = {
    black: [52, 50, 51],
    cream: [237, 213, 172],
    burgundy: [133, 57, 74],
  };
  const SURFACE_HIGHLIGHT = [29, 165, 205];
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => a.map((value, axis) => value + b[axis]);
  const subtract = (a, b) => a.map((value, axis) => value - b[axis]);
  const multiply = (a, factor) => a.map((value) => value * factor);
  const blend = (a, b, amount) => add(multiply(a, 1 - amount), multiply(b, amount));
  const average = (points) => multiply(points.reduce(add), 1 / points.length);
  const color = (base, light, reflection = 0) =>
    `rgb(${base.map((value) => Math.round(clamp(value * light + reflection * light ** 2, 0, 255))).join(' ')})`;

  function previewInk(stock, { c, m, y, k }) {
    const black = 1 - k / 100;
    const rgb = [c, m, y].map((channel, index) => stock[index] * (1 - channel / 100) * black);
    // A low, neutral paper reflection keeps details visible even with full black ink.
    return { rgb, reflection: 18 * Math.max(0, 1 - Math.max(...rgb) / 48) };
  }

  function face(vertices, normal, options = {}) {
    return { vertices, normal, center: average(vertices), ...options };
  }

  function cartesianOn(vertices, u, v) {
    return blend(blend(vertices[0], vertices[1], u), blend(vertices[3], vertices[2], u), v);
  }

  function camera(yaw, pitch, zoom, width, height, isBag, framing) {
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);
    const forward = [sinYaw * cosPitch, sinPitch, cosYaw * cosPitch];
    const right = [cosYaw, 0, -sinYaw];
    const up = [-sinYaw * sinPitch, cosPitch, -cosYaw * sinPitch];
    const focus = framing?.focus ?? [0, 0, 0];
    let fit = Math.min(width * (isBag ? .43 : .37), height * (isBag ? .51 : .49));
    let center = [0, 0];

    function plane(point) {
      const relative = subtract(point, focus);
      const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - dot(relative, forward));
      return [dot(relative, right) * perspective, -dot(relative, up) * perspective];
    }

    if (framing) {
      let left = Infinity;
      let rightEdge = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (const point of framing.points) {
        const [x, y] = plane(point);
        left = Math.min(left, x);
        rightEdge = Math.max(rightEdge, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      fit = Math.min(fit, width * .86 / (rightEdge - left), height * .82 / (bottom - top));
      center = [(left + rightEdge) / 2, (top + bottom) / 2];
    }
    const scale = zoom * fit;

    return {
      position: add(focus, multiply(forward, CAMERA_DISTANCE)),
      depth: (point) => dot(point, forward),
      project(point) {
        const [x, y] = plane(point);
        return [width / 2 + (x - center[0]) * scale, height * .475 + (y - center[1]) * scale];
      },
    };
  }

  function appendLoop(context, points) {
    context.moveTo(...points[0]);
    for (const point of points.slice(1)) context.lineTo(...point);
    context.closePath();
  }

  function path(context, points) {
    context.beginPath();
    appendLoop(context, points);
  }

  function traceSurface(context, surface, view, outline) {
    path(context, outline);
    for (const cutout of surface.cutouts || []) appendLoop(context, cutout.map(view.project));
  }

  function paperGrain(context) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 83;
    const tileContext = tile.getContext('2d');
    const pixels = tileContext.createImageData(tile.width, tile.height);
    let seed = 43;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (seed * 48271) % 2147483647;
      const light = seed % 2 === 0 ? 255 : 22;
      pixels.data.set([light, light, light, 2 + seed % 23], index);
    }
    tileContext.putImageData(pixels, 0, 0);
    return context.createPattern(tile, 'repeat');
  }

  function paintShadow(context, scene, view) {
    const center = view.project([0, scene.floor, 0]);
    const extent = view.project([scene.w * .5, scene.floor, -scene.d * .24]);
    const halfWidth = Math.max(Math.abs(center[0] - extent[0]), Math.abs(view.project([0, scene.floor, scene.d * .5])[0] - center[0])) + 21;
    const halfHeight = Math.max(14, halfWidth * .258);
    context.save();
    context.translate(center[0], center[1] + 8);
    context.scale(halfWidth * 1.24, halfHeight);
    const fade = context.createRadialGradient(0, 0, .045, 0, 0, 1);
    fade.addColorStop(0, 'rgba(63, 42, 27, .31)');
    fade.addColorStop(.47, 'rgba(80, 55, 37, .13)');
    fade.addColorStop(1, 'rgba(85, 57, 39, 0)');
    context.fillStyle = fade;
    context.beginPath();
    context.arc(0, 0, 1, 0, 2 * Math.PI);
    context.fill();
    context.restore();
  }

  function paintFace(context, surface, view, base, texture, reflection = 0) {
    const points = surface.vertices.map(view.project);
    const light = (.89 + .18 * surface.normal[1] - .115 * surface.normal[0] + .049 * surface.normal[2]) * (surface.tone ?? 1);
    const x = points.map((point) => point[0]);
    const y = points.map((point) => point[1]);
    const span = Math.max(...y) - Math.min(...y);
    if (span < 1) return;
    traceSurface(context, surface, view, points);

    if (surface.texture === false) {
      context.fillStyle = color(base, light, reflection);
    } else {
      const brush = context.createLinearGradient(Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y));
      brush.addColorStop(0, color(base, light + .11, reflection));
      brush.addColorStop(.42, color(base, light + .018, reflection));
      brush.addColorStop(1, color(base, light - .083, reflection));
      context.fillStyle = brush;
    }
    context.fill('evenodd');
    if (texture && surface.texture !== false) {
      context.save();
      context.globalAlpha = .28;
      context.fillStyle = texture;
      context.fill('evenodd');
      context.restore();
    }
    if (surface.edge !== false) {
      context.strokeStyle = 'rgba(79, 50, 31, .25)';
      context.lineWidth = .61;
      context.stroke();
    } else if (surface.texture === false) {
      context.strokeStyle = context.fillStyle;
      context.lineWidth = .42;
      context.stroke();
    }
  }

  function drawTriangle(context, image, corners, uv) {
    const [[x0, y0], [x1, y1], [x2, y2]] = corners;
    const [[u0, v0], [u1, v1], [u2, v2]] = uv;
    const du1 = u1 - u0;
    const du2 = u2 - u0;
    const dv1 = v1 - v0;
    const dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    const a = ((x1 - x0) * dv2 - (x2 - x0) * dv1) / det;
    const b = ((y1 - y0) * dv2 - (y2 - y0) * dv1) / det;
    const c = ((x2 - x0) * du1 - (x1 - x0) * du2) / det;
    const d = ((y2 - y0) * du1 - (y1 - y0) * du2) / det;
    const e = x0 - a * u0 - c * v0;
    const f = y0 - b * u0 - d * v0;
    const center = average(corners);
    const overlap = corners.map((point) => {
      const delta = subtract(point, center);
      return add(point, multiply(delta, .38 / Math.max(1, Math.hypot(...delta))));
    });
    context.save();
    path(context, overlap);
    context.clip();
    context.transform(a, b, c, d, e, f);
    context.drawImage(image, 0, 0, 1, 1);
    context.restore();
  }

  function paintLogo(context, surface, view, state) {
    if (!surface.panel) return;
    const art = state.panelArt ? state.panelArt[surface.panel] : (surface.panel === state.panel ? state : null);
    const logo = art?.logo;
    if (!logo?.naturalWidth || !logo.naturalHeight) return;
    const aspect = logo.naturalWidth / logo.naturalHeight;
    const [left, top, right, bottom] = surface.logoArea || [.095, .10, .905, .90];
    const maxU = right - left;
    const maxV = bottom - top;
    const width = surface.width;
    const height = surface.height;
    const scale = clamp(art.logoScale, .15, .95);
    const physicalWidth = Math.min(width * maxU, height * maxV * aspect) * scale;
    const spanU = physicalWidth / width;
    const spanV = physicalWidth / aspect / height;
    const centerU = (left + right) / 2 + clamp(art.logoX / .75, -1, 1) * (maxU - spanU) / 2;
    const centerV = (top + bottom) / 2 + clamp(art.logoY / .75, -1, 1) * (maxV - spanV) / 2;
    const cornerU = centerU - spanU / 2;
    const cornerV = centerV - spanV / 2;

    context.save();
    traceSurface(context, surface, view, surface.vertices.map(view.project));
    context.clip('evenodd');
    if (surface.uvTriangles) {
      // These facets are authored on the paper, so a curved print area follows the model's own UVs.
      for (const triangle of surface.uvTriangles) {
        const uv = triangle.uv.map(([u, v]) => [(u - cornerU) / spanU, (v - cornerV) / spanV]);
        if ([0, 1].some((axis) => uv.every((point) => point[axis] < 0) || uv.every((point) => point[axis] > 1))) continue;
        drawTriangle(context, logo, triangle.vertices.map(view.project), uv);
      }
      context.restore();
      return;
    }
    const panel = surface.uvVertices || surface.vertices;
    const project = ([u, v]) => view.project(cartesianOn(panel, cornerU + spanU * u, cornerV + spanV * v));
    const steps = 5;

    // Affine triangles approximate the perspective texture locally. A small shared edge prevents pixel gaps.
    path(context, [[0, 0], [1, 0], [1, 1], [0, 1]].map(project));
    context.clip();
    for (let row = 0; row < steps; row += 1) {
      for (let column = 0; column < steps; column += 1) {
        const corners = [[column, row], [column + 1, row], [column + 1, row + 1], [column, row + 1]].map((point) => point.map((coord) => coord / steps));
        for (const indices of [[0, 1, 2], [0, 2, 3]]) {
          const uv = indices.map((index) => corners[index]);
          drawTriangle(context, logo, uv.map(project), uv);
        }
      }
    }
    context.restore();
  }

  function createScene(dimensions, foldOpen, modelAsset) {
    const normalize = 2 / Math.max(...dimensions);
    const [w, d, h] = dimensions.map((value) => value * normalize);
    const scene = modelAsset.build({ dimensions: [w, d, h], foldOpen, face });
    return { ...scene, w, d };
  }

  class PackagingRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.texture = this.context ? paperGrain(this.context) : null;
      this.sceneKey = '';
    }

    render(state, options = {}) {
      const { canvas, context } = this;
      const { width = canvas.clientWidth, height = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2) } = options;
      if (!context || width < 1 || height < 1) return;
      const bufferWidth = Math.round(width * dpr);
      const bufferHeight = Math.round(height * dpr);
      if (canvas.width !== bufferWidth || canvas.height !== bufferHeight) {
        canvas.width = bufferWidth;
        canvas.height = bufferHeight;
      }
      context.setTransform(bufferWidth / width, 0, 0, bufferHeight / height, 0, 0);
      context.clearRect(0, 0, width, height);
      if (!state.modelAsset) return;

      const foldOpen = state.product === 'box' && state.foldOpen === true;
      const sceneKey = `${state.product}|${state.dimensions.join(',')}|${foldOpen}`;
      if (sceneKey !== this.sceneKey || state.modelAsset !== this.modelAsset) {
        this.scene = createScene(state.dimensions, foldOpen, state.modelAsset);
        this.sceneKey = sceneKey;
        this.modelAsset = state.modelAsset;
      }
      const scene = this.scene;
      const view = camera(state.yaw, state.pitch, state.zoom, width, height, state.product === 'bag', scene.framing);
      const base = PAPER[state.material] || PAPER.kraft;
      const ribbon = RIBBON[state.ribbonColor] || RIBBON.black;
      const inks = new Map();
      const allowedSurfaces = state.colorableSurfaces ? new Set(state.colorableSurfaces) : null;
      const highlighted = state.highlightSurface;
      for (const [area, ink] of Object.entries(state.printColors || {})) {
        if (ink) inks.set(area, previewInk(base, ink));
      }
      paintShadow(context, scene, view);

      // Faces travel from far to near so the near wall can cover the inside of the bag and the handle ends.
      const visible = scene.faces
        .filter((surface) => dot(subtract(view.position, surface.center), surface.normal) > .005)
        .map((surface) => ({ surface, depth: view.depth(surface.center) }))
        .sort((a, b) => a.depth - b.depth);

      const overlays = new Map();
      const surfaces = [];
      for (const { surface } of visible) {
        if (surface.overlayPanel) {
          if (!overlays.has(surface.overlayPanel)) overlays.set(surface.overlayPanel, []);
          overlays.get(surface.overlayPanel).push(surface);
        } else {
          surfaces.push(surface);
        }
      }

      for (const surface of surfaces) {
        const acceptsInk = !surface.ribbon && (!allowedSurfaces || allowedSurfaces.has(surface.surfaceId));
        const ink = acceptsInk
          ? inks.get(surface.surfaceId) ?? (surface.exterior ? inks.get('exterior') : null)
          : null;
        const isHighlighted = highlighted && surface.surfaceId === highlighted;
        const fill = isHighlighted ? SURFACE_HIGHLIGHT : surface.ribbon ? ribbon : ink?.rgb ?? base;
        paintFace(context, surface, view, fill, this.texture, isHighlighted ? 0 : ink?.reflection);
        for (const artwork of surface.artworkSurfaces || []) paintLogo(context, artwork, view, state);
        // The straps rest on the bag panel. Draw them above it even where perspective
        // puts an attachment farther away than the center of the broad panel.
        for (const detail of overlays.get(surface.surfaceId) || []) paintFace(context, detail, view, ribbon, this.texture);
      }
    }
  }

  window.PackagingRenderer = PackagingRenderer;
})();
