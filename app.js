(() => {
  'use strict';

  const byId = (id) => document.getElementById(id);
  const catalog = window.PackagingCatalog;
  if (!catalog?.products || !window.PackagingRenderer) {
    byId('studio-error').textContent = window.location.protocol === 'file:'
      ? 'Open the studio through a web server.'
      : 'The studio could not load. Refresh the page to try again.';
    byId('studio-error').hidden = false;
    byId('quote-open').disabled = true;
    return;
  }

  const products = catalog.products;
  const isDemo = catalog.demo === true;
  const productViews = {
    box: [0.35, 0.29],
    bag: [0.34, 0.13],
  };
  const openBoxView = [0.46, 0.50];
  const panelViews = {
    closure: [0.13, 0.23, false],
    front: [0.08, 0.13, true],
    back: [Math.PI, 0.08, false],
    roof: [0.35, 0.78, false],
    'left-side': [-1.25, 0.25, false],
    'right-side': [1.25, 0.25, false],
    'left-wing': [-0.9, 0.31, true],
    'right-wing': [0.9, 0.31, true],
    base: [0.32, -0.94, false],
    interior: [0.45, 0.78, true],
  };
  const maxLogoBytes = 8 * 1024 * 1024;
  const maxPreviewBytes = 5 * 1024 * 1024;
  const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const defaultPlacement = { logoScale: 0.55, logoX: 0, logoY: 0 };
  const noInk = { c: 0, m: 0, y: 0, k: 0 };
  const inkChannels = Object.keys(noInk);
  const canvas = byId('product-canvas');
  const productButtons = [...document.querySelectorAll('[data-product]')];
  const sizeSelect = byId('product-size');
  const panelSelect = byId('logo-panel');
  const ribbonSelect = byId('ribbon-color');
  const logoSettings = byId('logo-settings');
  const viewPanelButton = byId('view-front');
  const printColorSettings = byId('print-color-settings');
  const printColorScope = byId('print-color-scope');
  const printColorPicker = byId('print-color-picker');
  const printColorStatus = byId('print-color-status');
  const clearPrintColor = byId('print-color-clear');
  const inkInputs = Object.fromEntries(inkChannels.map((channel) => [channel, byId(`print-ink-${channel}`)]));
  const lidToggle = byId('lid-toggle');
  const fileInput = byId('logo-file');
  const logoName = byId('logo-name');
  const logoControls = byId('logo-controls');
  const removeButton = byId('logo-remove');
  const scaleInput = byId('logo-scale');
  const xInput = byId('logo-x');
  const yInput = byId('logo-y');
  const dialog = byId('quote-dialog');
  const form = byId('quote-form');
  const quoteResult = byId('quote-result');
  const quoteButton = form.querySelector('[type="submit"]');
  const renderer = new window.PackagingRenderer(canvas);
  const studioError = byId('studio-error');
  const modelLoading = byId('model-loading');
  const quoteOpen = byId('quote-open');

  function artworkPanels(draft) {
    const policy = selectedSize(draft).surfacePolicy;
    if (!policy) return products[draft.product].panels;
    return Object.fromEntries(
      policy.surfaces.filter(({ artwork }) => artwork).map(({ id, label }) => [id, label]),
    );
  }

  function createDraft(product) {
    const spec = products[product];
    const [yaw, pitch] = productViews[product];
    return {
      product,
      size: spec.defaultSize,
      dimensions: spec.sizes[spec.defaultSize].previewDimensions,
      material: spec.defaultMaterial,
      panel: spec.defaultPanel,
      ribbonColor: spec.ribbonDefault,
      foldOpen: false,
      model: null,
      modelAsset: null,
      modelStatus: 'idle',
      printScope: null,
      printColors: {},
      colorableSurfaces: [],
      panelArt: {},
      uploads: {},
      yaw,
      pitch,
      zoom: 1,
    };
  }

  const drafts = Object.fromEntries(Object.keys(products).map((product) => [product, createDraft(product)]));
  let state = drafts.box;
  let frame = 0;
  let drag = null;
  let pendingQuote = null;
  let submitting = false;
  let invalidPrintColor = false;

  function draw() {
    frame = 0;
    renderer.render(state);
  }

  function scheduleDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function notify(message) {
    byId('preview-status').textContent = message;
  }

  function selectedSize(draft = state) {
    return products[draft.product].sizes[draft.size];
  }

  function replaceOptions(select, options, selected) {
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    select.value = selected;
  }

  function syncDetails() {
    const variant = selectedSize();
    const dimensions = byId('product-dimensions');
    dimensions.textContent = variant.measurementLabel || '';
    dimensions.hidden = !variant.measurementLabel;
    const dielineLink = byId('product-dieline-link');
    dielineLink.hidden = !variant.dielineUrl;
    if (variant.dielineUrl) dielineLink.href = variant.dielineUrl;
    else dielineLink.removeAttribute('href');
  }

  function syncQuoteAvailability() {
    quoteOpen.disabled = isDemo || state.modelStatus !== 'ready' || invalidPrintColor;
  }

  function syncModelStatus() {
    const { modelStatus } = state;
    const loading = modelStatus === 'idle' || modelStatus === 'loading';
    canvas.setAttribute('aria-busy', String(loading));
    modelLoading.hidden = !loading;
    studioError.hidden = modelStatus !== 'failed';
    if (modelStatus === 'failed') {
      studioError.textContent = `The ${products[state.product].title} preview could not load. Refresh the page to try again.`;
    }
    syncQuoteAvailability();
  }

  async function loadDraftModel(draft) {
    const product = products[draft.product];
    const model = product.sizes[draft.size].model;
    if (draft.model === model && draft.modelStatus !== 'idle') return;
    draft.model = model;
    draft.modelAsset = null;
    draft.modelStatus = 'loading';
    if (draft === state) {
      syncModelStatus();
      scheduleDraw();
    }
    try {
      if (!model?.url) throw new Error('The product has no preview model.');
      const asset = await window.VectoryGLB.load(model.url, {
        product: draft.product,
        panels: model.guideSurfaces ?? Object.keys(product.panels),
        guidePoses: model.guidePoses,
      });
      if (draft.model !== model) return;
      draft.modelAsset = asset;
      draft.modelStatus = 'ready';
    } catch (error) {
      if (draft.model !== model) return;
      draft.modelStatus = 'failed';
      console.error('The product model could not load.', error);
    }
    if (draft === state) {
      syncModelStatus();
      scheduleDraw();
    }
  }

  function syncProduct() {
    const product = products[state.product];
    const permissions = artworkPanels(state);
    const panels = Object.entries(permissions);
    if (!Object.hasOwn(permissions, state.panel)) {
      state.panel = Object.hasOwn(permissions, product.defaultPanel) ? product.defaultPanel : panels[0]?.[0] ?? null;
    }
    const colorable = selectedSize().surfacePolicy?.surfaces.filter(({ color }) => color) || [];
    state.colorableSurfaces = colorable.map(({ id }) => id);
    const colorScopes = [
      ...(state.colorableSurfaces.some((id) => id !== 'interior') ? [['exterior', 'Exterior base']] : []),
      ...colorable.map(({ id, label }) => [id, label]),
    ];
    if (!colorScopes.some(([scope]) => scope === state.printScope)) state.printScope = colorScopes[0]?.[0] ?? null;
    productButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.product === state.product)));
    byId('product-title').textContent = product.title;
    replaceOptions(sizeSelect, Object.entries(product.sizes).map(([size, details]) => [size, details.label]), state.size);
    replaceOptions(panelSelect, panels, state.panel);
    logoSettings.hidden = panels.length === 0;
    replaceOptions(printColorScope, colorScopes, state.printScope);
    viewPanelButton.disabled = !state.panel && !state.printScope;
    replaceOptions(ribbonSelect, Object.entries(product.ribbonColors), state.ribbonColor);
    byId('ribbon-settings').hidden = Object.keys(product.ribbonColors).length === 0;
    byId('box-settings').hidden = state.product !== 'box';
    syncModelStatus();
    syncPrintColor();
    syncClosure();
    syncDetails();
  }

  function cmykToHex({ c, m, y, k }) {
    const black = 1 - k / 100;
    const bytes = [c, m, y].map((ink) => Math.round(255 * (1 - ink / 100) * black));
    return `#${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function hexToCmyk(hex) {
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const lightest = Math.max(...rgb);
    const percent = (value) => Math.round(clamp(value, 0, 1) * 1000) / 10;
    const [c, m, y] = lightest ? rgb.map((channel) => percent(1 - channel / lightest)) : [0, 0, 0];
    return { c, m, y, k: percent(1 - lightest) };
  }

  function syncPrintColorStatus() {
    const { printScope, printColors } = state;
    const ownColor = Object.hasOwn(printColors, printScope);
    clearPrintColor.disabled = !ownColor && !invalidPrintColor;
    printColorStatus.toggleAttribute('data-error', invalidPrintColor);
    if (invalidPrintColor) {
      printColorStatus.textContent = 'Enter a percentage from 0 to 100 for each ink.';
    } else if (printScope === 'exterior') {
      const overrides = Object.keys(printColors).filter((area) => area !== 'exterior' && area !== 'interior').length;
      const outside = selectedSize().surfacePolicy.surfaces.filter(({ id }) => id !== 'interior').length;
      const enabled = state.colorableSurfaces.filter((id) => id !== 'interior').length;
      printColorStatus.textContent = [
        enabled < outside && `Covers ${enabled} of ${outside} outside surfaces.`,
        overrides > 0 && `${overrides} ${overrides === 1 ? 'surface has its' : 'surfaces have their'} own color.`,
      ].filter(Boolean).join(' ');
    } else {
      printColorStatus.textContent = !ownColor && printScope !== 'interior' && printColors.exterior
        ? 'Using the exterior base color.'
        : '';
    }
    syncQuoteAvailability();
  }

  function syncPrintColor() {
    printColorSettings.hidden = !state.printScope;
    invalidPrintColor = false;
    if (printColorSettings.hidden) {
      syncQuoteAvailability();
      return;
    }
    printColorScope.value = state.printScope;
    const base = state.printScope !== 'interior' ? state.printColors.exterior : null;
    const ink = state.printColors[state.printScope] || base || noInk;
    for (const channel of inkChannels) inkInputs[channel].value = ink[channel];
    printColorPicker.value = cmykToHex(ink);
    syncPrintColorStatus();
  }

  function syncLogo() {
    const artwork = state.panelArt[state.panel];
    const placement = artwork || defaultPlacement;
    logoName.textContent = artwork?.filename || 'PNG, JPG or WebP · 8 MB total';
    logoControls.disabled = !artwork;
    removeButton.disabled = !artwork;
    removeButton.hidden = !artwork;
    scaleInput.value = String(Math.round(placement.logoScale * 100));
    xInput.value = String(Math.round(placement.logoX * 100));
    yInput.value = String(Math.round(placement.logoY * 100));
    const count = Object.keys(state.panelArt).length;
    byId('panel-art-count').textContent = count ? `${count} ${count === 1 ? 'panel' : 'panels'} with artwork` : '';
  }

  function syncClosure() {
    lidToggle.textContent = state.foldOpen ? 'Close closure' : 'Open closure';
  }

  function panelPose(panel) {
    const [yaw, pitch, open = false] = panelViews[panel] ?? productViews[state.product];
    const poses = state.model?.guidePoses?.[panel];
    const foldOpen = state.product === 'box' && (poses?.length === 1 ? poses[0] === 'open' : open);
    return { yaw, pitch, foldOpen };
  }

  function focusPanel(panel) {
    Object.assign(state, panelPose(panel), { zoom: 1 });
    syncClosure();
    scheduleDraw();
  }

  function resetView() {
    [state.yaw, state.pitch] = state.foldOpen ? openBoxView : productViews[state.product];
    state.zoom = 1;
    scheduleDraw();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function zoomBy(amount) {
    state.zoom = clamp(state.zoom + amount, 0.75, 1.65);
    scheduleDraw();
  }

  function rotateBy(yaw, pitch) {
    state.yaw = (state.yaw + yaw) % (Math.PI * 2);
    state.pitch = clamp(state.pitch + pitch, -0.35, 1.35);
    scheduleDraw();
  }

  productButtons.forEach((button) => button.addEventListener('click', () => {
    const product = button.dataset.product;
    if (product === state.product) return;
    state = drafts[product];
    syncProduct();
    syncLogo();
    loadDraftModel(state);
    scheduleDraw();
    notify(`${products[product].title} selected.`);
  }));

  sizeSelect.addEventListener('change', () => {
    state.size = sizeSelect.value;
    state.dimensions = selectedSize().previewDimensions;
    syncProduct();
    syncLogo();
    loadDraftModel(state);
    scheduleDraw();
  });

  panelSelect.addEventListener('change', () => {
    state.panel = panelSelect.value;
    syncLogo();
    focusPanel(state.panel);
  });

  function focusColorScope() {
    if (state.printScope === 'exterior') {
      state.foldOpen = false;
      syncClosure();
      resetView();
    } else {
      focusPanel(state.printScope);
    }
  }

  printColorScope.addEventListener('change', () => {
    state.printScope = printColorScope.value;
    syncPrintColor();
    focusColorScope();
  });

  for (const input of Object.values(inkInputs)) {
    input.addEventListener('input', () => {
      const ink = Object.fromEntries(inkChannels.map((channel) => [channel, inkInputs[channel].valueAsNumber]));
      invalidPrintColor = Object.values(ink).some((value) => !Number.isFinite(value) || value < 0 || value > 100);
      if (!invalidPrintColor) {
        state.printColors[state.printScope] = ink;
        printColorPicker.value = cmykToHex(ink);
        scheduleDraw();
      }
      syncPrintColorStatus();
    });
  }

  printColorPicker.addEventListener('input', () => {
    state.printColors[state.printScope] = hexToCmyk(printColorPicker.value);
    syncPrintColor();
    scheduleDraw();
  });

  clearPrintColor.addEventListener('click', () => {
    delete state.printColors[state.printScope];
    syncPrintColor();
    scheduleDraw();
  });

  lidToggle.addEventListener('click', () => {
    state.foldOpen = !state.foldOpen;
    const nextPanel = state.foldOpen ? 'front' : 'closure';
    if (Object.hasOwn(artworkPanels(state), nextPanel)) state.panel = nextPanel;
    panelSelect.value = state.panel;
    syncLogo();
    syncClosure();
    resetView();
    notify(state.foldOpen ? 'The closure is open.' : 'The closure is closed.');
  });

  ribbonSelect.addEventListener('change', () => {
    state.ribbonColor = ribbonSelect.value;
    scheduleDraw();
    notify(`${products.bag.ribbonColors[state.ribbonColor]} ribbon selected.`);
  });

  for (const [control, property] of [[scaleInput, 'logoScale'], [xInput, 'logoX'], [yInput, 'logoY']]) {
    control.addEventListener('input', () => {
      const artwork = state.panelArt[state.panel];
      if (!artwork) return;
      artwork[property] = Number(control.value) / 100;
      scheduleDraw();
    });
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(reader.result));
      reader.addEventListener('error', () => reject(new Error('The file could not be read.')));
      reader.readAsDataURL(file);
    });
  }

  function startUpload() {
    const upload = { draft: state, panel: state.panel };
    state.uploads[state.panel] = upload;
    return upload;
  }

  function showUploadError(upload, message) {
    if (upload.draft.uploads[upload.panel] !== upload) return;
    delete upload.draft.uploads[upload.panel];
    if (state === upload.draft && state.panel === upload.panel) {
      logoName.textContent = message;
      notify(message);
    }
  }

  function imageBytes(data) {
    const encodedLength = data.length - data.indexOf(',') - 1;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return encodedLength * 3 / 4 - padding;
  }

  async function setLogo(data, filename, bytes, upload) {
    const image = new Image();
    image.src = data;
    await image.decode();
    const { draft, panel } = upload;
    if (draft.uploads[panel] !== upload) return;
    const otherBytes = Object.entries(draft.panelArt).reduce((total, [id, artwork]) => total + (id === panel ? 0 : artwork.bytes), 0);
    if (bytes + otherBytes > maxLogoBytes) {
      showUploadError(upload, 'Total artwork for this product must be 8 MB or less.');
      return;
    }
    draft.panelArt[panel] = {
      logo: image,
      data,
      filename,
      bytes,
      ...defaultPlacement,
      logoY: draft.product === 'bag' && (panel === 'front' || panel === 'back') ? 0.45 : defaultPlacement.logoY,
    };
    delete draft.uploads[panel];
    if (state === draft) {
      syncLogo();
      if (state.panel === panel) focusPanel(panel);
      else scheduleDraw();
      notify(`${filename} added to ${artworkPanels(draft)[panel]}.`);
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const upload = startUpload();
    fileInput.value = '';
    if (!imageTypes.includes(file.type) || file.size > maxLogoBytes) {
      showUploadError(upload, 'Choose a PNG, JPG, or WebP image up to 8 MB.');
      return;
    }
    try {
      await setLogo(await readImage(file), file.name, file.size, upload);
    } catch {
      showUploadError(upload, 'This logo could not be opened. Try a different image.');
    }
  });

  byId('logo-sample')?.addEventListener('click', async () => {
    const sample = document.createElement('canvas');
    sample.width = 360;
    sample.height = 235;
    const context = sample.getContext('2d');
    context.translate(-60, 0);
    context.fillStyle = state.material === 'charcoal' ? '#f6efd7' : '#253629';
    context.lineWidth = 10;
    context.strokeStyle = context.fillStyle;
    context.beginPath();
    context.moveTo(194, 77);
    context.lineTo(227, 35);
    context.lineTo(250, 61);
    context.lineTo(270, 39);
    context.lineTo(301, 77);
    context.stroke();
    context.font = 'bold 83px Georgia, serif';
    context.textAlign = 'center';
    context.fillText('Juniper', 240, 166);
    context.font = 'bold 26px system-ui, sans-serif';
    context.fillText('G O O D S', 240, 212);
    const upload = startUpload();
    const imageData = sample.toDataURL();
    try {
      await setLogo(imageData, 'Sample logo.png', imageBytes(imageData), upload);
    } catch {
      showUploadError(upload, 'The sample logo could not be opened.');
    }
  });

  removeButton.addEventListener('click', () => {
    delete state.uploads[state.panel];
    delete state.panelArt[state.panel];
    syncLogo();
    scheduleDraw();
    notify('Logo removed.');
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-orbiting');
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    rotateBy((event.clientX - drag.x) * 0.009, (event.clientY - drag.y) * 0.007);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  canvas.addEventListener('lostpointercapture', () => {
    drag = null;
    canvas.classList.remove('is-orbiting');
  });
  canvas.addEventListener('keydown', (event) => {
    const keys = {
      ArrowLeft: () => rotateBy(-0.15, 0),
      ArrowRight: () => rotateBy(0.15, 0),
      ArrowUp: () => rotateBy(0, -0.13),
      ArrowDown: () => rotateBy(0, 0.13),
      '+': () => zoomBy(0.12),
      '=': () => zoomBy(0.12),
      '-': () => zoomBy(-0.12),
      Home: resetView,
    };
    if (!Object.hasOwn(keys, event.key)) return;
    event.preventDefault();
    keys[event.key]();
  });

  byId('view-reset').addEventListener('click', resetView);
  viewPanelButton.addEventListener('click', () => {
    if (state.panel) focusPanel(state.panel);
    else if (state.printScope) focusColorScope();
  });
  byId('zoom-in').addEventListener('click', () => zoomBy(0.12));
  byId('zoom-out').addEventListener('click', () => zoomBy(-0.12));

  quoteOpen.addEventListener('click', () => {
    if (isDemo) return;
    const product = products[state.product];
    byId('quote-summary').textContent = [
      product.title,
      selectedSize().label,
      product.materials[state.material],
      state.ribbonColor && `${product.ribbonColors[state.ribbonColor]} ribbon`,
      Object.keys(state.printColors).length && 'CMYK print colors',
    ].filter(Boolean).join(' · ');
    quoteResult.textContent = '';
    dialog.showModal();
  });
  dialog.querySelectorAll('[data-dialog-close]').forEach((button) => {
    button.addEventListener('click', () => { if (!submitting) dialog.close(); });
  });
  dialog.addEventListener('cancel', (event) => { if (submitting) event.preventDefault(); });

  function quotePreviews(panels) {
    const output = document.createElement('canvas');
    const exportRenderer = new window.PackagingRenderer(output);
    const [yaw, pitch] = productViews[state.product];
    const views = [['overview', { yaw, pitch, foldOpen: false }], ...panels.map((panel) => [panel, panelPose(panel)])];
    const context = output.getContext('2d');
    function capture(width, height) {
      return Object.fromEntries(views.map(([panel, pose]) => {
        exportRenderer.render({ ...state, ...pose, zoom: 1 }, { width, height, dpr: 1 });
        context.save();
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#efeee8';
        context.fillRect(0, 0, width, height);
        context.restore();
        return [panel, output.toDataURL('image/png')];
      }));
    }
    for (const [width, height] of [[900, 620], [660, 455]]) {
      const previews = capture(width, height);
      const totalBytes = Object.values(previews).reduce((total, preview) => total + imageBytes(preview), 0);
      if (totalBytes <= maxPreviewBytes) return previews;
    }
    return capture(400, 276);
  }

  function quotePayload() {
    const product = products[state.product];
    const policy = selectedSize().surfacePolicy;
    const artworks = Object.entries(state.panelArt).map(([panel, artwork]) => ({
      panel,
      filename: artwork.filename,
      data: artwork.data,
      scale: artwork.logoScale,
      x: artwork.logoX,
      y: artwork.logoY,
    }));
    return {
      specs: {
        product: state.product,
        styleId: product.styleId,
        size: state.size,
        catalogRevision: catalog.revision,
        modelRevision: state.model.revision,
        panelMapRevision: state.model.panelMapRevision,
        ...(policy ? { surfacePolicyRevision: policy.revision } : {}),
        material: state.material,
        ribbonColor: state.ribbonColor,
        ...(Object.keys(state.printColors).length ? { printColors: state.printColors } : {}),
      },
      contact: Object.fromEntries(new FormData(form)),
      artworks,
      previews: quotePreviews([...new Set([
        ...artworks.map((artwork) => artwork.panel),
        ...Object.keys(state.printColors).filter((area) => area !== 'exterior'),
      ])]),
    };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (isDemo || submitting) return;
    if (window.location.protocol === 'file:') {
      quoteResult.textContent = 'Open the configurator through its local server to submit a quote request.';
      return;
    }
    if (Object.keys(state.uploads).length) {
      quoteResult.textContent = 'Your logo is still loading. Try again in a moment.';
      return;
    }
    if (state.modelStatus !== 'ready') {
      quoteResult.textContent = 'Wait for the 3D model to load before requesting a quote.';
      return;
    }
    submitting = true;
    quoteButton.disabled = true;
    quoteResult.textContent = 'Saving your request…';
    try {
      const request = quotePayload();
      const signature = JSON.stringify([request.specs, request.contact, request.artworks]);
      if (pendingQuote?.signature !== signature) pendingQuote = { signature, id: crypto.randomUUID() };
      const response = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, requestId: pendingQuote.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The request could not be saved.');
      quoteResult.textContent = `Quote request saved. Reference ${result.reference}.`;
      pendingQuote = null;
      form.reset();
    } catch (error) {
      quoteResult.textContent = error instanceof TypeError
        ? 'The server could not be reached. Your details are still here. Try again.'
        : error.message || 'The request could not be saved. Try again.';
    } finally {
      submitting = false;
      quoteButton.disabled = false;
    }
  });

  for (const button of productButtons) {
    button.querySelector('.product-button-label').textContent = products[button.dataset.product].title;
  }
  byId('site-context').textContent = isDemo ? 'Packaging studio demo' : 'Packaging studio pilot';
  const pilotStatus = byId('pilot-status');
  pilotStatus.hidden = !isDemo && !catalog.provisional;
  if (isDemo) {
    pilotStatus.textContent = 'Sample geometry';
    byId('product-size-label').textContent = 'Size';
  }
  quoteOpen.closest('.quote-action').hidden = isDemo;
  syncProduct();
  syncLogo();
  loadDraftModel(state);
  new ResizeObserver(scheduleDraw).observe(canvas);
  scheduleDraw();
})();
