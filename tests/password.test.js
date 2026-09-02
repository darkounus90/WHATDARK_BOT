const crypto = require('crypto');
const { ck } = require('./_assert');
const p = require('../dist/utils/password.js');

module.exports = function () {
    const h = p.hashPassword('Contraseña-Segura-2026');
    ck(h.startsWith('scrypt$'), 'el hash usa el formato scrypt$');
    ck(p.hashPassword('misma') !== p.hashPassword('misma'), 'dos hashes de la misma clave difieren (hay sal)');
    ck(p.verifyPassword('Contraseña-Segura-2026', h), 'acepta la contraseña correcta');
    ck(!p.verifyPassword('otra', h), 'rechaza la incorrecta');
    ck(!p.verifyPassword('', h), 'rechaza contraseña vacía');

    // Regresión del agujero viejo: el login aceptaba `passwordHash === password`.
    ck(!p.verifyPassword('secreta123', 'secreta123'), 'NO acepta una contraseña guardada en texto plano');

    const legado = crypto.createHash('sha256').update('vieja').digest('hex');
    ck(p.isLegacyHash(legado), 'detecta un hash legado SHA-256');
    ck(!p.isLegacyHash(h), 'no confunde scrypt con legado');
    ck(p.verifyPassword('vieja', legado), 'acepta el legado para poder migrarlo');
    ck(!p.verifyPassword('mala', legado), 'rechaza el legado con clave incorrecta');
    ck(!p.verifyPassword('x', 'formato-raro'), 'rechaza un formato desconocido');
    ck(!p.verifyPassword('x', 'scrypt$zz$zz'), 'rechaza un scrypt malformado');
    ck(p.safeEquals('abc', 'abc') && !p.safeEquals('abc', 'abd'), 'safeEquals compara correctamente');
};
