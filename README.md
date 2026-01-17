# theatre-enhance

Theatre.js Studio helpers for camera path editing with anchor and bezier controls.

## Features
- Camera path line rendering from Theatre keyframes
- Anchor handles and bezier tangents for editing path curvature
- Studio toolbar toggle for helper visibility

## Install
```bash
npm install theatre-enhance
```

## Usage
```tsx
import studio from "@theatre/studio";
import r3fExtension from "@theatre/r3f/dist/extension";
import { CameraSplinePath, theatreEnhanceExtension } from "theatre-enhance";

studio.extend(r3fExtension);
studio.extend(theatreEnhanceExtension);
await studio.initialize({ usePersistentStorage: false });
```

Then render the helpers inside your scene:
```tsx
<CameraSplinePath cameraKey="GalleryCamera" />
```

## Props
- `cameraKey` (string): Theatre object key for the camera.
- `lineColor` (string): Path line color.
- `handleColor` (string): Anchor handle color.
- `handleSize` (number): Base handle size.
- `sampleCount` (number): Path sampling density.
- `refreshMs` (number): Path refresh interval.
- `showInViewport` (boolean): Force visibility outside Studio.

## Notes
- Helpers only render when `NEXT_PUBLIC_THEATRE_EDITOR=1` unless `showInViewport`
  is set to `true`.
- Requires `@theatre/r3f` and Theatre Studio to be initialized.
