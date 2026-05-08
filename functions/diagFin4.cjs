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

async function checkAllFinIds(cnpjNum, label) {
  // Busca por cnpj como numero
  const ps = await db.collection('pedidos').where('cnpj', '==', cnpjNum).get();
  console.log(`\n${label} — pedidos: ${ps.size}`);
  const fids = [...new Set(ps.docs.map(d => finId(d.data())).filter(Boolean))];
  console.log('FinIds:', fids.join(', '));
  
  // Verifica cada finId no financeiro
  for (const fid of fids) {
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
  await checkAllFinIds(31634395000108, 'MCO BAR / BUTECO DO SIMPRÃO');
  await checkAllFinIds(51623623000151, 'VAN SANTANA / PARK SUSHI');
  await checkAllFinIds(39281885000180, 'RVS BAR (numero)');
  await checkAllFinIds(87394154149, 'Nilia Lacerda');

  // Verifica também se RVS tem pedidos com CNPJ string
  console.log('\n=== RVS BAR - busca por cliente name em todos pedidos ===');
  const all = await db.collection('pedidos').where('vendedorResponsavel', '==', 'Ana Carolina').get();
  const rvs = all.docs.filter(d => {
    const p = d.data();
    const nome = (p.cliente || '').toUpperCase();
    return nome.includes('RVS') || String(p.cnpj).includes('39281885');
  });
  console.log(`Encontrados: ${rvs.length}`);
  rvs.slice(0,5).forEach(d => {
    const p = d.data();
    console.log(` cliente: ${p.cliente} | cnpj: ${p.cnpj} | contaAzul: ${p.contaAzul}`);
  });
}

main().catch(console.error).finally(() => process.exit());
