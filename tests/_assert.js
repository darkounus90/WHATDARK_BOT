// Utilidades mínimas. Sin dependencias a propósito: el proyecto no tiene
// framework de pruebas y no vale la pena arrastrar uno para esto.
let fallos = 0;
let total = 0;

function ck(condicion, mensaje) {
    total++;
    if (!condicion) {
        console.log(`    ✗ ${mensaje}`);
        fallos++;
    }
}

function resumen(nombre) {
    const ok = fallos === 0;
    console.log(`  ${ok ? '✓' : '✗'} ${nombre}: ${total - fallos}/${total}`);
    return ok;
}

function reset() { fallos = 0; total = 0; }

module.exports = { ck, resumen, reset };
