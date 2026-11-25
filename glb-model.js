/* Decodes Vectory's Blender model assets for the packaging renderer. */
(() => {
  'use strict';

  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const COMPONENTS = {
    5121: [1, 'getUint8', 255],
    5123: [2, 'getUint16', 65535],
    5125: [4, 'getUint32', 4294967295],
    5126: [4, 'getFloat32', 1],
  };
  const STRIDES = { SCALAR: 1, VEC2: 2, VEC3: 3 };
  const PANEL_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
  // Older approved files use names rather than a surfaceId custom property.
  const LEGACY_BOX_SURFACES = new Map([
    ['Front panel', 'front'], ['Back panel', 'back'], ['Closure outside', 'closure'],
    ['Right side', 'right-side'], ['Left side', 'left-side'], ['Base', 'base'],
    ['Curved roof outside', 'roof'], ['Left wing outside', 'left-wing'], ['Right wing outside', 'right-wing'],
    ['Interior and edges', 'interior'], ['Curved roof inside', 'interior'], ['Closure inside', 'interior'],
    ['Left wing inside', 'interior'], ['Right wing inside', 'interior'],
  ]);
  const BOX_SURFACES = new Set(LEGACY_BOX_SURFACES.values());
  const BAG_SURFACES = new Set(['front', 'back', 'left-side', 'right-side', 'base', 'interior']);
  const subtract = (a, b) => a.map((value, index) => value - b[index]);
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const pointKey = (point) => point.map((value) => Math.round(value * 1000000)).join(',');

  function unpack(buffer) {
    const file = new DataView(buffer);
    if (file.byteLength < 28 || file.getUint32(0, true) !== 0x46546c67 ||
        file.getUint32(4, true) !== 2 || file.getUint32(8, true) !== file.byteLength) {
      throw new Error('Expected a version 2 GLB.');
    }
    let gltf;
    let binary;
    for (let cursor = 12; cursor < file.byteLength;) {
      if (cursor + 8 > file.byteLength) throw new Error('Incomplete GLB header.');
      const length = file.getUint32(cursor, true);
      const type = file.getUint32(cursor + 4, true);
      const start = cursor + 8;
      const end = start + length;
      if (length % 4 || end > file.byteLength) throw new Error('Incomplete GLB chunk.');
      if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
      if (type === 0x004e4942) binary = new DataView(buffer, start, length);
      cursor = end;
    }
    if (gltf?.asset?.version !== '2.0' || !binary || gltf.buffers?.length !== 1 ||
        gltf.buffers[0].uri !== undefined || gltf.buffers[0].byteLength > binary.byteLength ||
        gltf.extensionsRequired?.length) {
      throw new Error('The preview requires an embedded, uncompressed GLB.');
    }
    return { gltf, binary };
  }

  function accessorReader(gltf, binary) {
    const cache = new Map();
    return (index, expectedType) => {
      if (cache.has(index) && cache.get(index).type === expectedType) return cache.get(index).values;
      const accessor = gltf.accessors?.[index];
      const view = gltf.bufferViews?.[accessor?.bufferView];
      const component = COMPONENTS[accessor?.componentType];
      if (accessor?.type !== expectedType || !component || !view ||
          view.buffer !== 0 || accessor.sparse || !Number.isInteger(accessor.count) || accessor.count < 1 ||
          (expectedType === 'SCALAR' && accessor.componentType === 5126)) {
        throw new Error('The model uses an unsupported vertex buffer.');
      }
      const [bytes, read, unit] = component;
      const size = STRIDES[expectedType];
      const stride = view.byteStride ?? bytes * size;
      const offset = accessor.byteOffset ?? 0;
      const start = (view.byteOffset ?? 0) + offset;
      const span = (accessor.count - 1) * stride + bytes * size;
      if (stride < bytes * size || offset < 0 || start < 0 || offset + span > view.byteLength ||
          start + span > binary.byteLength) throw new Error('The model buffer is truncated.');
      const values = Array.from({ length: accessor.count }, (_, item) => {
        const components = Array.from({ length: size }, (_, axis) =>
          binary[read](start + item * stride + axis * bytes, true) /
          (accessor.normalized ? unit : 1));
        return size === 1 ? components[0] : components;
      });
      cache.set(index, { type: expectedType, values });
      return values;
    };
  }

  function nodeMatrix(node) {
    if (node.matrix) return node.matrix;
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    return [
      sx * (1 - 2 * (y * y + z * z)), sx * 2 * (x * y + z * w), sx * 2 * (x * z - y * w), 0,
      sy * 2 * (x * y - z * w), sy * (1 - 2 * (x * x + z * z)), sy * 2 * (y * z + x * w), 0,
      sz * 2 * (x * z + y * w), sz * 2 * (y * z - x * w), sz * (1 - 2 * (x * x + y * y)), 0,
      tx, ty, tz, 1,
    ];
  }

  function multiply(a, b) {
    return a.map((_, index) => {
      const row = index % 4;
      const column = index - row;
      return a[row] * b[column] + a[row + 4] * b[column + 1] +
        a[row + 8] * b[column + 2] + a[row + 12] * b[column + 3];
    });
  }

  function transform(point, matrix) {
    return [0, 1, 2].map((axis) => matrix[axis] * point[0] +
      matrix[axis + 4] * point[1] + matrix[axis + 8] * point[2] + matrix[axis + 12]);
  }

  function trianglesOf(positions, indices, reflected, coordinates) {
    const triangles = [];
    if (indices.length % 3) throw new Error('The model has incomplete triangles.');
    for (let i = 0; i < indices.length; i += 3) {
      const corners = indices.slice(i, i + 3);
      if (reflected) [corners[1], corners[2]] = [corners[2], corners[1]];
      const triangle = corners.map((index) => positions[index]);
      if (triangle.some((point) => !point?.every(Number.isFinite))) throw new Error('The model has an invalid vertex.');
      const vector = cross(subtract(triangle[1], triangle[0]), subtract(triangle[2], triangle[0]));
      const length = Math.hypot(...vector);
      if (length > 1e-12) {
        const surface = { vertices: triangle, normal: vector.map((value) => value / length) };
        if (coordinates) surface.uv = corners.map((index) => coordinates[index]);
        triangles.push(surface);
      }
    }
    return triangles;
  }

  function addBoundaryEdge(segments, from, to) {
    if (from.key === to.key) return;
    const key = [from.key, to.key].sort().join('|');
    if (segments.has(key)) segments.delete(key);
    else segments.set(key, { from, to });
  }

  function followLoops(segments) {
    const edges = new Map();
    for (const edge of segments.values()) {
      if (edges.has(edge.from.key)) return null;
      edges.set(edge.from.key, edge);
    }
    const loops = [];
    while (edges.size) {
      const start = edges.keys().next().value;
      const loop = [];
      let current = start;
      do {
        const edge = edges.get(current);
        if (!edge) return null;
        loop.push(edge.from.point);
        edges.delete(current);
        current = edge.to.key;
      } while (current !== start);
      if (loop.length < 3) return null;
      loops.push(loop);
    }
    return loops;
  }

  function loopsOf(triangles) {
    const verticesByKey = new Map();
    const segments = new Map();
    for (const { vertices } of triangles) {
      const corners = vertices.map((point) => {
        const key = pointKey(point);
        if (!verticesByKey.has(key)) verticesByKey.set(key, { key, point });
        return verticesByKey.get(key);
      });
      corners.forEach((from, index) => addBoundaryEdge(segments, from, corners[(index + 1) % 3]));
    }
    const direct = followLoops(segments);
    if (direct) return direct;

    // Split exported edges at intervening vertices before canceling shared segments.
    const split = new Map();
    for (const { from, to } of segments.values()) {
      const direction = subtract(to.point, from.point);
      const lengthSquared = dot(direction, direction);
      const cuts = [[0, from], [1, to]];
      for (const candidate of verticesByKey.values()) {
        const delta = subtract(candidate.point, from.point);
        const ratio = dot(delta, direction) / lengthSquared;
        if (ratio <= .00001 || ratio >= .99999) continue;
        const residual = delta.map((value, axis) => value - direction[axis] * ratio);
        if (dot(residual, residual) < 9e-13) cuts.push([ratio, candidate]);
      }
      cuts.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < cuts.length; i++) addBoundaryEdge(split, cuts[i - 1][1], cuts[i][1]);
    }
    return followLoops(split);
  }

  function insideOutline(point, outline, normal) {
    const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    const [axisU, axisV] = [0, 1, 2].filter((axis) => axis !== drop);
    const u = point[axisU];
    const v = point[axisV];
    let inside = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const a = outline[i];
      const b = outline[j];
      if ((a[axisV] > v) !== (b[axisV] > v) &&
          u < a[axisU] + (b[axisU] - a[axisU]) * (v - a[axisV]) / (b[axisV] - a[axisV])) inside = !inside;
    }
    return inside;
  }

  function meshSurfaces(triangles, tone) {
    const planes = [];
    for (const triangle of triangles) {
      const plane = planes.find(({ normal, offset }) =>
        dot(normal, triangle.normal) > .99995 &&
        triangle.vertices.every((point) => Math.abs(dot(point, normal) - offset) < 1e-6)
      );
      if (plane) plane.triangles.push(triangle);
      else planes.push({
        normal: triangle.normal,
        offset: dot(triangle.vertices[0], triangle.normal),
        triangles: [triangle],
      });
    }
    return planes.flatMap(({ normal, triangles: group }) => {
      const loops = loopsOf(group);
      if (!loops?.length) return group.map((triangle) => ({ ...triangle, tone, texture: false }));
      const area = (loop) => loop.reduce((sum, point, index) =>
        sum + dot(cross(point, loop[(index + 1) % loop.length]), normal), 0);
      const outlines = loops.filter((loop) => area(loop) > 0);
      if (!outlines.length) return group.map((triangle) => ({ ...triangle, tone, texture: false }));
      const holes = loops.filter((loop) => area(loop) < 0);
      return outlines.map((vertices) => ({
        vertices,
        normal,
        tone,
        texture: planes.length === 1,
        cutouts: holes.filter((hole) => insideOutline(hole[0], vertices, normal)),
      }));
    });
  }

  function printCoordinates(positions, coordinates, extras) {
    const { uvOrigin } = extras;
    if (uvOrigin !== undefined && !['top-left', 'bottom-left'].includes(uvOrigin)) {
      throw new Error('The model has an invalid print panel UV origin.');
    }
    if (positions.length !== coordinates.length || coordinates.some(
      (point) => point.some((value) => !Number.isFinite(value) || value < -.0001 || value > 1.0001))) {
      throw new Error('The model print panel UVs must stay within the unit square.');
    }
    return uvOrigin === 'bottom-left' ? coordinates.map(([u, v]) => [u, 1 - v]) : coordinates;
  }

  function printSurface(parts, extras) {
    if (!Number.isFinite(extras.widthMm) || extras.widthMm <= 0 ||
        !Number.isFinite(extras.heightMm) || extras.heightMm <= 0) {
      throw new Error('The model is missing print panel measurements.');
    }
    const { logoArea } = extras;
    if (logoArea !== undefined && (!Array.isArray(logoArea) || logoArea.length !== 4 ||
        logoArea.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
        logoArea[0] >= logoArea[2] || logoArea[1] >= logoArea[3])) {
      throw new Error('The model has an invalid print panel area.');
    }
    const settings = {
      panel: extras.panelId,
      width: extras.widthMm / 1000,
      height: extras.heightMm / 1000,
      logoArea,
    };
    if (extras.mapping === 'mesh') {
      const triangles = parts.flatMap((part) => part.triangles);
      for (const { uv: [[u0, v0], [u1, v1], [u2, v2]] } of triangles) {
        if (Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) < 1e-10) {
          throw new Error('A print mesh triangle has collapsed UVs.');
        }
      }
      return { ...settings, triangles };
    }
    if ((extras.mapping !== undefined && extras.mapping !== 'quad') || parts.length !== 1) {
      throw new Error('Use mesh mapping for a print guide with multiple primitives.');
    }
    const { positions, coordinates, triangles } = parts[0];
    const corners = PANEL_CORNERS.map(([u, v]) => {
      const index = coordinates.findIndex(([textureU, textureV]) =>
        Math.abs(u - textureU) < 1e-4 && Math.abs(v - textureV) < 1e-4);
      return positions[index];
    });
    if (corners.some((point) => !point)) throw new Error('The model is missing a print panel UV corner.');
    return {
      ...settings,
      vertices: corners,
      uvVertices: corners,
      normal: triangles[0].normal,
    };
  }

  function readModel(buffer, product, guidePolicy, allowedSurfaces) {
    const { gltf, binary } = unpack(buffer);
    const read = accessorReader(gltf, binary);
    const poses = { closed: { paper: [], ribbons: [], print: [] } };
    if (product === 'box') poses.open = { paper: [], ribbons: [], print: [] };
    const visited = new Set();

    function visit(index, parent, parentPose) {
      if (visited.has(index) || !gltf.nodes?.[index]) throw new Error('The model has an invalid node hierarchy.');
      visited.add(index);
      const node = gltf.nodes[index];
      const extras = node.extras || {};
      const poseName = extras.pose === undefined
        ? parentPose
        : Object.hasOwn(poses, extras.pose) ? extras.pose : null;
      const pose = poses[poseName];
      const matrix = multiply(parent, nodeMatrix(node));
      if (node.mesh !== undefined && extras.role === 'print' && !guidePolicy.get(extras.panelId)?.has(poseName)) {
        throw new Error('The model has an unregistered print guide for this pose.');
      }
      if (node.mesh !== undefined && pose && ['paper', 'print', 'ribbon'].includes(extras.role)) {
        if (extras.role === 'ribbon' && product !== 'bag') throw new Error('Ribbon geometry is only supported on a bag.');
        const partName = node.name?.replace(/\.\d+$/, '');
        let surfaceId = extras.role === 'paper' && allowedSurfaces.has(extras.surfaceId) ? extras.surfaceId : undefined;
        if (product === 'box') {
          surfaceId ??= guidePolicy.has(extras.panelId) ? extras.panelId : LEGACY_BOX_SURFACES.get(partName);
        }
        const exterior = surfaceId !== 'interior' && (typeof extras.exterior === 'boolean' ? extras.exterior : Boolean(surfaceId));
        const reflected = dot(cross(matrix.slice(0, 3), matrix.slice(4, 7)), matrix.slice(8, 11)) < 0;
        const printParts = [];
        for (const primitive of gltf.meshes[node.mesh].primitives) {
          if ((primitive.mode ?? 4) !== 4) throw new Error('The model needs a triangulated mesh.');
          const positions = read(primitive.attributes.POSITION, 'VEC3').map((point) => transform(point, matrix));
          const indices = primitive.indices === undefined ? positions.map((_, vertex) => vertex) : read(primitive.indices, 'SCALAR');
          const coordinates = extras.role === 'print'
            ? printCoordinates(positions, read(primitive.attributes.TEXCOORD_0, 'VEC2'), extras)
            : undefined;
          const triangles = trianglesOf(positions, indices, reflected, coordinates);
          if (!triangles.length) throw new Error('The model includes an empty mesh.');
          if (extras.role === 'print') {
            printParts.push({ positions, coordinates, triangles });
            continue;
          }
          const ribbon = extras.role === 'ribbon';
          if (extras.overlayPanel !== undefined && (!ribbon || !['front', 'back'].includes(extras.overlayPanel))) {
            throw new Error('The model has an invalid ribbon attachment.');
          }
          const surfaces = meshSurfaces(triangles, extras.tone).map((surface) => ({
            ...surface,
            exterior,
            surfaceId,
            ribbon,
            overlayPanel: extras.overlayPanel,
            edge: extras.edge === true,
            texture: extras.texture ?? (ribbon ? false : surface.texture),
          }));
          (ribbon ? pose.ribbons : pose.paper).push(...surfaces);
        }
        if (extras.role === 'print') pose.print.push(printSurface(printParts, extras));
      }
      for (const child of node.children || []) visit(child, matrix, poseName);
    }

    const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes || [];
    for (const root of roots) visit(root, IDENTITY, null);
    for (const [poseName, pose] of Object.entries(poses)) {
      const expected = [...guidePolicy.values()].filter((allowedPoses) => allowedPoses.has(poseName)).length;
      if (!pose.paper.length || pose.print.length !== expected ||
          new Set(pose.print.map(({ panel }) => panel)).size !== expected) {
        throw new Error(`The model's ${poseName} pose must contain each specified print guide exactly once.`);
      }
      if (product === 'bag' && !pose.ribbons.length) throw new Error('The bag model is missing ribbon geometry.');
      pose.artwork = pose.print.flatMap((artwork) => bindArtwork(pose.paper, artwork, product === 'bag'));
    }
    return poses;
  }

  function bindPrint(paper, artwork, { requireSurfaceTag, requireCoplanar }) {
    const center = artwork.vertices[0].map((_, axis) =>
      artwork.vertices.reduce((sum, point) => sum + point[axis], 0) / artwork.vertices.length);
    let closest = -1;
    let distanceLimit = .0007;
    for (const [index, surface] of paper.entries()) {
      const matchesSurface = surface.surfaceId === artwork.panel || (!requireSurfaceTag && !surface.surfaceId);
      if (!matchesSurface || dot(surface.normal, artwork.normal) < .999 ||
          !insideOutline(center, surface.vertices, surface.normal)) continue;
      const distance = Math.abs(dot(subtract(center, surface.vertices[0]), surface.normal));
      if (distance >= distanceLimit || surface.cutouts?.some((loop) => insideOutline(center, loop, surface.normal))) continue;
      if (requireCoplanar && artwork.vertices.some(
        (point) => Math.abs(dot(subtract(point, surface.vertices[0]), surface.normal)) >= .0007)) continue;
      closest = index;
      distanceLimit = distance;
    }
    return closest;
  }

  function bindArtwork(paper, artwork, requireSurfaceTag) {
    const { panel, triangles } = artwork;
    if (!triangles) {
      const source = bindPrint(paper, artwork, { requireSurfaceTag });
      if (source === -1) throw new Error(`The ${panel} print guide does not match its paper surface.`);
      return [{ source, artwork }];
    }
    const facets = new Map();
    for (const triangle of triangles) {
      const source = bindPrint(paper, { ...triangle, panel }, { requireSurfaceTag, requireCoplanar: true });
      if (source === -1) throw new Error(`The ${panel} print mesh does not follow the paper facets.`);
      if (!facets.has(source)) facets.set(source, []);
      facets.get(source).push(triangle);
    }
    return [...facets].map(([source, group]) => ({ source, artwork: { ...artwork, triangles: group } }));
  }

  function modelOf(poses) {
    const closedPoints = poses.closed.paper.flatMap((surface) => surface.vertices);
    const min = [0, 1, 2].map((axis) => closedPoints.reduce((bound, point) => Math.min(bound, point[axis]), Infinity));
    const max = [0, 1, 2].map((axis) => closedPoints.reduce((bound, point) => Math.max(bound, point[axis]), -Infinity));
    const center = min.map((value, axis) => (value + max[axis]) / 2);
    const maxSize = Math.max(...subtract(max, min));
    if (!Number.isFinite(maxSize) || maxSize <= 0) throw new Error('The model does not have valid dimensions.');
    return {
      build({ dimensions, foldOpen, face }) {
        const pose = (foldOpen && poses.open) || poses.closed;
        const scale = Math.max(...dimensions) / maxSize;
        const convert = (point) => point.map((value, axis) => (value - center[axis]) * scale);
        const faces = pose.paper.concat(pose.ribbons).map(({ vertices, normal, cutouts, ...settings }) =>
          face(vertices.map(convert), normal, { ...settings, cutouts: cutouts?.map((loop) => loop.map(convert)) }));
        for (const { source, artwork } of pose.artwork) {
          const parent = faces[source];
          const overlay = {
            panel: artwork.panel,
            vertices: parent.vertices,
            width: artwork.width * scale,
            height: artwork.height * scale,
            logoArea: artwork.logoArea,
            cutouts: parent.cutouts,
          };
          if (artwork.triangles) {
            overlay.uvTriangles = artwork.triangles.map(({ vertices, uv }) => ({ vertices: vertices.map(convert), uv }));
          } else {
            overlay.uvVertices = artwork.uvVertices.map(convert);
          }
          parent.surfaceId ??= artwork.panel;
          (parent.artworkSurfaces ||= []).push(overlay);
        }
        return {
          faces,
          floor: (min[1] - center[1]) * scale,
          framing: { points: faces.flatMap((surface) => surface.vertices) },
        };
      },
    };
  }

  window.VectoryGLB = {
    async load(url, { product, panels, guidePoses = {} }) {
      const allowedSurfaces = product === 'box' ? BOX_SURFACES : BAG_SURFACES;
      const poses = product === 'box' ? ['closed', 'open'] : ['closed'];
      if (!['box', 'bag'].includes(product) || !Array.isArray(panels) ||
          panels.some((panel) => !allowedSurfaces.has(panel)) || new Set(panels).size !== panels.length ||
          !guidePoses || typeof guidePoses !== 'object' || Array.isArray(guidePoses) ||
          Object.keys(guidePoses).some((panel) => !panels.includes(panel))) {
        throw new Error('The catalog model is missing valid print panel settings.');
      }
      const guidePolicy = new Map();
      for (const panel of panels) {
        const supplied = Object.hasOwn(guidePoses, panel) ? guidePoses[panel] : poses;
        if (!Array.isArray(supplied) || supplied.length === 0 ||
            supplied.some((pose) => !poses.includes(pose)) || new Set(supplied).size !== supplied.length) {
          throw new Error(`The catalog model has invalid poses for the ${panel} print guide.`);
        }
        guidePolicy.set(panel, new Set(supplied));
      }
      const result = await fetch(url);
      if (!result.ok) throw new Error(`The 3D model could not be loaded (HTTP ${result.status}).`);
      return modelOf(readModel(await result.arrayBuffer(), product, guidePolicy, allowedSurfaces));
    },
  };
})();
