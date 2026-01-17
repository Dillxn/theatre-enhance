"use client";

import type { IExtension } from "@theatre/studio";
import { useEffect, useRef, useState } from "react";

type EnhanceState = {
  helpersVisible: boolean;
};

type EnhanceListener = (state: EnhanceState) => void;

const listeners = new Set<EnhanceListener>();
let currentState: EnhanceState = { helpersVisible: true };

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

const EYE_OPEN_ICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>";

const EYE_CLOSED_ICON =
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><path d=\"M3 3l18 18\"/><path d=\"M10.7 5.1C11.1 5 11.6 5 12 5c6 0 10 7 10 7a17.7 17.7 0 0 1-4.1 4.5\"/><path d=\"M6.1 6.1C3.2 8.3 2 12 2 12s4 7 10 7c1.4 0 2.7-.3 3.9-.8\"/></svg>";

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
        ]);
      };

      apply(currentState);
      return subscribeTheatreEnhanceState(apply);
    },
  },
};
