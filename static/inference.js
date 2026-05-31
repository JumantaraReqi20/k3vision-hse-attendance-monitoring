/**
 * K3Vision Client-Side Inference Engine
 * Uses ONNX Runtime.js for YOLO inference
 */

let ortSession = null;
let modelReady = false;

// Model configuration
const MODEL_CONFIG = {
    modelPath: '/model/best.onnx',
    inputSize: 640,
    confidence: 0.5,
    nmsIoU: 0.45,
    classes: ['human', 'helmet', 'vest', 'boots', 'gloves']
};

/**
 * Initialize ONNX Runtime and load model
 */
async function initializeInference() {
    try {
        console.log('[Inference] Loading ONNX Runtime...');
        
        // Set WASM paths
        const ort = window.ort;
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@latest/dist/';
        
        console.log('[Inference] Loading model:', MODEL_CONFIG.modelPath);
        const response = await fetch(MODEL_CONFIG.modelPath);
        const arrayBuffer = await response.arrayBuffer();
        
        ortSession = await ort.InferenceSession.create(arrayBuffer, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        });
        
        modelReady = true;
        console.log('[Inference] ✓ Model loaded successfully');
        document.getElementById('modelStatus')?.innerText = '✓ Model Ready';
        return true;
    } catch (error) {
        console.error('[Inference] Failed to load model:', error);
        document.getElementById('modelStatus')?.innerText = '✗ Model Failed';
        throw error;
    }
}

/**
 * Preprocess image for inference
 */
function preprocessImage(canvas) {
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Create tensor from image data
    const pixels = imgData.data;
    const tensorArray = new Float32Array(MODEL_CONFIG.inputSize * MODEL_CONFIG.inputSize * 3);
    
    // Assuming canvas is already resized to MODEL_CONFIG.inputSize
    for (let i = 0; i < pixels.length; i += 4) {
        const idx = i / 4;
        tensorArray[idx] = pixels[i] / 255.0;                                    // R
        tensorArray[MODEL_CONFIG.inputSize * MODEL_CONFIG.inputSize + idx] = pixels[i + 1] / 255.0; // G
        tensorArray[2 * MODEL_CONFIG.inputSize * MODEL_CONFIG.inputSize + idx] = pixels[i + 2] / 255.0; // B
    }
    
    return new ort.Tensor('float32', tensorArray, [1, 3, MODEL_CONFIG.inputSize, MODEL_CONFIG.inputSize]);
}

/**
 * Non-Maximum Suppression
 */
function nms(boxes, iouThreshold = 0.45) {
    if (boxes.length === 0) return [];
    
    // Sort by confidence
    boxes.sort((a, b) => b.conf - a.conf);
    
    const kept = [];
    while (boxes.length > 0) {
        const box = boxes.shift();
        kept.push(box);
        
        // Remove boxes with high IoU
        boxes = boxes.filter(b => {
            const iou = calculateIoU(box, b);
            return iou < iouThreshold;
        });
    }
    
    return kept;
}

/**
 * Calculate Intersection over Union
 */
function calculateIoU(box1, box2) {
    const x1_min = Math.min(box1.x1, box2.x1);
    const y1_min = Math.min(box1.y1, box2.y1);
    const x2_max = Math.max(box1.x2, box2.x2);
    const y2_max = Math.max(box1.y2, box2.y2);
    
    const intersection = Math.max(0, Math.min(box1.x2, box2.x2) - Math.max(box1.x1, box2.x1)) *
                        Math.max(0, Math.min(box1.y2, box2.y2) - Math.max(box1.y1, box2.y1));
    
    const area1 = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
    const area2 = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
    const union = area1 + area2 - intersection;
    
    return union > 0 ? intersection / union : 0;
}

/**
 * Post-process model output
 */
