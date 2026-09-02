const { ck } = require('./_assert');
const { esPrimerContacto, recortarHistorialSeguro } = require('../dist/bot/agent.js');

const H = 3600000;

module.exports = function () {
    const ahora = Date.now();
    ck(esPrimerContacto(null, ahora) === true, 'sin sesión previa el bot se presenta');
    ck(esPrimerContacto(new Date(ahora - 2 * 60000), ahora) === false, 'a los 2 minutos no se repite');
    ck(esPrimerContacto(new Date(ahora - 23 * H), ahora) === false, 'a las 23 h todavía no');
    ck(esPrimerContacto(new Date(ahora - 25 * H), ahora) === true, 'a las 25 h se vuelve a presentar');
    ck(esPrimerContacto('fecha-basura', ahora) === true, 'una fecha inválida falla hacia presentarse');
    ck(esPrimerContacto(new Date(ahora - 5 * H), ahora, 4) === true, 'el umbral es configurable');

    if (typeof recortarHistorialSeguro !== 'function') {
        ck(false, 'recortarHistorialSeguro debe estar exportada');
        return;
    }

    // La API exige que todo mensaje `tool` vaya precedido por el `assistant`
    // con su `tool_calls`. Un recorte que rompa ese par provoca un 400.
    const sys = { role: 'system', content: 'sistema' };
    const historial = [
        sys,
        { role: 'user', content: 'hola' },
        { role: 'assistant', tool_calls: [{ id: 'a1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'a1', content: '{}' },
        { role: 'assistant', content: 'respuesta' },
        { role: 'user', content: 'otra' }
    ];

    const invariante = (h) => {
        if (h.length && h[0].role !== 'system') return 'no empieza por system';
        const pendientes = new Set();
        for (const m of h) {
            if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) pendientes.add(tc.id);
            if (m.role === 'tool') {
                if (!pendientes.has(m.tool_call_id)) return 'mensaje tool huérfano';
                pendientes.delete(m.tool_call_id);
            }
        }
        return pendientes.size ? 'tool_calls sin resultado' : null;
    };

    ck(invariante(historial) === null, 'el historial de prueba es válido de entrada');

    for (let max = 1; max <= 8; max++) {
        const r = recortarHistorialSeguro(historial.slice(), max);
        const problema = invariante(r);
        ck(problema === null, `recorte a ${max} mantiene el invariante (${problema})`);
        ck(r.length === 0 || r[0].role === 'system', `recorte a ${max} conserva el system primero`);
    }
};
