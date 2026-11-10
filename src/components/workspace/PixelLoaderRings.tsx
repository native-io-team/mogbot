import { PixelLoader, type PixelLoaderProps } from '../primitives/PixelLoader';

export type PixelLoaderRingsProps = Omit<PixelLoaderProps, 'variant'>;

/** Centre-out pixel rings used for active agent work in the workspace sidebar; `colorway` lights it in that agent's colour. */
export function PixelLoaderRings(props: PixelLoaderRingsProps) {
  return <PixelLoader {...props} variant="rings" />;
}
