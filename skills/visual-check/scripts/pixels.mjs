// Pixel work done in a blank browser page, so the checks need no image library: the browser decodes
// the PNGs, measures them, and draws the contact sheets and the vision probe.

/** Opens the page all pixel work runs in. */
export async function pixelPage(browser) {
  const page = await browser.newPage();
  await page.goto("about:blank");
  return page;
}

/** How much of a screenshot is one colour, and how varied it is. A blank or failed screen is nearly one colour. */
export function imageStats(page, png) {
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
    const total = bmp.width * bmp.height;
    const step = Math.max(1, Math.floor(total / 250_000));
    const buckets = new Map();
    let n = 0, sum = 0, sumSq = 0;
    for (let p = 0; p < total; p += step) {
      const i = p * 4;
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      sum += y;
      sumSq += y * y;
      n++;
    }
    let top = 0, topKey = 0;
    for (const [k, v] of buckets) if (v > top) { top = v; topKey = k; }
    const hex = (v) => ((v << 4) | 8).toString(16).padStart(2, "0");
    const mean = sum / n;
    return {
      width: bmp.width,
      height: bmp.height,
      dominant: Math.round((top / n) * 1000) / 1000,
      dominantColor: `#${hex(topKey >> 8)}${hex((topKey >> 4) & 15)}${hex(topKey & 15)}`,
      colors: buckets.size,
      lumaStd: Math.round(Math.sqrt(Math.max(0, sumSq / n - mean * mean)) * 10) / 10,
    };
  }, png.toString("base64"));
}

/** The share of pixels that differ clearly between two same-sized screenshots (0 = identical). */
export function frameDiff(page, a, b) {
  return page.evaluate(async ([a64, b64]) => {
    const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
    const [ia, ib] = await Promise.all([load(a64), load(b64)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return 1;
    const read = (bmp) => {
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height).data;
    };
    const da = read(ia), db = read(ib);
    let changed = 0;
    const total = ia.width * ia.height;
    for (let p = 0; p < total; p++) {
      const i = p * 4;
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) changed++;
    }
    return Math.round((changed / total) * 10000) / 10000;
  }, [a.toString("base64"), b.toString("base64")]);
}

/**
 * One picture with every viewport and theme of a screen side by side, each labelled, so the
 * evaluator can compare them with one image read before opening the full-size ones.
 */
export async function contactSheet(page, rows, height = 520) {
  const b64 = await page.evaluate(
    async ({ rows, height }) => {
      const load = async (s) => createImageBitmap(await (await fetch(`data:image/png;base64,${s}`)).blob());
      const pad = 16, labelH = 26;
      const loaded = await Promise.all(rows.map(async (row) => Promise.all(row.map(async (cell) => ({ ...cell, bmp: await load(cell.png) })))));
      const scaled = loaded.map((row) => row.map((cell) => {
        const s = Math.min(1, height / cell.bmp.height);
        return { ...cell, w: Math.round(cell.bmp.width * s), h: Math.round(cell.bmp.height * s) };
      }));
      const width = Math.max(...scaled.map((row) => row.reduce((sum, c) => sum + c.w + pad, pad)));
      const rowH = scaled.map((row) => Math.max(...row.map((c) => c.h)) + labelH + pad);
      const c = new OffscreenCanvas(width, rowH.reduce((a, b) => a + b, pad));
      const g = c.getContext("2d");
      g.fillStyle = "#808080";
      g.fillRect(0, 0, c.width, c.height);
      let y = pad;
      scaled.forEach((row, r) => {
        let x = pad;
        for (const cell of row) {
          g.fillStyle = "#ffffff";
          g.font = "bold 16px sans-serif";
          g.fillText(cell.label, x, y + 18);
          g.drawImage(cell.bmp, x, y + labelH, cell.w, cell.h);
          g.strokeStyle = "#000000";
          g.strokeRect(x - 0.5, y + labelH - 0.5, cell.w + 1, cell.h + 1);
          x += cell.w + pad;
        }
        y += rowH[r];
      });
      const blob = await c.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    },
    { rows: rows.map((row) => row.map((cell) => ({ label: cell.label, png: cell.png.toString("base64") }))), height },
  );
  return Buffer.from(b64, "base64");
}

/**
 * A small picture with a random code on it. The evaluator has to read the code back, which proves
 * its model really sees images before it may judge any screenshot.
 */
export async function probeImage(page, code) {
  const b64 = await page.evaluate(async (code) => {
    const c = new OffscreenCanvas(420, 140);
    const g = c.getContext("2d");
    g.fillStyle = "#f4f1ea";
    g.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 14; i++) {
      g.strokeStyle = `hsl(${(i * 47) % 360} 30% 75%)`;
      g.beginPath();
      g.moveTo(Math.random() * 420, Math.random() * 140);
      g.lineTo(Math.random() * 420, Math.random() * 140);
      g.stroke();
    }
    g.translate(210, 72);
    g.rotate(-0.04);
    g.fillStyle = "#26324a";
    g.font = "bold 64px monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(code.split("").join(" "), 0, 0);
    const blob = await c.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }, code);
  return Buffer.from(b64, "base64");
}
