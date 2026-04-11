if (typeof document === 'undefined') {
  const noop = () => {};
  const mockElement = {
    setAttribute: noop,
    appendChild: noop,
    cloneNode: function() { return this; },
    style: {},
    classList: { add: noop, remove: noop, contains: () => false }
  };
  (self as any).document = {
    createElement: (type: string) => {
      if (type === 'canvas') {
        return new OffscreenCanvas(1, 1);
      }
      return { ...mockElement, nodeName: type.toUpperCase() };
    },
    createElementNS: (ns: string, type: string) => {
      if (type === 'canvas') {
        return new OffscreenCanvas(1, 1);
      }
      return { ...mockElement, nodeName: type.toUpperCase() };
    },
    createTextNode: () => ({ ...mockElement, nodeName: '#text' }),
    documentElement: mockElement,
    head: mockElement,
    body: mockElement
  };
  (self as any).window = self;
  (self as any).HTMLCanvasElement = OffscreenCanvas;
}

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

let doc: pdfjsLib.PDFDocumentProxy | null = null;
let fileUrl: string | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, file, pageNumber, resolution, quality, grayscale } = e.data;
  
  try {
    if (type === 'INIT') {
      if (fileUrl) {
        URL.revokeObjectURL(fileUrl);
      }
      fileUrl = URL.createObjectURL(file);
      
      // pdf.js natively supports OffscreenCanvas in workers via isOffscreenCanvasSupported
      doc = await pdfjsLib.getDocument({ 
        url: fileUrl,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/cmaps/',
        cMapPacked: true,
        isOffscreenCanvasSupported: true,
        disableFontFace: true,
        disableAutoFetch: true,
        disableStream: false,
        disableRange: false
      }).promise;
      self.postMessage({ type: 'INIT_DONE' });
    } else if (type === 'RENDER') {
      if (!doc) throw new Error("Document not initialized");
      const { pageNumber, resolution = 1.5, quality = 0.6, grayscale = false } = e.data;
      
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: resolution });
      
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      const ctx = canvas.getContext('2d', { alpha: false }) as OffscreenCanvasRenderingContext2D;
      
      // High-quality rendering settings for medical images and text
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      if (grayscale) {
        ctx.filter = 'grayscale(100%)';
      }
      
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      // Render using native OffscreenCanvas support with 'print' intent for highest quality annotations/vectors
      await page.render({ 
        canvasContext: ctx as any, 
        viewport,
        intent: 'print' 
      }).promise;
      
      // Mixed Rasterization Strategy
      // Detect if the page contains images to decide between JPEG (lossy) and PNG (lossless)
      const opList = await page.getOperatorList();
      const hasImages = opList.fnArray.some(fn => 
        fn === pdfjsLib.OPS.paintImageXObject || 
        fn === pdfjsLib.OPS.paintImageXObjectRepeat || 
        fn === pdfjsLib.OPS.paintJpegXObject ||
        fn === pdfjsLib.OPS.paintInlineImageXObject
      );

      const mimeType = hasImages ? 'image/jpeg' : 'image/png';
      const blobOptions: any = { type: mimeType };
      if (hasImages && quality !== undefined) {
        blobOptions.quality = quality;
      }
      const blob = await canvas.convertToBlob(blobOptions);
      
      const buffer = await blob.arrayBuffer();
      
      // Cleanup PDF.js internal page memory
      page.cleanup();
      if (doc) {
        doc.cleanup(); // Aggressive document-level cache clearing
      }
      
      // Transfer ownership of the ArrayBuffer back to the main thread
      self.postMessage({ 
        type: 'RENDER_DONE', 
        pageNumber, 
        buffer, 
        width: viewport.width, 
        height: viewport.height,
        mimeType
      }, [buffer]);
    }
  } catch (error: any) {
    self.postMessage({ type: 'ERROR', error: error.message || 'Unknown error', pageNumber });
  }
};
