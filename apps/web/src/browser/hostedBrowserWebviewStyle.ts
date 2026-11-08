import type { BrowserSurfaceRect } from "./browserSurfaceStore";

export interface HostedBrowserWebviewSize {
  readonly width: number;
  readonly height: number;
}

export interface HostedBrowserWebviewWrapperStyle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
  readonly pointerEvents: "auto" | "none";
  readonly borderRadius?: number;
  readonly visibility?: "hidden" | "visible";
  readonly opacity?: number;
  readonly clipPath?: string;
}

const HIDDEN_BROWSER_WEBVIEW_OFFSET = -100_000;

export function resolveHostedBrowserWebviewWrapperStyle(input: {
  readonly active: boolean;
  readonly renderingActive: boolean;
  readonly capturing: boolean;
  readonly keepPaintableWhenInactive?: boolean;
  readonly cornerRadius?: number;
  readonly zIndex?: number;
  readonly rect: BrowserSurfaceRect | null;
  readonly hiddenSize: HostedBrowserWebviewSize;
}): HostedBrowserWebviewWrapperStyle {
  const {
    active,
    capturing,
    cornerRadius = 0,
    hiddenSize,
    keepPaintableWhenInactive = false,
    rect,
    renderingActive,
    zIndex = 30,
  } = input;
  if (active && rect) {
    return {
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
      zIndex,
      pointerEvents: "auto",
      ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
    };
  }

  if (renderingActive) {
    const placement = {
      left: 0,
      top: 0,
      width: hiddenSize.width,
      height: hiddenSize.height,
      pointerEvents: "none",
      visibility: "visible",
    } as const;
    // Chromium draws no offscreen or fully covered guest, so a capturing guest shows one pixel above
    // the app's overlays. It stays non-opaque so guests sharing that pixel cannot cover each other.
    if (capturing) {
      return {
        ...placement,
        zIndex: 2_147_483_647,
        opacity: 0.99,
        clipPath: "inset(0 calc(100% - 1px) calc(100% - 1px) 0)",
      };
    }
    // Picture-in-picture frames come from capturePage, which needs no drawn guest.
    return { ...placement, zIndex: -1 };
  }

  return {
    left: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    top: HIDDEN_BROWSER_WEBVIEW_OFFSET,
    width: hiddenSize.width,
    height: hiddenSize.height,
    zIndex: -1,
    pointerEvents: "none",
    visibility: keepPaintableWhenInactive ? "visible" : "hidden",
  };
}
