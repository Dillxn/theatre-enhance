'use client';

import { getPointerParts } from '@theatre/dataverse';
import { onChange, val, type ISheetObject, type Keyframe } from '@theatre/core';
// @ts-ignore -- internal store needed to sync snapshot proxies without full refresh.
import { editable as e, useCurrentSheet, ____private_editorStore } from '@theatre/r3f';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useTheatreEnhanceState } from './extension';

const DEFAULT_SAMPLE_COUNT = 160;
const DEFAULT_HANDLE_SIZE = 0.6;
const DEFAULT_REFRESH_MS = 250;
const TANGENT_HANDLE_SCALE = 0.85;
const TANGENT_LINE_OPACITY = 0.45;
const TIME_MATCH_EPSILON = 1e-2;
const HANDLE_UNSET_DELAY_MS = 220;
const SCRUB_COMMIT_DELAY_MS = 200;
const TIME_QUANTIZE = 1e-3;
const POSITION_EPSILON = 1e-3;
const DEFAULT_TANGENT_OUT_RATIO = 1 / 3;
const DEFAULT_TANGENT_IN_RATIO = 2 / 3;
const MIN_TANGENT_DISTANCE_RATIO = 0.05;
const MAX_THEATRE_KEY_LENGTH = 64;
const TANGENT_DRAG_EPSILON = 0.02;
const HANDLE_DRAG_EPSILON = 0.008;
const TANGENT_UPDATE_SUPPRESS_MS = 240;
const SNAP_POSITION = (position: number) => position;

const isEditorEnabled =
  process.env.NODE_ENV === 'development' &&
  process.env.NEXT_PUBLIC_THEATRE_EDITOR === '1';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const approxEqual = (a: number, b: number, eps = POSITION_EPSILON) =>
  Math.abs(a - b) <= eps;

const hashKey = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const makeObjectKey = (prefix: string, parts: string[]) => {
  const hash = hashKey([prefix, ...parts].join('|'));
  const maxPrefix = Math.max(0, MAX_THEATRE_KEY_LENGTH - hash.length - 1);
  const safePrefix = prefix.length > maxPrefix ? prefix.slice(0, maxPrefix) : prefix;
  return `${safePrefix}_${hash}`;
};

const sortKeyframes = (keyframes: Keyframe[]) =>
  [...keyframes].sort((a, b) => a.position - b.position);

const findClosestKeyframe = (
  keyframes: Keyframe[],
  time: number,
  threshold: number | null
) => {
  let closest: Keyframe | null = null;
  let minDelta = threshold ?? Number.POSITIVE_INFINITY;
  keyframes.forEach((kf) => {
    const delta = Math.abs(kf.position - time);
    if (delta <= minDelta) {
      minDelta = delta;
      closest = kf;
    }
  });
  return closest;
};

const getInternalStudio = () => {
  if (typeof window === 'undefined') {
    return null;
  }
  const bundle = (window as unknown as {
    __TheatreJS_StudioBundle?: { _studio?: { transaction?: (fn: (api: any) => void) => void } };
  }).__TheatreJS_StudioBundle;
  return bundle?._studio ?? null;
};

const resolveHandleRatio = (value: number, fallback: number) =>
  Number.isFinite(value) ? value : fallback;

const ensureTangentDistance = (
  anchor: THREE.Vector3,
  start: THREE.Vector3,
  end: THREE.Vector3,
  point: THREE.Vector3,
  fallbackRatio: number
) => {
  const segment = new THREE.Vector3().subVectors(end, start);
  const length = segment.length();
  if (!Number.isFinite(length) || length <= 0) {
    return point;
  }
  if (point.distanceTo(anchor) >= length * MIN_TANGENT_DISTANCE_RATIO) {
    return point;
  }
  return start.clone().add(segment.multiplyScalar(fallbackRatio));
};

const isFiniteVec3 = (point: THREE.Vector3) =>
  isFiniteNumber(point.x) && isFiniteNumber(point.y) && isFiniteNumber(point.z);

const unsetObjectPosition = (
  unset: (pointer: any) => void,
  handleObject: ISheetObject
) => {
  const positionProps = handleObject.props.position as {
    x?: unknown;
    y?: unknown;
    z?: unknown;
  };
  const hasAxes =
    !!positionProps &&
    'x' in positionProps &&
    'y' in positionProps &&
    'z' in positionProps;
  if (hasAxes) {
    unset(positionProps.x as any);
    unset(positionProps.y as any);
    unset(positionProps.z as any);
  } else {
    unset(handleObject.props.position as any);
  }
};

class UnitBezier {
  private _cx: number;
  private _bx: number;
  private _ax: number;
  private _cy: number;
  private _by: number;
  private _ay: number;

  constructor(p1x: number, p1y: number, p2x: number, p2y: number) {
    this._cx = 3 * p1x;
    this._bx = 3 * (p2x - p1x) - this._cx;
    this._ax = 1 - this._cx - this._bx;
    this._cy = 3 * p1y;
    this._by = 3 * (p2y - p1y) - this._cy;
    this._ay = 1 - this._cy - this._by;
  }

  private _sampleCurveX(t: number) {
    return ((this._ax * t + this._bx) * t + this._cx) * t;
  }

  private _sampleCurveY(t: number) {
    return ((this._ay * t + this._by) * t + this._cy) * t;
  }

  private _sampleCurveDerivativeX(t: number) {
    return (3 * this._ax * t + 2 * this._bx) * t + this._cx;
  }

  private _solveCurveX(x: number, epsilon: number) {
    let t0;
    let t1;
    let t2 = x;
    for (let i = 0; i < 8; i += 1) {
      const x2 = this._sampleCurveX(t2) - x;
      if (Math.abs(x2) < epsilon) {
        return t2;
      }
      const d2 = this._sampleCurveDerivativeX(t2);
      if (Math.abs(d2) < epsilon) {
        break;
      }
      t2 = t2 - x2 / d2;
    }
    t0 = 0;
    t1 = 1;
    t2 = x;
    if (t2 < t0) {
      return t0;
    }
    if (t2 > t1) {
      return t1;
    }
    while (t0 < t1) {
      const x2 = this._sampleCurveX(t2);
      if (Math.abs(x2 - x) < epsilon) {
        return t2;
      }
      if (x > x2) {
        t0 = t2;
      } else {
        t1 = t2;
      }
      t2 = (t1 - t0) * 0.5 + t0;
    }
    return t2;
  }

  solveSimple(x: number) {
    return this._sampleCurveY(this._solveCurveX(x, 1e-6));
  }
}

type Vec3 = [number, number, number];

const isFiniteVec3Tuple = (value: Vec3) =>
  isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && isFiniteNumber(value[2]);

type HandleData = {
  key: string;
  time: number;
  position: Vec3;
  keyframes: { x: Keyframe; y: Keyframe; z: Keyframe };
};

type TangentKind = 'out' | 'in';

type TangentHandleData = {
  key: string;
  kind: TangentKind;
  time: number;
  startTime: number;
  endTime: number;
  position: Vec3;
  startKeyframes: { x: Keyframe; y: Keyframe; z: Keyframe };
  endKeyframes: { x: Keyframe; y: Keyframe; z: Keyframe };
  connected: { x: boolean; y: boolean; z: boolean };
};

export type CameraSplinePathProps = {
  cameraKey?: string;
  lineColor?: string;
  handleColor?: string;
  handleSize?: number;
  sampleCount?: number;
  refreshMs?: number;
  showInViewport?: boolean;
};

