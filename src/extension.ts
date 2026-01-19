"use client";

import type { IExtension } from "@theatre/studio";
import { useEffect, useRef, useState } from "react";

type EnhanceState = {
  helpersVisible: boolean;
};

type EnhanceListener = (state: EnhanceState) => void;

const listeners = new Set<EnhanceListener>();
let currentState: EnhanceState = { helpersVisible: true };
let exportProjectId: string | null = null;

const emit = () => {
  listeners.forEach((listener) => {
    listener(currentState);
  });
};

export const getTheatreEnhanceState = () => currentState;

export const setTheatreEnhanceState = (next: Partial<EnhanceState>) => {
  const updated = { ...currentState, ...next };
  if (updated.helpersVisible === currentState.helpersVisible) {
    currentState = updated;
    return;
  }
  currentState = updated;
  emit();
};

export const setTheatreEnhanceExportProjectId = (
  projectId: string | null
) => {
  exportProjectId = projectId ? projectId.trim() : null;
};

export const subscribeTheatreEnhanceState = (listener: EnhanceListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useTheatreEnhanceState = <T,>(
  selector: (state: EnhanceState) => T
) => {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const [selected, setSelected] = useState(() => selector(currentState));

  useEffect(
    () =>
      subscribeTheatreEnhanceState((state) => {
        const nextSelected = selectorRef.current(state);
        setSelected((prev) =>
          Object.is(prev, nextSelected) ? prev : nextSelected
        );
      }),
    []
  );

  return selected;
};

const getStudioState = () => {
  if (typeof window === "undefined") {
    return null;
  }
  const bundle = (
    window as unknown as {
      __TheatreJS_StudioBundle?: {
        _studio?: { _store?: { getState?: () => unknown } };
      };
    }
  ).__TheatreJS_StudioBundle;
  return bundle?._studio?._store?.getState?.() ?? null;
};

const resolveExportProjectId = () => {
  if (exportProjectId) {
    return exportProjectId;
  }
  const state = getStudioState() as {
    $persistent?: {
      historic?: {
        innerState?: {
          coreByProject?: Record<string, unknown>;
        };
      };
    };
  } | null;
  const coreByProject = state?.$persistent?.historic?.innerState?.coreByProject;
  if (!coreByProject || typeof coreByProject !== "object") {
    return null;
  }
  const ids = Object.keys(coreByProject);
  if (ids.length > 1) {
    console.warn(
      "Multiple Theatre projects found; exporting the first one.",
      ids
    );
  }
  return ids[0] ?? null;
};

const saveJsonToFile = async (fileName: string, payload: unknown) => {
  if (typeof window === "undefined") {
    return;
  }
  const json = JSON.stringify(payload, null, 2);
  const showSaveFilePicker = (
    window as unknown as {
      showSaveFilePicker?: (options?: unknown) => Promise<any>;
    }
  ).showSaveFilePicker;

  if (showSaveFilePicker) {
    const handle = await showSaveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "JSON",
          accept: { "application/json": [".json"] },
        },
      ],
    });
    const writable = await handle.createWritable();
    await writable.write(json);
    await writable.close();
    return;
  }

  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

const exportTheatreProjectState = async () => {
  try {
    const projectId = resolveExportProjectId();
    if (!projectId) {
      console.warn("No Theatre project ID found for export.");
      return;
    }
    const studioMod = await import("@theatre/studio");
    const payload = studioMod.default.createContentOfSaveFile(projectId);
    const fileName = projectId.endsWith(".json")
      ? projectId
      : `${projectId}.theatre-project-state.json`;
    await saveJsonToFile(fileName, payload);
  } catch (error) {
    if (isAbortError(error)) {
      return;
    }
    console.warn("Failed to export Theatre state.", error);
  }
};

const EYE_OPEN_ICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>";

const EYE_CLOSED_ICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3 3l18 18\"/><path d=\"M10.7 5.1C11.1 5 11.6 5 12 5c6 0 10 7 10 7a17.7 17.7 0 0 1-4.1 4.5\"/><path d=\"M6.1 6.1C3.2 8.3 2 12 2 12s4 7 10 7c1.4 0 2.7-.3 3.9-.8\"/></svg>";

const EXPORT_ICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M12 3v12\"/><path d=\"M8 11l4 4 4-4\"/><path d=\"M4 21h16\"/></svg>";

export const theatreEnhanceExtension: IExtension = {
  id: "theatre-enhance",
  toolbars: {
    global: (set) => {
      const apply = (state: EnhanceState) => {
        const helpersVisible = state.helpersVisible;
        set([
          {
            type: "Icon",
            svgSource: helpersVisible ? EYE_OPEN_ICON : EYE_CLOSED_ICON,
            title: helpersVisible
              ? "Hide path helpers"
              : "Show path helpers",
            onClick: () => {
              setTheatreEnhanceState({
                helpersVisible: !getTheatreEnhanceState().helpersVisible,
              });
            },
          },
          {
            type: "Icon",
            svgSource: EXPORT_ICON,
            title: "Export Theatre state",
            onClick: () => {
              void exportTheatreProjectState();
            },
          },
        ]);
      };

      apply(currentState);
      return subscribeTheatreEnhanceState(apply);
    },
  },
};
