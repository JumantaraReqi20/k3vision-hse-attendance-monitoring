/**
 * K3Vision Client-Side Inference Engine
 * Uses ONNX Runtime.js for YOLO inference
 */

let ortSession = null;
let modelReady = false;
let inferenceInitPromise = null;

// Model configuration
const MODEL_CONFIG = {
    modelPath: '/model/best.onnx',
    inputSize: 640,
    confidence: 0.5,
    nmsIoU: 0.45,
    classes: ['human', 'helmet', 'vest', 'boots', 'gloves'],
    classThresholds: {
        human: 0.55,
        helmet: 0.55,
        vest: 0.75,
        boots: 0.55,
        gloves: 0.60
    },
    minAreaRatio: {
        human: 0.04,
        helmet: 0.0015,
        vest: 0.012,
        boots: 0.0015,
        gloves: 0.001
    }
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
        const modelStatusEl = document.getElementById('modelStatus');
        if (modelStatusEl) modelStatusEl.innerText = '✓ Model Ready';
        return true;
    } catch (error) {
        console.error('[Inference] Failed to load model:', error);
        const modelStatusEl = document.getElementById('modelStatus');
        if (modelStatusEl) modelStatusEl.innerText = '✗ Model Failed';
        throw error;
    }
}

async function ensureInferenceReady() {
    if (modelReady) {
        return true;
    }

    if (!inferenceInitPromise) {
        inferenceInitPromise = initializeInference().catch(error => {
            inferenceInitPromise = null;
            throw error;
        });
    }

    return inferenceInitPromise;
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

function expandBox(box, ratio, width, height) {
    const padX = (box.x2 - box.x1) * ratio;
    const padY = (box.y2 - box.y1) * ratio;

    return {
        x1: Math.max(0, box.x1 - padX),
        y1: Math.max(0, box.y1 - padY),
        x2: Math.min(width, box.x2 + padX),
        y2: Math.min(height, box.y2 + padY)
    };
}

function centerInside(child, parent) {
    const cx = (child.x1 + child.x2) / 2;
    const cy = (child.y1 + child.y2) / 2;
    return parent.x1 <= cx && cx <= parent.x2 && parent.y1 <= cy && cy <= parent.y2;
}

function intersectsHuman(ppeBox, humanBoxes, width, height) {
    return humanBoxes.some(humanBox => centerInside(ppeBox, expandBox(humanBox, 0.08, width, height)));
}

function normalizeBox(x, y, w, h, originalWidth, originalHeight) {
    const inputSize = MODEL_CONFIG.inputSize;
    const scaleX = originalWidth / inputSize;
    const scaleY = originalHeight / inputSize;

    if (Math.max(x, y, w, h) <= 1.5) {
        x *= inputSize;
        y *= inputSize;
        w *= inputSize;
        h *= inputSize;
    }

    const x1 = (x - w / 2) * scaleX;
    const y1 = (y - h / 2) * scaleY;
    const x2 = (x + w / 2) * scaleX;
    const y2 = (y + h / 2) * scaleY;

    return {
        x1: Math.max(0, Math.min(originalWidth, x1)),
        y1: Math.max(0, Math.min(originalHeight, y1)),
        x2: Math.max(0, Math.min(originalWidth, x2)),
        y2: Math.max(0, Math.min(originalHeight, y2))
    };
}

function addDetection(boxes, x, y, w, h, classScores, objectness, originalWidth, originalHeight) {
    let maxClassConf = 0;
    let classIdx = 0;

    for (let j = 0; j < MODEL_CONFIG.classes.length; j++) {
        const classConf = Number(classScores[j] || 0);
        if (classConf > maxClassConf) {
            maxClassConf = classConf;
            classIdx = j;
        }
    }

    const label = MODEL_CONFIG.classes[classIdx];
    const confidence = (objectness == null ? 1 : Number(objectness || 0)) * maxClassConf;
    const threshold = MODEL_CONFIG.classThresholds[label] ?? MODEL_CONFIG.confidence;
    if (confidence < threshold) return;

    const coords = normalizeBox(Number(x), Number(y), Number(w), Number(h), originalWidth, originalHeight);
    const area = Math.max(0, coords.x2 - coords.x1) * Math.max(0, coords.y2 - coords.y1);
    const areaRatio = area / (originalWidth * originalHeight);
    if (areaRatio < (MODEL_CONFIG.minAreaRatio[label] || 0)) return;

    boxes.push({
        ...coords,
        conf: confidence,
        label,
        classIdx
    });
}

/**
 * Post-process model output
 */
function postprocessOutput(output, originalWidth, originalHeight) {
    const predictions = output.data;
    const boxes = [];

    const dims = output.dims || [];
    const classCount = MODEL_CONFIG.classes.length;
    const attrsWithoutObjectness = 4 + classCount;
    const attrsWithObjectness = 5 + classCount;

    if (dims.length === 3 && (dims[1] === attrsWithoutObjectness || dims[1] === attrsWithObjectness)) {
        const attrs = dims[1];
        const anchors = dims[2];
        const hasObjectness = attrs === attrsWithObjectness;

        for (let i = 0; i < anchors; i++) {
            const x = predictions[i];
            const y = predictions[anchors + i];
            const w = predictions[(2 * anchors) + i];
            const h = predictions[(3 * anchors) + i];
            const objectness = hasObjectness ? predictions[(4 * anchors) + i] : null;
            const classOffset = hasObjectness ? 5 : 4;
            const classScores = Array.from({ length: classCount }, (_, j) => predictions[((classOffset + j) * anchors) + i]);
            addDetection(boxes, x, y, w, h, classScores, objectness, originalWidth, originalHeight);
        }
    } else {
        const attrs = dims.length === 3 && (dims[2] === attrsWithoutObjectness || dims[2] === attrsWithObjectness)
            ? dims[2]
            : (predictions.length % attrsWithoutObjectness === 0 ? attrsWithoutObjectness : attrsWithObjectness);
        const hasObjectness = attrs === attrsWithObjectness;
        const numDetections = Math.floor(predictions.length / attrs);

        for (let i = 0; i < numDetections; i++) {
            const offset = i * attrs;
            const classOffset = hasObjectness ? 5 : 4;
            const classScores = Array.from({ length: classCount }, (_, j) => predictions[offset + classOffset + j]);
            addDetection(
                boxes,
                predictions[offset],
                predictions[offset + 1],
                predictions[offset + 2],
                predictions[offset + 3],
                classScores,
                hasObjectness ? predictions[offset + 4] : null,
                originalWidth,
                originalHeight
            );
        }
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
        
        // Group detections by class and only count PPE attached to a detected person
        const humanBoxes = detections.filter(d => d.label === 'human');
        const ppeBoxes = detections.filter(d =>
            ['helmet', 'vest', 'boots', 'gloves'].includes(d.label) &&
            intersectsHuman(d, humanBoxes, originalWidth, originalHeight)
        );
        const ppeDetected = {
            human: humanBoxes.length > 0,
            helmet: ppeBoxes.some(d => d.label === 'helmet'),
            vest: ppeBoxes.some(d => d.label === 'vest'),
            boots: ppeBoxes.some(d => d.label === 'boots'),
            gloves: ppeBoxes.some(d => d.label === 'gloves'),
            boxes: [...humanBoxes, ...ppeBoxes]
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

window.ensureInferenceReady = ensureInferenceReady;