const evaluateKeyframes = (
  keyframes: Keyframe[],
  time: number,
  fallback: number
) => {
  if (keyframes.length === 0) {
    return fallback;
  }

  if (time <= keyframes[0].position) {
    return Number(keyframes[0].value);
  }

  const lastKeyframe = keyframes[keyframes.length - 1];
  if (time >= lastKeyframe.position) {
    return Number(lastKeyframe.value);
  }

  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const left = keyframes[i];
    const right = keyframes[i + 1];
    if (time < left.position || time > right.position) {
      continue;
    }
    if (!left.connectedRight || left.type === 'hold') {
      return Number(left.value);
    }
    const segmentDuration = right.position - left.position;
    if (segmentDuration <= 0) {
      return Number(left.value);
    }
    const normalized = clamp01((time - left.position) / segmentDuration);
    const solver = new UnitBezier(
      left.handles[2],
      left.handles[3],
      right.handles[0],
      right.handles[1]
    );
    const valueProgression = solver.solveSimple(normalized);
    const leftValue = Number(left.value);
    const rightValue = Number(right.value);
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      return fallback;
    }
    return leftValue + (rightValue - leftValue) * valueProgression;
  }

  return fallback;
};

export default function CameraSplinePath({
  cameraKey = 'GalleryCamera',
  lineColor = '#5ad7ff',
  handleColor = '#ffd08a',
  handleSize = DEFAULT_HANDLE_SIZE,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  refreshMs = DEFAULT_REFRESH_MS,
  showInViewport = false,
}: CameraSplinePathProps) {
  const helpersVisible = useTheatreEnhanceState((state) => state.helpersVisible);
  const editorVisible = isEditorEnabled && helpersVisible;
  const sheet = useCurrentSheet();
  const cameraObjectRef = useRef<ISheetObject | null>(null);
  const studioRef = useRef<null | { default: typeof import('@theatre/studio') }>(
    null
  );
  const scrubRef = useRef<
    | null
    | {
        capture: (fn: (api: { set: (pointer: any, value: any) => void }) => void) => void;
        commit: () => void;
        discard: () => void;
      }
  >(null);
  const syncRef = useRef(false);
  const trackIdsRef = useRef<null | { x?: string; y?: string; z?: string }>(null);
  const handleObjectsRef = useRef(new Map<string, ISheetObject>());
  const tangentHandleObjectsRef = useRef(new Map<string, ISheetObject>());
  const handleUnsubRef = useRef(new Map<string, () => void>());
  const tangentHandleUnsubRef = useRef(new Map<string, () => void>());
  const handleUnsetTimersRef = useRef(new Map<string, number>());
  const pendingHandleUpdatesRef = useRef(
    new Map<string, { position: THREE.Vector3 }>()
  );
  const pendingHandleRafRef = useRef<number | null>(null);
  const pendingTangentUpdatesRef = useRef(
    new Map<string, { position: THREE.Vector3 }>()
  );
  const pendingTangentRafRef = useRef<number | null>(null);
  const computeRafRef = useRef<number | null>(null);
  const cameraWatchRafRef = useRef<number | null>(null);
  const cameraWatchUnsubRef = useRef<null | (() => void)>(null);
  const scrubCommitRef = useRef<number | null>(null);
  const scrubCommitTimeRef = useRef<number | null>(null);
  const tangentUpdateBlockRef = useRef(0);
  const lastSnapshotHandleKeysRef = useRef<string[]>([]);
  const lastSnapshotLineCountRef = useRef<number>(0);
  const lastSnapshotTangentHandleKeysRef = useRef<string[]>([]);
  const lastSnapshotTangentLineCountRef = useRef<number>(0);
  const expectedHandlePositionsRef = useRef(new Map<string, THREE.Vector3>());
  const expectedTangentPositionsRef = useRef(new Map<string, THREE.Vector3>());
  const handleDataRef = useRef(new Map<string, HandleData>());
  const tangentHandleDataRef = useRef(new Map<string, TangentHandleData>());
  const [linePoints, setLinePoints] = useState<THREE.Vector3[]>([]);
  const [handles, setHandles] = useState<HandleData[]>([]);
  const [tangentHandles, setTangentHandles] = useState<TangentHandleData[]>([]);
  const [tangentLinePoints, setTangentLinePoints] = useState<THREE.Vector3[]>(
    []
  );
  const lineKey = useMemo(() => `${cameraKey}PathLine`, [cameraKey]);
  const tangentLineKey = useMemo(
    () => `${cameraKey}PathTangentLines`,
    [cameraKey]
  );
  const disableRaycast = useCallback(() => {}, []);

  useEffect(() => {
    if (!isEditorEnabled) {
      return;
    }
    let active = true;
    import('@theatre/studio').then((mod) => {
      if (!active) {
        return;
      }
      studioRef.current = mod as typeof studioRef.current;
    });
    return () => {
      active = false;
    };
  }, []);

  const resolveTrackIds = useCallback(() => {
    const cameraObject = cameraObjectRef.current;
    if (!cameraObject) {
      return null;
    }
    if (trackIdsRef.current) {
      return trackIdsRef.current;
    }
    try {
      const pointer = cameraObject.props.position.x as unknown;
      const { root } = getPointerParts(pointer);
      const template = (root as { template?: any })?.template;
      const trackMap =
        template?.getMapOfValidSequenceTracks_forStudio?.().getValue?.();
      if (!trackMap) {
        const studio = getInternalStudio() as
          | { _store?: { getState?: () => any } }
          | null;
        const state = studio?._store?.getState?.();
        const readTrackIdsFromMap = (trackIdByPropPath: unknown) => {
          const readFallback = (path: string[]) => {
            const key = JSON.stringify(path);
            const value =
              trackIdByPropPath && typeof trackIdByPropPath === 'object'
                ? (trackIdByPropPath as Record<string, unknown>)[key]
                : undefined;
            return typeof value === 'string' ? value : undefined;
          };
          const ids = {
            x: readFallback(['position', 'x']),
            y: readFallback(['position', 'y']),
            z: readFallback(['position', 'z']),
          };
          if (ids.x || ids.y || ids.z) {
            return ids;
          }
          return null;
        };
        const coreByProject =
          state?.$persistent?.historic?.innerState?.coreByProject;
        const directMap =
          coreByProject?.[cameraObject.address.projectId]?.sheetsById?.[
            cameraObject.address.sheetId
          ]?.sequence?.tracksByObject?.[cameraObject.address.objectKey]
            ?.trackIdByPropPath;
        const directIds = readTrackIdsFromMap(directMap);
        if (directIds) {
          trackIdsRef.current = directIds;
          return directIds;
        }
        if (coreByProject && cameraObject.address.objectKey) {
          for (const projectState of Object.values(coreByProject)) {
            const sheetsById = (projectState as { sheetsById?: any })?.sheetsById;
            if (!sheetsById) {
              continue;
            }
            const sheets = Object.values(sheetsById) as Array<{
              sequence?: {
                tracksByObject?: Record<string, { trackIdByPropPath?: unknown }>;
              };
            }>;
            for (const sheetState of sheets) {
              const trackMapByObject =
                sheetState?.sequence?.tracksByObject?.[
                  cameraObject.address.objectKey
                ]?.trackIdByPropPath;
              const ids = readTrackIdsFromMap(trackMapByObject);
              if (ids) {
                trackIdsRef.current = ids;
                return ids;
              }
            }
          }
        }
        return null;
      }
      const readTrackId = (path: string[]) => {
        let current: unknown = trackMap;
        for (const key of path) {
          if (!current || typeof current !== 'object') {
            return undefined;
          }
          current = (current as Record<string, unknown>)[key];
        }
        if (typeof current === 'string') {
          return current;
        }
        const encoded = JSON.stringify(path);
        const fallback = (trackMap as Record<string, unknown>)[encoded];
        return typeof fallback === 'string' ? fallback : undefined;
      };
      const ids = {
        x: readTrackId(['position', 'x']),
        y: readTrackId(['position', 'y']),
        z: readTrackId(['position', 'z']),
      };
      trackIdsRef.current = ids;
      return ids;
    } catch {
      return null;
    }
  }, []);

  const scheduleScrubCommit = useCallback(() => {
    if (!isEditorEnabled) {
      return;
    }
    if (scrubCommitRef.current !== null) {
      window.clearTimeout(scrubCommitRef.current);
    }
    scrubCommitRef.current = window.setTimeout(() => {
      scrubCommitRef.current = null;
      const scrub = scrubRef.current;
      const cameraObject = cameraObjectRef.current;
      if (!scrub || !cameraObject) {
        scrubRef.current?.discard();
        scrubRef.current = null;
        return;
      }
      const sheetSequence = cameraObject.sheet.sequence;
      const previousPosition = sheetSequence.position;
      try {
        const commitTime = scrubCommitTimeRef.current;
        if (typeof commitTime === 'number' && Number.isFinite(commitTime)) {
          sheetSequence.position = commitTime;
        }
        scrub.commit();
      } finally {
        sheetSequence.position = previousPosition;
        scrubRef.current = null;
      }
    }, SCRUB_COMMIT_DELAY_MS);
  }, []);

  const updateCameraKeyframe = useCallback(
    (handle: HandleData, position: THREE.Vector3) => {
      if (!isEditorEnabled) {
        return;
      }
      const cameraObject = cameraObjectRef.current;
      const studioModule = studioRef.current;
      if (!cameraObject || !studioModule) {
        return;
      }
      const xKeyframes = sortKeyframes(
        sheet.sequence.__experimental_getKeyframes(
          cameraObject.props.position.x
        )
      );
      const yKeyframes = sortKeyframes(
        sheet.sequence.__experimental_getKeyframes(
          cameraObject.props.position.y
        )
      );
      const zKeyframes = sortKeyframes(
        sheet.sequence.__experimental_getKeyframes(
          cameraObject.props.position.z
        )
      );

      const resolveKeyframe = (
        keyframes: Keyframe[],
        ref: Keyframe,
        time: number
      ) => {
        const byId = keyframes.find((kf) => kf.id === ref.id);
        if (byId) {
          return byId;
        }
        const fallbackTime = Number.isFinite(time) ? time : ref.position;
        return findClosestKeyframe(keyframes, fallbackTime, TIME_MATCH_EPSILON);
      };

      const resolved = {
        x: resolveKeyframe(xKeyframes, handle.keyframes.x, handle.time),
        y: resolveKeyframe(yKeyframes, handle.keyframes.y, handle.time),
        z: resolveKeyframe(zKeyframes, handle.keyframes.z, handle.time),
      };

      const trackIds = resolveTrackIds();
      const internalStudio = getInternalStudio();
      const pendingHandleUpdates: Array<{
        trackId: string;
        keyframeId: string;
        start?: [number, number];
        end?: [number, number];
      }> = [];
      const pendingValueUpdates: Array<{
        trackId: string;
        position: number;
        value: number;
      }> = [];
      const collectValueUpdate = (
        current: Keyframe | null,
        newValue: number,
        trackId?: string
      ) => {
        if (!trackId || !current) {
          return;
        }
        const oldValue = Number(current.value);
        if (!isFiniteNumber(oldValue) || !isFiniteNumber(newValue)) {
          return;
        }
        if (approxEqual(oldValue, newValue)) {
          return;
        }
        pendingValueUpdates.push({
          trackId,
          position: current.position,
          value: newValue,
        });
      };
      if (trackIds) {
        collectValueUpdate(resolved.x, position.x, trackIds.x);
        collectValueUpdate(resolved.y, position.y, trackIds.y);
        collectValueUpdate(resolved.z, position.z, trackIds.z);
      }

      if (trackIds && internalStudio?.transaction) {
        const collectHandleUpdates = (
          keyframes: Keyframe[],
          current: Keyframe | null,
          newValue: number,
          trackId?: string
        ) => {
          if (!trackId || !current) {
            return;
          }
          const index = keyframes.findIndex((kf) => kf.id === current.id);
          if (index < 0) {
            return;
          }
          const oldValue = Number(current.value);
          if (!isFiniteNumber(oldValue) || !isFiniteNumber(newValue)) {
            return;
          }
          const delta = newValue - oldValue;
          if (!Number.isFinite(delta) || Math.abs(delta) <= POSITION_EPSILON) {
            return;
          }
          const prev = keyframes[index - 1];
          if (prev && prev.connectedRight && prev.type !== 'hold') {
            const prevValue = Number(prev.value);
            const denom = newValue - prevValue;
            if (isFiniteNumber(prevValue) && Math.abs(denom) > POSITION_EPSILON) {
              const oldControl =
                prevValue + (oldValue - prevValue) * current.handles[1];
              const nextY = (oldControl + delta - prevValue) / denom;
              if (!approxEqual(nextY, current.handles[1])) {
                pendingHandleUpdates.push({
                  trackId,
                  keyframeId: current.id,
                  end: [current.handles[0], nextY],
                });
              }
            }
          }
          const next = keyframes[index + 1];
          if (next && current.connectedRight && current.type !== 'hold') {
            const nextValue = Number(next.value);
            const denom = nextValue - newValue;
            if (isFiniteNumber(nextValue) && Math.abs(denom) > POSITION_EPSILON) {
              const oldControl =
                oldValue + (nextValue - oldValue) * current.handles[3];
              const nextY = (oldControl + delta - newValue) / denom;
              if (!approxEqual(nextY, current.handles[3])) {
                pendingHandleUpdates.push({
                  trackId,
                  keyframeId: current.id,
                  start: [current.handles[2], nextY],
                });
              }
            }
          }
        };

        collectHandleUpdates(xKeyframes, resolved.x, position.x, trackIds.x);
        collectHandleUpdates(yKeyframes, resolved.y, position.y, trackIds.y);
        collectHandleUpdates(zKeyframes, resolved.z, position.z, trackIds.z);

        if (pendingHandleUpdates.length > 0 || pendingValueUpdates.length > 0) {
          let didApplyValues = false;
          internalStudio.transaction(({ stateEditors }: { stateEditors?: any }) => {
            const editor = stateEditors?.coreByProject?.historic?.sheetsById?.sequence;
            if (!editor) {
              return;
            }
            if (pendingValueUpdates.length > 0 && editor.setKeyframeAtPosition) {
              pendingValueUpdates.forEach((update) => {
                editor.setKeyframeAtPosition({
                  ...cameraObject.address,
                  trackId: update.trackId,
                  position: update.position,
                  value: update.value,
                  snappingFunction: SNAP_POSITION,
                });
              });
              didApplyValues = true;
            }
            if (pendingHandleUpdates.length > 0 && editor.setHandlesForKeyframe) {
              pendingHandleUpdates.forEach((update) => {
                editor.setHandlesForKeyframe({
                  ...cameraObject.address,
                  ...update,
                });
              });
            }
          });
          if (didApplyValues) {
            return;
          }
        }
      }

      const studio = studioModule.default;
      if (!scrubRef.current) {
        scrubRef.current = studio.scrub();
      }
      scrubCommitTimeRef.current = handle.time;

      const sheetSequence = cameraObject.sheet.sequence;
      const previousPosition = sheetSequence.position;

      try {
        const applyAxis = (
          pointer: unknown,
          value: number,
          keyframe: Keyframe | null
        ) => {
          if (!keyframe || !isFiniteNumber(value)) {
            return;
          }
          const oldValue = Number(keyframe.value);
          if (isFiniteNumber(oldValue) && approxEqual(oldValue, value)) {
            return;
          }
          sheetSequence.position = keyframe.position;
          scrubRef.current?.capture(({ set }) => {
            set(pointer, value);
          });
        };
        applyAxis(cameraObject.props.position.x, position.x, resolved.x);
        applyAxis(cameraObject.props.position.y, position.y, resolved.y);
        applyAxis(cameraObject.props.position.z, position.z, resolved.z);
      } finally {
        sheetSequence.position = previousPosition;
      }
      scheduleScrubCommit();
    },
    [resolveTrackIds, scheduleScrubCommit]
  );

  const makeStoreKey = useCallback(
    (objectKey: string) =>
      `${sheet.address.sheetId}:${sheet.address.sheetInstanceId}:${objectKey}`,
    [sheet.address.sheetId, sheet.address.sheetInstanceId]
  );

  const syncSnapshotProxies = useCallback(
    (
      points: THREE.Vector3[],
      nextHandles: HandleData[],
      lineKey: string,
      tangentPoints: THREE.Vector3[],
      nextTangentHandles: TangentHandleData[],
      tangentLineKey: string
    ) => {
      if (!isEditorEnabled) {
        return false;
      }

      const store = ____private_editorStore as {
        getState?: () => {
          editablesSnapshot?: Record<
            string,
            {
              proxyObject?: THREE.Object3D | null;
            }
          > | null;
        };
      };
      const snapshot = store?.getState?.().editablesSnapshot;
      if (!snapshot) {
        return false;
      }

      const handleKeys = nextHandles.map((handle) => handle.key);
      const tangentHandleKeys = nextTangentHandles.map((handle) => handle.key);
      const lineCount = points.length;
      const tangentLineCount = tangentPoints.length;
      const handleKeysChanged =
        handleKeys.length !== lastSnapshotHandleKeysRef.current.length ||
        handleKeys.some(
          (key, index) => key !== lastSnapshotHandleKeysRef.current[index]
        );
      const tangentHandleKeysChanged =
        tangentHandleKeys.length !== lastSnapshotTangentHandleKeysRef.current.length ||
        tangentHandleKeys.some(
          (key, index) => key !== lastSnapshotTangentHandleKeysRef.current[index]
        );
      const lineCountChanged = lineCount !== lastSnapshotLineCountRef.current;
      const tangentLineCountChanged =
        tangentLineCount !== lastSnapshotTangentLineCountRef.current;

      const lineProxy = snapshot[makeStoreKey(lineKey)]?.proxyObject as
        | THREE.Line
        | undefined;
      if (lineProxy) {
        lineProxy.raycast = disableRaycast;
      }
      const tangentProxy = snapshot[makeStoreKey(tangentLineKey)]
        ?.proxyObject as THREE.LineSegments | undefined;
      if (tangentProxy) {
        tangentProxy.raycast = disableRaycast;
      }

      if (handleKeysChanged || lineCountChanged) {
        lastSnapshotHandleKeysRef.current = handleKeys;
        lastSnapshotLineCountRef.current = lineCount;
      }
      if (tangentHandleKeysChanged || tangentLineCountChanged) {
        lastSnapshotTangentHandleKeysRef.current = tangentHandleKeys;
        lastSnapshotTangentLineCountRef.current = tangentLineCount;
      }
      if (
        handleKeysChanged ||
        lineCountChanged ||
        tangentHandleKeysChanged ||
        tangentLineCountChanged
      ) {
        return true;
      }

      const linePointsValid =
        points.length > 0 && points.every((point) => isFiniteVec3(point));
      if (lineProxy?.geometry && linePointsValid) {
        const attribute = lineProxy.geometry.getAttribute(
          'position'
        ) as THREE.BufferAttribute | undefined;
        if (attribute && attribute.count === points.length) {
          points.forEach((point, index) => {
            attribute.setXYZ(index, point.x, point.y, point.z);
          });
          attribute.needsUpdate = true;
          lineProxy.geometry.computeBoundingSphere();
          lineProxy.geometry.computeBoundingBox();
        }
      }

      nextHandles.forEach((handle) => {
        if (pendingHandleUpdatesRef.current.has(handle.key)) {
          return;
        }
        const proxy = snapshot[makeStoreKey(handle.key)]
          ?.proxyObject as THREE.Object3D | null | undefined;
        if (proxy) {
          proxy.position.set(...handle.position);
          proxy.updateMatrixWorld();
        }
      });

      const tangentPointsValid =
        tangentPoints.length > 0 &&
        tangentPoints.every((point) => isFiniteVec3(point));
      if (tangentProxy?.geometry && tangentPointsValid) {
        const attribute = tangentProxy.geometry.getAttribute(
          'position'
        ) as THREE.BufferAttribute | undefined;
        if (attribute && attribute.count === tangentPoints.length) {
          tangentPoints.forEach((point, index) => {
            attribute.setXYZ(index, point.x, point.y, point.z);
          });
          attribute.needsUpdate = true;
          tangentProxy.geometry.computeBoundingSphere();
          tangentProxy.geometry.computeBoundingBox();
        }
      }

      nextTangentHandles.forEach((handle) => {
        if (pendingTangentUpdatesRef.current.has(handle.key)) {
          return;
        }
        const proxy = snapshot[makeStoreKey(handle.key)]
          ?.proxyObject as THREE.Object3D | null | undefined;
        if (proxy) {
          proxy.position.set(...handle.position);
          proxy.updateMatrixWorld();
        }
      });

      return false;
    },
    [disableRaycast, makeStoreKey]
  );

  const computePath = useCallback(() => {
    const cameraObject = sheet.__experimental_getExistingObject?.(cameraKey);
    if (!cameraObject) {
      setLinePoints([]);
      setHandles([]);
      setTangentHandles([]);
      setTangentLinePoints([]);
      expectedHandlePositionsRef.current.clear();
      expectedTangentPositionsRef.current.clear();
      handleDataRef.current.clear();
      tangentHandleDataRef.current.clear();
      return;
    }
    const previousObjectKey = cameraObjectRef.current?.address?.objectKey;
    cameraObjectRef.current = cameraObject as ISheetObject;
    if (previousObjectKey !== cameraObject.address.objectKey) {
      trackIdsRef.current = null;
    }

    const xKeyframes = sortKeyframes(
      sheet.sequence.__experimental_getKeyframes(
        cameraObject.props.position.x
      )
    );
    const yKeyframes = sortKeyframes(
      sheet.sequence.__experimental_getKeyframes(
        cameraObject.props.position.y
      )
    );
    const zKeyframes = sortKeyframes(
      sheet.sequence.__experimental_getKeyframes(
        cameraObject.props.position.z
      )
    );

    const fallback = cameraObject.value.position;
    const baseLength = val(sheet.sequence.pointer.length);
    const maxKeyframe = Math.max(
      ...xKeyframes.map((kf) => kf.position),
      ...yKeyframes.map((kf) => kf.position),
      ...zKeyframes.map((kf) => kf.position),
      0
    );
    const pathLength = Math.max(baseLength, maxKeyframe);

    if (!Number.isFinite(pathLength) || pathLength <= 0) {
      setLinePoints([]);
      setHandles([]);
      setTangentHandles([]);
      setTangentLinePoints([]);
      expectedHandlePositionsRef.current.clear();
      expectedTangentPositionsRef.current.clear();
      handleDataRef.current.clear();
      tangentHandleDataRef.current.clear();
      return;
    }

    const sampleTotal = Math.max(2, sampleCount);
    const nextLinePoints: THREE.Vector3[] = [];
    for (let i = 0; i < sampleTotal; i += 1) {
      const time = pathLength * (i / (sampleTotal - 1));
      const x = evaluateKeyframes(xKeyframes, time, fallback.x);
      const y = evaluateKeyframes(yKeyframes, time, fallback.y);
      const z = evaluateKeyframes(zKeyframes, time, fallback.z);
      if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
        continue;
      }
      nextLinePoints.push(new THREE.Vector3(x, y, z));
    }

    const sortedTimes = Array.from(
      new Set([
        ...xKeyframes.map((kf) => kf.position),
        ...yKeyframes.map((kf) => kf.position),
        ...zKeyframes.map((kf) => kf.position),
      ])
    ).sort((a, b) => a - b);

    const buildSharedEntries = (threshold: number | null) => {
      const entries: Array<{
        key: string;
        time: number;
        x: Keyframe;
        y: Keyframe;
        z: Keyframe;
      }> = [];
      const sharedKey = new Set<string>();
      sortedTimes.forEach((time) => {
        const x = findClosestKeyframe(xKeyframes, time, threshold);
        const y = findClosestKeyframe(yKeyframes, time, threshold);
        const z = findClosestKeyframe(zKeyframes, time, threshold);
        if (!x || !y || !z) {
          return;
        }
        const key = `${x.id}__${y.id}__${z.id}`;
        if (sharedKey.has(key)) {
          return;
        }
        sharedKey.add(key);
        entries.push({
          key,
          time: (x.position + y.position + z.position) / 3,
          x,
          y,
          z,
        });
      });
      entries.sort((a, b) => a.time - b.time);
      return entries;
    };

    const sharedEntries = buildSharedEntries(TIME_MATCH_EPSILON);

    const handlePrefix = `${cameraKey}PathHandle`;
    const nextHandles: HandleData[] = sharedEntries
      .map((entry) => {
        const x = Number(entry.x.value);
        const y = Number(entry.y.value);
        const z = Number(entry.z.value);
        if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
          return null;
        }
        return {
          key: makeObjectKey(handlePrefix, [entry.key]),
          time: entry.time,
          position: [x, y, z] as Vec3,
          keyframes: { x: entry.x, y: entry.y, z: entry.z },
        };
      })
      .filter((handle): handle is HandleData => Boolean(handle));

    const nextTangentHandles: TangentHandleData[] = [];
    const nextTangentLinePoints: THREE.Vector3[] = [];

    for (let i = 0; i < sharedEntries.length - 1; i += 1) {
      const startEntry = sharedEntries[i];
      const endEntry = sharedEntries[i + 1];
      if (endEntry.time <= startEntry.time + TIME_QUANTIZE) {
        continue;
      }
      const startX = startEntry.x;
      const startY = startEntry.y;
      const startZ = startEntry.z;
      const endX = endEntry.x;
      const endY = endEntry.y;
      const endZ = endEntry.z;
      const connected = {
        x: startX.type !== 'hold',
        y: startY.type !== 'hold',
        z: startZ.type !== 'hold',
      };

      const startValues = {
        x: Number(startX.value),
        y: Number(startY.value),
        z: Number(startZ.value),
      };
      const endValues = {
        x: Number(endX.value),
        y: Number(endY.value),
        z: Number(endZ.value),
      };
      if (
        !isFiniteNumber(startValues.x) ||
        !isFiniteNumber(startValues.y) ||
        !isFiniteNumber(startValues.z) ||
        !isFiniteNumber(endValues.x) ||
        !isFiniteNumber(endValues.y) ||
        !isFiniteNumber(endValues.z)
      ) {
        continue;
      }

      const resolveHandlePoint = (start: number, end: number, handleY: number) =>
        start + (end - start) * handleY;

      const startPoint = new THREE.Vector3(
        startValues.x,
        startValues.y,
        startValues.z
      );
      const endPoint = new THREE.Vector3(endValues.x, endValues.y, endValues.z);
      const outRatios = {
        x: connected.x
          ? resolveHandleRatio(startX.handles[3], DEFAULT_TANGENT_OUT_RATIO)
          : DEFAULT_TANGENT_OUT_RATIO,
        y: connected.y
          ? resolveHandleRatio(startY.handles[3], DEFAULT_TANGENT_OUT_RATIO)
          : DEFAULT_TANGENT_OUT_RATIO,
        z: connected.z
          ? resolveHandleRatio(startZ.handles[3], DEFAULT_TANGENT_OUT_RATIO)
          : DEFAULT_TANGENT_OUT_RATIO,
      };
      const inRatios = {
        x: connected.x
          ? resolveHandleRatio(endX.handles[1], DEFAULT_TANGENT_IN_RATIO)
          : DEFAULT_TANGENT_IN_RATIO,
        y: connected.y
          ? resolveHandleRatio(endY.handles[1], DEFAULT_TANGENT_IN_RATIO)
          : DEFAULT_TANGENT_IN_RATIO,
        z: connected.z
          ? resolveHandleRatio(endZ.handles[1], DEFAULT_TANGENT_IN_RATIO)
          : DEFAULT_TANGENT_IN_RATIO,
      };
      const outPoint = new THREE.Vector3(
        resolveHandlePoint(startValues.x, endValues.x, outRatios.x),
        resolveHandlePoint(startValues.y, endValues.y, outRatios.y),
        resolveHandlePoint(startValues.z, endValues.z, outRatios.z)
      );
      const inPoint = new THREE.Vector3(
        resolveHandlePoint(startValues.x, endValues.x, inRatios.x),
        resolveHandlePoint(startValues.y, endValues.y, inRatios.y),
        resolveHandlePoint(startValues.z, endValues.z, inRatios.z)
      );
      const adjustedOutPoint = ensureTangentDistance(
        startPoint,
        startPoint,
        endPoint,
        outPoint,
        DEFAULT_TANGENT_OUT_RATIO
      );
      const adjustedInPoint = ensureTangentDistance(
        endPoint,
        startPoint,
        endPoint,
        inPoint,
        DEFAULT_TANGENT_IN_RATIO
      );
      if (
        !isFiniteVec3(startPoint) ||
        !isFiniteVec3(endPoint) ||
        !isFiniteVec3(adjustedOutPoint) ||
        !isFiniteVec3(adjustedInPoint)
      ) {
        continue;
      }

      nextTangentLinePoints.push(
        startPoint.clone(),
        adjustedOutPoint.clone(),
        endPoint.clone(),
        adjustedInPoint.clone()
      );

      const startTime = startEntry.time;
      const endTime = endEntry.time;
      const segmentKey = `${startEntry.key}|${endEntry.key}`;
      const tangentOutKey = makeObjectKey(
        `${cameraKey}PathTangentOut`,
        [segmentKey]
      );
      const tangentInKey = makeObjectKey(
        `${cameraKey}PathTangentIn`,
        [segmentKey]
      );
      nextTangentHandles.push({
        key: tangentOutKey,
        kind: 'out',
        time: startTime,
        startTime,
        endTime,
        position: [adjustedOutPoint.x, adjustedOutPoint.y, adjustedOutPoint.z],
        startKeyframes: { x: startX, y: startY, z: startZ },
        endKeyframes: { x: endX, y: endY, z: endZ },
        connected,
      });
      nextTangentHandles.push({
        key: tangentInKey,
        kind: 'in',
        time: endTime,
        startTime,
        endTime,
        position: [adjustedInPoint.x, adjustedInPoint.y, adjustedInPoint.z],
        startKeyframes: { x: startX, y: startY, z: startZ },
        endKeyframes: { x: endX, y: endY, z: endZ },
        connected,
      });
    }

    const safeLinePoints = nextLinePoints.filter((point) => isFiniteVec3(point));
    const safeHandles = nextHandles.filter((handle) =>
      isFiniteVec3Tuple(handle.position)
    );
    const safeTangentHandles = nextTangentHandles.filter((handle) =>
      isFiniteVec3Tuple(handle.position)
    );
    const safeTangentLinePoints = nextTangentLinePoints.filter((point) =>
      isFiniteVec3(point)
    );
    if (safeTangentLinePoints.length % 2 !== 0) {
      safeTangentLinePoints.pop();
    }

    syncRef.current = true;
    expectedHandlePositionsRef.current = new Map(
      safeHandles.map((handle) => [
        handle.key,
        new THREE.Vector3(...handle.position),
      ])
    );
    expectedTangentPositionsRef.current = new Map(
      safeTangentHandles.map((handle) => [
        handle.key,
        new THREE.Vector3(...handle.position),
      ])
    );
    handleDataRef.current = new Map(
      safeHandles.map((handle) => [handle.key, handle])
    );
    tangentHandleDataRef.current = new Map(
      safeTangentHandles.map((handle) => [handle.key, handle])
    );
    setLinePoints(safeLinePoints);
    setHandles(safeHandles);
    setTangentHandles(safeTangentHandles);
    setTangentLinePoints(safeTangentLinePoints);
    syncSnapshotProxies(
      safeLinePoints,
      safeHandles,
      lineKey,
      safeTangentLinePoints,
      safeTangentHandles,
      tangentLineKey
    );

    requestAnimationFrame(() => {
      syncRef.current = false;
    });
  }, [
    cameraKey,
    lineKey,
    tangentLineKey,
    sampleCount,
    sheet,
    syncSnapshotProxies,
  ]);

  const scheduleComputePath = useCallback(() => {
    if (computeRafRef.current !== null) {
      return;
    }
    computeRafRef.current = window.requestAnimationFrame(() => {
      computeRafRef.current = null;
      computePath();
    });
  }, [computePath]);

  useEffect(() => {
    if (!isEditorEnabled && !showInViewport) {
      return;
    }

    let disposed = false;
    const attachWatchers = () => {
      if (disposed) {
        return;
      }
      const cameraObject = sheet.__experimental_getExistingObject?.(cameraKey);
      if (!cameraObject) {
        cameraWatchRafRef.current = window.requestAnimationFrame(attachWatchers);
        return;
      }

      cameraObjectRef.current = cameraObject as ISheetObject;
      cameraWatchUnsubRef.current?.();
      const scheduleUpdate = () => {
        if (syncRef.current) {
          return;
        }
        scheduleComputePath();
      };
      const unsubX = onChange(cameraObject.props.position.x, scheduleUpdate);
      const unsubY = onChange(cameraObject.props.position.y, scheduleUpdate);
      const unsubZ = onChange(cameraObject.props.position.z, scheduleUpdate);
      cameraWatchUnsubRef.current = () => {
        unsubX();
        unsubY();
        unsubZ();
      };
    };

    attachWatchers();
    return () => {
      disposed = true;
      if (cameraWatchRafRef.current !== null) {
        window.cancelAnimationFrame(cameraWatchRafRef.current);
        cameraWatchRafRef.current = null;
      }
      cameraWatchUnsubRef.current?.();
      cameraWatchUnsubRef.current = null;
    };
  }, [cameraKey, scheduleComputePath, sheet, showInViewport]);

  const scheduleHandleUnset = useCallback((handleKey: string) => {
    if (!isEditorEnabled) {
      return;
    }
    const existing = handleUnsetTimersRef.current.get(handleKey);
    if (existing) {
      window.clearTimeout(existing);
    }
    const timeoutId = window.setTimeout(() => {
      handleUnsetTimersRef.current.delete(handleKey);
      const studioModule = studioRef.current;
      const handleObject =
        handleObjectsRef.current.get(handleKey) ??
        tangentHandleObjectsRef.current.get(handleKey);
      if (!studioModule || !handleObject) {
        return;
      }
      const studio = studioModule.default;
      syncRef.current = true;
      studio.transaction(({ unset }) => {
        unsetObjectPosition(unset, handleObject);
      });
      window.requestAnimationFrame(() => {
        syncRef.current = false;
      });
    }, HANDLE_UNSET_DELAY_MS);
    handleUnsetTimersRef.current.set(handleKey, timeoutId);
  }, []);

  const clearTangentOverrides = useCallback(() => {
    if (!isEditorEnabled) {
      return;
    }
    if (pendingTangentUpdatesRef.current.size > 0) {
      return;
    }
    const studioModule = studioRef.current;
    if (!studioModule) {
      return;
    }
    const handles = Array.from(tangentHandleObjectsRef.current.values());
    if (handles.length === 0) {
      return;
    }
    const studio = studioModule.default;
    syncRef.current = true;
    studio.transaction(({ unset }) => {
      handles.forEach((handleObject) => {
        unsetObjectPosition(unset, handleObject);
      });
    });
    window.requestAnimationFrame(() => {
      syncRef.current = false;
    });
  }, []);

  const flushPendingHandleUpdates = useCallback(() => {
    if (!isEditorEnabled) {
      return;
    }
    const studioModule = studioRef.current;
    const cameraObject = cameraObjectRef.current;
    if (!studioModule || !cameraObject) {
      pendingHandleUpdatesRef.current.clear();
      return;
    }
    const pending = Array.from(pendingHandleUpdatesRef.current.entries());
    if (pending.length === 0) {
      return;
    }
    pendingHandleUpdatesRef.current.clear();

    pending.forEach(([handleKey, update]) => {
      const handle = handleDataRef.current.get(handleKey);
      if (!handle) {
        return;
      }
      updateCameraKeyframe(handle, update.position);
      expectedHandlePositionsRef.current.set(
        handleKey,
        update.position.clone()
      );
    });

    clearTangentOverrides();
    scheduleComputePath();
  }, [clearTangentOverrides, scheduleComputePath, updateCameraKeyframe]);

  const queueHandleUpdate = useCallback(
    (handle: HandleData, position: THREE.Vector3) => {
      tangentUpdateBlockRef.current =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) +
        TANGENT_UPDATE_SUPPRESS_MS;
      pendingHandleUpdatesRef.current.set(handle.key, { position });
      if (pendingHandleRafRef.current !== null) {
        return;
      }
      pendingHandleRafRef.current = window.requestAnimationFrame(() => {
        pendingHandleRafRef.current = null;
        flushPendingHandleUpdates();
      });
    },
    [flushPendingHandleUpdates]
  );

  const updateTangentKeyframeHandles = useCallback(
    (handle: TangentHandleData, position: THREE.Vector3) => {
      if (!isEditorEnabled) {
        return;
      }
      const cameraObject = cameraObjectRef.current;
      if (!cameraObject) {
        return;
      }
      const trackIds = resolveTrackIds();
      if (!trackIds) {
        return;
      }
      const { startKeyframes, endKeyframes } = handle;

      const computeRatio = (
        start: number,
        end: number,
        value: number,
        fallback: number
      ) => {
        const delta = end - start;
        if (!Number.isFinite(delta) || Math.abs(delta) <= POSITION_EPSILON) {
          return fallback;
        }
        return (value - start) / delta;
      };

      const axisUpdates = [
        {
          start: startKeyframes.x,
          end: endKeyframes.x,
          current: position.x,
          trackId: trackIds.x,
        },
        {
          start: startKeyframes.y,
          end: endKeyframes.y,
          current: position.y,
          trackId: trackIds.y,
        },
        {
          start: startKeyframes.z,
          end: endKeyframes.z,
          current: position.z,
          trackId: trackIds.z,
        },
      ];

      const pendingUpdates: Array<{
        trackId: string;
        keyframeId: string;
        start?: [number, number];
        end?: [number, number];
      }> = [];

      const keyframeTypeUpdates = new Map<
        string,
        { trackId: string; keyframeId: string }
      >();

      axisUpdates.forEach(({ start, end, current, trackId }) => {
        if (!trackId) {
          return;
        }
        const startValue = Number(start.value);
        const endValue = Number(end.value);
        if (!isFiniteNumber(startValue) || !isFiniteNumber(endValue)) {
          return;
        }
        if (handle.kind === 'out') {
          const nextY = computeRatio(
            startValue,
            endValue,
            current,
            start.handles[3]
          );
          if (approxEqual(nextY, start.handles[3])) {
            return;
          }
          const update = {
            trackId,
            keyframeId: start.id,
            start: [start.handles[2], nextY],
          };
          pendingUpdates.push(update);
          keyframeTypeUpdates.set(`${trackId}:${start.id}`, {
            trackId,
            keyframeId: start.id,
          });
          return;
        }
        const nextY = computeRatio(
          startValue,
          endValue,
          current,
          end.handles[1]
        );
        if (approxEqual(nextY, end.handles[1])) {
          return;
        }
        const update = {
          trackId,
          keyframeId: end.id,
          end: [end.handles[0], nextY],
        };
        pendingUpdates.push(update);
        keyframeTypeUpdates.set(`${trackId}:${end.id}`, {
          trackId,
          keyframeId: end.id,
        });
      });

      if (pendingUpdates.length === 0) {
        return;
      }

      const internalStudio = getInternalStudio();
      if (!internalStudio?.transaction) {
        return;
      }
      const address = cameraObject.address;
      let didUpdate = false;
      internalStudio.transaction(({ stateEditors }: { stateEditors?: any }) => {
        const editor = stateEditors?.coreByProject?.historic?.sheetsById?.sequence;
        if (!editor?.setHandlesForKeyframe) {
          return;
        }
        pendingUpdates.forEach((update) => {
          editor.setHandlesForKeyframe({
            ...address,
            ...update,
          });
        });
        if (editor.setKeyframeType) {
          keyframeTypeUpdates.forEach((update) => {
            editor.setKeyframeType({
              ...address,
              ...update,
              keyframeType: 'bezier',
            });
          });
        }
        didUpdate = true;
      });
      if (didUpdate) {
        expectedTangentPositionsRef.current.set(handle.key, position.clone());
      }
    },
    [resolveTrackIds]
  );

  const flushPendingTangentUpdates = useCallback(() => {
    if (!isEditorEnabled) {
      return;
    }
    if (pendingTangentUpdatesRef.current.size === 0) {
      return;
    }
    const pending = Array.from(pendingTangentUpdatesRef.current.entries());
    pendingTangentUpdatesRef.current.clear();
    pending.forEach(([handleKey, update]) => {
      const handle = tangentHandleDataRef.current.get(handleKey);
      if (!handle) {
        return;
      }
      updateTangentKeyframeHandles(handle, update.position);
    });
    scheduleComputePath();
  }, [scheduleComputePath, updateTangentKeyframeHandles]);

  const queueTangentUpdate = useCallback(
    (handle: TangentHandleData, position: THREE.Vector3) => {
      pendingTangentUpdatesRef.current.set(handle.key, { position });
      if (pendingTangentRafRef.current !== null) {
        return;
      }
      pendingTangentRafRef.current = window.requestAnimationFrame(() => {
        pendingTangentRafRef.current = null;
        flushPendingTangentUpdates();
      });
    },
    [flushPendingTangentUpdates]
  );

  useEffect(() => {
    if (!isEditorEnabled && !showInViewport) {
      return;
    }
    computePath();
    const interval = window.setInterval(() => {
      computePath();
    }, refreshMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [computePath, refreshMs, showInViewport]);

  useEffect(() => {
    const handleKeys = new Set(handles.map((handle) => handle.key));
    for (const [key, unsubscribe] of handleUnsubRef.current.entries()) {
      if (!handleKeys.has(key)) {
        unsubscribe();
        handleUnsubRef.current.delete(key);
      }
    }
    for (const key of handleObjectsRef.current.keys()) {
      if (!handleKeys.has(key)) {
        handleObjectsRef.current.delete(key);
      }
    }
  }, [handles]);

  useEffect(() => {
    const handleKeys = new Set(tangentHandles.map((handle) => handle.key));
    for (const [key, unsubscribe] of tangentHandleUnsubRef.current.entries()) {
      if (!handleKeys.has(key)) {
        unsubscribe();
        tangentHandleUnsubRef.current.delete(key);
      }
    }
    for (const key of tangentHandleObjectsRef.current.keys()) {
      if (!handleKeys.has(key)) {
        tangentHandleObjectsRef.current.delete(key);
      }
    }
  }, [tangentHandles]);

  useEffect(
    () => () => {
      for (const unsubscribe of handleUnsubRef.current.values()) {
        unsubscribe();
      }
      handleUnsubRef.current.clear();
      handleObjectsRef.current.clear();
      expectedHandlePositionsRef.current.clear();
      handleDataRef.current.clear();
      for (const unsubscribe of tangentHandleUnsubRef.current.values()) {
        unsubscribe();
      }
      tangentHandleUnsubRef.current.clear();
      tangentHandleObjectsRef.current.clear();
      expectedTangentPositionsRef.current.clear();
      tangentHandleDataRef.current.clear();
      for (const timeoutId of handleUnsetTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      handleUnsetTimersRef.current.clear();
      pendingHandleUpdatesRef.current.clear();
      if (pendingHandleRafRef.current !== null) {
        window.cancelAnimationFrame(pendingHandleRafRef.current);
        pendingHandleRafRef.current = null;
      }
      pendingTangentUpdatesRef.current.clear();
      if (pendingTangentRafRef.current !== null) {
        window.cancelAnimationFrame(pendingTangentRafRef.current);
        pendingTangentRafRef.current = null;
      }
      if (computeRafRef.current !== null) {
        window.cancelAnimationFrame(computeRafRef.current);
        computeRafRef.current = null;
      }
      if (scrubCommitRef.current !== null) {
        window.clearTimeout(scrubCommitRef.current);
        scrubCommitRef.current = null;
      }
      scrubRef.current?.discard();
      scrubRef.current = null;
      scrubCommitTimeRef.current = null;
      if (cameraWatchRafRef.current !== null) {
        window.cancelAnimationFrame(cameraWatchRafRef.current);
        cameraWatchRafRef.current = null;
      }
      cameraWatchUnsubRef.current?.();
      cameraWatchUnsubRef.current = null;
    },
    []
  );

  useEffect(() => {
    if (!isEditorEnabled) {
      return;
    }
    handles.forEach((handle) => {
      if (handleUnsubRef.current.has(handle.key)) {
        return;
      }
      const handleObject = handleObjectsRef.current.get(handle.key);
      if (!handleObject) {
        return;
      }
      const handleKey = handle.key;
      const unsubscribe = handleObject.onValuesChange((values) => {
        if (syncRef.current) {
          return;
        }
        const positionValue = values.position;
        if (!positionValue) {
          return;
        }
        if (
          !isFiniteNumber(positionValue.x) ||
          !isFiniteNumber(positionValue.y) ||
          !isFiniteNumber(positionValue.z)
        ) {
          return;
        }
        const expected = expectedHandlePositionsRef.current.get(handleKey);
        const nextPosition = new THREE.Vector3(
          positionValue.x,
          positionValue.y,
          positionValue.z
        );
        if (expected && expected.distanceTo(nextPosition) < HANDLE_DRAG_EPSILON) {
          expected.copy(nextPosition);
          return;
        }
        if (
          expected &&
          approxEqual(positionValue.x, expected.x) &&
          approxEqual(positionValue.y, expected.y) &&
          approxEqual(positionValue.z, expected.z)
        ) {
          return;
        }
        const currentHandle = handleDataRef.current.get(handleKey);
        if (!currentHandle) {
          return;
        }
        queueHandleUpdate(currentHandle, nextPosition);
        scheduleHandleUnset(handleKey);
      });
      handleUnsubRef.current.set(handle.key, unsubscribe);
    });
  }, [handles, queueHandleUpdate, scheduleHandleUnset]);

  useEffect(() => {
    if (!isEditorEnabled) {
      return;
    }
    tangentHandles.forEach((handle) => {
      if (tangentHandleUnsubRef.current.has(handle.key)) {
        return;
      }
      const handleObject = tangentHandleObjectsRef.current.get(handle.key);
      if (!handleObject) {
        return;
      }
      const handleKey = handle.key;
      const unsubscribe = handleObject.onValuesChange((values) => {
        if (syncRef.current) {
          return;
        }
        const positionValue = values.position;
        if (!positionValue) {
          return;
        }
        if (
          !isFiniteNumber(positionValue.x) ||
          !isFiniteNumber(positionValue.y) ||
          !isFiniteNumber(positionValue.z)
        ) {
          return;
        }
        const now =
          typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now < tangentUpdateBlockRef.current) {
          return;
        }
        const nextPosition = new THREE.Vector3(
          positionValue.x,
          positionValue.y,
          positionValue.z
        );
        const expected = expectedTangentPositionsRef.current.get(handleKey);
        if (expected) {
          if (expected.distanceTo(nextPosition) < TANGENT_DRAG_EPSILON) {
            expected.copy(nextPosition);
            return;
          }
        }
        if (
          expected &&
          approxEqual(positionValue.x, expected.x) &&
          approxEqual(positionValue.y, expected.y) &&
          approxEqual(positionValue.z, expected.z)
        ) {
          return;
        }
        const currentHandle = tangentHandleDataRef.current.get(handleKey);
        if (!currentHandle) {
          return;
        }
        queueTangentUpdate(currentHandle, nextPosition);
        scheduleHandleUnset(handleKey);
      });
      tangentHandleUnsubRef.current.set(handle.key, unsubscribe);
    });
  }, [queueTangentUpdate, scheduleHandleUnset, tangentHandles]);

  const linePositions = useMemo(() => {
    if (linePoints.length === 0) {
      return new Float32Array();
    }
    const positions = new Float32Array(linePoints.length * 3);
    linePoints.forEach((point, index) => {
      const base = index * 3;
      positions[base] = isFiniteNumber(point.x) ? point.x : 0;
      positions[base + 1] = isFiniteNumber(point.y) ? point.y : 0;
      positions[base + 2] = isFiniteNumber(point.z) ? point.z : 0;
    });
    return positions;
  }, [linePoints]);

  const tangentLinePositions = useMemo(() => {
    if (tangentLinePoints.length === 0) {
      return new Float32Array();
    }
    const positions = new Float32Array(tangentLinePoints.length * 3);
    tangentLinePoints.forEach((point, index) => {
      const base = index * 3;
      positions[base] = isFiniteNumber(point.x) ? point.x : 0;
      positions[base + 1] = isFiniteNumber(point.y) ? point.y : 0;
      positions[base + 2] = isFiniteNumber(point.z) ? point.z : 0;
    });
    return positions;
  }, [tangentLinePoints]);

  const resolvedHandleSize = useMemo(() => {
    if (linePoints.length < 2) {
      return handleSize;
    }
    const bounds = new THREE.Box3().setFromPoints(linePoints);
    const size = bounds.getSize(new THREE.Vector3());
    const longest = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(longest) || longest <= 0) {
      return handleSize;
    }
    return Math.max(handleSize, longest * 0.03);
  }, [handleSize, linePoints]);

  const resolvedTangentHandleSize = useMemo(
    () => Math.max(resolvedHandleSize * TANGENT_HANDLE_SCALE, handleSize * 0.5),
    [handleSize, resolvedHandleSize]
  );

  const lineVisible = showInViewport ? true : editorVisible ? 'editor' : false;

  if (!editorVisible && !showInViewport) {
    return null;
  }

  return (
    <group>
      {linePoints.length >= 2 ? (
        <e.line
          theatreKey={lineKey}
          visible={lineVisible}
          frustumCulled={false}
          renderOrder={10}
          raycast={disableRaycast}
        >
          <bufferGeometry key={`${lineKey}-geometry-${linePoints.length}`}>
            <bufferAttribute
              attach='attributes-position'
              array={linePositions}
              count={linePoints.length}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial
            color={lineColor}
            transparent
            opacity={0.9}
            depthTest={false}
            depthWrite={false}
          />
        </e.line>
      ) : null}
      {tangentLinePoints.length >= 2 ? (
        <e.lineSegments
          theatreKey={tangentLineKey}
          visible={editorVisible ? 'editor' : false}
          frustumCulled={false}
          renderOrder={25}
          raycast={disableRaycast}
        >
          <bufferGeometry
            key={`${tangentLineKey}-geometry-${tangentLinePoints.length}`}
          >
            <bufferAttribute
              attach='attributes-position'
              array={tangentLinePositions}
              count={tangentLinePoints.length}
              itemSize={3}
            />
          </bufferGeometry>
          <lineBasicMaterial
            color={lineColor}
            transparent
            opacity={TANGENT_LINE_OPACITY}
            depthTest={false}
            depthWrite={false}
          />
        </e.lineSegments>
      ) : null}
      {tangentHandles.map((handle) => (
        <e.mesh
          key={handle.key}
          theatreKey={handle.key}
          position={handle.position}
          visible={editorVisible ? 'editor' : false}
          frustumCulled={false}
          renderOrder={30}
          ref={(mesh) => {
            if (mesh) {
              mesh.userData.helper = true;
            }
          }}
          objRef={(obj) => {
            if (obj) {
              tangentHandleObjectsRef.current.set(handle.key, obj as ISheetObject);
            } else {
              tangentHandleObjectsRef.current.delete(handle.key);
            }
          }}
        >
          <sphereGeometry args={[resolvedTangentHandleSize, 14, 14]} />
          <meshBasicMaterial
            color={lineColor}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </e.mesh>
      ))}
      {handles.map((handle) => (
        <e.mesh
          key={handle.key}
          theatreKey={handle.key}
          position={handle.position}
          visible={editorVisible ? 'editor' : false}
          frustumCulled={false}
          renderOrder={20}
          ref={(mesh) => {
            if (mesh) {
              mesh.userData.helper = true;
            }
          }}
          objRef={(obj) => {
            if (obj) {
              handleObjectsRef.current.set(handle.key, obj as ISheetObject);
            } else {
              handleObjectsRef.current.delete(handle.key);
            }
          }}
        >
          <sphereGeometry args={[resolvedHandleSize, 16, 16]} />
          <meshBasicMaterial
            color={handleColor}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </e.mesh>
      ))}
    </group>
  );
}
