const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');

const sa = JSON.parse(fs.readFileSync('./serviceAccountKey.json.json', 'utf8'));
initializeApp({ credential: cert(sa) });
const db = getFirestore();

async function main() {
  // 1. Verifica GO_133, GO_164, GO_197
  console.log('\n=== 1. Docs GO_ ===');
  for (const id of ['GO_133', 'GO_164', 'GO_197']) {
    const doc = await db.collection('financeiro').doc(id).get();
    if (!doc.exists) {
      console.log(`${id}: NÃO EXISTE`);
    } else {
      const d = doc.data();
      const atrasados = (d.boletos||[]).filter(b => b.status === 'ATRASADO');
      console.log(`${id}: docId=${d.docId} | statusGeral=${d.statusGeral} | comissaoBloqueada=${d.comissaoBloqueada} | cliente=${d.cliente} | ATRASADOS=${atrasados.length}`);
    }
  }

  // 2. Query por docId field
  console.log('\n=== 2. Query where docId in GO_ids ===');
  const snap2 = await db.collection('financeiro').where('docId', 'in', ['GO_133', 'GO_164', 'GO_197']).get();
  console.log(`Via query: ${snap2.size} docs`);

  // 3. Clientes MCO/RVS/VAN/NILIA
  console.log('\n=== 3. Clientes bloqueados ===');
  const cliSnap = await db.collection('clientes').get();
  const targets = [];
  cliSnap.docs.forEach(d => {
    const nome = (d.data().nome || '').toUpperCase();
    if (nome.includes('MCO') || nome.includes('RVS') || nome.includes('VAN SANTANA') || nome.includes('NILIA')) {
      targets.push({ cnpj: d.id, nome: d.data().nome, bloqueio: d.data().statusBloqueio });
      console.log(` ${d.data().nome} | CNPJ: ${d.id}`);
    }
  });

  // 4. Pedidos por CNPJ
  console.log('\n=== 4. Pedidos por CNPJ ===');
  for (const cli of targets) {
    const cnpjNum = cli.cnpj.replace(/\D/g, '');
    let found = false;
    for (const q of [cli.cnpj, cnpjNum]) {
      const ps = await db.collection('pedidos').where('cnpj', '==', q).limit(10).get();
      if (!ps.empty) {
        const vends = [...new Set(ps.docs.map(d => d.data().vendedorResponsavel))];
        const chaves = [...new Set(ps.docs.map(d => d.data().chave))].slice(0,3);
        console.log(`${cli.nome}: ${ps.size} pedidos | vendedores=${vends.join(', ')} | chaves=${chaves}`);
        found = true; break;
      }
    }
    if (!found) console.log(`${cli.nome}: SEM PEDIDOS (CNPJ=${cli.cnpj})`);
  }

  // 5. Vendedores únicos
  console.log('\n=== 5. Vendedores (500 pedidos) ===');
  const allP = await db.collection('pedidos').limit(500).get();
  const vends = new Set(allP.docs.map(d => d.data().vendedorResponsavel));
  console.log([...vends].filter(v=>v).sort().join('\n'));
}

main().catch(console.error).finally(() => process.exit());
