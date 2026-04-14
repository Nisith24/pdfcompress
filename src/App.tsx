import React, { useState, useRef, useEffect, memo, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument } from 'pdf-lib';
import { motion, AnimatePresence } from 'motion/react';
import { UploadCloud, FileText, Download, X, ChevronLeft, ChevronRight, Layers, Check, Maximize, ArrowRight, Settings2, AlertTriangle, Pencil, Sliders, Plus, Minus, AlertCircle, CheckCircle, Info } from 'lucide-react';
import ExtractionWorker from './extractionWorker?worker';
import CompressionWorker from './compressionWorker?worker';
import { initDB, savePage, getPage, clearPages } from './lib/idb';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// --- Task Queue for Concurrency Limiting ---
class TaskQueue {
  private queue: (() => Promise<void>)[] = [];
  private active = 0;
  private max = 4; // Increased concurrency for faster thumbnail rendering

  enqueue(task: () => Promise<void>) {
    this.queue.push(task);
    this.runNext();
  }

  private async runNext() {
    if (this.active >= this.max || this.queue.length === 0) return;
    this.active++;
    const task = this.queue.shift();
    if (task) {
      try { await task(); } catch (e) {}
    }
    this.active--;
    this.runNext();
  }
}
const renderQueue = new TaskQueue();

// --- Helper Functions ---
const parsePageRange = (input: string, maxPage: number): Set<number> => {
  const pages = new Set<number>();
  const parts = input.split(',');
  for (const part of parts) {
    const range = part.trim().split('-');
    if (range.length === 1) {
      const p = parseInt(range[0], 10);
      if (!isNaN(p) && p >= 1 && p <= maxPage) pages.add(p);
    } else if (range.length === 2) {
      const start = parseInt(range[0], 10);
      const end = parseInt(range[1], 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPage, end); i++) {
          pages.add(i);
        }
      }
    }
  }
  return pages;
};

const setToRangeString = (pages: Set<number>): string => {
  const sorted = Array.from(pages).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  
  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      if (start === prev) ranges.push(`${start}`);
      else ranges.push(`${start}-${prev}`);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  return ranges.join(', ');
};

// --- Components ---

