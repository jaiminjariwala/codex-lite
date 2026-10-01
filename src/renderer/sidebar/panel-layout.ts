export function fitPanelWidth(requested: number, viewport: number, sidebar: number): number {
    return Math.min(requested, Math.max(260, (viewport - sidebar) * 0.55))
}
