const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./serviceAccountKey.json.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  // Amostra de pedidos - mostra campo cnpj e contaAzul exatos
  console.log('\n=== Formato do campo cnpj em pedidos ===');
  const ped = await db.collection('pedidos').where('vendedorResponsavel', '==', 'Ana Carolina').limit(5).get();
  ped.docs.forEach(d => {
    const p = d.data();
    console.log(`cnpj: "${p.cnpj}" | cliente: ${p.cliente} | contaAzul: "${p.contaAzul}" | chave: ${p.chave?.slice(0,40)}`);
  });

  // Busca por BUTECO DO SIMPRÃO diretamente
  console.log('\n=== Pedidos BUTECO DO SIMPRÃO ===');
  const ps1 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'BUTECO DO SIMPRÃO')
    .limit(5).get();
  ps1.docs.forEach(d => {
    const p = d.data();
    console.log(`cnpj: "${p.cnpj}" | contaAzul: "${p.contaAzul}" | chave: ${p.chave}`);
  });

  // Busca por PARK SUSHI  
  console.log('\n=== Pedidos PARK SUSHI ===');
  const ps2 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'PARK SUSHI')
    .limit(5).get();
  ps2.docs.forEach(d => {
    const p = d.data();
    console.log(`cnpj: "${p.cnpj}" | contaAzul: "${p.contaAzul}" | chave: ${p.chave}`);
  });

  // Busca Nilia  
  console.log('\n=== Pedidos Nilia Lacerda ===');
  const ps3 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .where('cliente', '==', 'Nilia Lacerda')
    .limit(5).get();
  ps3.docs.forEach(d => {
    const p = d.data();
    console.log(`cnpj: "${p.cnpj}" | contaAzul: "${p.contaAzul}" | chave: ${p.chave}`);
  });

  // Busca RVS
  console.log('\n=== Pedidos RVS ===');
  const ps4 = await db.collection('pedidos')
    .where('vendedorResponsavel', '==', 'Ana Carolina')
    .limit(2965).get();
  const rvs = ps4.docs.filter(d => d.data().cliente?.toUpperCase().includes('RVS'));
  rvs.slice(0,5).forEach(d => {
    const p = d.data();
    console.log(`cnpj: "${p.cnpj}" | contaAzul: "${p.contaAzul}" | cliente: ${p.cliente} | chave: ${p.chave}`);
  });
  if (rvs.length === 0) console.log('Nenhum pedido RVS encontrado');
}

main().catch(console.error).finally(() => process.exit());
