/**
 * diagnostico_pedidos.js — inspeciona o campo ultimaCompra nos registros de pedidosDia
 * cd functions && node diagnostico_pedidos.js
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');

initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
const db = getFirestore();

async function main() {
  const hoje = new Date().toISOString().slice(0, 10);
  console.log(`\n🔍 Verificando pedidosDia para hoje (${hoje})\n`);

  const snap = await db.collection('pedidosDia')
    .where('dataSugestao', '==', hoje)
    .limit(10)
    .get();

  if (snap.empty) {
    console.log('❌ Nenhum documento encontrado para hoje!');
    console.log('   Verifique se dataSugestao está preenchida corretamente.\n');
    return;
  }

  console.log(`✅ ${snap.size} documentos encontrados (mostrando até 10)\n`);
  console.log('─'.repeat(70));

  snap.docs.forEach(d => {
    const r = d.data();
    const uc = r.ultimaCompra;
    const tipo = uc === undefined ? '⚠️  AUSENTE'
               : uc === null      ? '⚠️  NULL'
               : uc === ''        ? '⚠️  STRING VAZIA'
               : typeof uc === 'object' && uc._seconds ? `🕐 TIMESTAMP (${new Date(uc._seconds * 1000).toISOString().slice(0,10)})`
               : typeof uc === 'object' && uc.toDate   ? `🕐 TIMESTAMP`
               : typeof uc === 'string'                ? `✅ STRING: "${uc}"`
               : `❓ OUTRO: ${JSON.stringify(uc)}`;

    console.log(`Cliente  : ${r.cliente}`);
    console.log(`Vendedor : ${r.vendedor}`);
    console.log(`ultimaCompra → ${tipo}`);
    console.log(`dataSugestao : ${r.dataSugestao}`);
    console.log('─'.repeat(70));
  });
}

main().catch(e => { console.error('\n❌', e); process.exit(1); });