const Thumbnail = memo(({ 
  pdfDoc, 
  pageNum, 
  isSelected, 
  onClick 
}: { 
  pdfDoc: pdfjsLib.PDFDocumentProxy; 
  pageNum: number; 
  isSelected: boolean; 
  onClick: (p: number) => void;
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isVisible, setIsVisible] = useState(pageNum <= 12); // Pre-render first 12 pages for better UX
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { rootMargin: '200px' }
    );
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isVisible || !pdfDoc || !canvasRef.current) return;
    let renderTask: pdfjsLib.RenderTask;
    let isMounted = true;

    const render = async () => {
      if (!isMounted) return; // Skip if unmounted before queue got to it
      try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = canvasRef.current;
        if (!canvas || !isMounted) return;
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        renderTask = page.render({ 
          canvasContext: ctx, 
          viewport,
          canvas: canvas // Add missing required property
        } as any);
        await renderTask.promise;
      } catch (err: any) {
        if (err.name !== 'RenderingCancelledException' && isMounted) {
          console.error(`Thumbnail ${pageNum} error:`, err);
        }
      }
    };

    renderQueue.enqueue(render);

    return () => {
      isMounted = false;
      if (renderTask) renderTask.cancel();
    };
  }, [isVisible, pdfDoc, pageNum]);

  return (
    <motion.div 
      ref={containerRef}
      onClick={() => onClick(pageNum)}
      whileHover={{ scale: 0.98 }}
      whileTap={{ scale: 0.95 }}
      className={`relative cursor-pointer rounded-xl overflow-hidden transition-all duration-200 border-2 ${
        isSelected ? 'border-zinc-200 shadow-[0_0_15px_rgba(255,255,255,0.1)]' : 'border-transparent hover:border-zinc-700 bg-zinc-900/50'
      }`}
    >
      <div className="aspect-[1/1.4] bg-zinc-900 flex items-center justify-center p-1.5">
        <canvas ref={canvasRef} className="max-w-full max-h-full shadow-sm opacity-90 rounded-sm" />
      </div>
      <div className={`absolute bottom-0 inset-x-0 py-1.5 text-center text-xs font-mono backdrop-blur-md transition-colors ${
        isSelected ? 'bg-zinc-200 text-zinc-950 font-semibold' : 'bg-zinc-950/90 text-zinc-400'
      }`}>
        {pageNum}
      </div>
      {isSelected && (
        <div className="absolute top-2 right-2 w-5 h-5 bg-zinc-200 rounded-full flex items-center justify-center shadow-sm">
          <Check className="w-3 h-3 text-zinc-950" strokeWidth={3} />
        </div>
      )}
    </motion.div>
  );
});

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  
  const [previewPage, setPreviewPage] = useState<number>(1);
  const [zoom, setZoom] = useState<number>(1.0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [rangeInput, setRangeInput] = useState<string>('');
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [currentView, setCurrentView] = useState<'cut' | 'compress'>('cut');
  
  const [isDragging, setIsDragging] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  
  // Compression States
  const [compressionMode, setCompressionMode] = useState<'lossless' | 'lossy'>('lossy');
  const [compressionPreset, setCompressionPreset] = useState<'high' | 'balanced' | 'aggressive' | 'custom'>('balanced');
  const [isGrayscale, setIsGrayscale] = useState(false);
  const [isCompressing, setIsCompressing] = useState(false);
  const [compressionProgress, setCompressionProgress] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [compressedPdfBytes, setCompressedPdfBytes] = useState<Uint8Array | null>(null);
  const [showSizeWarning, setShowSizeWarning] = useState(false);
  
  // Advanced Settings State
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customResolution, setCustomResolution] = useState(1.5);
  const [customQuality, setCustomQuality] = useState(0.6);
  const [workerCount, setWorkerCount] = useState(Math.min(3, navigator.hardwareConcurrency || 3));
  
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  
  // Toast Notification State
  const [toast, setToast] = useState<{ message: string, type: 'error' | 'success' | 'info', id: number } | null>(null);

  const showToast = useCallback((message: string, type: 'error' | 'success' | 'info' = 'info') => {
    const id = Date.now();
    setToast({ message, type, id });
    setTimeout(() => {
      setToast(current => current?.id === id ? null : current);
    }, 5000);
  }, []);

  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);

  // --- Initialization ---
  useEffect(() => {
    // Clean up any orphaned IndexedDB data on startup
    initDB().then(db => clearPages(db)).catch(console.error);
  }, []);

  // --- File Handling ---
  const processFile = async (selectedFile: File) => {
    if (selectedFile.type !== 'application/pdf') {
      const msg = 'Invalid file format. Please upload a PDF.';
      setError(msg);
      showToast(msg, 'error');
      return;
    }
    setError('');
    setFile(selectedFile);
    setPreviewPage(1);
    setSelectedPages(new Set());
    setRangeInput('');
    
    if (selectedFile.size > MAX_FILE_SIZE) {
      setShowSizeWarning(true);
      showToast('Large file detected. Processing may take longer.', 'info');
    } else {
      setShowSizeWarning(false);
    }

    try {
      const url = URL.createObjectURL(selectedFile);
      const loadingTask = pdfjsLib.getDocument({
        url: url,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@5.6.205/cmaps/',
        cMapPacked: true,
        disableFontFace: true,
        disableAutoFetch: true,
        disableStream: false,
      });
      
      const doc = await loadingTask.promise;
      setPdfDoc(doc);
      setNumPages(doc.numPages);
      showToast('PDF loaded successfully.', 'success');
    } catch (err: any) {
      console.error(err);
      let errorMessage = 'Failed to parse PDF document. The file may be corrupted or unsupported.';
      if (err.name === 'PasswordException') {
        errorMessage = 'This PDF is password protected. Please unlock it first.';
      } else if (err.name === 'InvalidPDFException') {
        errorMessage = 'The file appears to be corrupted or is not a valid PDF.';
      }
      setError(errorMessage);
      showToast(errorMessage, 'error');
      setFile(null);
    }
  };

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  };

  // --- Main Preview Rendering ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (currentView !== 'cut') return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      if (e.key === 'ArrowLeft') setPreviewPage(p => Math.max(1, p - 1));
      if (e.key === 'ArrowRight') setPreviewPage(p => Math.min(numPages, p + 1));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [numPages, currentView]);

  useEffect(() => {
    let isMounted = true;
    const renderPage = async () => {
      if (!pdfDoc || !mainCanvasRef.current) return;
      setIsLoading(true);
      try {
        const page = await pdfDoc.getPage(previewPage);
        const baseScale = 1.5 * zoom;
        const viewport = page.getViewport({ scale: baseScale });

        // Double buffering: render to offscreen canvas first to prevent white flashes
        const offscreenCanvas = document.createElement('canvas');
        const offscreenContext = offscreenCanvas.getContext('2d');
        if (!offscreenContext) return;

        const outputScale = window.devicePixelRatio || 1;
        offscreenCanvas.width = Math.floor(viewport.width * outputScale);
        offscreenCanvas.height = Math.floor(viewport.height * outputScale);

        const transform = outputScale !== 1 
          ? [outputScale, 0, 0, outputScale, 0, 0] 
          : null;

        if (renderTaskRef.current) {
          try { await renderTaskRef.current.cancel(); } catch (e) {}
        }

        const renderTask = page.render({ 
          canvasContext: offscreenContext, 
          transform: transform as any,
          viewport,
          canvas: offscreenCanvas
        } as any);
        renderTaskRef.current = renderTask;
        await renderTask.promise;

        if (!isMounted) return;

        const canvas = mainCanvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        // Apply dimensions and draw instantly
        canvas.width = offscreenCanvas.width;
        canvas.height = offscreenCanvas.height;
        canvas.style.width = Math.floor(viewport.width) + "px";
        canvas.style.height = Math.floor(viewport.height) + "px";
        context.drawImage(offscreenCanvas, 0, 0);

      } catch (err: any) {
        if (err.name !== 'RenderingCancelledException' && isMounted) {
          console.error('Main render error:', err);
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    renderPage();
    return () => {
      isMounted = false;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch (e) {}
      }
    };
  }, [pdfDoc, previewPage, zoom]);

  // --- Interactions ---
  const handleThumbnailClick = useCallback((pageNum: number) => {
    setSelectedPages(prev => {
      const next = new Set<number>(prev);
      if (next.has(pageNum)) next.delete(pageNum);
      else next.add(pageNum);
      setRangeInput(setToRangeString(next));
      return next;
    });
    setPreviewPage(pageNum);
  }, []);

  const handleRangeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setRangeInput(val);
    setSelectedPages(parsePageRange(val, numPages));
  };

  const handleExtract = (arg: any = false) => {
    if (!file || selectedPages.size === 0) return;
    
    // Robustly determine if we should go to compress view
    // (Prevents React MouseEvents from being treated as 'true')
    const goToCompress = arg === true;

    const baseName = editedName || file.name.replace('.pdf', '');
    const isFullFile = selectedPages.size === numPages;

    // SMART: If selecting all pages, skip the worker processing for efficiency
    if (isFullFile) {
      if (goToCompress) {
        setCurrentView('compress');
      } else {
        const filename = `${baseName}.pdf`;
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
      return;
    }

    setIsExtracting(!goToCompress);
    if (goToCompress) setIsCompressing(true);
    setError('');

    const worker = new ExtractionWorker();
    
    worker.onmessage = (e) => {
      setIsExtracting(false);
      const { success, pdfBytes, error } = e.data;
      
      if (success) {
        const newFileName = `${baseName}_extracted.pdf`;
        const newFile = new File([pdfBytes], newFileName, { type: 'application/pdf' });
        
        if (goToCompress) {
          processFile(newFile);
          setCurrentView('compress');
          setIsCompressing(false);
        } else {
          try {
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = newFileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            showToast('PDF extracted and downloaded successfully.', 'success');
          } catch (err) {
            console.error('Download error:', err);
            showToast('Failed to download the extracted PDF.', 'error');
          }
        }
      } else {
        console.error(error);
        const msg = 'Failed to extract pages. The document might be protected or corrupted.';
        setError(msg);
        showToast(msg, 'error');
        if (goToCompress) setIsCompressing(false);
      }
      worker.terminate();
    };

    worker.onerror = (err) => {
      setIsExtracting(false);
      console.error(err);
      const msg = 'A critical error occurred during extraction. Please try again.';
      setError(msg);
      showToast(msg, 'error');
      if (goToCompress) setIsCompressing(false);
      worker.terminate();
    };

    const pagesToExtract = Array.from(selectedPages).sort((a: number, b: number) => a - b);
    worker.postMessage({ file, pages: pagesToExtract });
  };

  const getExpectedSize = () => {
    if (!file) return 0;
    const size = file.size;
    if (compressionMode === 'lossless') return size * 0.9;
    switch (compressionPreset) {
      case 'high': return size * 0.7;
      case 'balanced': return size * 0.5;
      case 'aggressive': return size * 0.25;
      case 'custom': return size * (customQuality * 0.8);
      default: return size * 0.5;
    }
  };

  const handleCompress = async () => {
    if (!file || !pdfDoc) return;
    setIsCompressing(true);
    setError('');
    setCompressionProgress(0);
    setCompressedPdfBytes(null);

    try {
      if (compressionMode === 'lossless') {
        const arrayBuffer = await file.arrayBuffer();
        const newPdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        newPdfDoc.setTitle('');
        newPdfDoc.setAuthor('');
        newPdfDoc.setSubject('');
        newPdfDoc.setKeywords([]);
        newPdfDoc.setProducer('');
        newPdfDoc.setCreator('');
        const newBytes = await newPdfDoc.save({ useObjectStreams: true });
        setCompressedPdfBytes(newBytes);
        setIsCompressing(false);
        return;
      }

      // Lossy (Rasterize)
      let resolution = 1.5;
      let quality = 0.6;

      switch (compressionPreset) {
        case 'high': resolution = 2.0; quality = 0.8; break;
        case 'balanced': resolution = 1.5; quality = 0.6; break;
        case 'aggressive': resolution = 1.0; quality = 0.3; break;
        case 'custom': resolution = customResolution; quality = customQuality; break;
      }

      const numPages = pdfDoc.numPages;
      // Use up to workerCount workers for parallel processing
      const maxWorkers = workerCount;
      const MAX_PAGES_PER_WORKER = 15; // Cycle workers to prevent memory leaks
      const workers: { worker: Worker, activePage: number | null, timeout: any, pagesProcessed: number }[] = [];
      const pageQueue = Array.from({ length: numPages }, (_, i) => i + 1);
      const pageRetries: Record<number, number> = {};
      
      // IndexedDB Setup
      const db = await initDB();
      await clearPages(db);
      const renderedPagesMeta: { pageNumber: number, key: string, width: number, height: number, mimeType: string }[] = [];
      
      let pagesProcessed = 0;
      let pagesFailed = 0;
      const startTime = Date.now();

      for (let i = 0; i < maxWorkers; i++) {
        workers.push({ worker: new CompressionWorker(), activePage: null, timeout: null, pagesProcessed: 0 });
      }

      await new Promise<void>((resolve, reject) => {
        let initCount = 0;
        let isDone = false;

        const assignWork = (workerObj: typeof workers[0]) => {
          if (isDone) return;
          if (pageQueue.length === 0) {
            if (workers.every(w => w.activePage === null)) {
              isDone = true;
              resolve();
            }
            return;
          }

          const nextPage = pageQueue.shift()!;
          workerObj.activePage = nextPage;

          // Dead worker detection (Timeout)
          workerObj.timeout = setTimeout(() => {
            console.warn(`Worker timed out on page ${nextPage}`);
            handleWorkerError(workerObj, nextPage, new Error("Worker timeout"));
          }, 30000); // 30 seconds per page max

          workerObj.worker.postMessage({ 
            type: 'RENDER', 
            pageNumber: nextPage, 
            resolution, 
            quality, 
            grayscale: isGrayscale 
          });
        };

        const handleWorkerError = (workerObj: typeof workers[0], pageNumber: number, err: any) => {
          clearTimeout(workerObj.timeout);
          workerObj.activePage = null;

          // Terminate and respawn worker
          workerObj.worker.terminate();
          workerObj.worker = new CompressionWorker();
          workerObj.pagesProcessed = 0;
          setupWorker(workerObj);
          
          // Re-init with the File object
          workerObj.worker.postMessage({ type: 'INIT', file });

          // Re-queue or fail page
          pageRetries[pageNumber] = (pageRetries[pageNumber] || 0) + 1;
          if (pageRetries[pageNumber] > 3) {
            console.error(`Page ${pageNumber} failed after 3 retries. Error:`, err.message || err);
            pagesFailed++;
            pagesProcessed++;
            setCompressionProgress(Math.round((pagesProcessed / numPages) * 100));
            // Check if we are done despite the failure
            if (pageQueue.length === 0 && workers.every(w => w.activePage === null)) {
              isDone = true;
              resolve();
            }
          } else {
            pageQueue.push(pageNumber); // Re-queue
          }
        };

        const setupWorker = (workerObj: typeof workers[0]) => {
          workerObj.worker.onmessage = async (e) => {
            const { type, pageNumber, buffer, width, height, mimeType, error } = e.data;

            if (type === 'INIT_DONE') {
              initCount++;
              if (initCount === maxWorkers) {
                // Initial assignment
                workers.forEach(w => assignWork(w));
              } else if (initCount > maxWorkers) {
                // Respawned worker initialized
                assignWork(workerObj);
              }
            } else if (type === 'RENDER_DONE') {
              clearTimeout(workerObj.timeout);
              workerObj.activePage = null;
              
              // Save to IndexedDB instead of RAM
              const key = `page_${pageNumber}`;
              await savePage(db, key, buffer);
              renderedPagesMeta.push({ pageNumber, key, width, height, mimeType });
              
              pagesProcessed++;
              setCompressionProgress(Math.round((pagesProcessed / numPages) * 100));
              
              const elapsed = Date.now() - startTime;
              const timePerPage = elapsed / pagesProcessed;
              const remaining = Math.round((timePerPage * (numPages - pagesProcessed)) / 1000); // in seconds
              setTimeRemaining(remaining);

              workerObj.pagesProcessed++;
              
              if (workerObj.pagesProcessed >= MAX_PAGES_PER_WORKER && pageQueue.length > 0) {
                // Cycle the worker to free OS-level memory
                workerObj.worker.terminate();
                workerObj.worker = new CompressionWorker();
                workerObj.pagesProcessed = 0;
                setupWorker(workerObj);
                workerObj.worker.postMessage({ type: 'INIT', file });
              } else {
                assignWork(workerObj);
              }
            } else if (type === 'ERROR') {
              handleWorkerError(workerObj, pageNumber, new Error(error));
            }
          };

          workerObj.worker.onerror = (err) => {
            if (workerObj.activePage) {
              handleWorkerError(workerObj, workerObj.activePage, err);
            }
          };
        };

        workers.forEach(w => {
          setupWorker(w);
          w.worker.postMessage({ type: 'INIT', file });
        });
      });

      workers.forEach(w => {
        clearTimeout(w.timeout);
        w.worker.terminate();
      });

      if (pagesFailed === numPages) {
        throw new Error("All pages failed to compress.");
      }

      const newPdf = await PDFDocument.create();
      renderedPagesMeta.sort((a, b) => a.pageNumber - b.pageNumber);

      for (const rp of renderedPagesMeta) {
        // Fetch from IndexedDB
        const buffer = await getPage(db, rp.key);
        
        let image;
        if (rp.mimeType === 'image/png') {
          image = await newPdf.embedPng(buffer);
        } else {
          image = await newPdf.embedJpg(buffer);
        }
        const newPage = newPdf.addPage([rp.width, rp.height]);
        newPage.drawImage(image, {
          x: 0,
          y: 0,
          width: rp.width,
          height: rp.height,
        });
      }
      
      const newBytes = await newPdf.save({ useObjectStreams: true });
      setCompressedPdfBytes(newBytes);
      showToast('PDF compressed successfully.', 'success');
      
      // Cleanup
      await clearPages(db);

    } catch (err: any) {
      console.error(err);
      let errorMessage = 'Failed to compress PDF. ' + (err.message || 'Unknown error');
      if (err.message?.includes('memory') || err.message?.includes('allocation')) {
        errorMessage = 'Out of memory. Try using fewer workers or a smaller file.';
      }
      setError(errorMessage);
      showToast(errorMessage, 'error');
    } finally {
      setIsCompressing(false);
    }
  };

  const handleDownloadCompressed = () => {
    if (!compressedPdfBytes || !file) return;
    const blob = new Blob([compressedPdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${file.name.replace('.pdf', '')}_compressed.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const reset = () => {
    setFile(null);
    setPdfDoc(null);
    setNumPages(0);
    setSelectedPages(new Set());
    setRangeInput('');
    setCompressedPdfBytes(null);
    setCompressionProgress(0);
  };

  return (
    <div className="min-h-screen flex flex-col font-sans selection:bg-zinc-800 selection:text-zinc-100 bg-zinc-950 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(120,119,198,0.15),rgba(255,255,255,0))]">
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center space-x-3 px-4 py-3 rounded-2xl shadow-2xl backdrop-blur-xl border ${
              toast.type === 'error' ? 'bg-red-950/80 border-red-900/50 text-red-200' :
              toast.type === 'success' ? 'bg-emerald-950/80 border-emerald-900/50 text-emerald-200' :
              'bg-zinc-900/90 border-zinc-700/50 text-zinc-200'
            }`}
          >
            {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-red-400" />}
            {toast.type === 'success' && <CheckCircle className="w-5 h-5 text-emerald-400" />}
            {toast.type === 'info' && <Info className="w-5 h-5 text-zinc-400" />}
            <span className="text-sm font-medium">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold text-zinc-100">PDF</h1>
          <nav className="flex items-center gap-2">
            <button 
              onClick={() => setCurrentView('cut')}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${currentView === 'cut' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'}`}
            >
              Cut
            </button>
            <button 
              onClick={() => setCurrentView('compress')}
              className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${currentView === 'compress' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/50'}`}
            >
              Compress
            </button>
          </nav>
        </div>
      </header>
      <AnimatePresence mode="wait">
        {!pdfDoc ? (
          <motion.div 
            key="upload"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="flex-1 flex flex-col items-center justify-center p-6"
          >
            <div className="max-w-md w-full space-y-8 text-center">
              <div className="space-y-3">
                <div className="inline-flex items-center justify-center p-3 bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl mb-4">
                  <Layers className="w-8 h-8 text-zinc-300" />
                </div>
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">PDF Extractor</h1>
                <p className="text-zinc-400 text-sm">Secure, offline, client-side processing.</p>
              </div>

              <label
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`relative flex flex-col items-center justify-center w-full h-72 rounded-3xl border-2 border-dashed transition-all duration-300 cursor-pointer overflow-hidden group
                  ${isDragging ? 'border-zinc-400 bg-zinc-900/50 scale-[1.02]' : 'border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/40'}
                `}
              >
                <div className="absolute inset-0 bg-gradient-to-b from-transparent to-zinc-950/50 pointer-events-none" />
                <UploadCloud className={`w-12 h-12 mb-5 transition-colors duration-300 ${isDragging ? 'text-zinc-200' : 'text-zinc-500 group-hover:text-zinc-400'}`} />
                <p className="text-base font-medium text-zinc-200">Drop your PDF here</p>
                <p className="text-sm text-zinc-500 mt-2">or click to browse from your computer</p>
                <input type="file" accept="application/pdf" className="hidden" onChange={(e) => e.target.files?.[0] && processFile(e.target.files[0])} />
              </label>

              {error && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="text-red-400 text-sm bg-red-950/30 border border-red-900/50 py-2 px-4 rounded-lg">
                  {error}
                </motion.div>
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="workspace"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="flex-1 flex flex-col h-screen overflow-hidden"
          >
            {/* Top Navigation Bar */}
            <header className="h-14 border-b border-zinc-800/60 bg-zinc-950/80 backdrop-blur-xl flex items-center justify-between px-4 shrink-0 z-10">
              <div className="flex items-center space-x-3 overflow-hidden">
                <div className="p-1.5 bg-zinc-900 rounded-md border border-zinc-800">
                  <FileText className="w-4 h-4 text-zinc-400" />
                </div>
                {isEditingName ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      onBlur={() => {
                        setIsEditingName(false);
                        if (file) {
                          const newName = editedName.endsWith('.pdf') ? editedName : `${editedName}.pdf`;
                          const renamedFile = new File([file], newName, { type: file.type });
                          setFile(renamedFile);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          setIsEditingName(false);
                          if (file) {
                            const newName = editedName.endsWith('.pdf') ? editedName : `${editedName}.pdf`;
                            const renamedFile = new File([file], newName, { type: file.type });
                            setFile(renamedFile);
                          }
                        }
                      }}
                      className="bg-zinc-950 border border-zinc-700 text-zinc-100 text-sm rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                      autoFocus
                    />
                  </div>
                ) : (
                  <>
                    <span className="text-sm font-medium text-zinc-300 truncate max-w-[200px] sm:max-w-sm">
                      {file?.name}
                    </span>
                    <button 
                      onClick={() => {
                        setEditedName(file?.name.replace(/\.pdf$/i, '') || '');
                        setIsEditingName(true);
                      }}
                      className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </>
                )}
                <span className="text-xs font-mono text-zinc-600 px-2 py-0.5 bg-zinc-900 rounded-full border border-zinc-800">
                  {numPages} pages
                </span>
              </div>
              <button onClick={reset} className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </header>

            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
              {/* Left: Main Preview */}
              <div className="flex-1 relative bg-zinc-950 flex flex-col overflow-hidden">
                {/* Floating Controls */}
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 w-[90%] max-w-md pointer-events-none">
                  
                  {/* Page Progress Bar */}
                  <div className="w-full h-1.5 bg-zinc-900/80 rounded-full overflow-hidden border border-zinc-700/50 backdrop-blur-xl shadow-2xl pointer-events-auto">
                    <motion.div 
                      className="h-full bg-zinc-300"
                      initial={{ width: 0 }}
                      animate={{ width: `${(previewPage / numPages) * 100}%` }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                    />
                  </div>

                  {/* Control Bar */}
                  <div className="flex flex-row items-center justify-between w-full bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 p-1.5 sm:p-2 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.5)] pointer-events-auto">
                    
                    {/* Pagination */}
                    <div className="flex flex-row items-center gap-1">
                      <button 
                        onClick={() => setPreviewPage(p => Math.max(1, p - 1))}
                        disabled={previewPage <= 1}
                        className="p-1.5 sm:p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg disabled:opacity-20 transition-all"
                      >
                        <ChevronLeft className="w-4 h-4 sm:w-5 sm:h-5" />
                      </button>
                      
                      <div className="flex flex-row items-center px-2 py-1 bg-zinc-950/50 rounded-lg border border-zinc-800/50">
                        <input
                          type="number"
                          min={1}
                          max={numPages}
                          value={previewPage}
                          onChange={(e) => {
                            const val = parseInt(e.target.value);
                            if (val >= 1 && val <= numPages) setPreviewPage(val);
                          }}
                          className="w-8 sm:w-10 bg-transparent text-zinc-100 text-[10px] sm:text-xs font-mono text-center focus:outline-none"
                        />
                        <span className="text-[10px] sm:text-xs text-zinc-500 font-mono ml-1">/ {numPages}</span>
                      </div>

                      <button 
                        onClick={() => setPreviewPage(p => Math.min(numPages, p + 1))}
                        disabled={previewPage >= numPages}
                        className="p-1.5 sm:p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg disabled:opacity-20 transition-all"
                      >
                        <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5" />
                      </button>
                    </div>

                    <div className="h-6 sm:h-8 w-px bg-zinc-800"></div>

                    {/* Zoom */}
                    <div className="flex flex-row items-center gap-1">
                      <button 
                        onClick={() => setZoom(z => Math.max(0.5, z - 0.2))}
                        className="p-1.5 sm:p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-all"
                        title="Zoom Out"
                      >
                        <Minus className="w-3 h-3 sm:w-4 sm:h-4" />
                      </button>
                      <span className="text-[10px] font-mono text-zinc-500 w-8 text-center hidden sm:inline-block">{Math.round(zoom * 100)}%</span>
                      <button 
                        onClick={() => setZoom(z => Math.min(3, z + 0.2))}
                        className="p-1.5 sm:p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-all"
                        title="Zoom In"
                      >
                        <Plus className="w-3 h-3 sm:w-4 sm:h-4" />
                      </button>
                    </div>

                    <div className="h-6 sm:h-8 w-px bg-zinc-800"></div>

                    {/* Fullscreen */}
                    <button 
                      onClick={() => {
                        const container = document.getElementById('pdf-viewer-container');
                        if (container) {
                          if (!document.fullscreenElement) container.requestFullscreen();
                          else document.exitFullscreen();
                        }
                      }}
                      className="p-1.5 sm:p-2 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded-lg transition-all"
                      title="Fullscreen"
                    >
                      <Maximize className="w-3 h-3 sm:w-4 sm:h-4" />
                    </button>
                  </div>
                </div>
                
                <div 
                  className="flex-1 overflow-auto flex items-center justify-center p-4 relative" 
                  id="pdf-viewer-container"
                  style={{
                    backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)',
                    backgroundSize: '24px 24px'
                  }}
                >
                  {/* Navigation Sliders */}
                  <button 
                    onClick={() => setPreviewPage(p => Math.max(1, p - 1))}
                    disabled={previewPage <= 1}
                    className="absolute left-4 z-30 p-3 sm:p-4 bg-zinc-900/90 text-white rounded-full hover:bg-zinc-700 disabled:opacity-0 transition-all hover:scale-110 shadow-2xl border border-zinc-700/50 backdrop-blur-md"
                  >
                    <ChevronLeft className="w-6 h-6 sm:w-8 sm:h-8" />
                  </button>
                  <button 
                    onClick={() => setPreviewPage(p => Math.min(numPages, p + 1))}
                    disabled={previewPage >= numPages}
                    className="absolute right-4 z-30 p-3 sm:p-4 bg-zinc-900/90 text-white rounded-full hover:bg-zinc-700 disabled:opacity-0 transition-all hover:scale-110 shadow-2xl border border-zinc-700/50 backdrop-blur-md"
                  >
                    <ChevronRight className="w-6 h-6 sm:w-8 sm:h-8" />
                  </button>

                  <div className="relative shadow-2xl ring-1 ring-white/10 bg-white transition-transform duration-200 ease-out min-h-[50vh] min-w-[300px] flex items-center justify-center" style={{ transformOrigin: 'top center' }}>
                    <canvas 
                      ref={mainCanvasRef} 
                      className={`block max-w-full max-h-[75vh] object-contain transition-opacity duration-150 ${isLoading ? 'opacity-50' : 'opacity-100'}`}
                    />
                    
                    {isLoading && (
                      <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                        <div className="flex flex-col items-center space-y-4 bg-zinc-900/90 p-6 rounded-2xl shadow-2xl border border-zinc-800 backdrop-blur-md">
                          <div className="w-8 h-8 border-[3px] border-zinc-700 border-t-zinc-300 rounded-full animate-spin" />
                          <span className="text-[10px] font-mono text-zinc-400 tracking-widest uppercase">Rendering</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: Smart Controls & Grid */}
              <div className="w-full lg:w-[400px] xl:w-[480px] bg-zinc-950/80 backdrop-blur-xl border-l border-zinc-800/60 flex flex-col shrink-0 z-20 shadow-2xl">
                {currentView === 'cut' ? (
                  <div className="p-6 border-b border-zinc-800/60 bg-zinc-900/30">
                    <h2 className="text-sm font-semibold text-zinc-100 flex items-center mb-5 uppercase tracking-wider">
                      <Layers className="w-4 h-4 mr-2 text-zinc-400" />
                      Extraction Settings
                    </h2>
                    
                    <div className="space-y-4">
                      <div className="relative">
                        <input
                          type="text"
                          value={rangeInput}
                          onChange={handleRangeInputChange}
                          placeholder="e.g. 1, 3-5, 8"
                          className="w-full bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-zinc-700 focus:border-zinc-700 transition-all font-mono placeholder:text-zinc-600 placeholder:font-sans shadow-inner"
                        />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-zinc-400 bg-zinc-900 px-2 py-1 rounded-md border border-zinc-800">
                          {selectedPages.size} selected
                        </div>
                      </div>
                      
                      <button
                        onClick={() => handleExtract(false)}
                        disabled={selectedPages.size === 0 || isExtracting}
                        className="w-full relative overflow-hidden group bg-zinc-100 hover:bg-white text-zinc-950 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:border-zinc-800 disabled:border font-semibold text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center shadow-lg hover:shadow-xl disabled:shadow-none"
                      >
                        {isExtracting ? (
                          <span className="flex items-center space-x-3">
                            <div className="w-4 h-4 border-2 border-zinc-950/30 border-t-zinc-950 rounded-full animate-spin" />
                            <span>Processing...</span>
                          </span>
                        ) : (
                          <span className="flex items-center space-x-2">
                            <Download className="w-4 h-4" />
                            <span>Download {selectedPages.size > 0 ? `${selectedPages.size} Pages` : ''}</span>
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => setShowThumbnails(true)}
                        className="w-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center border border-zinc-800"
                      >
                        <Layers className="w-4 h-4 mr-2" />
                        Manage Pages
                      </button>
                      <button
                        onClick={() => {
                          if (selectedPages.size > 0 && selectedPages.size < numPages) {
                            handleExtract(true);
                          } else {
                            setCurrentView('compress');
                          }
                        }}
                        className="w-full bg-zinc-900/50 hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100 text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center border border-zinc-800 shadow-sm group"
                      >
                        <ArrowRight className="w-4 h-4 mr-2 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
                        Go to Compress
                      </button>
                      {error && <p className="text-xs text-red-400 mt-2 font-medium">{error}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="p-6 border-b border-zinc-800/60 bg-zinc-900/30 flex-1 flex flex-col overflow-y-auto">
                    <h2 className="text-sm font-semibold text-zinc-100 flex items-center mb-5 uppercase tracking-wider">
                      <Settings2 className="w-4 h-4 mr-2 text-zinc-400" />
                      Compression Settings
                    </h2>
                    
                    <div className="space-y-6">
                      {/* Mode Selection */}
                      <div className="space-y-3">
                        <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Mode</label>
                        <div className="grid grid-cols-2 gap-2 bg-zinc-950 p-1 rounded-xl border border-zinc-800">
                          <button 
                            onClick={() => setCompressionMode('lossy')} 
                            className={`py-2 text-xs font-medium rounded-lg transition-all ${compressionMode === 'lossy' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                          >
                            Smart (Lossy)
                          </button>
                          <button 
                            onClick={() => setCompressionMode('lossless')} 
                            className={`py-2 text-xs font-medium rounded-lg transition-all ${compressionMode === 'lossless' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                          >
                            Basic (Lossless)
                          </button>
                        </div>
                      </div>

                      {compressionMode === 'lossy' && (
                        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-6">
                          {/* Preset Selection */}
                          <div className="space-y-3">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Smart Presets</label>
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                { id: 'high', label: 'High Quality', desc: 'Best for medical/images' },
                                { id: 'balanced', label: 'Balanced', desc: 'Good size & quality' },
                                { id: 'aggressive', label: 'Aggressive', desc: 'Smallest file size' }
                              ].map((preset) => (
                                <button
                                  key={preset.id}
                                  onClick={() => setCompressionPreset(preset.id as any)}
                                  className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all ${
                                    compressionPreset === preset.id
                                      ? 'bg-blue-500/10 border-blue-500/50 text-blue-400'
                                      : 'bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300'
                                  }`}
                                >
                                  <span className="text-sm font-medium mb-1 text-center leading-tight">{preset.label}</span>
                                  <span className="text-[10px] text-center opacity-70 leading-tight">{preset.desc}</span>
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Grayscale Toggle */}
                          <label className="flex items-center justify-between cursor-pointer group p-3 rounded-xl border border-zinc-800 bg-zinc-950/50 hover:bg-zinc-900/50 transition-colors">
                            <span className="text-sm font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">Grayscale (B&W)</span>
                            <div className={`w-10 h-5 rounded-full transition-colors relative ${isGrayscale ? 'bg-zinc-200' : 'bg-zinc-800'}`}>
                              <div className={`absolute top-1 left-1 w-3 h-3 rounded-full bg-zinc-900 transition-transform ${isGrayscale ? 'translate-x-5' : ''}`} />
                            </div>
                          </label>

                          {/* Advanced Settings Toggle */}
                          <div className="pt-2 border-t border-zinc-800/40">
                            <button
                              onClick={() => setShowAdvanced(!showAdvanced)}
                              className="flex items-center gap-2 text-xs font-medium text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                              <Sliders className="w-3.5 h-3.5" />
                              Advanced Settings
                            </button>
                            
                            <AnimatePresence>
                              {showAdvanced && (
                                <motion.div
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className="overflow-hidden"
                                >
                                  <div className="mt-4 p-4 bg-zinc-950/50 border border-zinc-800/60 rounded-xl space-y-5">
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium text-zinc-400">Resolution Multiplier</label>
                                        <span className="text-xs font-mono text-blue-400">{customResolution.toFixed(1)}x</span>
                                      </div>
                                      <input
                                        type="range"
                                        min="0.5"
                                        max="3.0"
                                        step="0.1"
                                        value={customResolution}
                                        onChange={(e) => {
                                          setCustomResolution(parseFloat(e.target.value));
                                          setCompressionPreset('custom');
                                        }}
                                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                      />
                                    </div>
                                    
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium text-zinc-400">JPEG Quality</label>
                                        <span className="text-xs font-mono text-blue-400">{Math.round(customQuality * 100)}%</span>
                                      </div>
                                      <input
                                        type="range"
                                        min="0.1"
                                        max="1.0"
                                        step="0.05"
                                        value={customQuality}
                                        onChange={(e) => {
                                          setCustomQuality(parseFloat(e.target.value));
                                          setCompressionPreset('custom');
                                        }}
                                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                      />
                                    </div>
                                    
                                    <div className="space-y-2">
                                      <div className="flex justify-between items-center">
                                        <label className="text-xs font-medium text-zinc-400">Worker Threads</label>
                                        <span className="text-xs font-mono text-blue-400">{workerCount}</span>
                                      </div>
                                      <input
                                        type="range"
                                        min="1"
                                        max={navigator.hardwareConcurrency || 4}
                                        step="1"
                                        value={workerCount}
                                        onChange={(e) => setWorkerCount(parseInt(e.target.value))}
                                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                                      />
                                      <p className="text-[10px] text-zinc-500 leading-tight pt-1">
                                        Higher values compress faster but use more RAM. Max recommended: {Math.min(3, navigator.hardwareConcurrency || 3)}.
                                      </p>
                                    </div>
                                  </div>
                                </motion.div>
                              )}
                            </AnimatePresence>
                          </div>
                        </motion.div>
                      )}

                      {/* Action Area */}
                      <div className="pt-4 border-t border-zinc-800/60">
                        {showSizeWarning && !compressedPdfBytes && (
                          <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="mb-4 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start space-x-2.5 max-w-[280px] ml-auto">
                            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                            <div className="text-[11px] text-amber-200/80 leading-relaxed">
                              <strong className="text-amber-500 block mb-0.5">Large File Warning</strong>
                              This file is over 50MB. Compressing in-browser may be slow or cause memory issues.
                            </div>
                          </motion.div>
                        )}
                        {!compressedPdfBytes ? (
                          <div className="space-y-4">
                            {file && (
                              <div className="flex justify-between items-center px-2 text-xs font-mono">
                                <div className="text-zinc-500">
                                  Current: <span className="text-zinc-300">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                                </div>
                                <div className="text-zinc-500">
                                  Expected: <span className="text-blue-400">~{(getExpectedSize() / 1024 / 1024).toFixed(2)} MB</span>
                                </div>
                              </div>
                            )}
                            <button
                              onClick={handleCompress}
                              disabled={isCompressing}
                              className="w-full relative overflow-hidden group bg-zinc-100 hover:bg-white text-zinc-950 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:border-zinc-800 disabled:border font-semibold text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center shadow-lg hover:shadow-xl disabled:shadow-none"
                            >
                              {isCompressing ? (
                                <div className="absolute inset-0 bg-zinc-800/50">
                                  <div 
                                    className="h-full bg-zinc-700 transition-all duration-300 ease-out"
                                    style={{ width: `${compressionProgress}%` }}
                                  />
                                </div>
                              ) : null}
                              {isCompressing ? (
                                <span className="flex flex-col items-center justify-center relative z-10 w-full">
                                  <span className="flex items-center space-x-3 mb-1">
                                    <div className="w-4 h-4 border-2 border-zinc-500 border-t-zinc-300 rounded-full animate-spin" />
                                    <span className="text-zinc-300">Compressing... {compressionProgress}%</span>
                                  </span>
                                  {timeRemaining !== null && (
                                    <span className="text-[10px] text-zinc-400 font-mono">
                                      ~{timeRemaining > 60 ? `${Math.floor(timeRemaining / 60)}m ${timeRemaining % 60}s` : `${timeRemaining}s`} remaining
                                    </span>
                                  )}
                                </span>
                              ) : (
                                <span className="flex items-center space-x-2 relative z-10">
                                  <Download className="w-4 h-4" />
                                  <span>Compress PDF</span>
                                </span>
                              )}
                            </button>
                            <button
                              onClick={() => setCurrentView('cut')}
                              className="w-full bg-transparent hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 text-xs py-2 rounded-xl transition-all duration-300 flex items-center justify-center border border-transparent hover:border-zinc-800"
                            >
                              <ChevronLeft className="w-3 h-3 mr-1" />
                              Back to Extraction
                            </button>
                          </div>
                        ) : (
                          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
                            <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl flex justify-between items-center shadow-inner">
                              <div className="text-center">
                                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Original</p>
                                <p className="text-sm font-mono text-zinc-300">{(file!.size / 1024 / 1024).toFixed(2)} MB</p>
                              </div>
                              <ArrowRight className="w-4 h-4 text-zinc-700" />
                              <div className="text-center">
                                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Compressed</p>
                                <p className="text-sm font-mono text-green-400">{(compressedPdfBytes.length / 1024 / 1024).toFixed(2)} MB</p>
                              </div>
                              <div className="text-center">
                                <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Saved</p>
                                <p className="text-sm font-bold text-green-500 bg-green-500/10 px-2 py-0.5 rounded-md">
                                  {Math.max(0, Math.round((1 - compressedPdfBytes.length / file!.size) * 100))}%
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={handleDownloadCompressed}
                              className="w-full bg-green-500 hover:bg-green-400 text-green-950 font-semibold text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center shadow-lg hover:shadow-xl"
                            >
                              <Download className="w-4 h-4 mr-2" />
                              Download Compressed PDF
                            </button>
                            <button
                              onClick={() => setCompressedPdfBytes(null)}
                              className="w-full bg-transparent hover:bg-zinc-900 text-zinc-400 hover:text-zinc-300 text-sm py-3 rounded-xl transition-all duration-300 flex items-center justify-center border border-transparent hover:border-zinc-800"
                            >
                              Discard & Try Again
                            </button>
                          </motion.div>
                        )}
                        {error && <p className="text-xs text-red-400 mt-4 font-medium text-center">{error}</p>}
                      </div>
                    </div>
                  </div>
                )}

                {/* Thumbnail Modal */}
                {showThumbnails && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-950/80 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-4xl max-h-[80vh] flex flex-col shadow-2xl">
                      <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                        <h3 className="text-sm font-semibold text-zinc-100">Select Pages</h3>
                        <button onClick={() => setShowThumbnails(false)} className="text-zinc-500 hover:text-zinc-300">
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto p-6">
                        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                          {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
                            <Thumbnail
                              key={pageNum}
                              pdfDoc={pdfDoc}
                              pageNum={pageNum}
                              isSelected={selectedPages.has(pageNum)}
                              onClick={handleThumbnailClick}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
