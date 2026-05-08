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

async function checkFinIds(finIds, label) {
  console.log(`\n${label} — finIds: ${finIds.join(', ')}`);
  for (const fid of finIds) {
    const doc = await db.collection('financeiro').doc(fid).get();
    if (!doc.exists) {
      console.log(`  ${fid}: NÃO EXISTE`);
    } else {
      const d = doc.data();
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`  ${fid}: statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | ATRASADOS=${atrasados.length} | cliente=${d.cliente}`);
    }
  }
}

async function main() {
  // MCO BAR - pega todos os finIds
  const ps1 = await db.collection('pedidos').where('cnpj', '==', '31634395000108').get();
  const f1 = [...new Set(ps1.docs.map(d => finId(d.data())).filter(Boolean))];
  await checkFinIds(f1, 'MCO BAR / BUTECO DO SIMPRÃO');

  // VAN SANTANA / PARK SUSHI
  const ps2 = await db.collection('pedidos').where('cnpj', '==', '51623623000151').get();
  const f2 = [...new Set(ps2.docs.map(d => finId(d.data())).filter(Boolean))];
  await checkFinIds(f2, 'VAN SANTANA / PARK SUSHI');

  // RVS BAR - busca por CNPJ direto
  console.log('\n=== RVS BAR (39281885000180) ===');
  const ps3 = await db.collection('pedidos').where('cnpj', '==', '39281885000180').get();
  console.log(`Pedidos pelo CNPJ exato: ${ps3.size}`);
  if (!ps3.empty) {
    ps3.docs.slice(0,3).forEach(d => {
      const p = d.data();
      console.log(`  cliente: ${p.cliente} | vendedor: ${p.vendedorResponsavel} | contaAzul: ${p.contaAzul} | chave: ${p.chave?.slice(0,40)}`);
    });
  }
  // Busca por cliente com RVS no nome (todos vendedores)
  const allPed = await db.collection('pedidos').limit(3000).get();
  const rvs = allPed.docs.filter(d => {
    const p = d.data();
    return (p.cliente||'').toUpperCase().includes('RVS') || (p.cnpj||'').includes('39281885');
  });
  console.log(`RVS por nome/CNPJ parcial: ${rvs.length}`);
  rvs.slice(0,5).forEach(d => {
    const p = d.data();
    console.log(`  ${p.cliente} | CNPJ: ${p.cnpj} | vendedor: ${p.vendedorResponsavel}`);
  });

  // Nilia - todos finIds
  const ps4 = await db.collection('pedidos').where('cnpj', '==', '87394154149').get();
  const f4 = [...new Set(ps4.docs.map(d => finId(d.data())).filter(Boolean))];
  await checkFinIds(f4, 'Nilia Lacerda');
}

main().catch(console.error).finally(() => process.exit());
