export const getErrorDetail = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error || '未知错误');
    return raw
        .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
        .replace(/((?:["']?(?:api[_ -]?key|authorization|token|secret|password)["']?\s*[:=]\s*["']?))((?!Bearer\b)[^"',;\s}]+)/gi, '$1[已隐藏]')
        .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[已隐藏]')
        .trim() || '未知错误';
};
