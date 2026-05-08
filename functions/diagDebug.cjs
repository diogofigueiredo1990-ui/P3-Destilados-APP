const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./serviceAccountKey.json.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

function extrairNumeroVenda(chave) {
  if (!chave) return null;
  const partes = String(chave).split('_');
  if (partes.length >= 2 && /^\d+$/.test(partes[1])) return partes[1];
  return null;
}

function finId(p) {
  const ca = String(p.contaAzul || '').trim();
  if (!ca) return null;
  const nv = extrairNumeroVenda(p.chave);
  if (!nv) return null;
  return `${ca}_${nv}`;
}

async function main() {
  // Debug: pega pedidos de BUTECO DO SIMPRÃO e mostra campos raw
  const ps = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'BUTECO DO SIMPRÃO')
    .limit(3).get();
  
  console.log('Pedidos BUTECO:', ps.size);
  ps.docs.forEach(d => {
    const p = d.data();
    console.log('cnpj type:', typeof p.cnpj, '| value:', JSON.stringify(p.cnpj));
    console.log('contaAzul type:', typeof p.contaAzul, '| value:', JSON.stringify(p.contaAzul));
    console.log('chave:', p.chave);
    console.log('finId:', finId(p));
    console.log('---');
  });

  // Mesmo para PARK SUSHI
  const ps2 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'PARK SUSHI')
    .limit(3).get();
  
  console.log('\nPedidos PARK SUSHI:', ps2.size);
  ps2.docs.forEach(d => {
    const p = d.data();
    console.log('cnpj type:', typeof p.cnpj, '| value:', JSON.stringify(p.cnpj));
    console.log('contaAzul:', JSON.stringify(p.contaAzul), '| chave:', p.chave?.slice(0,30));
    console.log('finId:', finId(p));
  });

  // E para Nilia
  const ps3 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'Nilia Lacerda')
    .limit(3).get();
  
  console.log('\nPedidos Nilia:', ps3.size);
  ps3.docs.forEach(d => {
    const p = d.data();
    console.log('cnpj type:', typeof p.cnpj, '| value:', JSON.stringify(p.cnpj));
    console.log('contaAzul:', JSON.stringify(p.contaAzul), '| chave:', p.chave?.slice(0,30));
    console.log('finId:', finId(p));
  });
}

main().catch(console.error).finally(() => process.exit());
