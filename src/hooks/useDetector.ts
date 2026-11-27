import { useCallback, useEffect, useRef, useState } from 'react';
import type * as CocoSsdType from '@tensorflow-models/coco-ssd';
import type { CocoModelBase, RawDetection } from '../core/types';

export interface DetectorStatus {
  loading: boolean;
  ready: boolean;
  backend: string;
  isCpuFallback: boolean;
  modelSource: 'local' | 'remote' | 'none';
  error: string | null;
}

/**
 * Manages TensorFlow.js + coco-ssd person detection in the browser.
 *  - Prefers WebGL backend, surfaces explicit warning if CPU fallback occurred
 *  - Checks local `/models/<base>/model.json` first for 100% offline deployments
 *  - Enforces non-overlapping single-flight inference (skips frames while busy)
 */
export function useDetector(modelBase: CocoModelBase, enabled: boolean) {
  const [status, setStatus] = useState<DetectorStatus>({
    loading: false,
    ready: false,
    backend: 'standby',
    isCpuFallback: false,
    modelSource: 'none',
    error: null,
  });

  const modelRef = useRef<CocoSsdType.ObjectDetection | null>(null);
  const loadedBaseRef = useRef<CocoModelBase | null>(null);
  const isInferringRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    const loadModel = async () => {
      if (modelRef.current && loadedBaseRef.current === modelBase) {
        return;
      }

      setStatus((prev) => ({
        ...prev,
        loading: true,
        ready: false,
        error: null,
      }));

      try {
        const tf = await import('@tensorflow/tfjs');
        const cocoSsd = await import('@tensorflow-models/coco-ssd');

        // Prefer WebGL backend; fall back to CPU cleanly if unavailable
        let activeBackend = 'cpu';
        try {
          const ok = await tf.setBackend('webgl');
          await tf.ready();
          activeBackend = ok ? tf.getBackend() || 'webgl' : 'cpu';
        } catch {
          await tf.setBackend('cpu');
          await tf.ready();
          activeBackend = tf.getBackend() || 'cpu';
        }

        if (cancelled) return;

        // Try locally served offline model weights first (/models/<base>/model.json)
        let modelSource: 'local' | 'remote' = 'remote';
        let modelUrl: string | undefined;
        const localUrl = `/models/${modelBase}/model.json`;
        try {
          const headRes = await fetch(localUrl, { method: 'HEAD' });
          const contentType = headRes.headers.get('content-type') || '';
          if (headRes.ok && contentType.includes('application/json')) {
            modelUrl = localUrl;
            modelSource = 'local';
          }
        } catch {
          // Local offline weights not yet placed in public/models/; use default loader
        }

        const loaded = await cocoSsd.load({
          base: modelBase,
          ...(modelUrl ? { modelUrl } : {}),
        });

        if (cancelled) return;

        if (modelRef.current) {
          try {
            modelRef.current.dispose();
          } catch {
            // ignore
          }
        }

        modelRef.current = loaded;
        loadedBaseRef.current = modelBase;

        setStatus({
          loading: false,
          ready: true,
          backend: activeBackend,
          isCpuFallback: activeBackend !== 'webgl',
          modelSource,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Unable to load coco-ssd model weights. Place offline weights in public/models/ or check connectivity.';
        setStatus({
          loading: false,
          ready: false,
          backend: 'unavailable',
          isCpuFallback: false,
          modelSource: 'none',
          error: msg,
        });
      }
    };

    void loadModel();

    return () => {
      cancelled = true;
    };
  }, [modelBase, enabled]);

  /**
   * Runs single-flight person detection on an offscreen canvas.
   * Returns null if a previous inference is still in progress (never queues frames).
   */
  const detectCanvas = useCallback(
    async (
      canvas: HTMLCanvasElement,
      minScore: number,
    ): Promise<{ detections: RawDetection[]; inferenceMs: number } | null> => {
      const model = modelRef.current;
      if (!model || isInferringRef.current) {
        return null;
      }

      isInferringRef.current = true;
      const t0 = performance.now();
      try {
        const predictions = await model.detect(canvas, 20, Math.max(0.1, minScore * 0.85));
        const inferenceMs = performance.now() - t0;
        const detections: RawDetection[] = [];
        for (const pred of predictions) {
          if (pred.class !== 'person') continue;
          const [x, y, width, height] = pred.bbox;
          detections.push({
            x,
            y,
            width,
            height,
            score: pred.score,
            class: 'person',
          });
        }
        return { detections, inferenceMs };
      } catch {
        return null;
      } finally {
        isInferringRef.current = false;
      }
    },
    [],
  );

  return {
    status,
    detectCanvas,
    isInferringRef,
  };
}