function postprocessOutput(output, originalWidth, originalHeight) {
    const predictions = output.data;
    const numDetections = predictions.length / (5 + MODEL_CONFIG.classes.length);
    
    const boxes = [];
    const scaleX = originalWidth / MODEL_CONFIG.inputSize;
    const scaleY = originalHeight / MODEL_CONFIG.inputSize;
    
    for (let i = 0; i < numDetections; i++) {
        const offset = i * (5 + MODEL_CONFIG.classes.length);
        
        // YOLO output: [x, y, w, h, objectness, class_scores...]
        const x = predictions[offset];
        const y = predictions[offset + 1];
        const w = predictions[offset + 2];
        const h = predictions[offset + 3];
        const objectness = predictions[offset + 4];
        
        // Get class scores
        let maxClassConf = 0;
        let classIdx = 0;
        for (let j = 0; j < MODEL_CONFIG.classes.length; j++) {
            const classConf = predictions[offset + 5 + j];
            if (classConf > maxClassConf) {
                maxClassConf = classConf;
                classIdx = j;
            }
        }
        
        // Filter by confidence
        const totalConf = objectness * maxClassConf;
        if (totalConf < MODEL_CONFIG.confidence) continue;
        
        // Convert to box coordinates
        const x1 = (x - w / 2) * scaleX;
        const y1 = (y - h / 2) * scaleY;
        const x2 = (x + w / 2) * scaleX;
        const y2 = (y + h / 2) * scaleY;
        
        boxes.push({
            x1: Math.max(0, x1),
            y1: Math.max(0, y1),
            x2: Math.min(originalWidth, x2),
            y2: Math.min(originalHeight, y2),
            conf: totalConf,
            label: MODEL_CONFIG.classes[classIdx],
            classIdx: classIdx
        });
    }
    
    return nms(boxes, MODEL_CONFIG.nmsIoU);
}

/**
 * Run PPE detection on image
 */
async function detectPPE(imageSource) {
    if (!modelReady) {
        throw new Error('Model not loaded. Call initializeInference() first.');
    }
    
    try {
        // Create canvas and load image
        const canvas = document.createElement('canvas');
        canvas.width = MODEL_CONFIG.inputSize;
        canvas.height = MODEL_CONFIG.inputSize;
        const ctx = canvas.getContext('2d');
        
        // Draw image (assuming it's an HTMLImageElement, Blob, or canvas)
        let originalWidth, originalHeight;
        if (imageSource instanceof HTMLCanvasElement) {
            originalWidth = imageSource.width;
            originalHeight = imageSource.height;
            ctx.drawImage(imageSource, 0, 0, canvas.width, canvas.height);
        } else if (imageSource instanceof HTMLImageElement) {
            originalWidth = imageSource.width;
            originalHeight = imageSource.height;
            ctx.drawImage(imageSource, 0, 0, canvas.width, canvas.height);
        } else if (imageSource instanceof Blob) {
            const url = URL.createObjectURL(imageSource);
            const img = new Image();
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = url;
            });
            originalWidth = img.width;
            originalHeight = img.height;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
        }
        
        // Preprocess
        const inputTensor = preprocessImage(canvas);
        
        // Run inference
        console.log('[Inference] Running PPE detection...');
        const results = await ortSession.run({ images: inputTensor });
        
        // Get output (YOLO format: Nx(5+num_classes))
        const output = results.output0 || Object.values(results)[0];
        
        // Post-process
        const detections = postprocessOutput(output, originalWidth, originalHeight);
        
        console.log(`[Inference] Detected ${detections.length} objects`);
        
        // Group detections by class
        const humanBoxes = detections.filter(d => d.label === 'human');
        const ppeDetected = {
            human: humanBoxes.length > 0,
            helmet: detections.some(d => d.label === 'helmet'),
            vest: detections.some(d => d.label === 'vest'),
            boots: detections.some(d => d.label === 'boots'),
            gloves: detections.some(d => d.label === 'gloves'),
            boxes: detections
        };
        
        return ppeDetected;
    } catch (error) {
        console.error('[Inference] Detection failed:', error);
        throw error;
    }
}

/**
 * Draw detection boxes on canvas
 */
function drawDetections(canvas, detections, colors = {}) {
    const ctx = canvas.getContext('2d');
    const defaultColors = {
        'human': '#00FFCC',
        'helmet': '#4444FF',
        'vest': '#FFAA44',
        'boots': '#44CCFF',
        'gloves': '#AA44FF'
    };
    
    for (const box of detections) {
        const color = colors[box.label] || defaultColors[box.label] || '#FFFFFF';
        
        // Draw box
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
        
        // Draw label
        const label = `${box.label} ${box.conf.toFixed(2)}`;
        ctx.fillStyle = color;
        ctx.fillRect(box.x1, box.y1 - 25, ctx.measureText(label).width + 10, 25);
        ctx.fillStyle = '#000000';
        ctx.font = '14px Arial';
        ctx.fillText(label, box.x1 + 5, box.y1 - 8);
    }
}

/**
 * Capture frame from video element
 */
function captureFrame(videoElement) {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    return canvas;
}

/**
 * Convert canvas to base64 JPEG
 */
function canvasToBase64(canvas, quality = 0.8) {
    return canvas.toDataURL('image/jpeg', quality).split(',')[1];
}

// Auto-initialize when script loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeInference);
} else {
    initializeInference();
}
