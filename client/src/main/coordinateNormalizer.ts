import { screen } from 'electron';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ScaleMetrics {
    logicalBounds: Rect;
    nativeWidth: number;
    nativeHeight: number;
    scaleX: number;
    scaleY: number;
}

export class CoordinateNormalizer {
    private readonly metrics: ScaleMetrics;
    private static cachedVirtualBounds: Rect | null = null;
    private static cachedDisplaySignature = '';
    private static cacheExpiresAt = 0;
    private static displayListenersRegistered = false;

    constructor(metrics: ScaleMetrics) {
        this.metrics = metrics;
    }

    private static invalidateVirtualBoundsCache() {
        this.cachedVirtualBounds = null;
        this.cachedDisplaySignature = '';
        this.cacheExpiresAt = 0;
    }

    private static registerDisplayListeners() {
        if (this.displayListenersRegistered) return;
        this.displayListenersRegistered = true;
        try {
            screen.on('display-added', () => this.invalidateVirtualBoundsCache());
            screen.on('display-removed', () => this.invalidateVirtualBoundsCache());
            screen.on('display-metrics-changed', () => this.invalidateVirtualBoundsCache());
        } catch {
            // Tests can mock Electron's screen without EventEmitter support.
        }
    }

    public static getVirtualLogicalBounds(): Rect {
        this.registerDisplayListeners();
        const now = Date.now();
        if (this.cachedVirtualBounds && now < this.cacheExpiresAt) {
            return { ...this.cachedVirtualBounds };
        }
        const displays = screen.getAllDisplays();
        if (!displays.length) {
            const primary = screen.getPrimaryDisplay();
            const bounds = {
                x: primary.bounds.x,
                y: primary.bounds.y,
                width: Math.max(1, primary.bounds.width),
                height: Math.max(1, primary.bounds.height),
            };
            this.cachedVirtualBounds = bounds;
            this.cachedDisplaySignature = `primary:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`;
            this.cacheExpiresAt = now + 500;
            return { ...bounds };
        }
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        const signatureParts: string[] = [];
        for (const display of displays) {
            const { x, y, width, height } = display.bounds;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + width);
            maxY = Math.max(maxY, y + height);
            signatureParts.push(`${display.id}:${x}:${y}:${width}:${height}:${display.scaleFactor ?? 1}`);
        }
        const signature = signatureParts.join('|');
        if (this.cachedVirtualBounds && this.cachedDisplaySignature === signature) {
            this.cacheExpiresAt = now + 500;
            return { ...this.cachedVirtualBounds };
        }
        const bounds = {
            x: minX,
            y: minY,
            width: Math.max(1, maxX - minX),
            height: Math.max(1, maxY - minY),
        };
        this.cachedVirtualBounds = bounds;
        this.cachedDisplaySignature = signature;
        this.cacheExpiresAt = now + 500;
        return { ...bounds };
    }

    public static fromNativeImageDimensions(nativeWidth: number, nativeHeight: number): CoordinateNormalizer {
        const logicalBounds = this.getVirtualLogicalBounds();
        const primary = screen.getPrimaryDisplay();
        const fallbackScale = Math.max(1, primary.scaleFactor || 1);
        const ratioX = nativeWidth / logicalBounds.width;
        const ratioY = nativeHeight / logicalBounds.height;

        const validRatio = (ratio: number) => Number.isFinite(ratio) && ratio >= 0.75 && ratio <= 6;
        const scaleX = validRatio(ratioX) ? ratioX : fallbackScale;
        const scaleY = validRatio(ratioY) ? ratioY : fallbackScale;

        return new CoordinateNormalizer({
            logicalBounds,
            nativeWidth,
            nativeHeight,
            scaleX,
            scaleY,
        });
    }

    public logicalToNativePoint(x: number, y: number): { x: number; y: number } {
        return {
            x: Math.round((x - this.metrics.logicalBounds.x) * this.metrics.scaleX),
            y: Math.round((y - this.metrics.logicalBounds.y) * this.metrics.scaleY),
        };
    }

    public nativeToLogicalPoint(x: number, y: number): { x: number; y: number } {
        return {
            x: Math.round(this.metrics.logicalBounds.x + x / this.metrics.scaleX),
            y: Math.round(this.metrics.logicalBounds.y + y / this.metrics.scaleY),
        };
    }

    public logicalToNativeRect(region: Rect): Rect {
        const origin = this.logicalToNativePoint(region.x, region.y);
        const width = Math.max(1, Math.round(region.width * this.metrics.scaleX));
        const height = Math.max(1, Math.round(region.height * this.metrics.scaleY));
        return {
            x: origin.x,
            y: origin.y,
            width,
            height,
        };
    }

    public nativeToLogicalRect(region: Rect): Rect {
        const origin = this.nativeToLogicalPoint(region.x, region.y);
        const width = Math.max(1, Math.round(region.width / this.metrics.scaleX));
        const height = Math.max(1, Math.round(region.height / this.metrics.scaleY));
        return {
            x: origin.x,
            y: origin.y,
            width,
            height,
        };
    }

    public get scaleX(): number {
        return this.metrics.scaleX;
    }

    public get scaleY(): number {
        return this.metrics.scaleY;
    }

    public get logicalBounds(): Rect {
        return this.metrics.logicalBounds;
    }
}
