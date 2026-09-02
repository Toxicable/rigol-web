function collectStylesheetText(): string {
  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        chunks.push(rule.cssText);
      }
    } catch {
      // Cross-origin stylesheets cannot be inspected. Rigol Web currently bundles
      // its styles locally, so this is only a guard for future external content.
    }
  }
  return chunks.join("\n");
}

function copyRootPresentation(wrapper: HTMLDivElement): void {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);

  wrapper.style.width = `${window.innerWidth}px`;
  wrapper.style.height = `${window.innerHeight}px`;
  wrapper.style.overflow = "hidden";
  wrapper.style.background = bodyStyle.background;
  wrapper.style.color = rootStyle.color;
  wrapper.style.font = rootStyle.font;
  wrapper.style.colorScheme = rootStyle.colorScheme;

  for (const property of Array.from(rootStyle)) {
    if (property.startsWith("--")) {
      wrapper.style.setProperty(property, rootStyle.getPropertyValue(property));
    }
  }
}

function syncFormState(sourceRoot: HTMLElement, cloneRoot: HTMLElement): void {
  const sourceInputs = Array.from(sourceRoot.querySelectorAll("input"));
  const cloneInputs = Array.from(cloneRoot.querySelectorAll("input"));
  for (let index = 0; index < sourceInputs.length; index += 1) {
    const source = sourceInputs[index];
    const clone = cloneInputs[index];
    if (clone === undefined) {
      continue;
    }
    clone.value = source.value;
    clone.setAttribute("value", source.value);
    clone.checked = source.checked;
    if (source.checked) {
      clone.setAttribute("checked", "");
    } else {
      clone.removeAttribute("checked");
    }
  }

  const sourceTextareas = Array.from(sourceRoot.querySelectorAll("textarea"));
  const cloneTextareas = Array.from(cloneRoot.querySelectorAll("textarea"));
  for (let index = 0; index < sourceTextareas.length; index += 1) {
    const source = sourceTextareas[index];
    const clone = cloneTextareas[index];
    if (clone === undefined) {
      continue;
    }
    clone.value = source.value;
    clone.textContent = source.value;
  }

  const sourceSelects = Array.from(sourceRoot.querySelectorAll("select"));
  const cloneSelects = Array.from(cloneRoot.querySelectorAll("select"));
  for (let index = 0; index < sourceSelects.length; index += 1) {
    const source = sourceSelects[index];
    const clone = cloneSelects[index];
    if (clone === undefined) {
      continue;
    }
    for (let optionIndex = 0; optionIndex < clone.options.length; optionIndex += 1) {
      const option = clone.options[optionIndex];
      option.selected = optionIndex === source.selectedIndex;
      if (option.selected) {
        option.setAttribute("selected", "");
      } else {
        option.removeAttribute("selected");
      }
    }
  }
}

function replaceCanvases(sourceRoot: HTMLElement, cloneRoot: HTMLElement): void {
  const sourceCanvases = Array.from(sourceRoot.querySelectorAll("canvas"));
  const cloneCanvases = Array.from(cloneRoot.querySelectorAll("canvas"));

  if (sourceCanvases.length !== cloneCanvases.length) {
    throw new Error("Could not reproduce the current waveform canvases");
  }

  for (let index = 0; index < sourceCanvases.length; index += 1) {
    const source = sourceCanvases[index];
    const clone = cloneCanvases[index];
    if (clone === undefined) {
      continue;
    }

    const image = document.createElement("img");
    for (const attribute of Array.from(clone.attributes)) {
      image.setAttribute(attribute.name, attribute.value);
    }
    image.src = source.toDataURL("image/png");

    const bounds = source.getBoundingClientRect();
    image.style.width = `${bounds.width}px`;
    image.style.height = `${bounds.height}px`;
    clone.replaceWith(image);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not render the screenshot image"));
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("Could not encode the screenshot as PNG"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function renderViewportToPng(): Promise<Blob> {
  const sourceRoot = document.getElementById("root");
  if (!(sourceRoot instanceof HTMLElement)) {
    throw new Error("Rigol Web root element was not found");
  }

  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const cloneRoot = sourceRoot.cloneNode(true) as HTMLElement;
  syncFormState(sourceRoot, cloneRoot);
  replaceCanvases(sourceRoot, cloneRoot);
  cloneRoot.querySelectorAll("[data-screenshot-exclude]").forEach((element) => element.remove());
  cloneRoot.style.width = `${width}px`;
  cloneRoot.style.height = `${height}px`;

  const wrapper = document.createElement("div");
  wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  copyRootPresentation(wrapper);

  const style = document.createElement("style");
  style.textContent = collectStylesheetText();
  wrapper.append(style, cloneRoot);

  const markup = new XMLSerializer().serializeToString(wrapper);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject>`,
    "</svg>",
  ].join("");

  const svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(svgUrl);
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);

    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Browser canvas rendering is unavailable");
    }
    context.scale(pixelRatio, pixelRatio);
    context.drawImage(image, 0, 0, width, height);
    return await canvasBlob(canvas);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export async function copyViewportScreenshot(): Promise<void> {
  if (!window.isSecureContext) {
    throw new Error("Copy Screenshot requires HTTPS or localhost because browsers block image clipboard access on insecure pages");
  }
  if (navigator.clipboard?.write === undefined || typeof ClipboardItem === "undefined") {
    throw new Error("This browser does not support copying PNG images to the clipboard");
  }

  const png = await renderViewportToPng();
  await navigator.clipboard.write([
    new ClipboardItem({
      "image/png": png,
    }),
  ]);
}
