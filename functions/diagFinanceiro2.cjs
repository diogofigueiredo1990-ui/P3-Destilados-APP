const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./serviceAccountKey.json.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

function normalizarCnpj(v) {
  if (!v) return '';
  const s = String(v).replace(/\D/g, '');
  return s || String(v).trim();
}

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

async function checkCnpj(cnpj, label) {
  console.log(`\n--- ${label} (CNPJ: ${cnpj}) ---`);
  const ps = await db.collection('pedidos').where('cnpj', '==', cnpj).get();
  if (ps.empty) {
    console.log('SEM PEDIDOS');
    return;
  }
  const pedidos = ps.docs.map(d => d.data());
  const vendedores = [...new Set(pedidos.map(p => p.vendedorResponsavel))];
  console.log(`Pedidos: ${pedidos.length} | Vendedores: ${vendedores.join(', ')}`);
  
  const finIds = [...new Set(pedidos.map(finId).filter(Boolean))];
  console.log(`FinIds únicos: ${finIds.join(', ')}`);
  
  // Verifica cada finId
  for (const fid of finIds) {
    const doc = await db.collection('financeiro').doc(fid).get();
    if (!doc.exists) {
      // tenta query por docId
      const q = await db.collection('financeiro').where('docId', '==', fid).limit(1).get();
      if (q.empty) {
        console.log(`  ${fid}: NÃO EXISTE`);
      } else {
        const d = q.docs[0].data();
        console.log(`  ${fid} (via query): statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada}`);
      }
    } else {
      const d = doc.data();
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`  ${fid}: statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | ATRASADOS=${atrasados.length}`);
    }
  }
}

async function main() {
  // MCO BAR
  await checkCnpj('31634395000108', 'MCO BAR / BUTECO DO SIMPRÃO');
  
  // VAN SANTANA / PARK SUSHI
  await checkCnpj('51623623000151', 'VAN SANTANA / PARK SUSHI');
  
  // RVS BAR
  await checkCnpj('39281885000180', 'RVS BAR');
  
  // Nilia Lacerda - verifica outros finIds
  console.log('\n--- Nilia Lacerda (87394154149) - todos finIds ---');
  const niliaPeds = await db.collection('pedidos').where('cnpj', '==', '87394154149').get();
  const niliaFinIds = [...new Set(niliaPeds.docs.map(d => finId(d.data())).filter(Boolean))];
  console.log('FinIds:', niliaFinIds.join(', '));
  for (const fid of niliaFinIds) {
    const doc = await db.collection('financeiro').doc(fid).get();
    if (!doc.exists) {
      console.log(`  ${fid}: NÃO EXISTE`);
    } else {
      const d = doc.data();
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`  ${fid}: statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | ATRASADOS=${atrasados.length}`);
    }
  }
}

main().catch(console.error).finally(() => process.exit());
