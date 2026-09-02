/**
 * Detección de peticiones de "no me escribas más".
 * Módulo puro y sin dependencias para poder probarlo aislado.
 */

const OPT_OUT_PHRASES = new Set([
    'stop', 'baja', 'dar de baja', 'darme de baja', 'no mas', 'no mas mensajes',
    'no me escribas', 'no me escriban', 'no quiero mas mensajes', 'no me contacten',
    'cancelar', 'cancelar suscripcion', 'unsubscribe'
]);

export function normalizeText(text: string): string {
    return (text || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function isOptOutRequest(text: string): boolean {
    const normalized = normalizeText(text);
    // Solo mensajes cortos y explícitos, para no confundir con una frase larga cualquiera.
    if (!normalized || normalized.length > 30) return false;
    return OPT_OUT_PHRASES.has(normalized);
}
