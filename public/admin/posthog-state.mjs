export function resolvePosthogDashboard(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return { kind: 'missing', url: null };
    }

    let url;
    try {
        url = new URL(value.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return { kind: 'invalid', url: null };
        }
    } catch {
        return { kind: 'invalid', url: null };
    }

    const isSharedDashboard =
        url.pathname.startsWith('/shared/') ||
        url.pathname.startsWith('/shared_dashboard/');

    return {
        kind: isSharedDashboard ? 'embedded' : 'external',
        url: url.href
    };
}
