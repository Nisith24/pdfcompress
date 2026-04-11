import { PDFDocument } from 'pdf-lib';

self.onmessage = async (e: MessageEvent) => {
  const { file, pages } = e.data;
  try {
    const arrayBuffer = await file.arrayBuffer();
    let bytes = new Uint8Array(arrayBuffer);

    const pdfHeader = [0x25, 0x50, 0x44, 0x46, 0x2D]; // %PDF-
    let headerIndex = -1;
    for (let i = 0; i < Math.min(bytes.length - 5, 1024); i++) {
      if (bytes[i] === pdfHeader[0] && bytes[i+1] === pdfHeader[1] &&
          bytes[i+2] === pdfHeader[2] && bytes[i+3] === pdfHeader[3] &&
          bytes[i+4] === pdfHeader[4]) {
        headerIndex = i;
        break;
      }
    }
    if (headerIndex > 0) bytes = bytes.slice(headerIndex);

    const originalPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const newPdf = await PDFDocument.create();
    
    const copiedPages = await newPdf.copyPages(
      originalPdf,
      pages.map((p: number) => p - 1)
    );
    
    copiedPages.forEach(page => newPdf.addPage(page));
    
    const newPdfBytes = await newPdf.save();
    
    self.postMessage({ success: true, pdfBytes: newPdfBytes }, [newPdfBytes.buffer]);
  } catch (error: any) {
    self.postMessage({ success: false, error: error.message });
  }
};
