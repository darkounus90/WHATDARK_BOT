const { ck } = require('./_assert');
const { isOptOutRequest } = require('../dist/utils/optout.js');

module.exports = function () {
    const si = ['STOP', 'stop', 'Baja', 'no más', 'NO MAS', 'no me escribas',
                'Cancelar', 'unsubscribe', 'no me contacten', '  stop  ', 'no más mensajes', '¡STOP!'];
    const no = ['hola', 'quiero comprar', 'no más de 3 unidades por favor gracias',
                'me interesa pero no ahora', 'cuánto vale', 'no', 'stopper',
                'no me escribas el precio ahorita sino mañana temprano', '', 'bajar el precio'];

    for (const t of si) ck(isOptOutRequest(t), `"${t}" debe contar como opt-out`);
    for (const t of no) ck(!isOptOutRequest(t), `"${t}" NO debe contar como opt-out`);
};
