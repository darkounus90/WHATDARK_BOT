// Runner mínimo. Requiere que `dist/` esté construido (npm test lo hace).
const assert = require('./_assert');

const suites = [
    ['contraseñas', './password.test'],
    ['opt-out', './optout.test'],
    ['salud del número', './health.test'],
    ['agente', './agent.test'],
    ['herramientas', './tools.test']
];

console.log('\nPruebas\n');
let fallidas = 0;

for (const [nombre, ruta] of suites) {
    assert.reset();
    try {
        require(ruta)();
    } catch (error) {
        console.log(`  ✗ ${nombre}: excepción — ${error.message}`);
        fallidas++;
        continue;
    }
    if (!assert.resumen(nombre)) fallidas++;
}

console.log(fallidas === 0 ? '\nTodo en verde.\n' : `\n${fallidas} suite(s) con fallos.\n`);
process.exit(fallidas === 0 ? 0 : 1);
