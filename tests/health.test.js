const { ck } = require('./_assert');
const { evaluateHealth } = require('../dist/bot/health.js');

const base = { inbound24h:0, outbound24h:0, sendFailed24h:0, optOut7d:0,
               contacts7d:0, proactiveSent7d:0, proactiveReplied7d:0 };
const H = (o) => evaluateHealth('t', { ...base, ...o });

module.exports = function () {
    let h = H({ inbound24h:400, outbound24h:420, sendFailed24h:2, optOut7d:1,
                contacts7d:120, proactiveSent7d:40, proactiveReplied7d:14 });
    ck(h.status === 'ok', 'una tienda sana da estado ok');
    ck(!h.pauseProactive && !h.requiresAttention, 'una tienda sana no se frena');

    ck(H({}).status === 'ok', 'sin actividad da ok');

    // Los mínimos por señal evitan falsas alarmas con volúmenes ridículos.
    h = H({ outbound24h:5, sendFailed24h:5, contacts7d:2, optOut7d:2, proactiveSent7d:3, proactiveReplied7d:0 });
    ck(h.status === 'ok', 'un volumen bajo no dispara alarmas');

    h = H({ inbound24h:100, outbound24h:100, sendFailed24h:30 });
    ck(h.status === 'critical', 'fallos de entrega altos dan critical');
    ck(h.requiresAttention && h.pauseProactive, 'critical pide intervención y frena el proactivo');

    h = H({ inbound24h:200, outbound24h:200, contacts7d:100, optOut7d:20 });
    ck(h.status === 'watch', 'una sola señal rota da watch');
    ck(h.pauseProactive === true, 'una señal rota frena el proactivo');
    ck(h.requiresAttention === false, 'una señal rota no pide intervención humana');

    h = H({ inbound24h:10, outbound24h:100, contacts7d:100, optOut7d:20 });
    ck(h.status === 'degraded', 'dos señales rotas dan degraded');

    h = H({ inbound24h:0, outbound24h:80 });
    ck(h.signals.find(s => s.key === 'outbound_ratio').breached, 'predicar sin recibir rompe la señal de proporción');

    h = H({ inbound24h:100, outbound24h:100, proactiveSent7d:50, proactiveReplied7d:2 });
    ck(h.signals.find(s => s.key === 'proactive_reply_rate').breached, 'seguimientos ignorados rompen su señal');

    h = H({});
    ck(h.signals.length === 4, 'siempre devuelve las 4 señales');
    ck(h.signals.every(s => typeof s.threshold === 'number' && s.detail), 'cada señal trae umbral y detalle');
};
