import crypto from 'crypto';

/**
 * Hashing de contraseñas con scrypt (incluido en Node, sin dependencias nuevas).
 * scrypt es una KDF dura en memoria: a diferencia de SHA-256, encarece el
 * ataque por diccionario aunque la base de datos se filtre.
 */

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'scrypt';

export function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync(password, salt, KEYLEN, SCRYPT_OPTS);
    return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Hash viejo del sistema anterior: SHA-256 sin sal, 64 caracteres hex. */
export function isLegacyHash(stored: string): boolean {
    return /^[a-f0-9]{64}$/i.test(stored || '');
}

export function verifyPassword(password: string, stored: string): boolean {
    if (!password || !stored) return false;

    if (stored.startsWith(`${PREFIX}$`)) {
        const [, saltHex, hashHex] = stored.split('$');
        if (!saltHex || !hashHex) return false;

        const expected = Buffer.from(hashHex, 'hex');
        if (expected.length !== KEYLEN) return false;

        const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), KEYLEN, SCRYPT_OPTS);
        return crypto.timingSafeEqual(derived, expected);
    }

    // Formato viejo: se acepta SOLO para poder migrarlo al vuelo en el primer
    // login. Nunca se escribe uno nuevo con este formato.
    if (isLegacyHash(stored)) {
        const legacy = crypto.createHash('sha256').update(password).digest('hex');
        return crypto.timingSafeEqual(
            Buffer.from(legacy, 'hex'),
            Buffer.from(stored.toLowerCase(), 'hex')
        );
    }

    // Cualquier otro formato — incluida una contraseña guardada en texto
    // plano — se rechaza. El sistema anterior la aceptaba.
    return false;
}

/** Compara dos secretos de texto sin filtrar información por tiempo. */
export function safeEquals(a: string, b: string): boolean {
    const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(ha, hb);
}
