export function hotkeyTarget(uiTarget: string | null | undefined, profileTarget?: string | null): string {
    const ui = (uiTarget ?? '').trim();
    if (ui) return ui;
    const profile = (profileTarget ?? '').trim();
    if (profile) return profile;
    return 'screen';
}
