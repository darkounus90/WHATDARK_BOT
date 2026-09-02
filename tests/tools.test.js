const { ck } = require('./_assert');
const tools = require('../dist/bot/tools.js');

module.exports = function () {
    ck(Array.isArray(tools.takePendingImages('tiendaA_573001')), 'takePendingImages devuelve un array');
    ck(tools.takePendingImages('tiendaA_573001').length === 0, 'una sesión sin fotos devuelve vacío');
    ck(tools.consumeCloseRequest('tiendaA_573001') === false, 'sin cierre pendiente devuelve false');
    // Regresión: la versión original usaba un array global del módulo, y las
    // fotos de una tienda se le entregaban al cliente de otra.
    ck(tools.getPendingImages === undefined, 'no queda la cola global de imágenes');
    ck(typeof tools.discardPendingImages === 'function', 'discardPendingImages está exportada');

    const nombres = tools.botTools.map(t => t.function.name);
    ck(nombres.includes('send_product_image'), 'send_product_image está declarada');
    ck(nombres.includes('close_conversation'), 'close_conversation está declarada');
    ck(nombres.includes('generate_payment_link'), 'generate_payment_link está declarada');
    // get_order_status se retiró: orders.ts es un stub que siempre devuelve null.
    ck(!nombres.includes('get_order_status'), 'get_order_status ya no se expone al modelo');
};
